/* ==========================================================================
   FORGE — js/input/camwheel.js
   CB.input.camwheel : the "webcam air wheel" — steer by holding an imaginary steering wheel in front of the webcam.
   Default method 'hands': bare hands, tracked by MediaPipe Hand Landmarker (js/input/camwheel-hands.js, vendored under
   vendor/mediapipe/, run in a worker: js/input/camwheel-worker.js). Fallback method 'marker' (Settings: Advanced ->
   marker mode): pure-JS colour tracking of one or two coloured objects (no ML, ~2 ms/frame). Frames never leave the device.
   This file: the camera, the per-frame pipeline, the shared angle -> steer stage, the 'camwheel' hub source (steering
   + hands-only pedals: prefs.pedals 'fist' (default: "Fist = go, open hand = brake", in between = coast, open at a stop =
   reverse) | 'auto' | 'grip' (older: close = gas, pull back = brake) | 'push' | 'off', see camhands.createPedals), the 3-2-1
   re-centre countdown, and the colour-marker core (Node-tested).

   Pipeline: getUserMedia (640x360 ideal for hands, 640x480 for markers, 60 fps if offered) -> requestVideoFrameCallback
     hands : frame -> ImageBitmap -> worker (GPU, CPU fallback) -> 21 landmarks x 2 -> camhands solver (two-hand line,
             one-hand roll, continuity, re-base) -> createSteer
     marker: drawImage MIRRORED into a ~160x120 canvas -> 18-bit RGB class table -> connected components + moments ->
             tracking (gated by position / size / spacing) -> createSteer
     createSteer: unwrap -> centre -> 1-euro filter -> lookahead (cancels the filter lag) -> dead zone + full lock ->
             steer [-1, 1] (+1 = right); lost: hold 250 ms, then ease back to centre over 250 ms; re-acquired: ease
             from the held / centring value to the new reading over 120 ms (no snap), relocking the unwrap.
   Angles are in the MIRRORED (player's) view: clockwise as the player sees it = positive = steer right.

   Marker core (pure): rgbToHsv, hueDist, buildLut(models), segment(rgba, w, h, lut), axisAngle, calibrate(rgba, w, h,
     boxes) -> {ok, models, mode:'same'|'two'|'one', style, expect, warnings}, createTracker(cal, {w, h}).process(rgba, t)
   Shared: createSteer(prefs) -> S.update(meas, t) / S.read(t) / S.recentre(); oneEuro, mapAngle, cutoffFor
   Prefs (localStorage 'forge.camWheel.v1'): method 'hands'|'marker', handStyle 'two' (hands at 9 and 3) | 'top' (one
     hand at the top of the wheel) | 'auto' (two if both visible, else one-hand top grip), wheelSize 1 (top grip radius
     x 0.5..2), maxAngle 90, deadzone 2, smoothing 0.3, lookahead,
     deviceId, pip, pedals 'fist'|'auto'|'grip'|'push'|'off' (pedalsV 2: the old 'grip' default migrated to 'fist' once),
     pullBrake (opt-in pull-back brake), easyAssist (webcam: Heavy steering assist + automatic gearbox, see camwheel-ui),
     gestureNitro / gestureHandbrake / gestureItem (off), cpu,
     handCal {two, labels, top {x, y, L, q, side, roll0}}, pedalCal {open, grip, scale {a, b}, world}, style + cal (marker mode)
   Browser: secure() supported() listCameras() start({deviceId}) -> {ok, reason}  stop()  running()  enable() disable()
     ready()  calibrateNow(boxes?, style?) (immediate)  startCentre('centre'|'calibrate'|'setup'|'auto') (3-2-1 countdown,
     again = cancel)  cancelCentre()  countdown()  recentre() (= startCentre('centre'))  recentreNow()  captureGrip()
     captureFist() / captureOpen() (the Start flow's hand tests)  handState()  carStatus()
     model() / loadModel()  stats()  on('frame'|'hands'|'state'|'prefs'|'autocentre'|'countdown', fn)
     _feed(list, w, h, t) (Node tests: one detector result, as if from the camera)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var PREF_KEY = 'forge.camWheel.v1';
  var DEFAULT_PREFS = { method: 'hands', handStyle: 'two', wheelSize: 1, maxAngle: 90, deadzone: 2, smoothing: 0.3, lookahead: true, style: 'pair', deviceId: '', pip: true, pedals: 'fist', pullBrake: false, pedalsV: 2, easyAssist: true, gestureNitro: false, gestureHandbrake: false, gestureItem: false, cpu: false, handCal: null, pedalCal: null, cal: null };
  var PEDAL_MODES = ['fist', 'auto', 'grip', 'push', 'off'];   // 'grip' / 'push': the older modes (Advanced)
  var HAND_STYLES = ['two', 'top', 'auto'];      // two hands at 9 and 3 | one hand at the top of the wheel | either
  var COUNT_MS = 3000, GRIP_MS = 2000;
  var LUT_BITS = 6, LUT_SIZE = 1 << (3 * LUT_BITS);

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function CW_wrap180(a) { return wrapP(a, 360); }
  function wrapP(a, p) { var h = p / 2; a = ((a + h) % p + p) % p - h; return a; }

  /* ================================================================ colour */
  function rgbToHsv(r, g, b) {
    var mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b), d = mx - mn, h = 0;
    if (d > 0) {
      if (mx === r) h = (g - b) / d; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx > 0 ? d / mx : 0, mx / 255];
  }
  function hueDist(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  /** a colour model {h, hTol, sMin, vMin} */
  function matches(m, hsv) { return hsv[1] >= m.sMin && hsv[2] >= m.vMin && hueDist(hsv[0], m.h) <= m.hTol; }
  /** HSV of every 18-bit RGB bin centre, computed once: rebuilding the class table is then a cheap compare pass */
  var HSV_H = null, HSV_S = null, HSV_V = null;
  function hsvTable() {
    if (HSV_H) return;
    HSV_H = new Uint16Array(LUT_SIZE); HSV_S = new Uint8Array(LUT_SIZE); HSV_V = new Uint8Array(LUT_SIZE);
    var step = 256 >> LUT_BITS, half = step >> 1;
    for (var r = 0; r < 64; r++) for (var g = 0; g < 64; g++) for (var b = 0; b < 64; b++) {
      var hsv = rgbToHsv(r * step + half, g * step + half, b * step + half), k = (r << 12) | (g << 6) | b;
      HSV_H[k] = Math.round(hsv[0] * 10) % 3600; HSV_S[k] = Math.round(hsv[1] * 255); HSV_V[k] = Math.round(hsv[2] * 255);
    }
  }
  /** 18-bit RGB (6 bits / channel) -> class bits (bit i = models[i]), evaluated at the bin centre. */
  function buildLut(models, lut) {
    lut = lut && lut.length === LUT_SIZE ? lut : new Uint8Array(LUT_SIZE);
    lut.fill(0);
    models = (models || []).slice(0, 2);
    if (!models.length) return lut;
    hsvTable();
    for (var i = 0; i < models.length; i++) {
      var m = models[i], bit = 1 << i, h0 = Math.round(m.h * 10), tol = Math.round(m.hTol * 10), sm = Math.ceil(m.sMin * 255 - 1e-6), vm = Math.ceil(m.vMin * 255 - 1e-6);
      for (var k = 0; k < LUT_SIZE; k++) {
        if (HSV_S[k] < sm || HSV_V[k] < vm) continue;
        var d = HSV_H[k] - h0; if (d < 0) d = -d; if (d > 1800) d = 3600 - d;
        if (d <= tol) lut[k] |= bit;
      }
    }
    return lut;
  }
  function skinLike(h, s) { return (h <= 45 || h >= 345) && s >= 0.12 && s <= 0.62; }

  /* ================================================================ segmentation */
  function makeWork(n) {
    return { n: n, cls: new Uint8Array(n), lab: new Int32Array(n), par: new Int32Array(n + 1), st: new Float64Array((n + 1) * 13) };
  }
  function find(par, x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
  /**
   * Connected components (4-connected, per class) with first / second moments, then fragments of the same class whose
   * boxes are within `gap` px are merged into clusters. Returns clusters with n >= minN, largest first.
   */
  function segment(rgba, w, h, lut, work, opts) {
    opts = opts || {};
    var N = w * h;
    if (!work || work.n !== N) work = makeWork(N);
    var cls = work.cls, lab = work.lab, par = work.par, st = work.st;
    var next = 1, i, x, y, p;
    // pass 1: classify + provisional labels
    for (p = 0, i = 0; p < N; p++, i += 4) cls[p] = lut[((rgba[i] >> 2) << 12) | ((rgba[i + 1] >> 2) << 6) | (rgba[i + 2] >> 2)];
    for (y = 0, p = 0; y < h; y++) {
      for (x = 0; x < w; x++, p++) {
        var c = cls[p];
        if (!c) { lab[p] = 0; continue; }
        var l = x > 0 && cls[p - 1] === c ? lab[p - 1] : 0, u = y > 0 && cls[p - w] === c ? lab[p - w] : 0;
        if (l && u) {
          lab[p] = l;
          if (l !== u) { var rl = find(par, l), ru = find(par, u); if (rl !== ru) { if (rl < ru) par[ru] = rl; else par[rl] = ru; } }
        } else if (l || u) lab[p] = l || u;
        else { if (next >= par.length) { lab[p] = 0; continue; } par[next] = next; lab[p] = next++; }
      }
    }
    // pass 2: moments per root  [n, sx, sy, sxx, syy, sxy, x0, y0, x1, y1, sr, sg, sb]
    st.fill(0, 0, next * 13);
    for (var k = 1; k < next; k++) { var o = k * 13; st[o + 6] = 1e9; st[o + 7] = 1e9; st[o + 8] = -1; st[o + 9] = -1; }
    for (y = 0, p = 0; y < h; y++) {
      for (x = 0; x < w; x++, p++) {
        if (!lab[p]) continue;
        var rt = find(par, lab[p]), q = rt * 13, j = p * 4;
        st[q]++; st[q + 1] += x; st[q + 2] += y; st[q + 3] += x * x; st[q + 4] += y * y; st[q + 5] += x * y;
        if (x < st[q + 6]) st[q + 6] = x; if (y < st[q + 7]) st[q + 7] = y; if (x > st[q + 8]) st[q + 8] = x; if (y > st[q + 9]) st[q + 9] = y;
        st[q + 10] += rgba[j]; st[q + 11] += rgba[j + 1]; st[q + 12] += rgba[j + 2];
      }
    }
    var minFrag = num(opts.minFrag, 2), comps = [];
    for (k = 1; k < next; k++) {
      if (par[k] !== k) continue;
      q = k * 13;
      if (st[q] < minFrag) continue;
      comps.push({ cls: 0, raw: [st[q], st[q + 1], st[q + 2], st[q + 3], st[q + 4], st[q + 5], st[q + 10], st[q + 11], st[q + 12]], x0: st[q + 6], y0: st[q + 7], x1: st[q + 8], y1: st[q + 9], root: k });
    }
    // class of each component (any pixel of it)
    if (comps.length) {
      var byRoot = {};
      comps.forEach(function (cc) { byRoot[cc.root] = cc; });
      for (p = 0; p < N && comps.some(function (cc) { return !cc.cls; }); p++) {
        if (!lab[p]) continue;
        var cc2 = byRoot[find(par, lab[p])];
        if (cc2 && !cc2.cls) cc2.cls = cls[p];
      }
    }
    comps.sort(function (a, b) { return b.raw[0] - a.raw[0]; });
    // sensor-noise specks never join a marker (they would drag its centroid around)
    var minMerge = num(opts.minMergeFrag, 4);
    for (var cut = comps.length; cut > 0 && comps[cut - 1].raw[0] < minMerge; cut--) { /* sorted */ }
    if (comps.length > cut) comps.length = cut;
    if (comps.length > 80) comps.length = 80;
    // merge nearby fragments of the same class (shadows, fingers, glare split a marker into pieces)
    var gap = num(opts.gap, Math.max(2, Math.round(w * 0.025)));
    var merged = true, maxMerge = num(opts.maxMerge, Infinity);
    while (merged) {
      merged = false;
      for (var a = 0; a < comps.length && !merged; a++) {
        for (var b = a + 1; b < comps.length; b++) {
          var A = comps[a], B = comps[b];
          if (A.cls !== B.cls || A.raw[0] + B.raw[0] > maxMerge) continue;
          if (B.x0 > A.x1 + gap + 1 || A.x0 > B.x1 + gap + 1 || B.y0 > A.y1 + gap + 1 || A.y0 > B.y1 + gap + 1) continue;
          for (var m = 0; m < 9; m++) A.raw[m] += B.raw[m];
          A.x0 = Math.min(A.x0, B.x0); A.y0 = Math.min(A.y0, B.y0); A.x1 = Math.max(A.x1, B.x1); A.y1 = Math.max(A.y1, B.y1);
          comps.splice(b, 1); merged = true; break;
        }
      }
    }
    var minN = num(opts.minN, 3), out = [];
    comps.forEach(function (cc) { if (cc.raw[0] >= minN) out.push(finish(cc)); });
    out.sort(function (a, b) { return b.n - a.n; });
    out.work = work;
    return out;
  }
  function finish(cc) {
    var r = cc.raw, n = r[0], mx = r[1] / n, my = r[2] / n;
    return {
      cls: cc.cls, n: n, x: mx + 0.5, y: my + 0.5,
      mxx: r[3] / n - mx * mx + 1 / 12, myy: r[4] / n - my * my + 1 / 12, mxy: r[5] / n - mx * my,
      x0: cc.x0, y0: cc.y0, x1: cc.x1 + 1, y1: cc.y1 + 1, r: r[6] / n, g: r[7] / n, b: r[8] / n, raw: r
    };
  }
  /** union of clusters -> one cluster (moments combined exactly) */
  function unite(list) {
    if (!list.length) return null;
    var raw = [0, 0, 0, 0, 0, 0, 0, 0, 0], x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    list.forEach(function (c) { for (var m = 0; m < 9; m++) raw[m] += c.raw[m]; x0 = Math.min(x0, c.x0); y0 = Math.min(y0, c.y0); x1 = Math.max(x1, c.x1 - 1); y1 = Math.max(y1, c.y1 - 1); });
    return finish({ cls: list[0].cls, raw: raw, x0: x0, y0: y0, x1: x1, y1: y1 });
  }
  /** principal axis of a cluster: angle in (-90, 90] deg (y down => clockwise +), elongation = sqrt(l1 / l2) */
  function axisAngle(c) {
    var a = c.mxx, b = c.mxy, d = c.myy;
    var tr = a + d, det = a * d - b * b, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    var l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    return { angle: 0.5 * Math.atan2(2 * b, a - d) / DEG, elong: Math.sqrt(l1 / l2), len: Math.sqrt(12 * l1) };
  }

  /* ================================================================ calibration */
  function boxPx(bx, w, h) {
    return { x0: clamp(Math.round(bx.x * w), 0, w), y0: clamp(Math.round(bx.y * h), 0, h), x1: clamp(Math.round((bx.x + bx.w) * w), 0, w), y1: clamp(Math.round((bx.y + bx.h) * h), 0, h) };
  }
  function inBox(b, x, y) { return x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1; }
  function grow(b, f, w, h) {
    var gx = (b.x1 - b.x0) * f, gy = (b.y1 - b.y0) * f;
    return { x0: Math.max(0, b.x0 - gx), y0: Math.max(0, b.y0 - gy), x1: Math.min(w, b.x1 + gx), y1: Math.min(h, b.y1 + gy) };
  }
  /** dominant saturated hue inside a box: {h, s, v, n, frac} or null */
  function dominant(hsv, w, h, B) {
    var bins = new Float64Array(72), x, y, p;
    for (y = B.y0; y < B.y1; y++) for (x = B.x0; x < B.x1; x++) {
      p = (y * w + x) * 3;
      var s = hsv[p + 1], v = hsv[p + 2];
      if (s < 0.25 || v < 0.15) continue;
      bins[Math.floor(hsv[p] / 5) % 72] += s * Math.min(1, v * 1.5);
    }
    var best = -1, bi = 0;
    for (var i = 0; i < 72; i++) { var sm = bins[(i + 71) % 72] + 2 * bins[i] + bins[(i + 1) % 72]; if (sm > best) { best = sm; bi = i; } }
    if (best <= 0) return null;
    var h0 = bi * 5 + 2.5, cs = 0, sn = 0, ss = 0, vs = 0, n = 0;
    for (y = B.y0; y < B.y1; y++) for (x = B.x0; x < B.x1; x++) {
      p = (y * w + x) * 3;
      if (hsv[p + 1] < 0.25 || hsv[p + 2] < 0.15 || hueDist(hsv[p], h0) > 18) continue;
      cs += Math.cos(hsv[p] * DEG); sn += Math.sin(hsv[p] * DEG); ss += hsv[p + 1]; vs += hsv[p + 2]; n++;
    }
    if (!n) return null;
    var hh = Math.atan2(sn, cs) / DEG; if (hh < 0) hh += 360;
    return { h: hh, s: ss / n, v: vs / n, n: n, frac: n / Math.max(1, (B.x1 - B.x0) * (B.y1 - B.y0)) };
  }
  /** threshold search: as loose as possible while (almost) nothing outside the marker boxes matches */
  function tune(hsv, w, h, dom, insideBoxes, keepOut, opts) {
    var hTols = [8, 11, 14, 18, 22, 28], sF = [0.35, 0.5, 0.65, 0.8], vF = [0.25, 0.4, 0.55, 0.7];
    var maxTol = num(opts && opts.maxTol, 40);
    var N = w * h, hd = new Float32Array(N), S = new Float32Array(N), V = new Float32Array(N), where = new Uint8Array(N);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var p = y * w + x, q = p * 3;
      hd[p] = hueDist(hsv[q], dom.h); S[p] = hsv[q + 1]; V[p] = hsv[q + 2];
      var wh = 0;
      for (var i = 0; i < insideBoxes.length; i++) if (inBox(insideBoxes[i], x, y)) wh = 1;
      if (!wh) { wh = 2; for (var k = 0; k < keepOut.length; k++) if (inBox(keepOut[k], x, y)) wh = 0; }
      where[p] = wh;
    }
    var best = null;
    for (var a = 0; a < hTols.length; a++) {
      if (hTols[a] > maxTol) continue;
      for (var b = 0; b < sF.length; b++) for (var c = 0; c < vF.length; c++) {
        var m = { h: dom.h, hTol: hTols[a], sMin: clamp(dom.s * sF[b], 0.16, 0.75), vMin: clamp(dom.v * vF[c], 0.07, 0.7) };
        // red / orange / yellow markers: stay clear of skin (hands, arms, face are s ~0.2-0.5)
        if (hueDist(dom.h, 22) < m.hTol + 30) m.sMin = Math.max(m.sMin, Math.min(0.5, dom.s * 0.72));
        // background is judged with HEADROOM (looser thresholds): a wall that nearly matches now will match when the
        // camera's exposure or the room light changes a little
        var inN = 0, outN = 0, rh = m.hTol + 6, rs = m.sMin * 0.8, rv = m.vMin * 0.75;
        for (var j = 0; j < N; j++) {
          var wj = where[j];
          if (!wj) continue;
          if (wj === 1) { if (hd[j] <= m.hTol && S[j] >= m.sMin && V[j] >= m.vMin) inN++; }
          else if (hd[j] <= rh && S[j] >= rs && V[j] >= rv) outN++;
        }
        // loose thresholds survive lighting changes: a small bonus for looseness, a big penalty for background hits
        var loose = m.hTol / 28 + (1 - m.sMin) + (1 - m.vMin);
        var score = inN - 10 * outN + inN * 0.04 * loose;
        if (!best || score > best.score) best = { model: m, score: score, inN: inN, outN: outN };
      }
    }
    return best;
  }
  function hsvImage(rgba, w, h) {
    var N = w * h, out = new Float32Array(N * 3);
    for (var p = 0; p < N; p++) { var hsv = rgbToHsv(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]); out[p * 3] = hsv[0]; out[p * 3 + 1] = hsv[1]; out[p * 3 + 2] = hsv[2]; }
    return out;
  }
  /**
   * Calibrate from one frame (mirrored view). boxes: two boxes (style 'pair': left marker, right marker) or one box
   * (style 'bar'). -> {ok, style, mode:'same'|'two'|'one', models, expect:{area, sep, len, w, h}, warnings, reason?}
   */
  function calibrate(rgba, w, h, boxes, opts) {
    opts = opts || {};
    boxes = boxes || defaultBoxes(opts.style || 'pair');
    var style = boxes.length >= 2 ? 'pair' : 'bar';
    var hsv = hsvImage(rgba, w, h);
    var B = boxes.map(function (b) { return boxPx(b, w, h); });
    var keep = B.map(function (b) { return grow(b, 0.6, w, h); });
    var doms = B.map(function (b) { return dominant(hsv, w, h, b); });
    var warnings = [];
    if (doms.some(function (d) { return !d || d.frac < 0.03; })) return { ok: false, reason: 'nothing', warnings: warnings };
    // a greyish / pastel "colour" is usually the background behind an empty box, and tracks badly anyway
    if (doms.some(function (d) { return d.s < 0.38; })) return { ok: false, reason: 'dull', warnings: warnings };
    // bare hands / arms / face: skin tones are never a usable marker
    if (doms.some(function (d) { return skinLike(d.h, d.s) && d.s < 0.5; })) return { ok: false, reason: 'skin', warnings: warnings };
    var mode = style === 'bar' ? 'one' : 'same', models;
    if (style === 'pair' && hueDist(doms[0].h, doms[1].h) > 30) {
      mode = 'two';
      var sepH = hueDist(doms[0].h, doms[1].h), maxTol = Math.max(8, sepH / 2 - 3);
      models = [0, 1].map(function (i) {
        var t = tune(hsv, w, h, doms[i], [B[i]], keep, { maxTol: maxTol });
        return t && t.inN > 0 ? t.model : null;
      });
    } else {
      var d = doms[0];
      if (style === 'pair') {         // merge both boxes' statistics into one colour
        var n0 = doms[0].n, n1 = doms[1].n, cs = Math.cos(doms[0].h * DEG) * n0 + Math.cos(doms[1].h * DEG) * n1, sn = Math.sin(doms[0].h * DEG) * n0 + Math.sin(doms[1].h * DEG) * n1;
        var hh = Math.atan2(sn, cs) / DEG; if (hh < 0) hh += 360;
        d = { h: hh, s: (doms[0].s * n0 + doms[1].s * n1) / (n0 + n1), v: (doms[0].v * n0 + doms[1].v * n1) / (n0 + n1), n: n0 + n1 };
      }
      var t1 = tune(hsv, w, h, d, B, keep, {});
      models = [t1 && t1.inN > 0 ? t1.model : null];
    }
    if (models.some(function (m) { return !m; })) return { ok: false, reason: 'nothing', warnings: warnings };
    // what the tracker sees with these models
    var lut = buildLut(models);
    var cl = segment(rgba, w, h, lut, null, { minN: 3 });
    var found = B.map(function (b, i) {
      var want = mode === 'two' ? 1 << i : 1;
      var g = grow(b, 0.3, w, h);
      var inside = cl.filter(function (c) { return c.cls & want && inBox(g, c.x, c.y); });
      return inside.length ? (style === 'bar' ? unite(inside) : inside[0]) : null;
    });
    if (found.some(function (f) { return !f; })) return { ok: false, reason: 'nothing', warnings: warnings };
    // reference look of each marker (mean colour of its blob): tracking keeps thresholds relative to it
    found.forEach(function (f, i) {
      var mi = mode === 'two' ? i : 0, hs = rgbToHsv(f.r, f.g, f.b);
      if (!models[mi].ref || mode !== 'two') models[mi].ref = models[mi].ref ? { s: (models[mi].ref.s + hs[1]) / 2, v: (models[mi].ref.v + hs[2]) / 2 } : { s: hs[1], v: hs[2] };
    });
    var expect = { w: w, h: h };
    if (style === 'pair') {
      expect.area = (found[0].n + found[1].n) / 2;
      expect.sep = Math.hypot(found[1].x - found[0].x, found[1].y - found[0].y);
      if (expect.sep < Math.max(found[0].x1 - found[0].x0, found[1].x1 - found[1].x0)) return { ok: false, reason: 'merged', warnings: warnings };
      expect.angle = Math.atan2(found[1].y - found[0].y, found[1].x - found[0].x) / DEG;
    } else {
      var ax = axisAngle(found[0]);
      expect.area = found[0].n; expect.len = ax.len; expect.angle = ax.angle;
      if (ax.elong < 2) warnings.push('round');
    }
    // background clutter of the same colour (outside the boxes)
    var stray = cl.filter(function (c) { return !keep.some(function (g) { return inBox(g, c.x, c.y); }) && c.n >= expect.area * 0.2; });
    if (stray.length) warnings.push('clutter');
    doms.forEach(function (dd) { if (skinLike(dd.h, dd.s)) warnings.indexOf('skin') < 0 && warnings.push('skin'); if (dd.s < 0.5) warnings.indexOf('dull') < 0 && warnings.push('dull'); });
    if (expect.area < 12) warnings.push('small');
    return {
      ok: true, style: style, mode: mode, models: models, expect: expect, warnings: warnings,
      colors: doms.map(function (dd) { return { h: Math.round(dd.h), s: +dd.s.toFixed(2), v: +dd.v.toFixed(2) }; })
    };
  }
  function defaultBoxes(style) {
    if (style === 'bar') return [{ x: 0.22, y: 0.42, w: 0.56, h: 0.2 }];
    return [{ x: 0.17, y: 0.4, w: 0.18, h: 0.26 }, { x: 0.65, y: 0.4, w: 0.18, h: 0.26 }];
  }

  /* ================================================================ tracking */
  function createTracker(cal, dims) {
    var w = dims.w, h = dims.h;
    var sx = w / (cal.expect.w || w);                       // calibration made at another resolution
    var models = cal.models.map(function (m) { return Object.assign({}, m); });
    var base = cal.models.map(function (m) { return Object.assign({}, m); });
    var lut = buildLut(models), work = makeWork(w * h);
    var style = cal.style, mode = cal.mode;
    var expArea = cal.expect.area * sx * sx, expSep = (cal.expect.sep || 0) * sx, expLen = (cal.expect.len || 0) * sx;
    var tr = null;                                          // {a:{x,y,vx,vy}, b:{...}, c (centre), t}
    var lutT = 0, lutDirty = false;
    var T = {
      lut: lut, models: models, style: style, mode: mode, w: w, h: h, last: null, clusters: null,
      reset: function () { tr = null; },
      process: function (rgba, t) {
        t = num(t, nowMs());
        var minN = Math.max(3, expArea * 0.12);
        var cl = segment(rgba, w, h, lut, work, { minN: minN, maxMerge: style === 'pair' ? expArea * 1.6 : Infinity });
        T.clusters = cl;
        if (tr && t - tr.t > 1500) tr = null;             // long loss: acquire afresh
        var dt = tr ? clamp((t - tr.t) / 1000, 0, 0.5) : 0, age = tr ? t - tr.t : Infinity;
        var gate = w * 0.22 + (age < 400 ? 0 : w * 0.3);
        var meas = style === 'bar' ? trackBar(cl, dt, gate) : trackPair(cl, dt, gate);
        meas.t = t;
        if (meas.ok) adapt(meas.used, t);
        T.last = meas;
        return meas;
      }
    };
    function sizeOk(c) { return c.n >= expArea * 0.15 && c.n <= expArea * 6; }
    function predict(p, dt) { return { x: p.x + (p.vx || 0) * dt, y: p.y + (p.vy || 0) * dt }; }
    function cost(c, p, gate) { var d = Math.hypot(c.x - p.x, c.y - p.y); if (d > gate) return Infinity; return d / gate + 0.5 * Math.abs(Math.log(c.n / expArea)); }
    function upd(old, c, dt) {
      if (!old || !(dt > 0)) return { x: c.x, y: c.y, vx: 0, vy: 0 };
      var vx = (c.x - old.x) / dt, vy = (c.y - old.y) / dt;
      return { x: c.x, y: c.y, vx: lerp(old.vx || 0, vx, 0.5), vy: lerp(old.vy || 0, vy, 0.5) };
    }
    function trackPair(cl, dt, gate) {
      var A = null, B = null, ca, cb, i, j;
      var cand0 = cl.filter(function (c) { return (c.cls & 1) && sizeOk(c); });
      var cand1 = mode === 'two' ? cl.filter(function (c) { return (c.cls & 2) && sizeOk(c); }) : cand0;
      if (tr) {
        var pa = predict(tr.a, dt), pb = predict(tr.b, dt);
        if (mode === 'two') {
          A = best(cand0, pa, gate); B = best(cand1, pb, gate);
        } else {
          var bestC = Infinity;
          for (i = 0; i < cand0.length; i++) {
            ca = cost(cand0[i], pa, gate);
            for (j = 0; j < cand0.length; j++) {
              if (i === j) continue;
              cb = cost(cand0[j], pb, gate);
              var sepPen = expSep > 0 ? 0.6 * Math.abs(Math.log(Math.max(1, Math.hypot(cand0[i].x - cand0[j].x, cand0[i].y - cand0[j].y)) / expSep)) : 0;
              if (ca + cb + sepPen < bestC) { bestC = ca + cb + sepPen; A = cand0[i]; B = cand0[j]; }
            }
          }
          if (!A) {                                        // one marker only (other hidden, or both merged)
            var oa = best(cand0, pa, gate), ob = best(cand0, pb, gate);
            if (oa && ob && oa === ob) { if (cost(oa, pa, gate) <= cost(ob, pb, gate)) ob = null; else oa = null; }
            A = oa; B = ob;
          }
        }
      } else {
        // acquisition: the best-matching pair by size and spacing (identity: left = a)
        if (mode === 'two') { A = cand0[0] || null; B = cand1[0] || null; }
        else {
          var top = cand0.slice(0, 6), bs = Infinity;
          for (i = 0; i < top.length; i++) for (j = i + 1; j < top.length; j++) {
            var sep = Math.hypot(top[i].x - top[j].x, top[i].y - top[j].y);
            var s = Math.abs(Math.log(top[i].n / expArea)) + Math.abs(Math.log(top[j].n / expArea)) + (expSep ? 1.5 * Math.abs(Math.log(Math.max(1, sep) / expSep)) : 0);
            if (s < bs) { bs = s; A = top[i]; B = top[j]; }
          }
          if (A && B && A.x > B.x) { var tmp = A; A = B; B = tmp; }
        }
        if (!(A && B)) return { ok: false, conf: 0, pts: [], reason: 'acquire' };
      }
      var period = mode === 'two' ? 360 : 180;
      if (A && B) {
        var sepN = Math.hypot(B.x - A.x, B.y - A.y);
        if (expSep > 0 && (sepN < expSep * 0.35 || sepN > expSep * 2.6)) {
          return { ok: false, conf: 0, pts: [A, B], reason: 'spacing' };
        }
        var ang = Math.atan2(B.y - A.y, B.x - A.x) / DEG;
        var ctr = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
        tr = { a: upd(tr && tr.a, A, dt), b: upd(tr && tr.b, B, dt), c: tr && tr.c ? { x: lerp(tr.c.x, ctr.x, 0.25), y: lerp(tr.c.y, ctr.y, 0.25) } : ctr, r: tr && tr.r ? lerp(tr.r, sepN / 2, 0.2) : sepN / 2, t: tsNow };
        expSep = lerp(expSep || sepN, sepN, 0.02);
        var sizeC = clamp(1 - 0.5 * Math.abs(Math.log((A.n + B.n) / 2 / expArea)), 0.2, 1);
        return { ok: true, angle: ang, period: period, conf: sizeC, pts: [A, B], used: [A, B], centre: ctr, partial: false };
      }
      // one marker visible: angle of that marker around the tracked wheel centre
      var one = A || B;
      if (one && tr && tr.c && t_age() < 600) {
        var vx = one.x - tr.c.x, vy = one.y - tr.c.y, rr = Math.hypot(vx, vy);
        if (rr > tr.r * 0.55 && rr < tr.r * 1.6) {
          var a1 = Math.atan2(vy, vx) / DEG;
          var angle1 = A ? a1 + 180 : a1;                  // the centre -> a vector points opposite to the a -> b line
          if (A) tr.a = upd(tr.a, A, dt); else tr.b = upd(tr.b, B, dt);
          tr.t = tsNow;
          return { ok: true, angle: wrapP(angle1, 360), period: period, conf: 0.45, pts: [one], used: [one], centre: tr.c, partial: true };
        }
      }
      return { ok: false, conf: 0, pts: one ? [one] : [], reason: 'one' };
    }
    function t_age() { return tr ? tsNow - tr.t : Infinity; }
    function best(list, p, gate) { var bc = Infinity, b = null; list.forEach(function (c) { var k = cost(c, p, gate); if (k < bc) { bc = k; b = c; } }); return b; }
    function trackBar(cl, dt, gate) {
      var cand = cl.filter(function (c) { return c.cls & 1 && c.n >= expArea * 0.06; });
      var ctr;
      if (tr) ctr = predict(tr.a, dt);
      else {
        var big = cand.filter(function (c) { return c.n >= expArea * 0.25; })[0];
        if (!big) return { ok: false, conf: 0, pts: [], reason: 'acquire' };
        ctr = { x: big.x, y: big.y };
      }
      var R = Math.max(expLen * 0.75, w * 0.08) + (tr ? 0 : expLen * 0.3);
      var near = cand.filter(function (c) { return Math.hypot(c.x - ctr.x, c.y - ctr.y) <= R + Math.max(c.x1 - c.x0, c.y1 - c.y0) * 0.5; });
      if (!near.length) { if (t_age() > 600) tr = null; return { ok: false, conf: 0, pts: [], reason: 'lost' }; }
      var U = unite(near);
      if (U.n < expArea * 0.3 || U.n > expArea * 4) return { ok: false, conf: 0, pts: [U], reason: 'size' };
      var ax = axisAngle(U);
      if (ax.elong < 1.6) return { ok: false, conf: 0, pts: [U], reason: 'round' };
      tr = { a: upd(tr && tr.a, U, dt), t: tsNow };
      expLen = lerp(expLen || ax.len, ax.len, 0.02);
      return { ok: true, angle: ax.angle, period: 180, conf: clamp((ax.elong - 1.6) / 2.4, 0.2, 1), pts: [U], used: [U], centre: { x: U.x, y: U.y }, len: ax.len, partial: false };
    }
    /* slow drift of the colour model towards what the marker looks like now (lighting changes), bounded around the
       calibration; expected size follows the player moving closer / farther */
    function adapt(used, t) {
      var area = 0;
      used.forEach(function (c) { area += c.n; });
      expArea = lerp(expArea, area / used.length, 0.03);
      used.forEach(function (c) {
        var i = mode === 'two' ? (c.cls & 2 ? 1 : 0) : 0, m = models[i], b0 = base[i];
        var hsv = rgbToHsv(c.r, c.g, c.b);
        var nh = m.h + wrapP(hsv[0] - m.h, 360) * 0.03;
        if (hueDist(nh, b0.h) <= b0.hTol * 0.5) m.h = (nh + 360) % 360;
        // keep the calibrated thresholds RELATIVE to how bright / saturated the marker looks now
        var ref = b0.ref || { s: hsv[1], v: hsv[2] };
        var kv = clamp(hsv[2] / Math.max(0.05, ref.v), 0.4, 1.3), ks = clamp(hsv[1] / Math.max(0.05, ref.s), 0.6, 1.2);
        m.vMin = lerp(m.vMin, clamp(b0.vMin * kv, 0.05, 0.85), 0.05);
        m.sMin = lerp(m.sMin, clamp(b0.sMin * ks, 0.14, 0.85), 0.05);
        if (hueDist(m.h, m._lh == null ? b0.h : m._lh) > 2 || Math.abs(m.vMin - (m._lv == null ? b0.vMin : m._lv)) > 0.02 || Math.abs(m.sMin - (m._ls == null ? b0.sMin : m._ls)) > 0.02) lutDirty = true;
      });
      if (lutDirty && t - lutT > 700) {
        lutT = t; lutDirty = false;
        models.forEach(function (m) { m._lh = m.h; m._lv = m.vMin; m._ls = m.sMin; });
        buildLut(models, lut);
      }
    }
    var tsNow = 0;
    var proc = T.process;
    T.process = function (rgba, t) { tsNow = num(t, nowMs()); return proc(rgba, tsNow); };
    return T;
  }

  /* ================================================================ angle -> steer */
  function mapAngle(angle, o) {
    o = o || {};
    var dz = clamp(num(o.deadzone, 2), 0, 30), max = Math.max(dz + 1, num(o.maxAngle, 90));
    var a = Math.abs(num(angle, 0));
    if (a <= dz) return 0;
    return (angle < 0 ? -1 : 1) * clamp((a - dz) / (max - dz), 0, 1);
  }
  function oneEuro(o) {
    o = o || {};
    var minCutoff = num(o.minCutoff, 1.5), beta = num(o.beta, 0.02), dCutoff = num(o.dCutoff, 1.0);
    var xPrev = null, dxPrev = 0, tPrev = null;
    function alpha(cut, dt) { var tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
    var F = {
      filter: function (x, t) {
        if (xPrev === null) { xPrev = x; tPrev = t; dxPrev = 0; return x; }
        var dt = (t - tPrev) / 1000;
        if (!(dt > 0)) dt = 1 / 60;
        if (dt > 0.5) { xPrev = x; tPrev = t; dxPrev = 0; return x; }
        var dx = (x - xPrev) / dt, edx = dxPrev + alpha(dCutoff, dt) * (dx - dxPrev);
        var cut = minCutoff + beta * Math.abs(edx);
        var al = alpha(cut, dt), ex = xPrev + al * (x - xPrev);
        xPrev = ex; dxPrev = edx; tPrev = t;
        F.lag = (1 - al) / al * dt;                 // steady-ramp lag of this step (s): what a lookahead may cancel
        return ex;
      },
      lag: 0,
      reset: function () { xPrev = null; tPrev = null; dxPrev = 0; F.lag = 0; },
      set: function (p) { if (p) { minCutoff = num(p.minCutoff, minCutoff); beta = num(p.beta, beta); dCutoff = num(p.dCutoff, dCutoff); } }
    };
    return F;
  }
  /** smoothing 0 (raw) .. 1 (very smooth) -> 1-euro min cutoff (Hz) */
  function cutoffFor(smoothing) { var s = clamp(num(smoothing, 0.3), 0, 1); return 12 * Math.pow(0.06, s); }   // 12 Hz .. 0.72 Hz
  var EURO_BETA = 0.06, EURO_DCUT = 2;

  function createSteer(prefs) {
    var P = Object.assign({}, DEFAULT_PREFS, prefs || {});
    var f = oneEuro({ minCutoff: cutoffFor(P.smoothing), beta: EURO_BETA, dCutoff: EURO_DCUT });
    var holdMs = num(P.holdMs, 250), centreMs = num(P.centreMs, 250), relockMs = num(P.relockMs, 1000), easeMs = num(P.easeMs, 120);
    function ease(k) { return k * k * (3 - 2 * k); }
    var S = {
      steer: 0, angle: 0, raw: null, centre: 0, lastOk: -1e9, conf: 0, unwrapped: null, frames: 0, blend: null,
      update: function (m, t) {
        t = num(t, nowMs());
        S.frames++;
        if (!m || !m.ok) { S.conf = 0; return S.read(t).steer; }
        var p = m.period || 180, u;
        // re-acquired after a loss (the hold expired, or the solver identified the hands afresh): what the game sees
        // eases from the held / centring value to the new reading over easeMs, never a snap
        // (also after a few dropped frames: more than ~2.5 typical camera intervals without a reading)
        var was = S.read(t), relock = S.unwrapped === null || t - S.lastOk > relockMs || !!m.fresh, gap = t - S.lastOk;
        if (gap > 0 && gap < 200) S.dtAvg = S.dtAvg ? lerp(S.dtAvg, gap, 0.1) : gap;
        var dropped = gap > Math.max(90, 2.5 * (S.dtAvg || 33));
        if (S.everOk && (was.lost || m.fresh || S._seeded || dropped || m.snap)) S.blend = { steer: was.steer, angle: was.angleShown, t0: t };
        S.everOk = true; S._seeded = false;
        if (relock) { u = S.centre + wrapP(m.angle - S.centre, p); f.reset(); S._fa = null; S._t = null; }
        else u = S.unwrapped + wrapP(m.angle - S.unwrapped, p);
        // a whole extra turn folds back (never stuck at full lock)
        var rel = u - S.centre;
        if (Math.abs(rel) > Math.max(P.maxAngle + 90, 200)) { var k = 360 * Math.round(rel / 360); if (p === 180) k = 180 * Math.round(rel / 180); u -= k; f.reset(); }
        S.unwrapped = u; S.raw = u - S.centre; S.lastOk = t; S.conf = m.conf;
        if (S._wantCentre) { S.centre = u; S._wantCentre = false; f.reset(); S.raw = 0; }
        var fa = P.smoothing > 0 ? f.filter(u - S.centre, t) : u - S.centre;     // 0 = raw, no filter at all
        // lookahead: about half a camera frame of the current turning speed, cancelling most of the filter's lag;
        // the speed estimate reacts within ~2 frames and the lead is capped, so stopping does not overshoot much
        var dtf = S._t != null ? (t - S._t) / 1000 : 0;
        if (dtf > 0 && dtf < 0.2 && S._fa != null) {
          var v = (fa - S._fa) / dtf;
          S.vel = S.vel == null ? v : lerp(S.vel, v, 0.5);
          if (P.lookahead !== false && P.smoothing > 0) { S.lead = clamp(S.vel * Math.min(f.lag || 0, dtf * 0.5), -4, 4); fa += S.lead; }
        } else { S.vel = 0; S.lead = 0; }
        S._t = t; S._fa = fa - (S.lead || 0);
        S.target = fa; S.steerTarget = mapAngle(fa, P);
        var bk = blendK(t);
        S.angle = bk < 1 ? lerp(S.blend.angle, fa, bk) : fa;
        S.steer = bk < 1 ? lerp(S.blend.steer, S.steerTarget, bk) : S.steerTarget;
        return S.steer;
      },
      /** steering for time t with the lost-tracking policy applied: hold, then ease back to centre */
      read: function (t) {
        t = num(t, nowMs());
        var age = t - S.lastOk;
        if (age <= holdMs) {
          var bk = blendK(t), st = bk < 1 ? lerp(S.blend.steer, S.steerTarget, bk) : S.steerTarget != null ? S.steerTarget : S.steer;
          return { steer: st, held: age > 60, lost: false, angleShown: bk < 1 ? lerp(S.blend.angle, S.target, bk) : S.angle };
        }
        var k = clamp((age - holdMs) / centreMs, 0, 1), base = S.steer;
        return { steer: base * (1 - k), held: true, lost: true, angleShown: S.angle * (1 - k) };
      },
      recentre: function () { if (S.unwrapped !== null) { S.centre = S.unwrapped; S.raw = 0; S.angle = 0; S.steer = 0; S.target = 0; S.steerTarget = 0; S.blend = null; f.reset(); S._fa = null; S._t = null; } else S._wantCentre = true; },
      /** a new steer stage taking over from an old one (re-centre): start from what the game saw, ease to the new reading */
      seed: function (steer, angle, t) { S.steer = S.steerTarget = num(steer, 0); S.angle = S.target = num(angle, 0); S.lastOk = num(t, nowMs()); S.everOk = true; S._seeded = true; },
      /** forget the tracking state (camera stopped / restarted): the next reading relocks and eases in */
      reset: function () { S.unwrapped = null; S.lastOk = -1e9; S.everOk = S.everOk || S.frames > 0; S.blend = null; S.steer = 0; S.angle = 0; S.target = 0; S.steerTarget = 0; S._fa = null; S._t = null; f.reset(); },
      setPrefs: function (p) { P = Object.assign(P, p || {}); f.set({ minCutoff: cutoffFor(P.smoothing) }); },
      prefs: function () { return P; }
    };
    function blendK(t) {
      if (!S.blend) return 1;
      var k = easeMs > 0 ? clamp((t - S.blend.t0) / easeMs, 0, 1) : 1;
      if (k >= 1) { if (t >= S.lastOk) S.blend = null; return 1; }
      return ease(k);
    }
    return S;
  }

  /* ================================================================ prefs */
  function normPrefs(p) {
    p = p && typeof p === 'object' ? p : {};
    var hc = p.handCal && typeof p.handCal === 'object' ? p.handCal : null;
    return {
      method: p.method === 'marker' ? 'marker' : 'hands',
      handStyle: HAND_STYLES.indexOf(p.handStyle) >= 0 ? p.handStyle : 'two',
      wheelSize: clamp(num(+p.wheelSize, 1), 0.5, 2),
      maxAngle: clamp(num(+p.maxAngle, DEFAULT_PREFS.maxAngle), 20, 180),
      deadzone: clamp(num(+p.deadzone, DEFAULT_PREFS.deadzone), 0, 15),
      smoothing: clamp(num(+p.smoothing, DEFAULT_PREFS.smoothing), 0, 1),
      lookahead: p.lookahead !== false,
      style: p.style === 'bar' ? 'bar' : 'pair',
      deviceId: typeof p.deviceId === 'string' ? p.deviceId.slice(0, 200) : '',
      pip: p.pip !== false,
      // pedalsV 2: "Fist = go, open hand = brake" is the default; a player still on the OLD default (grip + pull back
      // to brake, or never chosen) moves to it once; a mode chosen after that (even 'grip') is kept
      pedals: p.pedalsV !== 2 && (p.pedals === 'grip' || p.pedals == null) ? 'fist' : PEDAL_MODES.indexOf(p.pedals) >= 0 ? p.pedals : 'fist',
      pedalsV: 2,
      pullBrake: !!p.pullBrake,
      easyAssist: p.easyAssist !== false,
      gestureNitro: !!p.gestureNitro,
      gestureHandbrake: !!p.gestureHandbrake,
      gestureItem: !!p.gestureItem,
      cpu: !!p.cpu,
      handCal: hc && (isFinite(hc.two) || normTop(hc.top)) ? { two: isFinite(hc.two) ? +hc.two : 0, labels: hc.labels && typeof hc.labels === 'object' ? hc.labels : null, top: normTop(hc.top) } : null,
      pedalCal: normPedalCal(p.pedalCal),
      cal: p.cal && p.cal.ok && Array.isArray(p.cal.models) ? p.cal : null
    };
  }
  /** the one-hand top-grip calibration: top point (x, y: 0..1 of the frame), palm length L and scale q (/ frame width),
      which hand, its roll there */
  function normTop(c) {
    if (!c || typeof c !== 'object') return null;
    var ok = [c.x, c.y, c.L, c.q].every(function (v) { return typeof v === 'number' && isFinite(v); }) && c.L > 0 && c.q > 0;
    if (!ok || !c.roll0 || !isFinite(c.roll0.a) || !isFinite(c.roll0.b)) return null;
    return { x: clamp(c.x, -0.5, 1.5), y: clamp(c.y, -0.5, 1.5), L: c.L, q: c.q, qv: c.qv === 2 ? 2 : undefined, side: c.side === 'L' ? 'L' : c.side === 'R' ? 'R' : null, roll0: { a: +c.roll0.a, b: +c.roll0.b } };
  }
  function normPedalCal(c) {
    if (!c || typeof c !== 'object') return null;
    var o = { open: clamp(num(+c.open, 0.3), 0, 0.8), grip: clamp(num(+c.grip, 0.92), 0.2, 1), scale: {}, world: c.world == null ? null : !!c.world, v: 2,
      fist: c.fist != null && isFinite(+c.fist) ? clamp(+c.fist, 0, 0.5) : null, ext: c.ext != null && isFinite(+c.ext) ? clamp(+c.ext, 0.5, 1) : null };
    if (o.grip < o.open + 0.15) o.grip = Math.min(1, o.open + 0.15);
    // v 2: the pull-back size is the 3D (rotation-invariant) pullScale; an older 2D neutral is not comparable: dropped
    if (c.v === 2 && c.scale && typeof c.scale === 'object') ['a', 'b'].forEach(function (k) { var v = +c.scale[k]; if (isFinite(v) && v > 0) o.scale[k] = v; });
    return o;
  }
  /* ================================================================ re-centre countdown (pure)
     Every re-centre (buttons, Space / C, pause menu, the PiP chip, the first auto-centre) counts 3-2-1 first and captures
     the neutral pose at the end; the old calibration keeps steering until then. The same call again (or Esc) cancels.
       cd = createCountdown()   cd.start(t, phases, kind) / cd.toggle(...) (running: cancels -> {state:'cancelled'})
       cd.cancel()   cd.step(t) -> null (idle) | {state:'count', phase, left (whole seconds, 3 2 1), frac 0..1, kind}
                                 | {state:'capture', phase, next, kind} (once, when a phase ends; the next one starts)
       phases: [{id:'neutral', ms:3000}] (+ {id:'grip', ms:2000} for a full calibration) */
  function createCountdown() {
    var C = {
      phase: null, phases: [], i: 0, t0: 0, endsAt: 0, kind: null,
      active: function () { return !!C.phase; },
      start: function (t, phases, kind) {
        C.phases = phases && phases.length ? phases : [{ id: 'neutral', ms: COUNT_MS }];
        C.i = 0; C.kind = kind || 'centre'; begin(t);
        return C.step(t);
      },
      toggle: function (t, phases, kind) { if (C.phase) { C.cancel(); return { state: 'cancelled', kind: C.kind }; } return C.start(t, phases, kind); },
      cancel: function () { var was = !!C.phase; C.phase = null; return was; },
      step: function (t) {
        if (!C.phase) return null;
        if (t < C.endsAt) {
          var ms = C.endsAt - C.t0;
          return { state: 'count', phase: C.phase, left: Math.max(1, Math.ceil((C.endsAt - t) / 1000 - 1e-9)), frac: clamp((t - C.t0) / ms, 0, 1), kind: C.kind, endsAt: C.endsAt };
        }
        var fired = C.phase;
        C.i++;
        if (C.i < C.phases.length) begin(t); else C.phase = null;
        return { state: 'capture', phase: fired, next: C.phase, kind: C.kind };
      }
    };
    function begin(t) { var p = C.phases[C.i]; C.phase = p.id; C.t0 = t; C.endsAt = t + num(p.ms, COUNT_MS); }
    return C;
  }
  function loadPrefs() {
    try { var s = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY); if (s) return normPrefs(JSON.parse(s)); } catch (e) { /* ignore */ }
    return normPrefs(DEFAULT_PREFS);
  }
  function savePrefs(p) { try { if (globalThis.localStorage) globalThis.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }

  /* ================================================================ browser: camera + hub source */
  var listeners = {};
  function on(t, fn) { (listeners[t] = listeners[t] || []).push(fn); return function () { var l = listeners[t]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }; }
  function emit(t, a) { (listeners[t] || []).slice().forEach(function (fn) { try { fn(a); } catch (e) { if (typeof console !== 'undefined') console.error('[camwheel]', e); } }); }
  function HANDS() { return CB.input.camhands; }

  var api = {
    rgbToHsv: rgbToHsv, hueDist: hueDist, buildLut: buildLut, segment: segment, unite: unite, axisAngle: axisAngle,
    calibrate: calibrate, defaultBoxes: defaultBoxes, createTracker: createTracker, createSteer: createSteer,
    mapAngle: mapAngle, oneEuro: oneEuro, cutoffFor: cutoffFor, skinLike: skinLike, wrapP: wrapP,
    normPrefs: normPrefs, normTop: normTop, HAND_STYLES: HAND_STYLES, DEFAULT_PREFS: DEFAULT_PREFS, PREF_KEY: PREF_KEY, createCountdown: createCountdown, COUNT_MS: COUNT_MS, GRIP_MS: GRIP_MS, PEDAL_MODES: PEDAL_MODES,
    prefs: loadPrefs(), on: on
  };
  api.setPrefs = function (p) {
    var old = api.prefs;
    api.prefs = normPrefs(Object.assign({}, api.prefs, p || {}));
    savePrefs(api.prefs);
    if (B.steer) B.steer.setPrefs(api.prefs);
    if (B.solver) {
      B.solver.wheelSize = api.prefs.wheelSize;
      if (B.solver.style !== api.prefs.handStyle) { B.solver.style = api.prefs.handStyle; B.solver.reset(); }   // identify afresh
    }
    if (old.method !== api.prefs.method && B.stream) { B.tracker = null; B.solver = null; B.steer = null; ensureTracker(); if (api.prefs.method === 'hands') loadModel(); }
    emit('prefs', api.prefs);
    return api.prefs;
  };
  function hands() { return api.prefs.method === 'hands'; }

  var B = {
    stream: null, video: null, canvas: null, ctx: null, w: 0, h: 0, state: 'off', reason: null,
    tracker: null, solver: null, steer: null, cal: null, enabled: false, unreg: null,
    vfcId: 0, rafId: 0, lastVT: -1, frameN: 0, fpsT0: 0, fpsN: 0, fps: 0, procMs: 0, procs: [], infer: [],
    lats: [], pageLats: [], pend: null, lastRgba: null, camW: 0, camH: 0, camFps: 0, startTok: 0,
    gest: {}, gestOut: { throttle: null, nitro: false }, nitroOn: false, autoCal: null, steady: [], inflight: {}, resLat: [],
    pedals: null, pedOut: null, cd: createCountdown(), cdTimer: 0, lastHandsT: -1e9
  };
  function setState(s, reason) { if (B.state !== s || B.reason !== (reason || null)) { B.state = s; B.reason = reason || null; emit('state', { state: s, reason: B.reason }); } }
  function secure() {
    if (typeof window === 'undefined') return false;
    if (window.location && window.location.protocol === 'file:') return false;   // the hand model cannot load from a file either
    if (window.isSecureContext) return true;
    var hn = window.location && window.location.hostname;
    return hn === 'localhost' || hn === '127.0.0.1' || hn === '[::1]';
  }
  function supported() { return typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
  api.secure = secure; api.supported = supported;
  api.listCameras = function () {
    if (!supported() || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices().then(function (ds) {
      return ds.filter(function (d) { return d.kind === 'videoinput'; }).map(function (d, i) { return { deviceId: d.deviceId, label: d.label || 'Camera ' + (i + 1) }; });
    }, function () { return []; });
  };
  function procDims(vw, vh) {
    var target = num(api.procPixels, 19200), asp = vw > 0 && vh > 0 ? vw / vh : 4 / 3;
    var w = Math.round(Math.sqrt(target * asp)), h = Math.round(w / asp);
    return { w: Math.max(32, w), h: Math.max(24, h) };
  }
  /* ---------------- hand model (lazy: vendor/mediapipe/ is fetched only now) */
  B.model = { state: 'idle', delegate: null, reason: null };
  function loadModel() {
    var H = HANDS();
    if (!H) { B.model = { state: 'error', reason: 'missing' }; return Promise.resolve({ ok: false, reason: 'missing' }); }
    if (B.model.state === 'ready') return Promise.resolve({ ok: true, delegate: B.model.delegate });
    if (B.model.promise) return B.model.promise;
    B.model.state = 'loading'; emit('state', { state: B.state, reason: B.reason });
    B.model.promise = H.load({ preferGpu: !api.prefs.cpu }).then(function (r) {
      B.model.promise = null;
      if (r.ok) { B.model.state = 'ready'; B.model.delegate = r.delegate; warmUp(); }
      else { B.model.state = 'error'; B.model.reason = r.reason; B.model.error = r.error; }
      emit('state', { state: B.state, reason: B.reason });
      return r;
    });
    return B.model.promise;
  }
  /** the first inference compiles the GPU programs (~seconds): do it on a blank frame, not on the player's first turn */
  function warmUp() {
    try {
      var c = document.createElement('canvas'); c.width = 256; c.height = 192;
      var g = c.getContext('2d'); g.fillStyle = '#777'; g.fillRect(0, 0, 256, 192);
      HANDS().detect(c, nowMs());
    } catch (e) { /* ignore */ }
  }
  api.model = function () { return { state: B.model.state, delegate: B.model.delegate, reason: B.model.reason, error: B.model.error }; };
  api.loadModel = loadModel;

  api.start = function (opts) {
    opts = opts || {};
    if (typeof document === 'undefined') return Promise.resolve({ ok: false, reason: 'unsupported' });
    if (!secure()) { setState('error', window.location.protocol === 'file:' ? 'file' : 'insecure'); return Promise.resolve({ ok: false, reason: B.reason }); }
    if (!supported()) { setState('error', 'unsupported'); return Promise.resolve({ ok: false, reason: 'unsupported' }); }
    if (hands()) loadModel();                                 // in parallel with the camera permission prompt
    var devId = opts.deviceId != null ? opts.deviceId : api.prefs.deviceId;
    if (B.stream && (!opts.deviceId || opts.deviceId === B.devId)) return Promise.resolve({ ok: true });
    api.stop(true);
    var tok = ++B.startTok;
    setState('starting');
    // hands: 640x360-ish is plenty (the landmarker works on ~224 px crops) and keeps the GPU upload small
    var v = { width: { ideal: 640 }, height: { ideal: hands() ? 360 : 480 }, frameRate: { ideal: 60 } };
    if (devId) v.deviceId = { exact: devId }; else v.facingMode = 'user';
    function gum(c) { return navigator.mediaDevices.getUserMedia({ video: c, audio: false }); }
    return gum(v).catch(function (e) {
      if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && devId) { delete v.deviceId; v.facingMode = 'user'; return gum(v); }
      throw e;
    }).then(function (stream) {
      if (tok !== B.startTok) { stream.getTracks().forEach(function (t) { t.stop(); }); return { ok: false, reason: 'cancelled' }; }
      B.stream = stream;
      var track = stream.getVideoTracks()[0], st = track && track.getSettings ? track.getSettings() : {};
      B.devId = st.deviceId || devId || '';
      B.camW = st.width || 0; B.camH = st.height || 0; B.camFps = st.frameRate || 0;
      if (track) track.addEventListener('ended', function () { if (B.stream === stream) { api.stop(true); setState('error', 'ended'); } });
      var vid = B.video;
      if (!vid) {
        vid = B.video = document.createElement('video');
        vid.muted = true; vid.playsInline = true; vid.setAttribute('playsinline', ''); vid.setAttribute('aria-hidden', 'true');
        // kept in the document (some browsers skip video-frame callbacks for detached videos), invisible
        vid.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1';
      }
      if (!vid.isConnected && document.body) document.body.appendChild(vid);
      vid.srcObject = stream;
      return vid.play().catch(function () { /* autoplay of a muted camera is allowed; ignore */ }).then(function () {
        return waitDims(vid).then(function () {
          if (tok !== B.startTok) return { ok: false, reason: 'cancelled' };
          B.camW = vid.videoWidth || B.camW; B.camH = vid.videoHeight || B.camH;
          var d = procDims(B.camW, B.camH);
          if (!B.paths || B.w !== d.w || B.h !== d.h) makeCanvases(d);
          if (api.prefs.deviceId !== B.devId) api.setPrefs({ deviceId: B.devId });
          ensureTracker();
          B.autoCal = hands() ? { pending: true } : null;     // hands: auto-centre once they are held steady and level
          setState(B.tracker || B.solver ? 'tracking' : 'calibrate');
          loop();
          return { ok: true };
        });
      });
    }).catch(function (e) {
      if (tok !== B.startTok) return { ok: false, reason: 'cancelled' };
      var n = e && e.name, reason = n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'notfound' : n === 'NotReadableError' || n === 'AbortError' ? 'busy' : 'error';
      api.stop(true);
      setState('error', reason);
      return { ok: false, reason: reason, error: String(e && e.message || e) };
    });
  };
  function waitDims(vid) {
    return new Promise(function (res) {
      if (vid.videoWidth) return res();
      var done = false, to = setTimeout(fin, 3000);
      function fin() { if (done) return; done = true; clearTimeout(to); vid.removeEventListener('loadedmetadata', fin); vid.removeEventListener('resize', fin); res(); }
      vid.addEventListener('loadedmetadata', fin); vid.addEventListener('resize', fin);
    });
  }
  api.stop = function (keepState) {
    B.startTok++;
    if (B.vfcId && B.video && B.video.cancelVideoFrameCallback) { try { B.video.cancelVideoFrameCallback(B.vfcId); } catch (e) { /* ignore */ } }
    B.vfcId = 0;
    if (B.rafId) { cancelAnimationFrame(B.rafId); B.rafId = 0; }
    if (B.stream) { B.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); B.stream = null; }
    if (B.video) { try { B.video.pause(); B.video.srcObject = null; } catch (e) { /* ignore */ } if (B.video.parentNode) B.video.parentNode.removeChild(B.video); }
    B.lastRgba = null; B.fps = 0; B.lastVT = -1;
    if (B.nitroOn) setNitro(false);
    if (B.cd.active()) api.cancelCentre();
    if (B.pedals) B.pedals.reset();
    if (B.solver) B.solver.reset();                    // a restarted camera identifies the hands afresh
    if (B.steer && B.steer.reset) B.steer.reset();     // ... and eases in from centre (no stale unwrap / held value)
    if (!keepState) setState('off');
  };
  api.running = function () { return !!B.stream; };
  function ensureTracker() {
    if (hands()) {
      B.tracker = null;
      var H = HANDS();
      if (!H) { B.solver = null; return; }
      if (!B.solver) {
        B.solver = H.createSolver();
        var hc = api.prefs.handCal;
        if (hc) {
          // straight ahead = hands roughly level: an old calibration stored > 90 deg is the hands swapped (normalise)
          var two = CW_wrap180(+hc.two || 0), lb = hc.labels;
          if (Math.abs(two) > 90) { two = CW_wrap180(two + 180); lb = lb && lb.a && lb.b ? { a: lb.b, b: lb.a } : lb; }
          B.solver.cal = { two: two, labels: lb };
          if (hc.top) B.solver.topCal = JSON.parse(JSON.stringify(hc.top));
        }
        B.solver.style = api.prefs.handStyle; B.solver.wheelSize = api.prefs.wheelSize;
      }
      if (!B.pedals && H.createPedals) { B.pedals = H.createPedals(); if (api.prefs.pedalCal) B.pedals.setCal(api.prefs.pedalCal); }
      if (!B.steer) { B.steer = createSteer(api.prefs); B.steer.centre = 0; }
      return;
    }
    B.solver = null;
    var cal = api.prefs.cal;
    if (!cal || !B.w) { B.tracker = null; return; }
    try { B.tracker = createTracker(cal, { w: B.w, h: B.h }); B.cal = cal; } catch (e) { B.tracker = null; }
    if (!B.steer) { B.steer = createSteer(api.prefs); B.steer.centre = num(cal.expect && cal.expect.angle, 0); }
  }
  function loop() {
    var vid = B.video;
    if (!vid || !B.stream) return;
    if (vid.requestVideoFrameCallback) {
      var cb = function (now, md) { if (!B.stream || B.video !== vid) return; onFrame(now, md); B.vfcId = vid.requestVideoFrameCallback(cb); };
      B.vfcId = vid.requestVideoFrameCallback(cb);
    } else {
      var rf = function (now) {
        if (!B.stream) return;
        if (vid.currentTime !== B.lastVT && vid.readyState >= 2) { B.lastVT = vid.currentTime; onFrame(now, null); }
        B.rafId = requestAnimationFrame(rf);
      };
      B.rafId = requestAnimationFrame(rf);
    }
  }
  /* Two ways to get a small frame for the colour-marker tracker: a CPU-backed canvas (willReadFrequently: the browser
     reads the whole camera frame back and scales it on the CPU) or a GPU canvas (scaled on the GPU, only the small result
     is read back). Which is faster depends on the browser / GPU / camera, so the first ~40 frames time both. */
  function makeCanvases(d) {
    B.paths = [true, false].map(function (cpu) {
      var c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
      var g = c.getContext('2d', cpu ? { willReadFrequently: true, alpha: false } : { alpha: false });
      g.setTransform(-1, 0, 0, 1, d.w, 0);                 // mirrored: the player's view
      g.imageSmoothingEnabled = true;
      try { g.imageSmoothingQuality = 'low'; } catch (e) { /* ignore */ }
      return { name: cpu ? 'cpu' : 'gpu', canvas: c, ctx: g, times: [] };
    });
    B.path = null; B.pathN = 0;
    B.canvas = B.paths[0].canvas; B.ctx = B.paths[0].ctx;
    B.w = d.w; B.h = d.h; B.tracker = null;
  }
  function pickPath() {
    if (B.path) return B.path;
    var n = B.pathN++;
    if (n < 40) return B.paths[n & 1];
    function med(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[s.length >> 1] : Infinity; }
    var a = med(B.paths[0].times.slice(6)), b = med(B.paths[1].times.slice(6));
    B.path = b < a * 0.85 ? B.paths[1] : B.paths[0];
    B.canvas = B.path.canvas; B.ctx = B.path.ctx;
    return B.path;
  }
  function setNitro(on) {
    if (B.nitroOn === on) return;
    B.nitroOn = on;
    var H = CB.input.hub; if (H && H.pushEvent && B.enabled) H.pushEvent(on ? 'nitroOn' : 'nitroOff', 'camwheel');
  }
  /** hands: auto-centre once both hands have been held steady (< 1.5 deg wobble) and roughly level for ~1 s */
  function autoCentre(meas, t) {
    var A = B.autoCal;
    if (!A || !A.pending) return;
    var topStyle = api.prefs.handStyle === 'top';
    if (!meas || !meas.ok || meas.mode !== (topStyle ? 'top' : 'two')) { B.steady.length = 0; return; }
    B.steady.push({ t: t, a: meas.angle });
    while (B.steady.length && t - B.steady[0].t > 1000) B.steady.shift();
    if (B.steady.length < 8 || t - B.steady[0].t < 900) return;
    var lo = Infinity, hi = -Infinity;
    B.steady.forEach(function (s) { lo = Math.min(lo, s.a); hi = Math.max(hi, s.a); });
    var rel = (lo + hi) / 2 + (!topStyle && B.solver.cal ? B.solver.cal.two : 0);
    if (hi - lo < 1.5 && Math.abs(wrapP(rel, 360)) < 15 && !B.cd.active()) { A.pending = false; B.steady.length = 0; api.startCentre('auto'); }
  }
  /** a landmark result (worker or main thread) for the frame submitted with timestamp ts */
  function onHands(list, ts, ms) {
    var key = Math.round(ts), F = B.inflight[key];
    delete B.inflight[key];
    for (var k in B.inflight) if (nowMs() - B.inflight[k].sent > 1000) delete B.inflight[k];
    if (!F || !B.solver || !hands()) return;
    B.infer.push(ms); if (B.infer.length > 120) B.infer.shift();
    var meas = B.solver.update(list || [], F.w, F.h, F.t);
    B.lastHands = meas;
    autoCentre(meas, F.t);
    B.steer.update(meas, F.t);
    if (meas.ok) B.lastHandsT = nowMs();
    var nitroOk = api.prefs.gestureNitro && api.prefs.pedals !== 'push';   // push / pull pedals: a push is the gas
    B.gestOut = CB.input.camhands.gestures(meas, nitroOk ? api.prefs : { gestureNitro: false }, F.t, B.gest);
    if (nitroOk) setNitro(!!B.gestOut.nitro); else if (B.nitroOn) setNitro(false);
    if (B.pedals) {
      B.pedOut = B.pedals.update(meas, F.t, api.prefs);
      if (B.pedOut.item && B.enabled) { var Hb = CB.input.hub; if (Hb && Hb.pushEvent) Hb.pushEvent('item', 'camwheel'); }
    }
    if (B.cd.active()) cdStep();
    if (B.state === 'tracking' || B.state === 'lost') setState(B.steer.read(nowMs()).lost === false ? 'tracking' : 'lost');
    var done = nowMs();
    B.resN = (B.resN || 0) + 1;
    if (meas.ok) B.pend = { id: B.resN, cap: F.cap, shown: F.shown, done: done, sent: F.sent };
    B.resLat.push(done - F.shown); if (B.resLat.length > 120) B.resLat.shift();
    emit('hands', { meas: meas, ms: ms, t: F.t, done: done });
  }
  function onFrame(now, md) {
    var vid = B.video;
    if (!vid || vid.readyState < 2) return;
    var t0 = nowMs();
    var cap = md && typeof md.captureTime === 'number' && md.captureTime > 0 ? md.captureTime : null;
    var shown = md && typeof md.presentationTime === 'number' ? md.presentationTime : now;
    var tFrame = cap != null ? cap : shown;
    var meas = null, steer = 0, rgba = null, inf = 0;
    if (hands()) {
      // bare hands: the frame goes to the landmarker (worker: off the main thread); the result lands in onHands()
      var Hd = HANDS();
      if (B.solver && Hd && Hd.loaded()) {
        if (!B.offRes) B.offRes = Hd.onResult(onHands);
        var ts = md && md.mediaTime != null ? md.mediaTime * 1000 : tFrame;
        if (Hd.submit(vid, ts)) { B.inflight[Math.round(ts)] = { cap: cap, shown: shown, t: tFrame, w: vid.videoWidth || B.camW, h: vid.videoHeight || B.camH, sent: nowMs() }; }
      }
    } else {
      if (!B.paths) return;
      if ((vid.videoWidth && vid.videoWidth !== B.camW) || (vid.videoHeight && vid.videoHeight !== B.camH)) {
        B.camW = vid.videoWidth; B.camH = vid.videoHeight;
        var d = procDims(B.camW, B.camH);
        if (d.w !== B.w || d.h !== B.h) { makeCanvases(d); ensureTracker(); }
      }
      var path = pickPath(), ctx = path.ctx;
      var tA = nowMs();
      ctx.drawImage(vid, 0, 0, B.w, B.h);
      rgba = ctx.getImageData(0, 0, B.w, B.h).data;
      if (!B.path) path.times.push(nowMs() - tA);
      B.lastRgba = rgba;
      if (B.tracker) { meas = B.tracker.process(rgba, tFrame); steer = B.steer.update(meas, tFrame); }
    }
    if (B.tracker) {
      if (B.state === 'tracking' || B.state === 'lost') setState(B.steer && B.steer.read(nowMs()).lost === false ? 'tracking' : 'lost');
    }
    var t1 = nowMs();
    B.split = { start: t0, cbNow: now, infer: inf };
    B.procMs = B.procMs ? lerp(B.procMs, t1 - t0, 0.1) : t1 - t0;
    B.procs.push(t1 - t0); if (B.procs.length > 240) B.procs.shift();
    B.frameN++; B.fpsN++;
    if (!B.fpsT0) B.fpsT0 = t1;
    if (t1 - B.fpsT0 >= 1000) { B.fps = Math.round(B.fpsN * 1000 / (t1 - B.fpsT0)); B.fpsN = 0; B.fpsT0 = t1; }
    if (!hands() && meas && meas.ok) B.pend = { id: B.frameN, cap: cap, shown: shown, done: t1, mediaTime: md ? md.mediaTime : null };
    emit('frame', { rgba: rgba, w: B.w, h: B.h, meas: meas, steer: steer, t: tFrame, cap: cap, shown: shown, done: t1, md: md || null, split: B.split, hands: hands() });
  }
  /** the player's car (speed m/s, gear) as race-ui reports it to the hub every frame: the pedals' reverse rule */
  function carStatus() {
    var Hb = CB.input.hub, st = Hb && Hb.status ? Hb.status() : null;
    return st && st.driving && !st.paused ? { driving: true, speed: num(st.speed, 0), gear: num(st.gear, 0) } : null;
  }
  api.carStatus = carStatus;
  /* ---------------- hub source */
  function hubSource() {
    return {
      read: function (now) {
        if (!B.enabled || !B.stream || !B.steer || !(B.tracker || B.solver)) return null;
        now = num(now, nowMs());
        var r = B.steer.read(now);
        if (B.pend) {                                     // first time this frame's steering reaches the game
          var p = B.pend; B.pend = null;
          if (p.cap != null) { B.lats.push(now - p.cap); if (B.lats.length > 120) B.lats.shift(); }
          B.pageLats.push(now - p.shown); if (B.pageLats.length > 120) B.pageLats.shift();
          B.lastApplied = { id: p.id, at: now, cap: p.cap, shown: p.shown, done: p.done, mediaTime: p.mediaTime };
        }
        var pd = hands() && B.pedals && api.prefs.pedals !== 'off' ? B.pedals.read(nowMs(), api.prefs.pedals, carStatus()) : null;
        return { active: true, stale: r.lost, steer: r.steer, throttle: pd ? pd.throttle : 0, brake: pd ? pd.brake : 0, handbrake: !!(pd && pd.handbrake) };
      }
    };
  }
  api.ready = function () { return hands() ? !!HANDS() : !!api.prefs.cal; };
  api.enable = function () {
    var H = CB.input.hub;
    if (!api.ready()) return { ok: false, reason: 'calibrate' };
    ensureTracker();
    B.enabled = true;
    if (H && !B.unreg) B.unreg = H.register('camwheel', hubSource(), 8);
    emit('state', { state: B.state, reason: B.reason });
    return { ok: true };
  };
  api.disable = function () {
    if (B.nitroOn) setNitro(false);
    B.enabled = false;
    if (B.unreg) { B.unreg(); B.unreg = null; }
    api.stop();
  };
  api.enabled = function () { return B.enabled; };
  /** hands: the current pose is straight ahead.  marker: sample the colours in the boxes (boxes / style optional). */
  api.calibrateNow = function (boxes, style, o) {
    if (hands()) {
      if (!B.solver) ensureTracker();
      if (!B.solver || !B.lastHands || !B.lastHands.ok) return { ok: false, reason: 'nohands', warnings: [] };
      var mode = B.lastHands.mode;
      B.solver.calibrate();
      // remember which MediaPipe handedness label the left / right hand had (diagnostics only: identity is geometric)
      var labels = null;
      if (mode === 'two' && B.lastHands.hands.length === 2) {
        var hs = B.lastHands.hands.slice().sort(function (p, q) { return p.x - q.x; });
        if (hs[0].h.label && hs[1].h.label && hs[0].h.label !== hs[1].h.label) labels = { a: hs[0].h.label, b: hs[1].h.label };
      }
      if (labels) B.solver.cal.labels = labels;
      var pc = null;
      if (B.pedals) { pc = B.pedals.calibrateNeutral(B.lastHands, { curl: !!(o && o.curl) }); }
      api.setPrefs({ handCal: { two: B.solver.cal ? B.solver.cal.two : 0, labels: B.solver.cal && B.solver.cal.labels || null, top: B.solver.topCal || null }, pedalCal: B.pedals ? pedalCalOf() : api.prefs.pedalCal });
      var was = B.steer ? B.steer.read(nowMs()) : null;
      B.steer = createSteer(api.prefs); B.steer.centre = 0;
      if (was && !was.lost) B.steer.seed(was.steer, was.angleShown, nowMs());   // no snap at the re-centre
      if (B.autoCal) B.autoCal.pending = false;
      setState('tracking');
      return { ok: true, mode: mode === 'two' ? 'hands2' : mode === 'top' ? 'top' : 'hands1', side: mode === 'top' ? B.lastHands.side : null, warnings: [], open: pc && pc.open };
    }
    if (!B.lastRgba) return { ok: false, reason: 'noframe', warnings: [] };
    style = style || api.prefs.style;
    var r = calibrate(B.lastRgba, B.w, B.h, boxes || defaultBoxes(style), { style: style });
    if (r.ok) {
      api.setPrefs({ cal: r, style: r.style });
      ensureTracker();
      // the angle the player held while calibrating is straight ahead
      B.steer = createSteer(api.prefs);
      B.steer.centre = r.expect.angle || 0;
      setState('tracking');
    }
    return r;
  };
  function pedalCalOf() { var c = B.pedals.cal; return { open: +c.open.toFixed(3), grip: +c.grip.toFixed(3), scale: Object.assign({}, c.scale), world: c.world, v: 2, fist: c.fist == null ? null : +c.fist.toFixed(3), ext: c.ext == null ? null : +c.ext.toFixed(3) }; }
  /** re-centre right now (no countdown): hands = the current pose is straight ahead; markers = the current angle */
  api.recentreNow = function () {
    if (hands()) { var r = api.calibrateNow(); if (r.ok) return r; }
    if (B.steer) B.steer.recentre();
    return { ok: !!B.steer };
  };
  /** hands: the current full grip = full gas (Calibrate's second step) */
  api.captureGrip = function () {
    if (!B.pedals || !hands()) return { ok: false, reason: 'nohands' };
    if (nowMs() - B.lastHandsT > 400) return { ok: false, reason: 'nohands' };
    var r = B.pedals.calibrateGrip(B.lastHands);
    if (r.ok) api.setPrefs({ pedalCal: pedalCalOf() });
    return r;
  };
  /** the Start flow's hand tests: "make fists" / "open your hands" -> the player's own closed / open readings (saved) */
  function captureHand(which) {
    if (!B.pedals || !hands()) return { ok: false, reason: 'nohands' };
    if (nowMs() - B.lastHandsT > 400) return { ok: false, reason: 'nohands' };
    var r = which === 'fist' ? B.pedals.calibrateFist(B.lastHands) : B.pedals.calibrateOpen(B.lastHands);
    if (r.ok) api.setPrefs({ pedalCal: pedalCalOf() });
    return r;
  }
  api.captureFist = function () { return captureHand('fist'); };
  api.captureOpen = function () { return captureHand('open'); };
  /** what the hands look like right now: {n hands, open: [0..1 per hand], hand 'closed'|'mid'|'open'|null, state} */
  api.handState = function () {
    var m = B.lastHands, fresh = m && m.ok && nowMs() - B.lastHandsT < 400;
    var pd = B.pedals ? B.pedals.read(nowMs(), api.prefs.pedals, carStatus()) : null;
    var op = fresh ? m.pts.map(function (p) { return p.open; }).filter(function (v) { return v != null; }) : [], bd = B.pedals ? B.pedals.bands() : HANDS().PEDALS;
    return { n: op.length, mode: fresh ? m.mode : null, open: op, closed: op.length > 0 && op.every(function (v) { return v < bd.closeOn; }), opened: op.length > 0 && op.every(function (v) { return v > bd.extOn; }),
      hand: pd && pd.ok ? pd.hand : null, state: pd ? pd.state : 'off', reverse: !!(pd && pd.reverse) };
  };
  /* ---- the 3-2-1 countdown: kind 'centre' (straight ahead), 'calibrate' (neutral + full grip), 'auto' (first auto-centre) */
  function cdEmit(e) { B.cdState = e; emit('countdown', e); }
  function cdStep() {
    var e = B.cd.step(nowMs());
    if (!e) { stopCdTimer(); return; }
    if (e.state === 'count') { if (!B.cdState || B.cdState.left !== e.left || B.cdState.phase !== e.phase || B.cdState.state !== 'count') cdEmit(e); else B.cdState = e; return; }
    // capture at the end of a phase
    var res;
    if (e.phase === 'grip') res = api.captureGrip();
    else if (hands()) {
      res = nowMs() - B.lastHandsT > 400 ? { ok: false, reason: 'nohands' } : api.calibrateNow(null, null, { curl: e.kind !== 'centre' && e.kind !== 'setup' });
    } else if (e.kind === 'calibrate' || !api.prefs.cal) res = api.calibrateNow(null, api.prefs.style);
    else { if (B.steer) B.steer.recentre(); res = { ok: !!B.steer }; }
    if (!res || !res.ok) { B.cd.cancel(); stopCdTimer(); if (e.kind === 'auto' && B.autoCal) B.autoCal.pending = true; cdEmit({ state: 'fail', phase: e.phase, kind: e.kind, result: res || { ok: false } }); return; }
    if (e.phase === 'neutral' && e.kind === 'auto') emit('autocentre', { angle: 0 });
    if (e.next) { cdEmit({ state: 'captured', phase: e.phase, next: e.next, kind: e.kind, result: res }); cdStep(); return; }
    stopCdTimer();
    cdEmit({ state: 'done', phase: e.phase, kind: e.kind, result: res });
  }
  function stopCdTimer() { if (B.cdTimer) { clearInterval(B.cdTimer); B.cdTimer = 0; } }
  /** start (or, when one is running, cancel) the 3-2-1 re-centre countdown. kind 'centre' | 'calibrate' (+ the full grip,
      for the older 'grip' pedals) | 'setup' (the Start flow: the centre and the pull-back neutral, the hands as they drive)
      | 'auto' */
  api.startCentre = function (kind) {
    kind = kind || 'centre';
    if (B.cd.active()) { api.cancelCentre(); return { state: 'cancelled' }; }
    var ph = [{ id: 'neutral', ms: num(api.countMs, COUNT_MS) }];
    if (kind === 'calibrate' && hands()) ph.push({ id: 'grip', ms: num(api.gripMs, GRIP_MS) });
    if (B.autoCal && kind !== 'auto') B.autoCal.pending = false;    // asked for: no auto-centre on top of it
    var e = B.cd.start(nowMs(), ph, kind);
    cdEmit(e);
    stopCdTimer();
    if (typeof setInterval === 'function') B.cdTimer = setInterval(cdStep, 50);
    return e;
  };
  api.cancelCentre = function () {
    var was = B.cd.cancel(); stopCdTimer();
    if (was) cdEmit({ state: 'cancel', kind: B.cd.kind });
    return was;
  };
  api.countdown = function () { return B.cd.active() ? B.cd.step(nowMs()) : null; };
  api.recentre = function () { return api.startCentre('centre'); };
  api.forget = function () { api.setPrefs({ cal: null, handCal: null, pedalCal: null }); B.tracker = null; B.solver = null; B.pedals = null; if (B.enabled) api.disable(); };
  api.stats = function () {
    function med(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); return s[s.length >> 1]; }
    var t = nowMs(), r = B.steer ? B.steer.read(t) : { steer: 0, lost: true };
    var lh = B.lastHands;
    return {
      state: B.state, reason: B.reason, enabled: B.enabled, method: api.prefs.method, fps: B.fps, procMs: B.procMs ? +B.procMs.toFixed(2) : 0,
      inferMs: med(B.infer), model: B.model.state, delegate: B.model.delegate, worker: !!(HANDS() && HANDS().mode === 'worker'),
      resultLatency: med(B.resLat),
      latency: med(B.lats), pageLatency: med(B.pageLats),
      conf: B.steer ? B.steer.conf : 0, angle: B.steer ? B.steer.angle : 0, steer: r.steer, lost: !!r.lost,
      hands: lh && lh.ok ? lh.pts.length : 0, handMode: lh && lh.ok ? lh.mode : null, handSide: lh && lh.ok && lh.side || (B.solver && B.solver.topCal ? B.solver.topCal.side : null), handStyle: api.prefs.handStyle,
      w: B.w, h: B.h, camW: B.camW, camH: B.camH, camFps: B.camFps, path: B.path ? B.path.name : 'auto',
      calibrated: hands() ? true : !!api.prefs.cal, mode: hands() ? 'hands' : api.prefs.cal ? api.prefs.cal.mode : null,
      gestures: { nitro: !!B.gestOut.nitro },
      pedals: hands() && B.pedals ? B.pedals.read(t, api.prefs.pedals, carStatus()) : null, pedalMode: api.prefs.pedals
    };
  };
  api._b = B;
  /** tests (Node): feed one detector result as if it came from the camera (list: [{lm, score, label}], t ms) */
  api._feed = function (list, w, h, t) {
    ensureTracker();
    t = num(t, nowMs());
    B.inflight[Math.round(t)] = { cap: null, shown: t, t: t, w: w, h: h, sent: nowMs() };
    onHands(list, t, 0);
    return B.lastHands;
  };
  Object.defineProperty(api, 'video', { get: function () { return B.video; } });
  Object.defineProperty(api, 'canvas', { get: function () { return B.canvas; } });
  Object.defineProperty(api, 'tracker', { get: function () { return B.tracker; } });
  Object.defineProperty(api, 'solver', { get: function () { return B.solver; } });

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('pagehide', function () { if (B.stream) api.stop(); });
  }

  CB.input.camwheel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

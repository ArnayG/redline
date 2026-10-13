/* ==========================================================================
   FORGE — js/input/pad-tilt.js
   CB.input.padTilt : "Tilt your controller like a wheel". Reads the motion sensors (gyro + accelerometer) of a
   DualSense (PS5), DualShock 4 (PS4), Nintendo Switch Pro Controller or a single sideways Joy-Con over WebHID
   (Chrome / Edge desktop, HTTPS or localhost), USB or Bluetooth, and turns the controller's roll into a steering angle.
   Sticks, triggers and buttons keep working through the normal Gamepad API (race-ui), WebHID only adds the motion data.

   Core (pure, Node-tested):
     P.parseReport(kind, reportId, bytes) -> {samples:[{a:[x,y,z] g, w:[x,y,z] deg/s, dt?}], transport, l3, r3} | null
        bytes = the report WITHOUT its report id (as WebHID delivers it: event.reportId + event.data)
        kind 'ds4'  DualShock 4     report 0x01 (USB, 63 B) / 0x11 (Bluetooth, struct after 2 header bytes)
                                    gyro x,y,z int16 LE at +12, accel x,y,z at +18 (USB offsets; BT +2), timestamp u16 at
                                    +9 (5.33 us units), buttons[1] at +5 (L3 0x40, R3 0x80). Accel 8192 / g, gyro 16.4 / (deg/s)
        kind 'ds'   DualSense       report 0x01 (USB, 63 B) / 0x31 (Bluetooth, struct after 1 header byte)
                                    gyro at +15, accel at +21, timestamp u32 at +27 (1/3 us units), buttons[1] at +8
        kind 'pro' | 'jcl' | 'jcr'  Switch Pro / Joy-Con L / R, standard full report 0x30 (after subcommands 0x40 0x01
                                    = enable IMU and 0x03 0x30 = full report mode): 3 IMU samples x 12 bytes at +12
                                    (accel x,y,z then gyro x,y,z, int16 LE, oldest first, 5 ms apart);
                                    accel 0.244 mg / LSB, gyro 0.07 deg/s / LSB; shared buttons at +3 (R stick 0x04, L stick 0x08)
        Every kind is converted to one controller frame: x = right, y = up out of the face, z = toward the player
        (Nintendo: (-y, z, -x); a sideways Joy-Con L: (-x, z, y), R: (x, z, -y)). Accel is the "up" vector at rest.
     P.createRollFilter(opts) -> F   F.update(a, w, dt) -> angle (deg, + = turned right / clockwise, unwrapped)
        complementary (Mahony-style PI) filter on the roll about the calibrated wheel axis: the gyro integrates (no lag),
        the accelerometer's gravity pulls the angle back (no drift) with trust falling off when the controller is
        shaken or the wheel axis is vertical; the PI term learns the gyro bias. Unwrapped: keeps counting past
        +-90 / +-180 deg. Works for any hold (flat, tilted toward you, upright like a wheel): F.recentre(a?) captures
        the current pose as straight ahead. A gyro whose sign disagrees with gravity is detected and flipped.
     P.mapSteer(angleDeg, {lock 90|180|270 (lock to lock), deadzone deg, invert}) -> steer [-1, 1] (+1 = right)
     P.KNOWN  vendor / product ids     P.kindOf(device)
   Browser:
     P.supported() -> {ok, reason?: 'unsupported' | 'insecure'}   P.connect() (user gesture: navigator.hid.requestDevice)
     P.restore() (re-opens an already permitted device: navigator.hid.getDevices())   P.disconnect()   P.recentre()
     P.state() -> {connected, name, kind, transport, angle, steer, rate, fresh, latencyMs}
     the 'padtilt' CB.input.hub source (priority 7); press R3 (Joy-Con: the stick) to re-centre
     prefs (localStorage 'forge.padTilt.v1'): lock 90 | 180 (default) | 270, deadzone (1.5 deg), invert
   Steering source picker entry: CB.input.sources 'padtilt'.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';
  var DEG = Math.PI / 180, TAU = 2 * Math.PI;
  var PREF_KEY = 'forge.padTilt.v1';
  var DEFAULT_PREFS = { lock: 180, deadzone: 1.5, invert: false };
  var SONY_ACC = 1 / 8192, SONY_GYR = 2000 / 32768;
  var NIN_ACC = 0.000244, NIN_GYR = 0.07;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function i16(b, o) { var v = b[o] | (b[o + 1] << 8); return v >= 0x8000 ? v - 0x10000 : v; }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

  var KNOWN = [
    { vendorId: 0x054c, productId: 0x05c4, kind: 'ds4', name: 'DualShock 4' },
    { vendorId: 0x054c, productId: 0x09cc, kind: 'ds4', name: 'DualShock 4' },
    { vendorId: 0x054c, productId: 0x0ba0, kind: 'ds4', name: 'DualShock 4 (USB wireless adapter)' },
    { vendorId: 0x054c, productId: 0x0ce6, kind: 'ds', name: 'DualSense' },
    { vendorId: 0x054c, productId: 0x0df2, kind: 'ds', name: 'DualSense Edge' },
    { vendorId: 0x057e, productId: 0x2009, kind: 'pro', name: 'Switch Pro Controller' },
    { vendorId: 0x057e, productId: 0x2006, kind: 'jcl', name: 'Joy-Con (L)' },
    { vendorId: 0x057e, productId: 0x2007, kind: 'jcr', name: 'Joy-Con (R)' }
  ];
  function kindOf(dev) {
    if (!dev) return null;
    for (var i = 0; i < KNOWN.length; i++) if (KNOWN[i].vendorId === dev.vendorId && KNOWN[i].productId === dev.productId) return KNOWN[i];
    return null;
  }

  /* ---------------------------------------------------------------- report parsing */
  var tsMem = {};   // previous device timestamps (per kind) for sample dt
  function sonySample(b, go, ao, accS, gyrS) {
    return { a: [i16(b, ao) * accS, i16(b, ao + 2) * accS, i16(b, ao + 4) * accS], w: [i16(b, go) * gyrS, i16(b, go + 2) * gyrS, i16(b, go + 4) * gyrS] };
  }
  function parseReport(kind, reportId, bytes, mem) {
    var b = bytes;
    if (!b || typeof b.length !== 'number') return null;
    mem = mem || tsMem;
    var off, s, ts, prev, out;
    if (kind === 'ds4') {
      off = reportId === 0x01 ? 0 : reportId === 0x11 ? 2 : -1;
      if (off < 0 || b.length < off + 24) return null;
      s = sonySample(b, off + 12, off + 18, SONY_ACC, SONY_GYR);
      ts = u16(b, off + 9); prev = mem.ds4;
      if (prev != null) { var d16 = (ts - prev + 65536) % 65536; if (d16 > 0 && d16 < 20000) s.dt = d16 * 16 / 3 / 1e6; }
      mem.ds4 = ts;
      return { samples: [s], transport: reportId === 0x11 ? 'Bluetooth' : 'USB', l3: !!(b[off + 5] & 0x40), r3: !!(b[off + 5] & 0x80) };
    }
    if (kind === 'ds') {
      off = reportId === 0x01 ? 0 : reportId === 0x31 ? 1 : -1;
      if (off < 0 || b.length < off + 31) return null;
      s = sonySample(b, off + 15, off + 21, SONY_ACC, SONY_GYR);
      ts = u32(b, off + 27); prev = mem.ds;
      if (prev != null) { var d32 = (ts - prev + 4294967296) % 4294967296; if (d32 > 0 && d32 < 300000) s.dt = d32 / 3 / 1e6; }
      mem.ds = ts;
      return { samples: [s], transport: reportId === 0x31 ? 'Bluetooth' : 'USB', l3: !!(b[off + 8] & 0x40), r3: !!(b[off + 8] & 0x80) };
    }
    if (kind === 'pro' || kind === 'jcl' || kind === 'jcr') {
      if ((reportId !== 0x30 && reportId !== 0x31 && reportId !== 0x32 && reportId !== 0x33) || b.length < 48) return null;
      out = [];
      for (var i = 0; i < 3; i++) {
        var o = 12 + 12 * i;
        var ax = i16(b, o) * NIN_ACC, ay = i16(b, o + 2) * NIN_ACC, az = i16(b, o + 4) * NIN_ACC;
        var gx = i16(b, o + 6) * NIN_GYR, gy = i16(b, o + 8) * NIN_GYR, gz = i16(b, o + 10) * NIN_GYR;
        if (kind === 'pro') out.push({ a: [-ay, az, -ax], w: [-gy, gz, -gx] });
        else if (kind === 'jcl') out.push({ a: [-ax, az, ay], w: [-gx, gz, gy] });
        else out.push({ a: [ax, az, -ay], w: [gx, gz, -gy] });
      }
      return { samples: out, transport: null, l3: !!(b[3] & 0x08), r3: !!(b[3] & 0x04), timer: b[0] };
    }
    return null;
  }

  /* ---------------------------------------------------------------- roll filter */
  function createRollFilter(opts) {
    opts = opts || {};
    var KP = num(opts.kp, 3), KI = num(opts.ki, 0.5);
    var F = { phi: 0, off: 0, c: null, bias: 0, gyroSign: 1, vote: 0, prevAcc: null, angle: 0, trust: 0, n: 0 };
    function accAngle(a, c) { return Math.atan2(a[0], a[1] * c[0] + a[2] * c[1]); }
    function setFrame(a) {
      var yz = Math.hypot(a[1], a[2]);
      F.c = yz > 0.3 ? [a[1] / yz, a[2] / yz] : [1, 0];
      F.phi = accAngle(a, F.c); F.off = F.phi; F.prevAcc = F.phi;
    }
    F.recentre = function (a) {
      if (a) setFrame(a);
      else F.off = F.phi;
      F.angle = 0;
    };
    F.update = function (a, w, dt) {
      dt = clamp(num(dt, 0.004), 0.0005, 0.05);
      F.n++;
      if (!F.c) { setFrame(a); return 0; }
      var c = F.c;
      var rate = (-w[1] * c[1] + w[2] * c[0]) * DEG * F.gyroSign;          // roll rate about the wheel axis (rad/s)
      var pred = F.phi + (rate - F.bias) * dt;
      var mag = Math.hypot(a[0], a[1], a[2]), along = a[1] * c[0] + a[2] * c[1], plane = Math.hypot(a[0], along);
      var acc = Math.atan2(a[0], along);
      acc += TAU * Math.round((pred - acc) / TAU);                            // unwrap next to the prediction
      var wt = plane > 0.3 ? Math.exp(-Math.pow((mag - 1) / 0.2, 2)) * clamp((plane - 0.3) / 0.3, 0, 1) : 0;
      var e = acc - pred;
      F.phi = pred + clamp(KP * dt, 0, 1) * wt * e;
      F.bias = clamp(F.bias - KI * dt * wt * e, -0.2, 0.2);                   // learnt gyro bias (rad/s, +-11 deg/s max)
      F.trust = wt;
      // gyro sign check: while turning steadily, gravity and gyro must agree on the direction
      if (F.prevAcc != null && wt > 0.7 && Math.abs(rate) > 0.6) {
        var dAcc = (acc - F.prevAcc) / dt;
        if (Math.abs(dAcc) > 0.3) {
          F.vote = clamp(F.vote + (dAcc * rate > 0 ? 1 : -1), -40, 40);
          if (F.vote <= -30) { F.gyroSign = -F.gyroSign; F.vote = 0; F.bias = 0; F.phi = acc; }
        }
      }
      F.prevAcc = acc;
      // + = clockwise as the player sees it (the controller's right side going down: the up vector tilts to -x)
      F.angle = -(F.phi - F.off) / DEG;
      return F.angle;
    };
    return F;
  }

  function normPrefs(p) {
    p = p && typeof p === 'object' ? p : {};
    var l = num(p.lock, DEFAULT_PREFS.lock);
    return { lock: l === 90 || l === 270 ? l : 180, deadzone: clamp(num(p.deadzone, DEFAULT_PREFS.deadzone), 0, 10), invert: !!p.invert };
  }
  function mapSteer(angle, prefs) {
    var p = normPrefs(prefs), half = p.lock / 2, m = Math.abs(angle);
    var v = m <= p.deadzone ? 0 : clamp((m - p.deadzone) / Math.max(1, half - p.deadzone), 0, 1);
    v *= angle < 0 ? -1 : 1;
    return p.invert ? -v : v;
  }
  function loadPrefs() {
    try { var s = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY); if (s) return normPrefs(JSON.parse(s)); } catch (e) { /* ignore */ }
    return normPrefs(DEFAULT_PREFS);
  }
  function savePrefs(p) { try { if (globalThis.localStorage) globalThis.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }

  var P = {
    KNOWN: KNOWN, DEFAULT_PREFS: DEFAULT_PREFS, kindOf: kindOf, parseReport: parseReport, createRollFilter: createRollFilter,
    mapSteer: mapSteer, normPrefs: normPrefs, prefs: loadPrefs(), _i16: i16
  };
  P.setPrefs = function (p) { P.prefs = normPrefs(Object.assign({}, P.prefs, p || {})); savePrefs(P.prefs); return P.prefs; };

  /* ================================================================ browser: WebHID binding */
  var hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  var D = {
    dev: null, info: null, filter: null, mem: {}, transport: null, lastT: 0, lastRepT: 0, rate: 0, rateN: 0, rateT0: 0, unreg: null,
    r3: false, steer: 0, angle: 0, evT: 0, evPending: false, lat: [], lastLat: null, opening: false, wantOn: false, initT: 0, hud: null, raf: 0, chip: null
  };
  function H() { return CB.input.hub; }
  function SS() { return CB.input.sources; }
  function toast(t, k) { var u = CB.input.ui; if (u && u.toast) u.toast(t, k); }
  function hid() { return hasDOM && typeof navigator !== 'undefined' ? navigator.hid : null; }
  P.supported = function () {
    if (!hasDOM) return { ok: false, reason: 'unsupported' };
    if (!hid()) return { ok: false, reason: window.isSecureContext === false ? 'insecure' : 'unsupported' };
    if (window.isSecureContext === false) return { ok: false, reason: 'insecure' };
    return { ok: true };
  };
  function reasonText(r) {
    return r === 'insecure' ? 'Controller tilt needs a secure page: open the game over HTTPS (or http://localhost).'
      : r === 'unsupported' ? 'Controller tilt needs WebHID: Chrome or Edge on a computer (Safari, Firefox and iPhone / iPad browsers do not have it).'
        : r === 'cancelled' ? 'No controller picked.' : r === 'unknown-device' ? 'That controller is not supported for tilt (DualSense, DualShock 4, Switch Pro, Joy-Con).'
          : 'Could not open the controller' + (r ? ': ' + r : '') + '.';
  }
  P.reasonText = reasonText;
  function fresh(t) { return !!D.dev && D.lastT > 0 && (num(t, nowMs()) - D.lastT) < 250; }

  /** Feed one input report (WebHID inputreport, or a test). */
  function onReport(reportId, bytes, t) {
    if (!D.info) return;
    t = num(t, nowMs());
    var r = parseReport(D.info.kind, reportId, bytes, D.mem);
    if (!r || !r.samples.length) return;
    if (r.transport) D.transport = r.transport;
    // sample spacing: Sony reports carry a device timestamp (s.dt); the Switch IMU samples at a fixed 200 Hz (3 per report).
    // Never the arrival time: the browser can deliver reports in bunches while the page is busy.
    var nominal = r.samples.length > 1 ? 0.005 : D.lastRepT ? clamp((t - D.lastRepT) / 1000, 0.002, 0.02) : 0.004;
    D.lastRepT = t;
    if (!D.filter) D.filter = createRollFilter();
    for (var i = 0; i < r.samples.length; i++) {
      var s = r.samples[i];
      D.angle = D.filter.update(s.a, s.w, s.dt || nominal);
    }
    D.lastA = r.samples[r.samples.length - 1].a;
    D.steer = mapSteer(D.angle, P.prefs);
    D.lastT = t; D.evT = t; D.evPending = true;
    // report rate (Hz)
    if (!D.rateT0) D.rateT0 = t;
    D.rateN++;
    if (t - D.rateT0 >= 1000) { D.rate = Math.round(D.rateN * 1000 / (t - D.rateT0)); D.rateN = 0; D.rateT0 = t; }
    var stick = D.info.kind === 'jcl' ? r.l3 : D.info.kind === 'jcr' ? r.r3 : r.r3;
    if (stick && !D.r3) { P.recentre(); toast('Controller tilt: centred', 'ok'); }
    D.r3 = !!stick;
  }
  P._feed = onReport;

  function source() {
    return {
      read: function (now) {
        if (!D.dev || !fresh(now)) return null;
        if (D.evPending) {
          D.evPending = false;
          var l = nowMs() - D.evT;
          if (l >= 0 && l < 1000) { D.lastLat = l; D.lat.push(l); if (D.lat.length > 120) D.lat.shift(); }
        }
        return { active: true, steer: D.steer, throttle: 0, brake: 0, handbrake: false };
      }
    };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var subCnt = 0;
  function switchSub(dev, id, args) {
    var d = new Uint8Array(10 + args.length);
    d[0] = subCnt++ & 0x0f;
    d.set([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40], 1);
    d[9] = id; d.set(args, 10);
    return dev.sendReport(0x01, d).catch(function () { /* ignore */ });
  }
  function initDevice(dev, info) {
    if (info.kind === 'ds4') {
      // feature report 0x02 = calibration; reading it also switches a Bluetooth DS4 from report 0x01 to the full 0x11
      return dev.receiveFeatureReport(0x02).catch(function () { return dev.receiveFeatureReport(0x05); }).catch(function () { /* ignore */ });
    }
    if (info.kind === 'ds') return dev.receiveFeatureReport(0x05).catch(function () { /* ignore */ });   // BT: 0x01 -> 0x31
    // Switch Pro / Joy-Con: USB handshake (Pro over USB only; ignored over Bluetooth), enable the IMU, full report mode
    var p = Promise.resolve();
    if (info.kind === 'pro') {
      p = dev.sendReport(0x80, new Uint8Array([0x02])).then(function () { return dev.sendReport(0x80, new Uint8Array([0x04])); }).catch(function () { /* Bluetooth */ });
    }
    return p.then(function () { return switchSub(dev, 0x40, [0x01]); }).then(function () { return sleep(40); })
      .then(function () { return switchSub(dev, 0x03, [0x30]); }).then(function () { return sleep(40); })
      .then(function () { return switchSub(dev, 0x30, [0x01]); });   // player 1 light
  }
  function onInputReport(e) {
    if (!e || e.device !== D.dev) return;
    var dv = e.data, bytes = dv instanceof DataView ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength) : new Uint8Array(dv || []);
    onReport(e.reportId, bytes, e.timeStamp > 0 && e.timeStamp < 1e12 ? e.timeStamp : nowMs());
  }
  function openDevice(dev) {
    var info = kindOf(dev);
    if (!info) return Promise.resolve({ ok: false, reason: 'unknown-device' });
    if (D.dev === dev && dev.opened) return Promise.resolve({ ok: true });
    closeDevice();
    D.opening = true;
    return Promise.resolve(dev.opened ? null : dev.open()).then(function () {
      D.dev = dev; D.info = info; D.filter = createRollFilter(); D.mem = {}; D.transport = null; D.lastT = 0; D.lastRepT = 0; D.rate = 0; D.initT = nowMs();
      dev.addEventListener('inputreport', onInputReport);
      var h = H();
      if (h && !D.unreg) D.unreg = h.register('padtilt', source(), 7);
      D.opening = false;
      startLoops();
      initDevice(dev, info);
      // no motion data after a while (Switch controllers sometimes ignore the first subcommands): ask again
      setTimeout(function () { if (D.dev === dev && !D.lastT && info.kind !== 'ds' && info.kind !== 'ds4') initDevice(dev, info); }, 1200);
      return { ok: true, name: info.name };
    }, function (err) { D.opening = false; return { ok: false, reason: String(err && err.message || err) }; });
  }
  function closeDevice() {
    if (D.dev) {
      try { D.dev.removeEventListener('inputreport', onInputReport); } catch (e) { /* ignore */ }
      // the device stays open for the Gamepad API side of the browser; closing our handle only stops our reports
      try { if (D.dev.opened && D.dev.close) D.dev.close().catch(function () { /* ignore */ }); } catch (e2) { /* ignore */ }
    }
    D.dev = null; D.info = null; D.lastT = 0;
    if (D.unreg) { D.unreg(); D.unreg = null; }
  }
  var FILTERS = KNOWN.map(function (k) { return { vendorId: k.vendorId, productId: k.productId }; });
  /** From a click: the browser's device chooser. */
  P.connect = function () {
    var s = P.supported();
    if (!s.ok) return Promise.resolve(s);
    D.wantOn = true;
    var h = hid();
    return P.restore().then(function (r) {
      if (r.ok) return r;
      return h.requestDevice({ filters: FILTERS }).then(function (list) {
        var dev = (list || []).filter(kindOf)[0];
        if (!dev) return { ok: false, reason: list && list.length ? 'unknown-device' : 'cancelled' };
        return openDevice(dev);
      }, function (err) { return { ok: false, reason: err && err.name === 'SecurityError' ? 'Not allowed here (' + (err.message || 'security') + ')' : String(err && err.message || err) }; });
    });
  };
  /** Re-open a controller this site was already allowed to use (no prompt, no gesture needed). */
  P.restore = function () {
    var h = hid();
    if (!h || !h.getDevices) return Promise.resolve({ ok: false, reason: 'unsupported' });
    D.wantOn = true;
    return h.getDevices().then(function (list) {
      var dev = (list || []).filter(kindOf)[0];
      return dev ? openDevice(dev) : { ok: false, reason: 'none' };
    }, function () { return { ok: false, reason: 'none' }; });
  };
  P.disconnect = function () { D.wantOn = false; closeDevice(); if (D.hud) D.hud.hide(); updateChip(); };
  P.recentre = function () { if (D.filter) D.filter.recentre(D.lastA || null); D.angle = 0; D.steer = 0; };
  P.state = function () {
    var t = nowMs(), a = D.lat, avg = a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null;
    return {
      connected: !!D.dev, wanted: D.wantOn, name: D.info ? D.info.name : null, kind: D.info ? D.info.kind : null, transport: D.transport,
      angle: D.angle, steer: D.steer, rate: D.rate, fresh: fresh(t), waiting: !!D.dev && !D.lastT, latencyMs: D.lastLat, avgMs: avg,
      gyroSign: D.filter ? D.filter.gyroSign : 1, trust: D.filter ? D.filter.trust : 0
    };
  };
  if (hasDOM && hid() && hid().addEventListener) {
    hid().addEventListener('disconnect', function (e) {
      if (e && e.device === D.dev) { closeDevice(); toast('Controller tilt: controller disconnected', 'bad'); updateChip(); }
    });
    hid().addEventListener('connect', function (e) {
      if (D.wantOn && !D.dev && e && kindOf(e.device)) openDevice(e.device).then(function (r) { if (r.ok) toast('Controller tilt: ' + r.name + ' connected', 'ok'); });
    });
  }

  /* ---------------------------------------------------------------- HUD indicator + status chip */
  function statusText() {
    var s = P.state();
    if (!s.connected) return { cls: 'bad', text: D.wantOn ? 'No controller open · Connect it again' : 'Not connected' };
    if (s.waiting) return { cls: '', text: s.name + ' · waiting for motion data…' };
    if (!s.fresh) return { cls: 'bad', text: s.name + ' · no motion data (sleeping?)' };
    return { cls: 'ok', text: s.name + (s.transport ? ' (' + s.transport + ')' : '') + ' · ' + (s.angle >= 0 ? '+' : '') + Math.round(s.angle) + '° · ' + s.rate + ' Hz' + (s.avgMs != null ? ' · ' + s.avgMs.toFixed(1) + ' ms to the car' : '') };
  }
  var CHIP_CSS = '.pt-chip{position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:2147482000;display:flex;align-items:center;gap:8px;padding:6px 12px 6px 10px;border-radius:999px;background:rgba(8,9,11,.82);border:1px solid var(--line-2,#3a3b44);color:var(--text,#ecebe6);font:600 11.5px var(--font,system-ui,sans-serif);font-variant-numeric:tabular-nums;cursor:pointer}' +
    '.pt-chip.up{bottom:56px} .pt-chip .ss-dot{width:8px;height:8px;border-radius:50%;background:var(--warn,#e3a33a)} .pt-chip .ss-dot.ok{background:var(--good,#3fbf7f)} .pt-chip .ss-dot.bad{background:var(--bad,#e5484d)}';
  function updateChip() {
    if (!hasDOM || !document.body) return;
    var st = H() && H().status ? H().status() : {};
    var show = (D.dev || D.wantOn) && !st.driving;
    if (!show) { if (D.chip) D.chip.style.display = 'none'; return; }
    if (!D.chip) {
      if (!document.getElementById('pt-css')) { var c = document.createElement('style'); c.id = 'pt-css'; c.textContent = CHIP_CSS; document.head.appendChild(c); }
      D.chip = document.createElement('button'); D.chip.type = 'button'; D.chip.className = 'pt-chip'; D.chip.title = 'Controller tilt · click to re-centre';
      D.chip.addEventListener('click', function () { if (D.dev) { P.recentre(); toast('Controller tilt: centred', 'ok'); } else P.connect().then(function (r) { if (!r.ok) toast(reasonText(r.reason), 'bad'); }); });
      document.body.appendChild(D.chip);
    }
    var pc = document.querySelector('.pw-chip');
    D.chip.classList.toggle('up', !!(pc && pc.style.display !== 'none'));
    var t = statusText();
    D.chip.style.display = '';
    D.chip.innerHTML = '<span class="ss-dot ' + t.cls + '"></span><span>Controller tilt · ' + esc(t.text) + '</span>';
  }
  function loop() {
    D.raf = 0;
    if (!D.dev && !D.wantOn) { if (D.hud) D.hud.hide(); updateChip(); return; }
    var st = H() && H().status ? H().status() : {};
    if (st.driving && !st.paused && D.dev) {
      if (!D.hud) D.hud = SS() && SS().hud ? SS().hud('padtilt') : null;
      var f = fresh();
      if (D.hud) D.hud.show(f ? D.steer : 0, 'Controller tilt ' + (f ? (D.angle >= 0 ? '+' : '') + Math.round(D.angle) + '°' : '· no motion data'), f ? '' : 'Move the controller (or reconnect it) to wake its motion sensor');
    } else if (D.hud) D.hud.hide();
    D.raf = requestAnimationFrame(loop);
  }
  var chipTimer = 0;
  function startLoops() {
    if (!hasDOM) return;
    if (!D.raf) D.raf = requestAnimationFrame(loop);
    if (!chipTimer) chipTimer = setInterval(updateChip, 250);
  }

  /* ---------------------------------------------------------------- steering-source picker entry */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function detailHTML() {
    var p = P.prefs, s = P.supported(), st = P.state();
    if (!s.ok) return '<div class="ss-hint"><b>' + esc(reasonText(s.reason)) + '</b></div>';
    function seg(key, cur, opts) {
      return '<div class="ss-chipseg">' + opts.map(function (o) { return '<button type="button" data-pt-seg="' + key + '" data-v="' + o[0] + '" class="' + (String(cur) === String(o[0]) ? 'is-on' : '') + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>';
    }
    return '<div class="ss-hint">DualSense, DualShock 4, Switch Pro Controller or one Joy-Con held sideways, by USB or Bluetooth. Hold it like a small wheel and turn it; sticks, triggers and buttons keep working. Press <b>R3</b> (Joy-Con: the stick) or click the status chip to re-centre.</div>' +
      '<div class="ss-row"><button class="gh-btn small" type="button" data-pt-act="connect">' + (st.connected ? 'Connected: ' + esc(st.name) + ' · pick another' : 'Connect controller') + '</button>' +
      '<button class="gh-btn small" type="button" data-pt-act="centre"' + (st.connected ? '' : ' disabled') + '>Re-centre</button>' +
      (st.connected ? '<button class="gh-btn small" type="button" data-pt-act="off">Disconnect</button>' : '') + '</div>' +
      '<div class="ss-row"><span>Full lock (lock to lock)</span>' + seg('lock', p.lock, [[90, '90°'], [180, '180°'], [270, '270°']]) + '</div>' +
      '<label class="ss-row"><span>Dead zone</span><input type="range" min="0" max="10" step="0.5" value="' + p.deadzone + '" data-pt-pref="deadzone"><b>' + p.deadzone + '°</b></label>' +
      '<div class="ss-row"><span>Invert</span>' + seg('invert', p.invert ? '1' : '0', [['0', 'Normal'], ['1', 'Inverted']]) + '</div>';
  }
  function bindDetail(host) {
    if (!host) return;
    host.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('[data-pt-act],[data-pt-seg]');
      if (!a) return;
      e.preventDefault();
      var act = a.getAttribute('data-pt-act');
      if (act === 'connect') {
        P.connect().then(function (r) { toast(r.ok ? 'Controller tilt: ' + (r.name || 'controller') + ' connected. Hold it straight and press R3 to centre.' : reasonText(r.reason), r.ok ? 'ok' : 'bad'); var S = SS(); if (S && S.refresh) S.refresh(); });
      } else if (act === 'centre') { P.recentre(); toast('Controller tilt: centred', 'ok'); }
      else if (act === 'off') { P.disconnect(); var S2 = SS(); if (S2) { S2.select('default'); S2.refresh(); } }
      else {
        var k = a.getAttribute('data-pt-seg'), v = a.getAttribute('data-v'), o = {};
        o[k] = k === 'invert' ? v === '1' : +v; P.setPrefs(o);
        Array.prototype.forEach.call(a.parentNode.children, function (c) { c.classList.toggle('is-on', c === a); });
      }
    });
    host.addEventListener('input', function (e) {
      if (!e.target || e.target.getAttribute('data-pt-pref') !== 'deadzone') return;
      P.setPrefs({ deadzone: +e.target.value });
      if (e.target.nextSibling) e.target.nextSibling.textContent = e.target.value + '°';
    });
  }
  function defineSource() {
    var S = SS();
    if (!S || !S.define) return;
    S.define('padtilt', {
      name: 'Controller tilt', short: 'Tilt pad',
      hint: 'Tilt a PlayStation or Switch controller like a wheel: its gyro is read straight over USB / Bluetooth (no network).',
      available: function () { var s = P.supported(); return s.ok ? { ok: true } : { ok: false, reason: s.reason === 'insecure' ? 'Needs HTTPS' : 'Needs Chrome / Edge (WebHID)' }; },
      enable: function () {
        D.wantOn = true; startLoops();
        return P.connect().then(function (r) { if (!r.ok) toast(reasonText(r.reason), 'bad'); else toast('Controller tilt: ' + r.name + ' connected. Hold it straight and press R3 to centre.', 'ok'); return r; });
      },
      disable: function () { P.disconnect(); },
      isOn: function () { return !!D.dev || D.wantOn; },
      detailHTML: detailHTML, bindDetail: bindDetail, status: statusText,
      menuItems: function () {
        return [
          { label: 'Controller tilt: re-centre', icon: 'steer', fn: function () { P.recentre(); toast('Controller tilt: centred', 'ok'); } },
          { label: D.dev ? 'Controller tilt: ' + D.info.name : 'Controller tilt: connect', icon: 'steer', fn: function () { P.connect().then(function (r) { toast(r.ok ? 'Controller tilt: ' + r.name + ' connected' : reasonText(r.reason), r.ok ? 'ok' : 'bad'); }); } }
        ];
      }
    });
    // a controller this site was allowed to use before: re-open it silently (no prompt needed)
    if (S.selected() === 'padtilt' && hasDOM && P.supported().ok) { D.wantOn = true; startLoops(); P.restore(); }
  }
  defineSource();

  P._D = D;
  CB.input.padTilt = P;
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})();

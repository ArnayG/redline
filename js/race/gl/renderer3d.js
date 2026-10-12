/* ==========================================================================
   FORGE Atelier — js/race/gl/renderer3d.js
   CB.race.renderer3d : real-time 3D race renderer (cockpit / chase / TV / heli) assembling the CB.gl modules.

   Contract (RACE3D-SPEC.md) — SAME interface as CB.race.renderer:
     CB.race.renderer3d.isSupported() -> bool
     CB.race.renderer3d.create(canvas, geom, trackDef, opts {timeOfDay, weather, quality, camera, racingLine, autoQuality})
       -> { render(snap, alpha?), setCamera(mode), cycleCamera(), getCamera(), resize(), destroy(), setQuality(q),
            setLookBack(bool), getQuality(), reset(), setRacingLine(bool), setLabels(bool), stats(), cameraModes() }

   Design notes
   ------------
   * `canvas` is the HUD 2D canvas owned by race-ui. We insert our own WebGL canvas directly BEFORE it (same parent,
     absolutely positioned to cover it exactly, pointer-events none), make the 2D canvas transparent and clear it each
     frame so the HUD (drawn after render()) overlays the 3D view. 'map' mode hides the GL canvas and delegates to the
     2D CB.race.renderer drawing into the HUD canvas.
   * World axes: sim (x, y) -> GL (x, z = -y), up = +Y. Car-local axes: +X forward, +Y up, +Z right; a car's world
     matrix is T(x, elev, -y) * Ry(heading) * Rz(pitch) * Rx(roll)  (Ry(h) maps +X to the sim heading direction).
   * Every CB.gl sub-module (track, scenery, car, cockpit, effects, shadows) is optional at runtime: missing pieces are
     replaced by simple built-in fallbacks (flat road ribbon + walls, box cars) so the view never goes black. Only the
     gl-core essentials (createContext, shaders, drawList, createMesh) are required (isSupported() checks them).
   * Cameras are spring-damped (critically damped implicit springs, stable at any dt), with speed FOV, trauma shake
     (events, kerbs, high speed), wall-safe chase boom, look-back, g-force head motion, TV broadcast cams that cut by
     track distance and a slow heli orbit.
   * Post FX are self-contained here (own shaders + render targets): WebGL2 MSAA resolve, bloom (bright pass + separable
     blur at 1/4 res), radial speed blur, FXAA when no MSAA, vignette, grade, optional ACES tonemap + gamma.
   * Adaptive quality: if the frame time EMA exceeds 22 ms for 2 s, quality steps down one level (ultra->high->medium->low).
   * Pure helpers (math, springs, frustum, TV cam placement, chase wall safety, lighting presets, governor, fallback
     geometry) are exported on `._` and load in Node without any DOM access.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

CB.race.renderer3d = (function () {
  'use strict';

  var TAU = Math.PI * 2, PI = Math.PI, DEG = Math.PI / 180;

  var CAMERA_MODES = ['cockpit', 'hood', 'bumper', 'chase', 'chase-far', 'tv', 'heli', 'map'];
  var CAMERA_LABELS = {
    cockpit: 'Cockpit', hood: 'Hood', bumper: 'Bumper', chase: 'Chase', 'chase-far': 'Chase (far)',
    tv: 'TV broadcast', heli: 'Helicopter', map: 'Map (2D)'
  };
  var MODE_ALIASES = {
    north: 'map', '2d': 'map', top: 'map', topdown: 'map', 'top-down': 'map', overhead: 'map', birdseye: 'map',
    interior: 'cockpit', 'first-person': 'cockpit', firstperson: 'cockpit', fp: 'cockpit', fpv: 'cockpit', driver: 'cockpit',
    bonnet: 'hood', bumpercam: 'bumper', nose: 'bumper',
    'third-person': 'chase', third: 'chase', thirdperson: 'chase', follow: 'chase', 'chase-near': 'chase',
    far: 'chase-far', chasefar: 'chase-far', 'chase_far': 'chase-far',
    broadcast: 'tv', trackside: 'tv', helicopter: 'heli', orbit: 'heli', aerial: 'heli'
  };

  /* ------------------------------------------------------------- quality */
  var QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];
  var QUALITY = {
    low: {
      maxDpr: 1, scale: 0.85, shadow: 0, post: false, bloom: false, msaa: 0, fxaa: false, speedBlur: false,
      mirrorEvery: 4, mirrorScale: 0.16, lodNear: 22, maxHigh: 2, far: 1500, particles: 300, effectsNear: 90, grain: 0,
      nearShadow: 0, nearRadius: 0
    },
    medium: {
      maxDpr: 1.25, scale: 1, shadow: 1024, post: true, bloom: false, msaa: 2, fxaa: true, speedBlur: true,
      mirrorEvery: 2, mirrorScale: 0.2, lodNear: 40, maxHigh: 4, far: 2000, particles: 700, effectsNear: 140, grain: 0,
      nearShadow: 1024, nearRadius: 16
    },
    high: {
      maxDpr: 1.5, scale: 1, shadow: 2048, post: true, bloom: true, msaa: 4, fxaa: true, speedBlur: true,
      mirrorEvery: 2, mirrorScale: 0.25, lodNear: 65, maxHigh: 6, far: 2600, particles: 1400, effectsNear: 200, grain: 0.012,
      nearShadow: 2048, nearRadius: 18
    },
    ultra: {
      maxDpr: 2, scale: 1, shadow: 4096, post: true, bloom: true, msaa: 4, fxaa: true, speedBlur: true,
      mirrorEvery: 1, mirrorScale: 0.3, lodNear: 120, maxHigh: 12, far: 3400, particles: 2600, effectsNear: 300, grain: 0.014,
      nearShadow: 2048, nearRadius: 22
    }
  };
  function normQuality(q) { return QUALITY[q] ? q : (q === 'med' ? 'medium' : q === 'max' || q === 'epic' ? 'ultra' : null); }

  /* -------------------------------------------------------------- optional graphics modules (lazy script load)
     CB.gl.envmap (reflection probe) and CB.gl.post (HDR post chain) are optional. Pages that do not list their
     <script> tags get them injected next to this file (same directory) on first create(); the renderer picks them
     up as soon as they have loaded (every per-frame use is feature-detected), and runs without them until then. */
  var SELF_DIR = (function () {
    try {
      var cs = typeof document !== 'undefined' && document.currentScript;
      var src = cs && cs.src ? String(cs.src) : '';
      return src ? src.replace(/[^\/]*$/, '') : '';
    } catch (e) { return ''; }
  })();
  var OPTIONAL_MODULES = [['envmap', 'envmap.js'], ['post', 'post.js']];
  function ensureOptionalModules(doc) {
    if (!doc || typeof doc.createElement !== 'function' || !SELF_DIR) return;
    var gl = (globalThis.CB && globalThis.CB.gl) || {};
    for (var i = 0; i < OPTIONAL_MODULES.length; i++) {
      var key = OPTIONAL_MODULES[i][0], file = OPTIONAL_MODULES[i][1];
      if (gl[key]) continue;
      var url = SELF_DIR + file, have = false;
      try {
        var tags = doc.getElementsByTagName('script');
        for (var j = 0; j < tags.length; j++) { var ts = tags[j].getAttribute('src') || ''; if (tags[j].src === url || /(^|\/)js\/race\/gl\//.test(ts) && ts.slice(-file.length - 1) === '/' + file) { have = true; break; } }
        if (have) continue;
        var el = doc.createElement('script');
        el.src = url; el.async = true; el.charset = 'utf-8'; el.setAttribute('data-forge-optional', key);
        (doc.head || doc.documentElement).appendChild(el);
      } catch (e) { /* optional */ }
    }
  }

  /* ================================================================ utilities */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function smoothstep(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  function wrapAngle(a) { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; }
  function lerpAngle(a, b, t) { return a + wrapAngle(b - a) * t; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function hexToRgb(hex, fallback) {
    if (Array.isArray(hex) && hex.length >= 3) return [hex[0], hex[1], hex[2]];
    if (typeof hex !== 'string') return fallback || [0.8, 0.8, 0.8];
    var h = hex.replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}/.test(h)) return fallback || [0.8, 0.8, 0.8];
    var n = parseInt(h.slice(0, 6), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /** sim (x, y) -> GL [x, h, -y] */
  function simToGL(x, y, h, out) { out = out || [0, 0, 0]; out[0] = x; out[1] = h || 0; out[2] = -y; return out; }

  /* -------------------------------------------------------------- mat4 / vec3 (column-major, gl-matrix style) */
  var m4 = {
    create: function () { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    identity: function (o) { for (var i = 0; i < 16; i++) o[i] = (i % 5 === 0) ? 1 : 0; return o; },
    copy: function (o, a) { for (var i = 0; i < 16; i++) o[i] = a[i]; return o; },
    multiply: function (o, a, b) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      for (var c = 0; c < 4; c++) {
        var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        o[c * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        o[c * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        o[c * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        o[c * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      }
      return o;
    },
    perspective: function (o, fovy, aspect, near, far) {
      var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      for (var i = 0; i < 16; i++) o[i] = 0;
      o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
      return o;
    },
    lookAt: function (o, eye, center, up) {
      var z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
      var l = Math.hypot(z0, z1, z2) || 1; z0 /= l; z1 /= l; z2 /= l;
      var x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
      l = Math.hypot(x0, x1, x2);
      if (l < 1e-6) { x0 = 1; x1 = 0; x2 = 0; } else { x0 /= l; x1 /= l; x2 /= l; }
      var y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
      o[0] = x0; o[1] = y0; o[2] = z0; o[3] = 0;
      o[4] = x1; o[5] = y1; o[6] = z1; o[7] = 0;
      o[8] = x2; o[9] = y2; o[10] = z2; o[11] = 0;
      o[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
      o[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
      o[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
      o[15] = 1;
      return o;
    },
    invert: function (o, a) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
        b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
        b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return null;
      det = 1 / det;
      o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return o;
    }
  };

  /** World matrix of a car: T(x, elev, -y) * Ry(heading) * Rz(pitch) * Rx(roll). Car-local +X fwd, +Y up, +Z right. */
  function carMatrix(o, x, y, elev, heading, pitch, roll) {
    var ch = Math.cos(heading), sh = Math.sin(heading);
    var cp = Math.cos(pitch || 0), sp = Math.sin(pitch || 0);
    var cr = Math.cos(roll || 0), sr = Math.sin(roll || 0);
    // R = Ry * Rz * Rx (columns = images of local X, Y, Z)
    // Rz*Rx columns: X' = (cp, sp, 0); Y' = (-sp*cr, cp*cr, sr); Z' = (sp*sr, -cp*sr, cr)
    // Ry maps (a, b, c) -> (a*ch + c*sh, b, -a*sh + c*ch)
    var X0 = cp, X1 = sp, X2 = 0;
    var Y0 = -sp * cr, Y1 = cp * cr, Y2 = sr;
    var Z0 = sp * sr, Z1 = -cp * sr, Z2 = cr;
    o[0] = X0 * ch + X2 * sh; o[1] = X1; o[2] = -X0 * sh + X2 * ch; o[3] = 0;
    o[4] = Y0 * ch + Y2 * sh; o[5] = Y1; o[6] = -Y0 * sh + Y2 * ch; o[7] = 0;
    o[8] = Z0 * ch + Z2 * sh; o[9] = Z1; o[10] = -Z0 * sh + Z2 * ch; o[11] = 0;
    o[12] = x; o[13] = elev || 0; o[14] = -y; o[15] = 1;
    return o;
  }
  function xformPoint(m, x, y, z, out) {
    out = out || [0, 0, 0];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
  }
  function xformDir(m, x, y, z, out) {
    out = out || [0, 0, 0];
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
    return out;
  }
  function v3norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; }

  /* -------------------------------------------------------------- springs */
  /** Critically damped spring, implicit integration (unconditionally stable). s = {x, v}. Returns new x. */
  function spring(s, target, omega, dt) {
    if (!(dt > 0)) return s.x;
    var f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, det = 1 / (f + hhoo);
    var x = (f * s.x + dt * s.v + hhoo * target) * det;
    s.v = (s.v + hoo * (target - s.x)) * det;
    s.x = x;
    return x;
  }
  function springSet(s, x) { s.x = x; s.v = 0; return x; }
  function mkSpring(x) { return { x: x || 0, v: 0 }; }
  function mkSpring3() { return [mkSpring(), mkSpring(), mkSpring()]; }
  function spring3(s3, t, omega, dt, out) {
    out = out || [0, 0, 0];
    out[0] = spring(s3[0], t[0], omega, dt); out[1] = spring(s3[1], t[1], omega, dt); out[2] = spring(s3[2], t[2], omega, dt);
    return out;
  }
  function spring3Set(s3, t) { springSet(s3[0], t[0]); springSet(s3[1], t[1]); springSet(s3[2], t[2]); }

  /** Speed-dependent FOV (degrees): base at low speed easing to max at ~vmax m/s. */
  function fovForSpeed(speed, base, max, vmin, vmax) {
    base = num(base, 60); max = num(max, 75);
    return base + (max - base) * smoothstep(num(vmin, 8), num(vmax, 85), Math.abs(num(speed, 0)));
  }

  /** Smooth pseudo-random noise in [-1, 1] for camera shake. */
  function shakeNoise(t, seed) {
    return Math.sin(t * 13.13 + seed) * 0.5 + Math.sin(t * 27.71 + seed * 2.31) * 0.3 + Math.sin(t * 51.37 + seed * 4.13) * 0.2;
  }

  /* -------------------------------------------------------------- pose interpolation */
  /** Interpolated pose of a snapshot car using its engine substep prevX/prevY/prevHeading. Teleports are not lerped. */
  function interpolatePose(car, alpha, out) {
    out = out || {};
    var x = num(car.x, 0), y = num(car.y, 0), h = num(car.heading, 0);
    var a = clamp01(num(alpha, 1));
    if (isNum(car.prevX) && isNum(car.prevY) && isNum(car.prevHeading) && a < 1) {
      var dx = x - car.prevX, dy = y - car.prevY;
      if (dx * dx + dy * dy < 36) {
        x = car.prevX + dx * a; y = car.prevY + dy * a;
        h = lerpAngle(car.prevHeading, h, a);
      }
    }
    out.x = x; out.y = y; out.heading = h;
    return out;
  }

  /* -------------------------------------------------------------- frustum */
  function frustumPlanes(vp, out) {
    out = out || new Float32Array(24);
    var r0 = [vp[0], vp[4], vp[8], vp[12]], r1 = [vp[1], vp[5], vp[9], vp[13]];
    var r2 = [vp[2], vp[6], vp[10], vp[14]], r3 = [vp[3], vp[7], vp[11], vp[15]];
    var P = [
      [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]],
      [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]],
      [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]],
      [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]],
      [r3[0] + r2[0], r3[1] + r2[1], r3[2] + r2[2], r3[3] + r2[3]],
      [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]]
    ];
    for (var i = 0; i < 6; i++) {
      var p = P[i], l = Math.hypot(p[0], p[1], p[2]) || 1;
      out[i * 4] = p[0] / l; out[i * 4 + 1] = p[1] / l; out[i * 4 + 2] = p[2] / l; out[i * 4 + 3] = p[3] / l;
    }
    return out;
  }
  function sphereInFrustum(pl, x, y, z, r) {
    for (var i = 0; i < 24; i += 4) {
      if (pl[i] * x + pl[i + 1] * y + pl[i + 2] * z + pl[i + 3] < -r) return false;
    }
    return true;
  }
  /** Local bounding sphere [cx, cy, cz, r] from a mesh `bounds` ({min,max} | {center,radius} | [6]). */
  function boundsSphere(b) {
    if (!b) return null;
    if (b.center && isNum(b.radius)) return [b.center[0], b.center[1], b.center[2], b.radius];
    var mn = b.min, mx = b.max;
    if (!mn && b.length === 6) { mn = [b[0], b[1], b[2]]; mx = [b[3], b[4], b[5]]; }
    if (!mn || !mx) return null;
    var cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
    var r = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2;
    if (!isFinite(r)) return null;
    return [cx, cy, cz, r];
  }
  function worldSphere(ls, m) {
    if (!ls) return null;
    if (!m) return ls.slice();
    var c = xformPoint(m, ls[0], ls[1], ls[2]);
    var sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    return [c[0], c[1], c[2], ls[3] * Math.max(sx, sy, sz)];
  }

  /* -------------------------------------------------------------- track helpers (pure) */
  function samplesOf(geom) { return (geom && (geom.samples || geom.centerline)) || []; }
  function sampleIndexAt(geom, s) {
    var S = samplesOf(geom), N = S.length;
    if (!N) return 0;
    var L = num(geom.length, num(geom.length_m, 0));
    var ds = num(geom.ds, L > 0 ? L / N : 2);
    return mod(Math.round(num(s, 0) / ds), N);
  }

  /** Is sim point (x, y) safely inside the barriers? Uses geom.project (surface 'wall' / wallDist). */
  function insideWalls(geom, x, y, hint, margin) {
    if (!geom || typeof geom.project !== 'function') return true;
    var r;
    try { r = geom.project(x, y, hint); } catch (e) { return true; }
    if (!r) return true;
    if (r.surface === 'wall') return false;
    if (isNum(r.wallDist)) return r.wallDist > num(margin, 0.4);
    return true;
  }
  /** Fraction t in [0,1] of the boom from car (cx,cy) towards desired camera (px,py) that stays inside the walls. */
  function chaseSafeFraction(geom, cx, cy, px, py, hint, margin) {
    if (insideWalls(geom, px, py, hint, margin)) return 1;
    if (!insideWalls(geom, cx, cy, hint, 0)) return 1; // car itself is outside: nothing sensible to clamp against
    var lo = 0, hi = 1;
    for (var k = 0; k < 7; k++) {
      var mid = (lo + hi) / 2;
      if (insideWalls(geom, lerp(cx, px, mid), lerp(cy, py, mid), hint, margin)) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** Deterministic PRNG. */
  function rng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s >>> 0) / 4294967296; };
  }
  function hashStr(str) {
    var h = 2166136261;
    str = String(str || '');
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /** TV broadcast camera placement: trackside, outside of the upcoming corner, beyond the barriers. */
  /** scenery types (CB.gl.scenery placed[].type) a broadcast camera must not stand inside */
  var TV_BLOCKERS = { building: 1, city: 1, grandstand: 1, pits: 1, tower: 1, 'tv-tower': 1, 'footbridge-tower': 1, truck: 1, tent: 1, tree: 1 };
  /** thin scenery that must not stand in the line of sight just in front of a broadcast camera */
  var LOS_BLOCKERS = { lamp: 1, 'gantry-pillar': 1, 'tv-tower': 1, tree: 1, 'footbridge-tower': 1 };
  function buildTvCams(geom, opts) {
    opts = opts || {};
    var S = samplesOf(geom), N = S.length;
    if (N < 8) return [];
    var L = num(geom.length, num(geom.length_m, N * 2));
    var ds = num(geom.ds, L / N);
    var spacing = num(opts.spacing, clamp(L / 14, 140, 320));
    var r = rng(hashStr((geom.id || 'track') + ':tv'));
    var cams = [];
    var look = Math.max(4, Math.round(90 / ds));
    var blockers = opts.blockers && opts.blockers.length ? opts.blockers : null;
    for (var s = spacing * 0.35; s < L - spacing * 0.3; s += spacing) {
      var i = mod(Math.round(s / ds), N), k = 0, j;
      for (j = 0; j < look; j++) k += num(S[(i + j) % N].curvature, 0);
      var pref = k > 0 ? -1 : 1; // turning left (curvature > 0): stand on the right (outside, side -1)
      var placed = null;
      for (var attempt = 0; attempt < 10 && !placed; attempt++) {
        var side = attempt % 2 === 0 ? pref : -pref;
        var sm = S[i], hw = num(sm.hw, num(sm.width, 12) / 2);
        var wall = side > 0 ? num(sm.wallL, hw + 4) : num(sm.wallR, hw + 4);
        // far -> farther -> just behind the barrier (street circuits: on the pavement in front of the buildings)
        var off = attempt >= 8 ? wall + 0.4 : attempt >= 6 ? wall + 1.4 : attempt >= 4 ? wall + 2.8 : wall + 5 + r() * 6 + (attempt >= 2 ? 10 : 0);
        var nx = num(sm.nx, -Math.sin(num(sm.heading, 0))), ny = num(sm.ny, Math.cos(num(sm.heading, 0)));
        var x = sm.x + nx * off * side, y = sm.y + ny * off * side;
        var ok = true;
        if (typeof geom.project === 'function') {
          try {
            var p = geom.project(x, y);
            if (p && p.surface !== 'wall' && !(isNum(p.wallDist) && p.wallDist < -1.5)) ok = false;
          } catch (e) { ok = true; }
        }
        // never inside / against scenery (city blocks, grandstands, pit buildings, trees)
        // last resort (attempt 8/9): a pole camera right on the barrier line, which scenery always keeps clear
        if (ok && blockers && attempt < 8) {
          for (var bi = 0; bi < blockers.length && ok; bi++) {
            var bo = blockers[bi];
            if (bo && isNum(bo.x) && isNum(bo.y) && TV_BLOCKERS[bo.type] && Math.hypot(x - bo.x, y - bo.y) < num(bo.r, 2) + 1.5) ok = false;
          }
        }
        // thin vertical obstructions (lamp poles, gantry legs, tv towers, trees) right in front of the lens
        if (ok && blockers && attempt < 8) {
          for (var lk = 0; lk <= 3 && ok; lk++) {
            var tsm = S[(i + Math.round(look * (lk - 1) / 3) + N) % N];
            if (!tsm || !isNum(tsm.x)) continue;
            for (bi = 0; bi < blockers.length && ok; bi++) {
              bo = blockers[bi];
              if (!bo || !LOS_BLOCKERS[bo.type] || !isNum(bo.x) || !isNum(bo.y)) continue;
              var bdx = bo.x - x, bdy = bo.y - y, bd = Math.hypot(bdx, bdy);
              if (bd > 32 || bd < 0.01) continue;
              var sdx = tsm.x - x, sdy = tsm.y - y, sl = Math.hypot(sdx, sdy) || 1;
              var along = (bdx * sdx + bdy * sdy) / sl;
              if (along <= 0 || along >= sl) continue;
              var perp = Math.abs(bdx * sdy - bdy * sdx) / sl;
              if (perp < num(bo.r, 0.5) + 0.9) ok = false;
            }
          }
        }
        if (ok) placed = { s: s, index: i, x: x, y: y, h: 7.5 + r() * 5, side: side };   // above catch fences (top ~6 m on ovals)
      }
      if (placed) cams.push(placed);
    }
    return cams;
  }
  /* -------------------------------------------------------------- camera occluders (pure) */
  /** Tall scenery volumes (sim coords: x, y; heights in metres) for camera line-of-sight tests. Authored items
      (geom.scenery: l/w/h/rot) become oriented boxes; procedural scenery (CB.gl.scenery placed[]) becomes boxes
      aligned with the nearest track heading (grandstands / pits) or circles (city blocks, towers, trees).
      groundY(glX, glZ) gives the base height (optional). */
  var OCC_DEFAULT_H = { building: 12, city: 18, grandstand: 15, pits: 8, tower: 20, 'tv-tower': 12.5, 'footbridge-tower': 8, tent: 4, truck: 4, tree: 10 };
  function buildOccluders(geom, placed, groundY) {
    var out = [];
    var proj = (CB.race && CB.race.tracks && typeof CB.race.tracks.project === 'function') ? function (x, y) { return CB.race.tracks.project(geom, x, y); }
      : (geom && typeof geom.project === 'function' ? function (x, y) { return geom.project(x, y); } : null);
    function base(x, y) { if (!groundY) return 0; try { return num(groundY(x, -y), 0); } catch (e) { return 0; } }
    function headingAt(x, y) {
      if (!proj) return 0;
      try { var p = proj(x, y); return p && isNum(p.heading) ? p.heading : 0; } catch (e) { return 0; }
    }
    function box(x, y, rot, l, w, top, type) {
      var b = base(x, y);
      out.push({ type: type, x: x, y: y, c: Math.cos(rot), s: Math.sin(rot), hl: l / 2, hw: w / 2, br: Math.hypot(l, w) / 2, base: b - 1, top: b + top });
    }
    function circ(x, y, r, top, type) {
      var b = base(x, y);
      out.push({ type: type, x: x, y: y, r: r, br: r, base: b - 1, top: b + top });
    }
    var items = geom && geom.scenery && geom.scenery.length ? geom.scenery : [];
    for (var i = 0; i < items.length; i++) {
      var o = items[i];
      if (!o || !isNum(o.x) || !isNum(o.y) || !OCC_DEFAULT_H[o.type]) continue;
      if (o.variant === 'yacht') continue;
      var h = num(o.h, OCC_DEFAULT_H[o.type]);
      var top = o.type === 'grandstand' ? h * 1.3 + 2 : o.type === 'pits' ? h + 2.5 : o.type === 'tree' ? Math.max(h, 8) : h + 1;
      if (o.type === 'tree') { circ(o.x, o.y, num(o.r, 2.5) * 0.7, top, o.type); continue; }
      if (o.shape !== 'circle' && isNum(o.l) && isNum(o.w)) box(o.x, o.y, num(o.rot, 0), o.l, o.w, top, o.type);
      else circ(o.x, o.y, num(o.r, 3), top, o.type);
    }
    var P = placed || [];
    for (i = 0; i < P.length; i++) {
      var q = P[i];
      if (!q || q.authored || q.marker || !isNum(q.x) || !isNum(q.y) || !OCC_DEFAULT_H[q.type]) continue;
      var r = num(q.r, 2);
      if (q.type === 'grandstand') box(q.x, q.y, headingAt(q.x, q.y), Math.min(r * 2, 120), 20, 15 * 1.3 + 2, q.type);
      else if (q.type === 'pits') box(q.x, q.y, headingAt(q.x, q.y), Math.min(r * 2, 200), 14, 10.5, q.type);
      else if (q.type === 'city') circ(q.x, q.y, r * 0.85, num(q.h, 18) + 1, q.type);
      else if (q.type === 'tree') circ(q.x, q.y, r * 1.2, 9, q.type);
      else circ(q.x, q.y, Math.max(1.5, r), OCC_DEFAULT_H[q.type] + 1, q.type);
    }
    return out;
  }
  /** Occluders whose bounds come within `range` m of (x, y) (sim coords), written into `out`. */
  function occludersNear(occ, x, y, range, out) {
    out = out || [];
    out.length = 0;
    if (!occ) return out;
    for (var i = 0; i < occ.length; i++) {
      var o = occ[i], dx = o.x - x, dy = o.y - y, rr = range + o.br;
      if (dx * dx + dy * dy < rr * rr) out.push(o);
    }
    return out;
  }
  function occContains(o, x, y, z) {
    if (z > o.top || z < o.base) return false;
    var dx = x - o.x, dy = y - o.y;
    if (o.r != null) return dx * dx + dy * dy < o.r * o.r;
    var u = dx * o.c + dy * o.s, v = -dx * o.s + dy * o.c;
    return Math.abs(u) < o.hl && Math.abs(v) < o.hw;
  }
  /** Is the straight segment A -> B (sim x, y, height z) blocked by any occluder? Sampled every ~1.5 m. */
  function segmentBlocked(occ, ax, ay, az, bx, by, bz) {
    if (!occ || !occ.length) return false;
    var dx = bx - ax, dy = by - ay, dz = bz - az, L2 = dx * dx + dy * dy, L = Math.sqrt(L2 + dz * dz);
    var n = Math.max(4, Math.min(120, Math.ceil(L / 1.5)));
    for (var i = 0; i < occ.length; i++) {
      var o = occ[i];
      // 2D distance from the occluder centre to the segment: cheap reject
      var t0 = L2 > 1e-9 ? clamp(((o.x - ax) * dx + (o.y - ay) * dy) / L2, 0, 1) : 0;
      var cx = ax + dx * t0 - o.x, cy = ay + dy * t0 - o.y;
      if (cx * cx + cy * cy > o.br * o.br) continue;
      if (Math.min(az, bz) > o.top) continue;
      for (var k = 1; k <= n; k++) {
        var t = k / n;
        if (occContains(o, ax + dx * t, ay + dy * t, az + dz * t)) return true;
      }
    }
    return false;
  }
  /** Helicopter orbit candidates: [angle swing (rad), radius multiplier, height multiplier], best first. */
  var HELI_CANDIDATES = [[0, 1, 1], [0.55, 1, 1], [-0.55, 1, 1], [0, 0.75, 1.45], [1.15, 1, 1.1], [-1.15, 1, 1.1],
    [PI, 1, 1.1], [0, 0.5, 1.9], [0.8, 0.5, 1.9], [0, 0.22, 2.4]];
  /** First candidate index whose eye -> car line is clear (the last one, near top-down, as a fallback). */
  function pickHeliCandidate(occ, px, py, pz, a, R, H) {
    for (var i = 0; i < HELI_CANDIDATES.length; i++) {
      var c = HELI_CANDIDATES[i], A = a + c[0], r = R * c[1], h = H * c[2];
      var ex = px + Math.cos(A) * r, ey = py - Math.sin(A) * r, ez = pz + h;
      // line of sight to the car body centre (~0.9 m up)
      if (!segmentBlocked(occ, px, py, pz + 0.9, ex, ey, ez)) return i;
    }
    return HELI_CANDIDATES.length - 1;
  }

  /** Active TV cam for lap distance s: the last cam at or before s + lead (cyclic). */
  function pickTvCam(cams, s, L, lead) {
    if (!cams || !cams.length) return -1;
    var q = mod(num(s, 0) + num(lead, 0), L || 1), best = cams.length - 1;
    for (var i = 0; i < cams.length; i++) { if (cams[i].s <= q) best = i; else break; }
    return best;
  }

  /* -------------------------------------------------------------- lighting presets (pure) */
  function lightingFor(timeOfDay, weather) {
    var tod = timeOfDay === 'dusk' || timeOfDay === 'night' ? timeOfDay : 'day';
    var L;
    if (tod === 'day') {
      L = {
        sunDir: v3norm([-0.42, 0.78, -0.46]), sunColor: [1.28, 1.2, 1.06], sunIntensity: 1,
        ambientSky: [0.44, 0.52, 0.64], ambientGround: [0.24, 0.22, 0.17],
        fogColor: [0.70, 0.78, 0.88], fogDensity: 0.00075,
        envTop: [0.30, 0.50, 0.84], envHorizon: [0.80, 0.86, 0.93], envBottom: [0.26, 0.25, 0.22],
        headlights: false, exposure: 0.9, grade: { saturation: 1.06, contrast: 1.04, lift: [0, 0, 0.005], gain: [1, 1, 1] }
      };
    } else if (tod === 'dusk') {
      L = {
        sunDir: v3norm([0.82, 0.16, -0.55]), sunColor: [1.35, 0.74, 0.42], sunIntensity: 0.85,
        ambientSky: [0.34, 0.30, 0.44], ambientGround: [0.17, 0.12, 0.10],
        fogColor: [0.64, 0.46, 0.42], fogDensity: 0.0011,
        envTop: [0.18, 0.22, 0.44], envHorizon: [0.98, 0.58, 0.36], envBottom: [0.16, 0.12, 0.12],
        headlights: true, exposure: 1.0, grade: { saturation: 1.1, contrast: 1.06, lift: [0.01, 0.0, 0.02], gain: [1.04, 0.98, 0.95] }
      };
    } else {
      L = {
        sunDir: v3norm([0.3, 0.62, 0.42]), sunColor: [0.16, 0.19, 0.28], sunIntensity: 0.15,
        ambientSky: [0.07, 0.09, 0.15], ambientGround: [0.035, 0.035, 0.045],
        fogColor: [0.035, 0.045, 0.075], fogDensity: 0.0015,
        envTop: [0.01, 0.015, 0.04], envHorizon: [0.08, 0.09, 0.14], envBottom: [0.02, 0.02, 0.025],
        headlights: true, exposure: 1.1, grade: { saturation: 0.95, contrast: 1.08, lift: [0, 0.005, 0.02], gain: [0.96, 1, 1.06] }
      };
    }
    L.timeOfDay = tod;
    L.wetness = 0;
    if (weather === 'damp' || weather === 'wet') {
      var wet = weather === 'wet';
      var k = wet ? 0.45 : 0.75;
      L.sunColor = L.sunColor.map(function (c) { return c * k; });
      L.sunIntensity *= k;
      var grey = tod === 'night' ? [0.06, 0.065, 0.08] : tod === 'dusk' ? [0.45, 0.4, 0.42] : [0.6, 0.64, 0.68];
      L.fogColor = L.fogColor.map(function (c, i) { return lerp(c, grey[i], wet ? 0.75 : 0.4); });
      L.envHorizon = L.envHorizon.map(function (c, i) { return lerp(c, grey[i], wet ? 0.7 : 0.35); });
      L.envTop = L.envTop.map(function (c, i) { return lerp(c, grey[i] * 0.8, wet ? 0.7 : 0.35); });
      L.ambientSky = L.ambientSky.map(function (c) { return c * (wet ? 1.05 : 1.0); });
      L.fogDensity *= wet ? 2.6 : 1.6;
      L.wetness = wet ? 1 : 0.45;
      L.headlights = L.headlights || wet;
      L.grade.saturation *= wet ? 0.82 : 0.92;
    }
    L.weather = weather || 'dry';
    return L;
  }

  /* -------------------------------------------------------------- dynamic lights (pure) */
  /** Pick up to `max` lights: higher `priority` first, then nearest to camPos. */
  function pickLights(cands, camPos, max, scratch) {
    max = max == null ? 8 : max;
    var scored = scratch ? (scratch.scored || (scratch.scored = [])) : [], pool = scratch ? (scratch.pool || (scratch.pool = [])) : null;
    scored.length = 0;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c || !c.pos) continue;
      var d = Math.hypot(c.pos[0] - camPos[0], c.pos[1] - camPos[1], c.pos[2] - camPos[2]);
      var rng2 = num(c.range, 40);
      if (d > rng2 * 3 + 60 && !(c.priority > 0)) continue;
      var sc;
      if (pool) { sc = pool[scored.length] || (pool[scored.length] = { c: null, k: 0 }); sc.c = c; sc.k = d - num(c.priority, 0) * 10000; }
      else sc = { c: c, k: d - num(c.priority, 0) * 10000 };
      scored.push(sc);
    }
    scored.sort(byLightK);
    var out = scratch ? (scratch.out || (scratch.out = [])) : [];
    out.length = 0;
    for (i = 0; i < scored.length && out.length < max; i++) out.push(scored[i].c);
    if (pool) for (i = 0; i < scored.length; i++) scored[i].c = null;
    return out;
  }
  function byLightK(a, b) { return a.k - b.k; }
  var DOWN3 = [0, -1, 0], ZERO3 = [0, 0, 0];
  function packLights(list, env) {
    var n = Math.min(8, list.length);
    var P = env.lightPos || new Float32Array(24), D = env.lightDir || new Float32Array(24);
    var C = env.lightColor || new Float32Array(24), Q = env.lightParams || new Float32Array(32);
    for (var i = 0; i < 8; i++) {
      var l = i < n ? list[i] : null;
      P[i * 3] = l ? l.pos[0] : 0; P[i * 3 + 1] = l ? l.pos[1] : 0; P[i * 3 + 2] = l ? l.pos[2] : 0;
      var d = l && l.dir ? l.dir : DOWN3;
      D[i * 3] = d[0]; D[i * 3 + 1] = d[1]; D[i * 3 + 2] = d[2];
      var c = l ? l.color : ZERO3;
      C[i * 3] = c[0]; C[i * 3 + 1] = c[1]; C[i * 3 + 2] = c[2];
      Q[i * 4] = l ? num(l.range, 40) : 0;
      Q[i * 4 + 1] = l ? num(l.cosInner, 1) : 1;
      Q[i * 4 + 2] = l ? num(l.cosOuter, 0.9) : 0.9;
      Q[i * 4 + 3] = l ? num(l.type, l.dir ? 1 : 0) : -1;
    }
    var EL = env.lights && env.lights !== list ? env.lights : [];
    EL.length = 0;
    for (i = 0; i < n; i++) EL.push(list[i]);
    env.lights = EL; env.lightCount = n; env.numLights = n;
    env.lightPos = P; env.lightDir = D; env.lightColor = C; env.lightParams = Q;
    env.uLightPos = P; env.uLightDir = D; env.uLightColor = C; env.uLightParams = Q; env.uLightCount = n;
    return env;
  }

  /* -------------------------------------------------------------- GPU frame timer (WebGL2 timer query, optional) */
  /** GPU time of whole frames via EXT_disjoint_timer_query_webgl2. Results arrive a few frames late; poll()
      returns the latest valid measurement in ms, or -1 when none is available (extension missing on most
      macOS / Safari builds -> the governor falls back to interval probing). */
  function createGpuTimer(gl) {
    if (!gl || typeof gl.createQuery !== 'function' || typeof gl.getExtension !== 'function') return null;
    var ext = null;
    try { ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch (e) { ext = null; }
    if (!ext) return null;
    var pool = [], pending = [], active = null, last = -1, broken = false;
    var T = {
      begin: function () {
        if (broken) return;
        if (active) T.end();
        if (pending.length > 4) return;
        try { var q = pool.length ? pool.pop() : gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); active = q; } catch (e) { broken = true; active = null; }
      },
      end: function () {
        if (!active) return;
        try { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); } catch (e) { broken = true; }
        active = null;
      },
      poll: function () {
        if (broken || !pending.length) return last;
        try {
          var disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
          while (pending.length) {
            var q = pending[0];
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
            pending.shift();
            var ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
            if (!disjoint && ns > 0) last = ns / 1e6;
            pool.push(q);
          }
        } catch (e) { broken = true; }
        return last;
      },
      destroy: function () {
        try { if (active) gl.endQuery(ext.TIME_ELAPSED_EXT); } catch (e) { /* ignore */ }
        pool.concat(pending, active ? [active] : []).forEach(function (q) { try { gl.deleteQuery(q); } catch (e) { /* ignore */ } });
        pool = []; pending = []; active = null; broken = true;
      }
    };
    return T;
  }

  /* -------------------------------------------------------------- adaptive quality governor (pure) */
  function createGovernor(opts) {
    opts = opts || {};
    var threshold = num(opts.thresholdMs, 22), hold = num(opts.holdS, 2), warm = num(opts.warmupS, 1.5);
    var probeS = num(opts.probeS, 2.5);
    // warm-up is gated on BOTH a frame count and (clamped) time: build hitches (shader compiles, uploads) are a few
    // huge intervals that would otherwise burn the whole time budget in a handful of frames
    var warmFrames = Math.max(0, Math.round(num(opts.warmupFrames, warm > 0 ? 120 : 0))), warmClampMs = num(opts.warmupClampMs, 34);
    // ema: frame interval; cost: renderer CPU time (+ GPU time when a timer query is available)
    // capMs: a learned frame-interval floor that is NOT caused by the renderer (30 Hz display / energy saver rAF
    // cap / other main-thread work): intervals at or below it never count as slow.
    // probe: after a downgrade decided without GPU timing, watch whether the interval actually improves; if not,
    // the slowness was not ours -> the caller restores the previous quality and the interval is learned as capMs.
    var g = { ema: 0, slow: 0, warm: warm, warmN: warmFrames, cost: -1, gpuKnown: false, capMs: 0, probe: null };
    g.reset = function () { g.ema = 0; g.slow = 0; g.warm = warm; g.warmN = warmFrames; g.cost = -1; };
    g.forget = function () { g.capMs = 0; g.probe = null; g.reset(); };
    g.cancelProbe = function () { g.probe = null; };
    /** Feed a frame interval (ms), optionally the renderer's own CPU cost (ms) of the previous frame and the
        measured GPU time (ms, when known). Returns 'down' when a downgrade is due, 'restore' when the last
        downgrade did not help (caller should go back to the previous quality), otherwise false. */
    g.sample = function (ms, cpuMs, gpuMs) {
      if (!(ms > 0) || ms > 250) return false;          // tab switches / pauses / hitches are ignored
      var hasCpu = isNum(cpuMs) && cpuMs >= 0, hasGpu = isNum(gpuMs) && gpuMs >= 0;
      if (hasGpu) g.gpuKnown = true;
      var cost = hasCpu ? cpuMs + (hasGpu ? gpuMs : 0) : -1;
      if (g.probe) {
        var P = g.probe;
        P.t += ms / 1000; P.sum += ms; P.n++;
        if (P.t < probeS) return false;
        var avg = P.sum / Math.max(1, P.n);
        g.probe = null; g.ema = avg; g.slow = 0;
        if (avg > P.before * 0.88) {
          // no real improvement: the interval is a cap outside the renderer
          g.capMs = Math.max(g.capMs, Math.max(avg, P.before) * 1.1);
          g.warm = warm; g.warmN = warmFrames;
          return 'restore';
        }
        return false;
      }
      if (g.warm > 0 || g.warmN > 0) { g.warm -= Math.min(ms, warmClampMs) / 1000; g.warmN--; return false; }
      g.ema = g.ema ? g.ema * 0.92 + ms * 0.08 : ms;
      if (cost >= 0) g.cost = g.cost >= 0 ? g.cost * 0.9 + cost * 0.1 : cost;
      var slow = g.ema > threshold;
      if (slow && g.capMs > 0 && g.ema <= g.capMs) slow = false;
      if (slow && g.cost >= 0) {
        // renderer cost is a small share of the interval: the time goes somewhere else (vsync cap, sim, GC)
        if (g.gpuKnown && g.cost < g.ema * 0.5 && g.cost < threshold * 0.6) slow = false;
      }
      if (g.cost > threshold) slow = true;  // measured: the renderer itself is over budget
      if (slow) g.slow += ms / 1000;
      else g.slow = Math.max(0, g.slow - ms / 1000 * 1.5);
      if (g.slow >= hold) {
        var before = g.ema;
        g.slow = 0; g.ema = threshold * 0.75; g.warm = warm; g.warmN = warmFrames;
        if (!g.gpuKnown) g.probe = { before: before, t: 0, sum: 0, n: 0 };
        return 'down';
      }
      return false;
    };
    return g;
  }
  function lowerQuality(q) { var i = QUALITY_ORDER.indexOf(q); return i > 0 ? QUALITY_ORDER[i - 1] : null; }

  /* -------------------------------------------------------------- fallback geometry (pure) */
  function emptyGeo() { return { positions: [], normals: [], uvs: [], colors: [], indices: [] }; }
  function geoQuad(g, a, b, c, d, n, col, uv) {
    var base = g.positions.length / 3;
    [a, b, c, d].forEach(function (p, k) {
      g.positions.push(p[0], p[1], p[2]); g.normals.push(n[0], n[1], n[2]);
      var u = uv ? uv[k] : [k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0];
      g.uvs.push(u[0], u[1]);
      g.colors.push(col[0], col[1], col[2], col.length > 3 ? col[3] : 1);
    });
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** Axis-aligned box centered at c with size s, appended to g. Outward CCW faces. */
  function geoBox(g, c, s, col) {
    var x0 = c[0] - s[0] / 2, x1 = c[0] + s[0] / 2, y0 = c[1] - s[1] / 2, y1 = c[1] + s[1] / 2, z0 = c[2] - s[2] / 2, z1 = c[2] + s[2] / 2;
    geoQuad(g, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], col);
    geoQuad(g, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], col);
    geoQuad(g, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], col);
    geoQuad(g, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col);
    geoQuad(g, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col);
    geoQuad(g, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], col);
    return g;
  }
  function finishGeo(g, colorSize) {
    var n = g.positions.length / 3, cs = colorSize || 4, cols = new Float32Array(n * cs);
    for (var i = 0; i < n; i++) for (var k = 0; k < cs; k++) cols[i * cs + k] = g.colors[i * 4 + k];
    return {
      positions: new Float32Array(g.positions), normals: new Float32Array(g.normals), uvs: new Float32Array(g.uvs),
      colors: cols, indices: n > 65535 ? new Uint32Array(g.indices) : new Uint16Array(g.indices)
    };
  }
  /** Append a quad-strip loft: rings = array of arrays of [x,y,z] (equal length, closed ring). Smooth normals. */
  function geoLoft(g, rings, col, capEnds) {
    var R = rings.length, P = rings[0].length, base = g.positions.length / 3;
    var i, j;
    for (i = 0; i < R; i++) {
      for (j = 0; j < P; j++) {
        var p = rings[i][j];
        g.positions.push(p[0], p[1], p[2]); g.normals.push(0, 0, 0);
        g.uvs.push(j / P, i / (R - 1)); g.colors.push(col[0], col[1], col[2], col.length > 3 ? col[3] : 1);
      }
    }
    for (i = 0; i < R - 1; i++) {
      for (j = 0; j < P; j++) {
        var a = base + i * P + j, b = base + i * P + (j + 1) % P, c = base + (i + 1) * P + (j + 1) % P, d = base + (i + 1) * P + j;
        g.indices.push(a, d, c, a, c, b);
      }
    }
    // accumulate face normals for the loft vertices only
    var start = (g.indices.length - (R - 1) * P * 6);
    for (var t = start; t < g.indices.length; t += 3) {
      var i0 = g.indices[t] * 3, i1 = g.indices[t + 1] * 3, i2 = g.indices[t + 2] * 3, Pp = g.positions;
      var ux = Pp[i1] - Pp[i0], uy = Pp[i1 + 1] - Pp[i0 + 1], uz = Pp[i1 + 2] - Pp[i0 + 2];
      var vx = Pp[i2] - Pp[i0], vy = Pp[i2 + 1] - Pp[i0 + 1], vz = Pp[i2 + 2] - Pp[i0 + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      [i0, i1, i2].forEach(function (k) { g.normals[k] += nx; g.normals[k + 1] += ny; g.normals[k + 2] += nz; });
    }
    for (i = base * 3; i < g.normals.length; i += 3) {
      var l = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]) || 1;
      g.normals[i] /= l; g.normals[i + 1] /= l; g.normals[i + 2] /= l;
    }
    if (capEnds) {
      [0, R - 1].forEach(function (ri, k) {
        var ring = rings[ri], cx = 0, cy = 0, cz = 0;
        ring.forEach(function (p) { cx += p[0]; cy += p[1]; cz += p[2]; });
        cx /= P; cy /= P; cz /= P;
        var nx2 = k ? 1 : -1, cb = g.positions.length / 3;
        g.positions.push(cx, cy, cz); g.normals.push(nx2, 0, 0); g.uvs.push(0.5, 0.5); g.colors.push(col[0], col[1], col[2], 1);
        ring.forEach(function (p) { g.positions.push(p[0], p[1], p[2]); g.normals.push(nx2, 0, 0); g.uvs.push(0, 0); g.colors.push(col[0], col[1], col[2], 1); });
        for (var q = 0; q < P; q++) {
          if (k) g.indices.push(cb, cb + 1 + (q + 1) % P, cb + 1 + q);
          else g.indices.push(cb, cb + 1 + q, cb + 1 + (q + 1) % P);
        }
      });
    }
    return g;
  }
  /** Cylinder along local Z (wheel axis) centered at c. */
  function geoCylinderZ(g, c, r, w, seg, colSide, colCap) {
    var base = g.positions.length / 3, i;
    for (i = 0; i <= seg; i++) {
      var a = i / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
      g.positions.push(c[0] + ca * r, c[1] + sa * r, c[2] - w / 2, c[0] + ca * r, c[1] + sa * r, c[2] + w / 2);
      g.normals.push(ca, sa, 0, ca, sa, 0); g.uvs.push(i / seg, 0, i / seg, 1);
      g.colors.push(colSide[0], colSide[1], colSide[2], 1, colSide[0], colSide[1], colSide[2], 1);
    }
    for (i = 0; i < seg; i++) { var a0 = base + i * 2; g.indices.push(a0, a0 + 2, a0 + 3, a0, a0 + 3, a0 + 1); }
    [-1, 1].forEach(function (s) {
      var cb = g.positions.length / 3, z = c[2] + s * w / 2;
      g.positions.push(c[0], c[1], z); g.normals.push(0, 0, s); g.uvs.push(0.5, 0.5); g.colors.push(colCap[0], colCap[1], colCap[2], 1);
      for (var k = 0; k <= seg; k++) {
        var a = k / seg * TAU, rr = r * (k % 3 === 0 ? 0.62 : 0.66);
        g.positions.push(c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr, z); g.normals.push(0, 0, s); g.uvs.push(0, 0);
        var cc = k % 3 === 0 ? colSide : colCap;
        g.colors.push(cc[0], cc[1], cc[2], 1);
      }
      for (k = 0; k < seg; k++) {
        if (s > 0) g.indices.push(cb, cb + 1 + k, cb + 2 + k); else g.indices.push(cb, cb + 2 + k, cb + 1 + k);
      }
    });
    return g;
  }
  /** Square-section beam from point a to point b (car-local), thickness t. */
  function geoBeam(g, a, b, t, col) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], l = Math.hypot(dx, dy, dz) || 1;
    var ax = [dx / l, dy / l, dz / l];
    var ref = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var u = [ax[1] * ref[2] - ax[2] * ref[1], ax[2] * ref[0] - ax[0] * ref[2], ax[0] * ref[1] - ax[1] * ref[0]];
    var ul = Math.hypot(u[0], u[1], u[2]) || 1; u = [u[0] / ul * t / 2, u[1] / ul * t / 2, u[2] / ul * t / 2];
    var v = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    function ring(p) {
      return [[p[0] + u[0] + v[0], p[1] + u[1] + v[1], p[2] + u[2] + v[2]], [p[0] - u[0] + v[0], p[1] - u[1] + v[1], p[2] - u[2] + v[2]],
        [p[0] - u[0] - v[0], p[1] - u[1] - v[1], p[2] - u[2] - v[2]], [p[0] + u[0] - v[0], p[1] + u[1] - v[1], p[2] + u[2] - v[2]]];
    }
    return geoLoft(g, [ring(a), ring(b)], col, true);
  }
  /** Torus in the local YZ plane (normal = +X), major radius R, tube radius r. */
  function geoTorusX(g, R, r, segs, tube, col) {
    var rings = [];
    for (var i = 0; i < segs; i++) {
      var a = i / segs * TAU, ring = [];
      for (var j = 0; j < tube; j++) {
        var b = j / tube * TAU, rr = R + Math.cos(b) * r;
        ring.push([Math.sin(b) * r, Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      rings.push(ring);
    }
    rings.push(rings[0]);
    return geoLoft(g, rings, col, false);
  }

  /** Lofted car in car-local space (+X fwd, +Y up, +Z right): body shell, greenhouse, wheels, lights.
      style: body style id (coupe, sedan, hatchback, wagon, suv, roadster, pickup, hypercar, shooting-brake, van). */
  function fallbackCarGeometry(L, W, H, colorSize, style) {
    L = num(L, 4.5); W = num(W, 1.9); H = num(H, 1.3);
    style = String(style || 'coupe').toLowerCase();
    var body = emptyGeo(), dark = emptyGeo(), glass = emptyGeo(), lights = emptyGeo();
    var ride = 0.12, wr = clamp(H * 0.26, 0.3, 0.42), wb = L * 0.6, tr = W * 0.84;
    var tall = /suv|van|pickup/.test(style), low = /hyper/.test(style);
    var belt = ride + H * (tall ? 0.5 : low ? 0.42 : 0.48);
    var NS = 16;
    // cross-section (z, y) template, normalized: z in [-1,1], y in [0,1] (0 = sill, 1 = shoulder)
    var CS = [[0, -0.02], [0.55, 0], [0.92, 0.08], [1, 0.35], [0.99, 0.7], [0.9, 0.93], [0.6, 1], [0.2, 1.02],
      [-0.2, 1.02], [-0.6, 1], [-0.9, 0.93], [-0.99, 0.7], [-1, 0.35], [-0.92, 0.08], [-0.55, 0]];
    var bodyRings = [];
    for (var i = 0; i <= NS; i++) {
      var u = i / NS, x = -L / 2 + u * L;
      var endT = Math.pow(Math.abs(2 * u - 1), 5);
      var hw = W / 2 * (0.94 + 0.06 * Math.sin(PI * u)) * (1 - 0.16 * endT);
      var top = belt - H * (0.16 * smoothstep(0.72, 1, u) + 0.06 * smoothstep(0.12, 0, u));
      if (/pickup/.test(style) && u < 0.42) top = belt;
      var bot = ride + 0.05 + 0.1 * Math.max(smoothstep(0.9, 1, u), smoothstep(0.08, 0, u));
      if (u === 0 || u === 1) { hw *= 0.9; top -= 0.04; }
      var ring = [];
      for (var k = 0; k < CS.length; k++) ring.push([x, bot + (top - bot) * CS[k][1], CS[k][0] * hw]);
      bodyRings.push(ring);
    }
    geoLoft(body, bodyRings, [1, 1, 1, 1], true);
    // greenhouse
    var gStart = /pickup/.test(style) ? 0.42 : /wagon|shooting|van|suv/.test(style) ? 0.12 : /hatch/.test(style) ? 0.18 : 0.24;
    var gEnd = low ? 0.7 : 0.66, roofH = /roadster/.test(style) ? H * 0.22 : (ride + H) - belt;
    var GR = [], NG = 10;
    for (i = 0; i <= NG; i++) {
      var gu = gStart + (gEnd - gStart) * i / NG, gx = -L / 2 + gu * L;
      var rel = i / NG;
      var rise = /roadster/.test(style) ? smoothstep(0.55, 0.9, rel) * (1 - smoothstep(0.9, 1, rel)) :
        smoothstep(0, /wagon|van|suv|shooting/.test(style) ? 0.08 : 0.3, rel) * (1 - smoothstep(0.62, 1, rel));
      var gh = Math.max(0.02, roofH * rise), ghw = W / 2 * 0.86;
      var b0 = belt - 0.02;
      GR.push([[gx, b0, -ghw], [gx, b0 + gh * 0.92, -ghw * 0.8], [gx, b0 + gh, -ghw * 0.55], [gx, b0 + gh, ghw * 0.55],
        [gx, b0 + gh * 0.92, ghw * 0.8], [gx, b0, ghw]]);
    }
    geoLoft(glass, GR, [1, 1, 1, 1], true);
    // wheels: tyre + rim
    [[wb / 2, -tr / 2], [wb / 2, tr / 2], [-wb / 2, -tr / 2], [-wb / 2, tr / 2]].forEach(function (p) {
      geoCylinderZ(dark, [p[0], wr, p[1]], wr, 0.25, 20, [0.05, 0.05, 0.055], [0.62, 0.63, 0.66]);
    });
    // splitter / diffuser
    geoBox(dark, [L / 2 - 0.12, ride + 0.03, 0], [0.3, 0.04, W * 0.9], [0.04, 0.04, 0.045, 1]);
    geoBox(dark, [-L / 2 + 0.12, ride + 0.05, 0], [0.26, 0.06, W * 0.8], [0.04, 0.04, 0.045, 1]);
    if (low || /coupe/.test(style)) {   // rear wing
      var wy = belt + (low ? 0.28 : 0.14);
      geoBox(dark, [-L / 2 + 0.28, wy, 0], [0.32, 0.04, W * 0.92], [0.05, 0.05, 0.055, 1]);
      geoBox(dark, [-L / 2 + 0.3, (wy + belt) / 2, -W * 0.3], [0.08, wy - belt, 0.04], [0.05, 0.05, 0.055, 1]);
      geoBox(dark, [-L / 2 + 0.3, (wy + belt) / 2, W * 0.3], [0.08, wy - belt, 0.04], [0.05, 0.05, 0.055, 1]);
    }
    // lights (unlit part): headlights warm white, tail lights red
    var hy = belt - H * 0.2, ty = belt - 0.08;
    geoBox(lights, [L / 2 - 0.04, hy, -W * 0.32], [0.08, 0.09, 0.36], [1, 0.97, 0.88, 1]);
    geoBox(lights, [L / 2 - 0.04, hy, W * 0.32], [0.08, 0.09, 0.36], [1, 0.97, 0.88, 1]);
    geoBox(lights, [-L / 2 + 0.02, ty, -W * 0.33], [0.06, 0.07, 0.4], [0.9, 0.04, 0.03, 1]);
    geoBox(lights, [-L / 2 + 0.02, ty, W * 0.33], [0.06, 0.07, 0.4], [0.9, 0.04, 0.03, 1]);
    return {
      body: finishGeo(body, colorSize), dark: finishGeo(dark, colorSize), glass: finishGeo(glass, colorSize), lights: finishGeo(lights, colorSize),
      dims: { length: L, width: W, height: H, wheelbase: wb, track: tr, wheelRadius: wr, rideHeight: ride, belt: belt, roof: belt - 0.02 + roofH },
      cockpitEye: [-L * 0.06 + (low ? 0.15 : 0), Math.max(belt + 0.2, ride + H * 0.78), -W * 0.2],
      hoodCam: [L * 0.18, belt + 0.25, 0], bumperCam: [L / 2 + 0.05, ride + 0.38, 0]
    };
  }

  /** Built-in first-person interior (car-local), used when CB.gl.cockpit is missing or fails.
      Returns static geometries, the steering-wheel geometry (wheel-local, YZ plane), and placement data. */
  function fallbackCockpitGeometry(eye, dims, colorSize) {
    eye = eye || [-0.3, 1.05, -0.38];
    dims = dims || {};
    var W = num(dims.width, 1.9);
    var ex = eye[0], ey = eye[1], ez = eye[2];
    var open = isNum(dims.roof) && dims.roof < ey + 0.05;          // roadster: low windscreen frame, no roof
    var roofY = open ? ey + 0.06 : Math.max(ey + 0.2, num(dims.roof, ey + 0.26));
    var trim = [0.035, 0.035, 0.04, 1], soft = [0.07, 0.07, 0.075, 1], liner = [0.14, 0.14, 0.15, 1], metal = [0.35, 0.36, 0.38, 1];
    var shell = emptyGeo();
    var dashX = ex + 0.72, dashY = ey - 0.37;
    // dashboard: lower block + top pad + binnacle hood
    geoBox(shell, [dashX + 0.05, dashY - 0.12, 0], [0.42, 0.26, W * 0.94], trim);
    geoBox(shell, [dashX - 0.1, dashY + 0.04, 0], [0.24, 0.06, W * 0.92], soft);
    geoBox(shell, [ex + 0.63, ey - 0.15, ez], [0.14, 0.03, 0.44], soft);
    geoBox(shell, [ex + 0.68, ey - 0.24, ez], [0.08, 0.18, 0.44], trim);
    // centre console + screen bezel
    geoBox(shell, [ex + 0.2, ey - 0.6, 0], [0.9, 0.22, 0.24], trim);
    geoBox(shell, [dashX - 0.17, dashY - 0.08, 0.02], [0.03, 0.15, 0.26], [0.02, 0.02, 0.025, 1]);
    // door cards / sills
    geoBox(shell, [ex, ey - 0.33, -W * 0.47], [1.6, 0.36, 0.06], soft);
    geoBox(shell, [ex, ey - 0.33, W * 0.47], [1.6, 0.36, 0.06], soft);
    // A-pillars, header, roof liner, B-pillars
    var bx = dashX - 0.02, by = dashY + 0.06, tx = ex + 0.22;
    geoBeam(shell, [bx, by, -W * 0.45], [tx, roofY, -W * 0.39], 0.07, trim);
    geoBeam(shell, [bx, by, W * 0.45], [tx, roofY, W * 0.39], 0.07, trim);
    geoBeam(shell, [tx, roofY, -W * 0.4], [tx, roofY, W * 0.4], 0.06, trim);
    if (!open) {
      geoBox(shell, [ex - 0.45, roofY + 0.02, 0], [1.35, 0.03, W * 0.84], liner);
      geoBeam(shell, [ex - 0.55, ey - 0.25, -W * 0.45], [ex - 0.5, roofY, -W * 0.4], 0.12, liner);
      geoBeam(shell, [ex - 0.55, ey - 0.25, W * 0.45], [ex - 0.5, roofY, W * 0.4], 0.12, liner);
    }
    // rear-view mirror stalk + housing
    var mPos = [ex + 0.46, Math.min(roofY - 0.06, ey + 0.13), 0.04];
    var smx = mPos[0] + 0.05, wsY = roofY + (by - roofY) * clamp01((smx - tx) / (bx - tx));   // stalk meets the windscreen
    geoBeam(shell, [smx, Math.max(wsY, mPos[1] + 0.05), 0.04], [mPos[0] + 0.02, mPos[1] + 0.03, 0.04], 0.025, trim);
    geoBox(shell, [mPos[0] + 0.02, mPos[1], mPos[2]], [0.03, 0.085, 0.27], trim);
    // steering column
    var wc = [ex + 0.42, ey - 0.42, ez];
    geoBeam(shell, [wc[0] + 0.04, wc[1] - 0.02, ez], [dashX - 0.05, dashY - 0.05, ez], 0.07, trim);
    // steering wheel (wheel-local, plane YZ) + spokes + hub + gloves at 9 & 3 + shift lights strip
    var wheel = emptyGeo(), Rw = 0.175;
    geoTorusX(wheel, Rw, 0.018, 28, 6, [0.05, 0.05, 0.055, 1]);
    geoBox(wheel, [0.01, 0, 0], [0.04, 0.07, 0.1], metal);
    geoBeam(wheel, [0.01, 0, -0.03], [0, 0, -Rw], 0.025, trim);
    geoBeam(wheel, [0.01, 0, 0.03], [0, 0, Rw], 0.025, trim);
    geoBeam(wheel, [0.01, -0.02, 0], [0, -Rw, 0], 0.025, trim);
    geoBox(wheel, [-0.01, 0.02, -Rw], [0.06, 0.09, 0.05], [0.12, 0.12, 0.13, 1]);
    geoBox(wheel, [-0.01, 0.02, Rw], [0.06, 0.09, 0.05], [0.12, 0.12, 0.13, 1]);
    geoBox(wheel, [-0.005, Rw - 0.005, 0], [0.012, 0.012, 0.03], [0.85, 0.15, 0.08, 1]);
    // quads facing the driver (normal -X): gauge cluster + mirror glass. uv u=1 at +Z (right), v=1 at top.
    function faceQuad(cx, cy, cz, w, h) {
      var g = emptyGeo();
      geoQuad(g, [cx, cy - h / 2, cz - w / 2], [cx, cy - h / 2, cz + w / 2], [cx, cy + h / 2, cz + w / 2], [cx, cy + h / 2, cz - w / 2],
        [-1, 0, 0], [1, 1, 1, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      return finishGeo(g, colorSize);
    }
    return {
      shell: finishGeo(shell, colorSize), wheel: finishGeo(wheel, colorSize),
      gauges: faceQuad(ex + 0.635, ey - 0.225, ez, 0.38, 0.125),
      mirrorGlass: faceQuad(mPos[0], mPos[1], mPos[2], 0.25, 0.07),
      wheelCenter: wc, wheelTilt: 0.32,
      mirror: { pos: mPos, normal: v3norm([ex - mPos[0], ey - mPos[1], ez - mPos[2]]), up: [0, 1, 0], fovY: 16 }
    };
  }
  /** Flat road ribbon + barrier walls + ground slab from tracks.build() geometry (fallback when CB.gl.track is absent). */
  function fallbackTrackGeometry(geom, colorSize) {
    var S = samplesOf(geom), N = S.length;
    var road = emptyGeo(), walls = emptyGeo(), ground = emptyGeo();
    var bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    var sAcc = 0;
    for (var i = 0; i < N; i++) {
      var a = S[i], b = S[(i + 1) % N];
      var na = [num(a.nx, -Math.sin(a.heading)), num(a.ny, Math.cos(a.heading))];
      var nb = [num(b.nx, -Math.sin(b.heading)), num(b.ny, Math.cos(b.heading))];
      var hwa = num(a.hw, num(a.width, 12) / 2), hwb = num(b.hw, num(b.width, 12) / 2);
      var segLen = Math.hypot(b.x - a.x, b.y - a.y), u0 = sAcc / 8, u1 = (sAcc + segLen) / 8;
      sAcc += segLen;
      var la = [a.x + na[0] * hwa, a.y + na[1] * hwa], ra = [a.x - na[0] * hwa, a.y - na[1] * hwa];
      var lb = [b.x + nb[0] * hwb, b.y + nb[1] * hwb], rb = [b.x - nb[0] * hwb, b.y - nb[1] * hwb];
      // CCW seen from +Y (GL): (ra, rb, lb, la) mapped to (x, 0, -y)
      geoQuad(road, [ra[0], 0, -ra[1]], [rb[0], 0, -rb[1]], [lb[0], 0, -lb[1]], [la[0], 0, -la[1]], [0, 1, 0],
        [0.24, 0.24, 0.25, 1], [[0, u0], [0, u1], [1, u1], [1, u0]]);
      [1, -1].forEach(function (side) {
        var wa = side > 0 ? num(a.wallL, hwa + 4) : num(a.wallR, hwa + 4), wbd = side > 0 ? num(b.wallL, hwb + 4) : num(b.wallR, hwb + 4);
        var pa = [a.x + na[0] * wa * side, a.y + na[1] * wa * side], pb = [b.x + nb[0] * wbd * side, b.y + nb[1] * wbd * side];
        var h = 1.1, n = [-na[0] * side, 0, na[1] * side];
        var stripe = (i >> 2) % 2 ? [0.85, 0.85, 0.86, 1] : [0.72, 0.1, 0.1, 1];
        if (side > 0) geoQuad(walls, [pa[0], 0, -pa[1]], [pb[0], 0, -pb[1]], [pb[0], h, -pb[1]], [pa[0], h, -pa[1]], n, stripe);
        else geoQuad(walls, [pb[0], 0, -pb[1]], [pa[0], 0, -pa[1]], [pa[0], h, -pa[1]], [pb[0], h, -pb[1]], n, stripe);
      });
      bb.x0 = Math.min(bb.x0, a.x); bb.x1 = Math.max(bb.x1, a.x); bb.y0 = Math.min(bb.y0, a.y); bb.y1 = Math.max(bb.y1, a.y);
    }
    if (!N) { bb = { x0: -500, y0: -500, x1: 500, y1: 500 }; }
    var m = 400;
    geoQuad(ground, [bb.x0 - m, -0.03, -(bb.y0 - m)], [bb.x1 + m, -0.03, -(bb.y0 - m)], [bb.x1 + m, -0.03, -(bb.y1 + m)],
      [bb.x0 - m, -0.03, -(bb.y1 + m)], [0, 1, 0], [0.24, 0.38, 0.16, 1]);
    return { road: finishGeo(road, colorSize), walls: finishGeo(walls, colorSize), ground: finishGeo(ground, colorSize), bounds: bb };
  }

  /** Racing-line ribbon colored by the speed profile (green accelerate / yellow lift / red brake). */
  function racingLineGeometry(geom, colorSize) {
    var P = geom && geom.racingLineXY, N = P ? P.length : 0;
    if (N < 8) return null;
    var vel = null;
    try { if (typeof geom.speedProfile === 'function') vel = geom.speedProfile(1.25, 1.05); } catch (e) { vel = null; }
    var g = emptyGeo(), hw = 0.4, y = 0.035;
    for (var i = 0; i < N; i++) {
      var a = P[i], b = P[(i + 1) % N];
      var ha = isNum(a.heading) ? a.heading : Math.atan2(b.y - a.y, b.x - a.x);
      var hb = isNum(b.heading) ? b.heading : ha;
      var col = [0.2, 0.9, 0.35, 0.6];
      if (vel && vel.length === N) {
        var dv = vel[(i + 6) % N] - vel[i];
        col = dv < -1.2 ? [0.95, 0.15, 0.12, 0.7] : dv < -0.3 ? [1.0, 0.8, 0.1, 0.65] : [0.2, 0.9, 0.35, 0.5];
      }
      if ((i & 1) === 1) continue; // dashed: every other segment
      var nax = -Math.sin(ha), nay = Math.cos(ha), nbx = -Math.sin(hb), nby = Math.cos(hb);
      geoQuad(g, [a.x - nax * hw, y, -(a.y - nay * hw)], [b.x - nbx * hw, y, -(b.y - nby * hw)],
        [b.x + nbx * hw, y, -(b.y + nby * hw)], [a.x + nax * hw, y, -(a.y + nay * hw)], [0, 1, 0], col);
    }
    return finishGeo(g, colorSize);
  }

  /* ================================================================ raw GL helpers for post FX / RTs */
  var POST_VS = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');
  var FS_HEAD = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\nvarying vec2 vUv;\n';
  var BRIGHT_FS = FS_HEAD + [
    'uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThreshold;',
    'void main(){',
    '  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-1.0,-1.0)).rgb + texture2D(uTex, vUv + uTexel * vec2(1.0,-1.0)).rgb',
    '         + texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;',
    '  c *= 0.25;',
    '  float l = max(c.r, max(c.g, c.b));',
    '  float k = smoothstep(uThreshold, uThreshold + 0.22, l);',
    '  gl_FragColor = vec4(c * k, 1.0);',
    '}'
  ].join('\n');
  var BLUR_FS = FS_HEAD + [
    'uniform sampler2D uTex; uniform vec2 uDir;',
    'void main(){',
    '  vec3 c = texture2D(uTex, vUv).rgb * 0.2270270;',
    '  c += texture2D(uTex, vUv + uDir * 1.3846154).rgb * 0.3162162;',
    '  c += texture2D(uTex, vUv - uDir * 1.3846154).rgb * 0.3162162;',
    '  c += texture2D(uTex, vUv + uDir * 3.2307692).rgb * 0.0702703;',
    '  c += texture2D(uTex, vUv - uDir * 3.2307692).rgb * 0.0702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');
  var COMPOSITE_FS = FS_HEAD + [
    'uniform sampler2D uScene; uniform sampler2D uBloom;',
    'uniform vec2 uTexel; uniform float uAspect, uBloomStr, uVignette, uSpeedBlur, uFxaa, uTonemap, uExposure;',
    'uniform float uSaturation, uContrast, uFlash, uTime, uGrain;',
    'uniform vec3 uLift, uGain, uFlashColor;',
    'vec3 fxaa(vec2 uv){',
    '  vec3 rgbNW = texture2D(uScene, uv + vec2(-1.0,-1.0) * uTexel).rgb;',
    '  vec3 rgbNE = texture2D(uScene, uv + vec2( 1.0,-1.0) * uTexel).rgb;',
    '  vec3 rgbSW = texture2D(uScene, uv + vec2(-1.0, 1.0) * uTexel).rgb;',
    '  vec3 rgbSE = texture2D(uScene, uv + vec2( 1.0, 1.0) * uTexel).rgb;',
    '  vec3 rgbM  = texture2D(uScene, uv).rgb;',
    '  vec3 lw = vec3(0.299, 0.587, 0.114);',
    '  float lNW = dot(rgbNW, lw), lNE = dot(rgbNE, lw), lSW = dot(rgbSW, lw), lSE = dot(rgbSE, lw), lM = dot(rgbM, lw);',
    '  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));',
    '  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));',
    '  if (lMax - lMin < max(0.0312, lMax * 0.125)) return rgbM;',
    '  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));',
    '  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);',
    '  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);',
    '  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;',
    '  vec3 rgbA = 0.5 * (texture2D(uScene, uv + dir * (1.0/3.0 - 0.5)).rgb + texture2D(uScene, uv + dir * (2.0/3.0 - 0.5)).rgb);',
    '  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(uScene, uv - dir * 0.5).rgb + texture2D(uScene, uv + dir * 0.5).rgb);',
    '  float lB = dot(rgbB, lw);',
    '  return (lB < lMin || lB > lMax) ? rgbA : rgbB;',
    '}',
    'vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    'void main(){',
    '  vec2 uv = vUv;',
    '  vec3 c = uFxaa > 0.5 ? fxaa(uv) : texture2D(uScene, uv).rgb;',
    '  if (uSpeedBlur > 0.001) {',
    '    vec2 d = uv - vec2(0.5, 0.52);',
    '    float r = length(d * vec2(uAspect, 1.0));',
    '    float m = smoothstep(0.2, 0.85, r) * uSpeedBlur;',
    '    vec3 acc = c;',
    '    for (int i = 1; i < 6; i++) { acc += texture2D(uScene, uv - d * m * 0.022 * float(i)).rgb; }',
    '    c = acc / 6.0;',
    '  }',
    '  if (uBloomStr > 0.0) {',
    '    vec3 bl = texture2D(uBloom, uv).rgb * uBloomStr;',
    // display-referred scene: screen-blend the bloom so bright areas glow without clipping to flat white
    '    c = uTonemap > 0.5 ? c + bl : vec3(1.0) - (vec3(1.0) - clamp(c, 0.0, 1.0)) * (vec3(1.0) - clamp(bl, 0.0, 1.0));',
    '  }',
    '  if (uTonemap > 0.5) { c = aces(c * uExposure); c = pow(c, vec3(1.0 / 2.2)); }',
    // soft highlight shoulder: keeps near-white roofs / walls from flattening into pure white
    '  float hm = max(c.r, max(c.g, c.b));',
    '  if (hm > 0.84) { float hk = 0.84 + 0.15 * (1.0 - exp((0.84 - hm) / 0.15)); vec3 cs = c * (hk / hm); c = mix(cs, vec3(dot(cs, vec3(0.2126, 0.7152, 0.0722))), clamp((hm - 0.95) * 2.0, 0.0, 0.25)); }',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = mix(vec3(l), c, uSaturation);',
    '  c = (c - 0.5) * uContrast + 0.5;',
    '  c = c * uGain + uLift * (1.0 - c);',
    '  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);',
    '  float v = smoothstep(1.15, 0.32, length(q));',
    '  c *= mix(1.0, v, uVignette);',
    '  c += uFlashColor * uFlash;',
    '  float n = fract(sin(dot(uv * vec2(12.9898, 78.233) + uTime, vec2(1.0, 1.7))) * 43758.5453);',
    '  c += (n - 0.5) * uGrain;',
    '  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  function compileProgram(gl, vsSrc, fsSrc, attribs) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        var log = gl.getShaderInfoLog(s); gl.deleteShader(s);
        throw new Error('renderer3d shader: ' + log);
      }
      return s;
    }
    var vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc), p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    attribs = attribs || { aPos: 0 };
    for (var an in attribs) gl.bindAttribLocation(p, attribs[an], an);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('renderer3d link: ' + gl.getProgramInfoLog(p));
    var U = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      if (info) U[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, u: U };
  }

  /** Color texture + depth render target; on WebGL2 with samples > 0, an MSAA FBO that resolve() blits into it. */
  function createTarget(gl, isGL2, w, h, opts) {
    opts = opts || {};
    var t = { w: w, h: h, isGL2: isGL2 };
    t.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    t.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    if (opts.depth) {
      t.depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, isGL2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
    }
    t.ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    var samples = isGL2 && opts.samples > 0 ? Math.min(opts.samples, gl.getParameter(gl.MAX_SAMPLES) || 0) : 0;
    if (samples > 0 && t.ok) {
      try {
        t.msFb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFb);
        t.msColor = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, t.msColor);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.msColor);
        if (opts.depth) {
          t.msDepth = gl.createRenderbuffer();
          gl.bindRenderbuffer(gl.RENDERBUFFER, t.msDepth);
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.msDepth);
        }
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('msaa incomplete');
        t.samples = samples;
      } catch (e) {
        if (t.msFb) gl.deleteFramebuffer(t.msFb);
        if (t.msColor) gl.deleteRenderbuffer(t.msColor);
        if (t.msDepth) gl.deleteRenderbuffer(t.msDepth);
        t.msFb = t.msColor = t.msDepth = null; t.samples = 0;
      }
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    t.bind = function () { gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFb || t.fb); gl.viewport(0, 0, t.w, t.h); };
    t.resolve = function () {
      if (!t.msFb) return;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msFb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.fb);
      gl.blitFramebuffer(0, 0, t.w, t.h, 0, 0, t.w, t.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    };
    t.destroy = function () {
      [t.fb, t.msFb].forEach(function (f) { if (f) gl.deleteFramebuffer(f); });
      [t.depth, t.msColor, t.msDepth].forEach(function (r) { if (r) gl.deleteRenderbuffer(r); });
      if (t.tex) gl.deleteTexture(t.tex);
      t.fb = t.msFb = t.depth = t.msColor = t.msDepth = t.tex = null;
    };
    return t;
  }

  /* ================================================================ built-in "lite" core
     Used when js/race/gl/gl-core.js (CB.gl.createContext/createMesh/shaders/drawList) is missing or failed, so the
     3D view still works: physically-flavoured forward shading (sun + hemisphere ambient + procedural env fresnel +
     up to 8 spot/point lights + exponential fog), vertex colours, optional sRGB texture map, alpha test, blending.
     Lighting happens in linear space; output is linear when the post composite tonemaps, else ACES + gamma in shader. */
  var LITE_VS = [
    'attribute vec3 aPos; attribute vec3 aNormal; attribute vec2 aUv; attribute vec4 aColor;',
    'uniform mat4 uModel; uniform mat4 uViewProj;',
    'varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv; varying vec4 vColor;',
    'void main(){',
    '  vec4 w = uModel * vec4(aPos, 1.0);',
    '  vWorld = w.xyz; vNormal = (uModel * vec4(aNormal, 0.0)).xyz; vUv = aUv; vColor = aColor;',
    '  gl_Position = uViewProj * w;',
    '}'
  ].join('\n');
  var LITE_FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
    'varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv; varying vec4 vColor;',
    'uniform vec4 uBaseColor; uniform sampler2D uMap; uniform float uUseMap, uMetallic, uRoughness, uClearcoat, uAlphaTest, uUnlit;',
    'uniform vec3 uEmissive, uSunDir, uSunColor, uAmbientSky, uAmbientGround, uFogColor, uCamPos, uEnvTop, uEnvHorizon, uEnvBottom;',
    'uniform float uFogDensity, uWetness, uOutGamma, uExposure, uLightCount;',
    'uniform vec3 uLightPos[8]; uniform vec3 uLightDir[8]; uniform vec3 uLightColor[8]; uniform vec4 uLightParams[8];',
    'vec3 envColor(vec3 d){ float y = d.y; return y > 0.0 ? mix(uEnvHorizon, uEnvTop, pow(clamp(y, 0.0, 1.0), 0.55)) : mix(uEnvHorizon, uEnvBottom, pow(clamp(-y, 0.0, 1.0), 0.35)); }',
    'vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    'void main(){',
    '  vec4 base = uBaseColor * vColor;',
    '  if (uUseMap > 0.5) { vec4 t = texture2D(uMap, vUv); t.rgb = pow(t.rgb, vec3(2.2)); base *= t; }',
    '  if (base.a < uAlphaTest) discard;',
    '  vec3 col;',
    '  vec3 V = normalize(uCamPos - vWorld);',
    '  if (uUnlit > 0.5) { col = base.rgb + uEmissive; }',
    '  else {',
    '    vec3 N = normalize(vNormal); if (!gl_FrontFacing) N = -N;',
    '    float wet = uWetness * smoothstep(0.6, 0.95, N.y);',
    '    float rough = clamp(mix(uRoughness, uRoughness * 0.3, wet), 0.045, 1.0);',
    '    vec3 diffC = base.rgb * (1.0 - uMetallic) * (1.0 - wet * 0.35);',
    '    vec3 F0 = mix(vec3(0.04), base.rgb, uMetallic);',
    '    float NV = max(dot(N, V), 0.0);',
    '    float fres = pow(1.0 - NV, 5.0);',
    '    vec3 F = F0 + (vec3(1.0) - F0) * fres * (1.0 - rough * 0.85);',
    '    float shin = min(2.0 / (rough * rough * rough * rough + 0.0005) - 2.0, 4096.0);',
    '    float norm = (shin + 8.0) / 25.13;',
    '    vec3 L = normalize(uSunDir);',
    '    float ndl = max(dot(N, L), 0.0);',
    '    float spec = pow(max(dot(N, normalize(L + V)), 0.0), shin) * norm;',
    '    vec3 amb = mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5);',
    '    col = diffC * (amb + uSunColor * ndl) + F * spec * uSunColor * ndl;',
    '    vec3 R = reflect(-V, N);',
    '    float envK = (1.0 - rough) * (1.0 - rough);',
    '    col += envColor(R) * F * envK;',
    '    if (uClearcoat > 0.0) {',
    '      float cf = 0.04 + 0.96 * fres;',
    '      col += (envColor(R) * cf + pow(max(dot(N, normalize(L + V)), 0.0), 1800.0) * 70.0 * uSunColor * ndl * cf) * uClearcoat;',
    '    }',
    '    for (int i = 0; i < 8; i++) {',
    '      if (float(i) >= uLightCount) break;',
    '      vec4 P = uLightParams[i];',
    '      vec3 d = uLightPos[i] - vWorld; float dist = length(d); vec3 l = d / max(dist, 0.001);',
    '      float att = clamp(1.0 - dist / max(P.x, 0.1), 0.0, 1.0); att *= att;',
    '      if (P.w > 0.5) att *= smoothstep(P.z, P.y, dot(-l, normalize(uLightDir[i])));',
    '      float nl = max(dot(N, l), 0.0);',
    '      float sp = pow(max(dot(N, normalize(l + V)), 0.0), shin) * norm;',
    '      col += (diffC * nl + F * sp * nl + wet * 0.25 * pow(max(dot(R, l), 0.0), 30.0)) * uLightColor[i] * att;',
    '    }',
    '    col += uEmissive;',
    '  }',
    '  float dist = length(uCamPos - vWorld);',
    '  float fog = 1.0 - exp(-dist * uFogDensity);',
    '  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));',
    '  if (uOutGamma > 0.5) { col = aces(col * uExposure); col = pow(col, vec3(1.0 / 2.2)); }',
    '  gl_FragColor = vec4(col, base.a);',
    '}'
  ].join('\n');

  function createLiteCore() {
    var lite = { lite: true };
    lite.createContext = function (canvas, attrs) {
      var a = {}; attrs = attrs || {};
      for (var k in attrs) a[k] = attrs[k];
      var gl = null, isGL2 = false;
      try { gl = canvas.getContext('webgl2', a); isGL2 = !!gl; } catch (e) { gl = null; }
      if (!gl) { try { gl = canvas.getContext('webgl', a) || canvas.getContext('experimental-webgl', a); } catch (e2) { gl = null; } }
      if (!gl) return null;
      var ctx = { gl: gl, isWebGL2: isGL2, lite: true, colorSize: 4, canvas: canvas, ext: {} };
      ctx.ext.uint = isGL2 || !!gl.getExtension('OES_element_index_uint');
      ctx.ext.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      ctx.resize = function (cssW, cssH, dpr) {
        var w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
      };
      return ctx;
    };
    lite.createMesh = function (ctx, geo) {
      var gl = ctx.gl || ctx;
      var pos = geo.positions instanceof Float32Array ? geo.positions : new Float32Array(geo.positions || []);
      var nv = pos.length / 3;
      var m = { vertexCount: nv, buffers: {} };
      function buf(data, Ctor) {
        if (!data || !data.length) return null;
        var b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data instanceof Ctor ? data : new Ctor(data), gl.STATIC_DRAW);
        return b;
      }
      m.buffers.pos = buf(pos, Float32Array);
      m.buffers.nrm = buf(geo.normals, Float32Array);
      m.buffers.uv = buf(geo.uvs, Float32Array);
      m.buffers.col = buf(geo.colors, Float32Array);
      m.colorSize = geo.colors && geo.colors.length ? (num(geo.colorSize, 0) || Math.round(geo.colors.length / Math.max(1, nv))) : 4;
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      var idx = geo.indices;
      if (idx && idx.length) {
        var big = nv > 65535 || idx instanceof Uint32Array;
        if (big && !ctx.ext.uint) throw new Error('lite mesh: 32-bit indices unsupported');
        var arr = big ? (idx instanceof Uint32Array ? idx : new Uint32Array(idx)) : (idx instanceof Uint16Array ? idx : new Uint16Array(idx));
        m.ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        m.count = arr.length; m.indexType = big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      } else m.count = nv;
      var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (var i = 0; i < pos.length; i += 3) for (var c = 0; c < 3; c++) { var v = pos[i + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
      m.bounds = nv ? { min: mn, max: mx } : null;
      m._lite = true;
      m.destroy = function () {
        for (var k in m.buffers) if (m.buffers[k]) gl.deleteBuffer(m.buffers[k]);
        if (m.ibo) gl.deleteBuffer(m.ibo);
        m.buffers = {}; m.ibo = null; m.count = 0;
      };
      return m;
    };
    var progCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    lite.shaders = function (ctx) {
      var gl = ctx.gl || ctx;
      if (progCache && progCache.has(gl)) return progCache.get(gl);
      var p = compileProgram(gl, LITE_VS, LITE_FS, { aPos: 0, aNormal: 1, aUv: 2, aColor: 3 });
      var out = { standard: p, lite: true };
      if (progCache) progCache.set(gl, out);
      return out;
    };
    function mget(m, a, b, c) { if (!m) return undefined; return m[a] !== undefined ? m[a] : m[b] !== undefined ? m[b] : c ? m[c] : undefined; }
    var ZERO3 = [0, 0, 0], ONE4 = [1, 1, 1, 1];
    lite.drawList = function (ctx, items, cam, env) {
      var gl = ctx.gl || ctx;
      var P = lite.shaders(ctx).standard, u = P.u;
      env = env || {};
      var cp = cam.position || [0, 0, 0];
      var opaque = [], trans = [], customPre = [], customPost = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || !it.mesh) continue;
        if (!it.mesh._lite) {
          // self-drawing items (effects particles / skids / rain, foreign meshes with their own draw())
          if (typeof it.draw === 'function' || typeof it.mesh.draw === 'function') (num(it.order, 50) < 15 ? customPre : customPost).push(it);
          continue;
        }
        if (!it.mesh.count) continue;
        var mt = it.material || {};
        var m = it.model;
        var dx = (m ? m[12] : 0) - cp[0], dy = (m ? m[13] : 0) - cp[1], dz = (m ? m[14] : 0) - cp[2];
        it._d = dx * dx + dy * dy + dz * dz;
        if (it.transparent || mt.transparent || mt.blend) trans.push(it); else opaque.push(it);
      }
      opaque.sort(function (a, b) { return a._d - b._d; });
      trans.sort(function (a, b) { return b._d - a._d; });
      var byOrder = function (a, b) { return num(a.order, 50) - num(b.order, 50); };
      customPre.sort(byOrder); customPost.sort(byOrder);
      function bindLite() {
        gl.useProgram(P.program);
        if (gl.bindVertexArray) gl.bindVertexArray(null);
        else { var vx = ctx._vaoExt === undefined ? (ctx._vaoExt = gl.getExtension('OES_vertex_array_object')) : ctx._vaoExt; if (vx) vx.bindVertexArrayOES(null); }
        gl.uniformMatrix4fv(u.uViewProj, false, cam.viewProj);
        gl.uniform3fv(u.uCamPos, cp);
        gl.uniform3fv(u.uSunDir, env.sunDir || [0.4, 0.8, 0.4]);
        gl.uniform3fv(u.uSunColor, env.sunColor || [1, 1, 1]);
        gl.uniform3fv(u.uAmbientSky, env.ambientSky || [0.4, 0.45, 0.55]);
        gl.uniform3fv(u.uAmbientGround, env.ambientGround || [0.2, 0.2, 0.18]);
        gl.uniform3fv(u.uFogColor, env.fogColor || [0.7, 0.8, 0.9]);
        gl.uniform1f(u.uFogDensity, num(env.fogDensity, 0.001));
        gl.uniform3fv(u.uEnvTop, env.envTop || [0.3, 0.5, 0.8]);
        gl.uniform3fv(u.uEnvHorizon, env.envHorizon || [0.8, 0.85, 0.9]);
        gl.uniform3fv(u.uEnvBottom, env.envBottom || [0.25, 0.25, 0.22]);
        gl.uniform1f(u.uWetness, num(env.wetness, 0));
        gl.uniform1f(u.uOutGamma, env.linearOutput ? 0 : 1);
        gl.uniform1f(u.uExposure, num(env.exposure, 1));
        gl.uniform1f(u.uLightCount, num(env.lightCount, 0));
        if (env.lightPos) {
          gl.uniform3fv(u.uLightPos, env.lightPos); gl.uniform3fv(u.uLightDir, env.lightDir);
          gl.uniform3fv(u.uLightColor, env.lightColor); gl.uniform4fv(u.uLightParams, env.lightParams);
        }
        gl.uniform1i(u.uMap, 0);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
        gl.enableVertexAttribArray(0);
      }
      function unbindLite() {
        for (var a = 1; a < 4; a++) gl.disableVertexAttribArray(a);
        gl.disableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.depthMask(true); gl.depthFunc(gl.LESS);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      function drawCustom(list) {
        for (var c = 0; c < list.length; c++) {
          var ci = list[c];
          try { if (typeof ci.draw === 'function') ci.draw(cam, env); else ci.mesh.draw(null, cam, env); }
          catch (e) { if (!ci._liteWarned && typeof console !== 'undefined') { ci._liteWarned = true; console.warn('[renderer3d] custom draw', ci.kind, e); } }
        }
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      }
      function drawOne(it, blend) {
        var me = it.mesh, mt = it.material || {}, B = me.buffers;
        gl.uniformMatrix4fv(u.uModel, false, it.model || IDENT_LITE);
        var bc = mget(mt, 'uBaseColor', 'baseColor', 'color') || ONE4;
        var op = num(mt.opacity, 1);
        gl.uniform4f(u.uBaseColor, bc[0], bc[1], bc[2], (bc.length > 3 ? bc[3] : 1) * (bc.length > 3 ? 1 : op));
        var map = mget(mt, 'uMap', 'map');
        var useMap = map && (typeof WebGLTexture === 'undefined' || map instanceof WebGLTexture) && mget(mt, 'uUseMap', 'useMap') !== 0 && mget(mt, 'uUseMap', 'useMap') !== false;
        gl.uniform1f(u.uUseMap, useMap ? 1 : 0);
        if (useMap) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, map); }
        gl.uniform1f(u.uMetallic, num(mget(mt, 'uMetallic', 'metallic'), 0));
        gl.uniform1f(u.uRoughness, num(mget(mt, 'uRoughness', 'roughness'), 0.7));
        gl.uniform1f(u.uClearcoat, num(mget(mt, 'uClearcoat', 'clearcoat'), 0));
        gl.uniform1f(u.uAlphaTest, num(mt.alphaTest, 0));
        gl.uniform1f(u.uUnlit, mt.unlit ? 1 : 0);
        gl.uniform3fv(u.uEmissive, mget(mt, 'uEmissive', 'emissive') || ZERO3);
        var po = mt.polygonOffset;
        if (po) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(po[0], po[1]); }
        gl.depthMask(blend ? mt.depthWrite === true : mt.depthWrite !== false);
        gl.bindBuffer(gl.ARRAY_BUFFER, B.pos); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        if (B.nrm) { gl.bindBuffer(gl.ARRAY_BUFFER, B.nrm); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0); }
        else { gl.disableVertexAttribArray(1); gl.vertexAttrib3f(1, 0, 1, 0); }
        if (B.uv) { gl.bindBuffer(gl.ARRAY_BUFFER, B.uv); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0); }
        else { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0, 0); }
        if (B.col) { gl.bindBuffer(gl.ARRAY_BUFFER, B.col); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, me.colorSize, gl.FLOAT, false, 0, 0); }
        else { gl.disableVertexAttribArray(3); gl.vertexAttrib4f(3, 1, 1, 1, 1); }
        if (me.ibo) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, me.ibo); gl.drawElements(gl.TRIANGLES, me.count, me.indexType, 0); }
        else gl.drawArrays(gl.TRIANGLES, 0, me.count);
        if (po) gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      bindLite();
      gl.disable(gl.BLEND);
      for (i = 0; i < opaque.length; i++) drawOne(opaque[i], false);
      unbindLite();
      if (customPre.length) drawCustom(customPre);
      if (trans.length) {
        bindLite();
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        for (i = 0; i < trans.length; i++) drawOne(trans[i], true);
        gl.disable(gl.BLEND);
        unbindLite();
      }
      if (customPost.length) drawCustom(customPost);
      return opaque.length + trans.length + customPre.length + customPost.length;
    };
    return lite;
  }
  var IDENT_LITE = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /* ================================================================ support detection */
  var supportCache = null;
  function hasCore() {
    var G = CB.gl;
    return !!(G && typeof G.createContext === 'function' && typeof G.shaders === 'function' &&
      typeof G.drawList === 'function' && typeof G.createMesh === 'function');
  }
  /** WebGL available? (The built-in lite core keeps the 3D view working even if gl-core.js is missing.) */
  function isSupported() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return false;
    if (supportCache !== null) return supportCache;
    try {
      if (hasCore() && typeof CB.gl.isSupported === 'function') { supportCache = !!CB.gl.isSupported(); return supportCache; }
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      supportCache = !!gl;
      if (gl) { var ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
    } catch (e) { supportCache = false; }
    return supportCache;
  }

  /* ================================================================ create */
  function create(canvas, geom, trackDef, opts) {
    if (!canvas) throw new Error('renderer3d: canvas required');
    opts = opts || {};
    geom = geom || {};
    trackDef = trackDef || geom.def || {};
    CB.gl = CB.gl || {};
    var M = CB.gl;                                   // sub-modules (track, scenery, car, cockpit, effects, textures)
    var G = (opts.forceLite || !hasCore()) ? createLiteCore() : CB.gl;   // core (context, meshes, shaders, drawList)
    var doc = canvas.ownerDocument || document;
    var win = doc.defaultView || window;
    if (!G.lite && opts.optionalModules !== false) ensureOptionalModules(doc);

    var S = {
      mode: 'cockpit', lookBack: false, labels: true,
      quality: normQuality(opts.quality) || 'high',
      autoQuality: opts.autoQuality !== false,
      timeOfDay: opts.timeOfDay || 'day', weather: opts.weather || 'dry',
      racingLine: !!opts.racingLine, manualFx: opts.manualEffects === true,
      frame: 0, time: 0, last: 0, fps: 60, frameMs: 16.7, cpuMs: 0,
      cars: {}, carOrder: [], playerId: 'player',
      lost: false, destroyed: false, warned: {}, fbGeoCache: {}, fbMeshCache: {},
      sizeKey: '', cssW: 1, cssH: 1, glW: 1, glH: 1,
      governor: createGovernor({ thresholdMs: num(opts.frameBudgetMs, 22) }),
      prevSnapT: null, dyn: { latG: mkSpring(), longG: mkSpring(), lastSpeed: null, lastHeading: null, lastT: null, rawLat: 0, rawLong: 0 },
      cam: {
        snap: true, yaw: mkSpring(), dist: mkSpring(6), fov: mkSpring(65), look: mkSpring(),
        head: mkSpring3(), roll: mkSpring(), pitch: mkSpring(), tvTarget: mkSpring3(), heliPos: mkSpring3(),
        heliA: 0.6, tvIndex: -1, trauma: 0, eye: [0, 2, 5], target: [0, 1, 0], up: [0, 1, 0], fovDeg: 65, near: 0.1, far: 2000
      },
      stats: { drawn: 0, culled: 0, cars: 0, high: 0, shadow: false, mirror: false, post: false }
    };
    S.Q = QUALITY[S.quality];
    S.lit = lightingFor(S.timeOfDay, S.weather);

    var hasCockpit = true;   // the built-in interior guarantees a first-person view
    var initial = normMode(opts.camera);
    S.mode = initial && initial !== 'map' ? initial : (initial === 'map' ? 'map' : (hasCockpit ? 'cockpit' : 'chase'));

    /* ---------------- DOM: GL canvas layered behind the HUD canvas */
    var glCanvas = doc.createElement('canvas');
    glCanvas.className = 'race3d-gl';
    glCanvas.setAttribute('aria-hidden', 'true');
    var gs = glCanvas.style;
    gs.position = 'absolute'; gs.pointerEvents = 'none'; gs.display = 'block'; gs.left = '0px'; gs.top = '0px';
    gs.margin = '0'; gs.padding = '0'; gs.border = '0';
    var saved = { background: canvas.style.background, backgroundColor: canvas.style.backgroundColor, position: canvas.style.position };
    canvas.style.background = 'transparent';
    canvas.style.backgroundColor = 'transparent';
    var ctx2d = null;
    try { ctx2d = canvas.getContext('2d'); } catch (e) { ctx2d = null; }

    function ensureDom() {
      if (!glCanvas.parentNode && canvas.parentNode) {
        canvas.parentNode.insertBefore(glCanvas, canvas);
        try {
          var cs = win.getComputedStyle(canvas);
          if (cs && cs.position === 'static') canvas.style.position = 'relative'; // keep the HUD canvas above the positioned GL canvas
          if (cs && cs.zIndex && cs.zIndex !== 'auto') gs.zIndex = cs.zIndex;
        } catch (e) { /* ignore */ }
      }
    }
    ensureDom();

    /* ---------------- GL context */
    var ctx, gl, isGL2, shaders, colorSize = 4;
    function initContext() {
      if (!G.lite) {
        try { initContextWith(G); return; }
        catch (e) {
          warn('gl-core init failed, using built-in lite core', e);
          if (ctx && ctx.gl && typeof ctx.destroy === 'function') { try { ctx.destroy(); } catch (e2) { /* ignore */ } }
          // a canvas cannot switch context types; start over on a fresh canvas
          var fresh = doc.createElement('canvas');
          fresh.className = glCanvas.className; fresh.setAttribute('aria-hidden', 'true'); fresh.style.cssText = glCanvas.style.cssText;
          if (glCanvas.parentNode) glCanvas.parentNode.replaceChild(fresh, glCanvas);
          glCanvas = fresh; gs = glCanvas.style;
          G = createLiteCore();
        }
      }
      initContextWith(G);
    }
    function initContextWith(G, reuse) {
      // context restore: the gl-core wrapper already refreshed itself (its own webglcontextrestored listener was
      // registered first and bumped ctx.generation); creating a second wrapper would leak another listener pair
      if (reuse && ctx && ctx.gl && ctx._onRestored && !G.lite) { if (ctx.lost) ctx._onRestored(); }
      else ctx = G.createContext(glCanvas, { antialias: true, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, webgl1: !!opts.webgl1 });
      if (!ctx) throw new Error('renderer3d: WebGL context creation failed');
      gl = ctx.gl || ctx;
      isGL2 = !!(ctx.isWebGL2 || (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext));
      shaders = G.shaders(ctx) || {};
      if (S.gpuTimer) safe('gpuTimer.destroy', function () { S.gpuTimer.destroy(); });
      S.gpuTimer = isGL2 && !G.lite && opts.gpuTimer !== false ? safe('gpuTimer', function () { return createGpuTimer(gl); }, null) : null;
      colorSize = num(G.COLOR_SIZE, num(ctx.colorSize, 4));
      if (!shaders.standard && !G.lite) throw new Error('CB.gl.shaders() returned no standard program');
    }
    initContext();
    /** Does the scene shading output linear HDR (=> the post composite must tonemap + gamma)? */
    function linearPipeline(usePost) {
      if (G.lite || !usePost) return false;
      return !!(G.linearOutput || ctx.linearOutput || (shaders && shaders.linearOutput));
    }

    var onLost = function (e) { if (e && e.preventDefault) e.preventDefault(); S.lost = true; };
    var onRestored = function () {
      try { S.lost = false; if (ctx && ctx.gl && ctx._onRestored && !G.lite) initContextWith(G, true); else initContext(); if (M.car && M.car.cache && typeof M.car.cache.clear === 'function') safe('car.cache.clear', function () { M.car.cache.clear(ctx); }); S.fbMeshCache = {}; S.cockpitBuild = null; buildWorld(); S.cars = {}; S.cockpit = null; S.post = null; S.targets = null; S.sizeKey = ''; destroyPost2(); destroyProbe(); S.post2Broken = false; S.probeBroken = false; S.nearBroken = false; }
      catch (e) { warn('restore', e); S.lost = true; }
    };
    glCanvas.addEventListener('webglcontextlost', onLost, false);
    glCanvas.addEventListener('webglcontextrestored', onRestored, false);
    /** gl-core initialised but its drawList keeps throwing (driver / shader-link quirk): tear the gl-core world down
        and rebuild everything on a fresh canvas with the built-in lite core, so the race still shows track + cars
        instead of a blank view (called between frames, see render()). */
    function switchToLite(reason) {
      if (G.lite || S.destroyed) return false;
      warn('gl-core draw failed, switching to built-in lite core', reason);
      var W = S.world || {};
      ['effects', 'scenery', 'track', 'shadow'].forEach(function (k) {
        if (W[k] && typeof W[k].destroy === 'function') safe(k + '.destroy', function () { W[k].destroy(); });
      });
      if (S.cockpit && typeof S.cockpit.destroy === 'function') safe('cockpit.destroy', function () { S.cockpit.destroy(); });
      destroyTargets(); destroyPost2(); destroyProbe();
      if (M.car && M.car.cache && typeof M.car.cache.clear === 'function') safe('car.cache.clear', function () { M.car.cache.clear(ctx); });
      var TX = CB.gl && CB.gl.textures;
      if (TX && typeof TX.dispose === 'function') safe('textures.dispose', function () { TX.dispose(ctx && ctx.gl ? ctx : gl); });
      if (ctx && typeof ctx.destroy === 'function') safe('ctx.destroy', function () { ctx.destroy(); });
      glCanvas.removeEventListener('webglcontextlost', onLost);
      glCanvas.removeEventListener('webglcontextrestored', onRestored);
      var fresh = doc.createElement('canvas');
      fresh.className = glCanvas.className; fresh.setAttribute('aria-hidden', 'true'); fresh.style.cssText = glCanvas.style.cssText;
      if (glCanvas.parentNode) glCanvas.parentNode.replaceChild(fresh, glCanvas);
      glCanvas = fresh; gs = glCanvas.style;
      G = createLiteCore();
      var ok = safe('lite core init', function () { initContextWith(G); return true; }, false);
      if (!ok) { S.lost = true; return false; }   // no WebGL at all: render() shows the 2D view
      glCanvas.addEventListener('webglcontextlost', onLost, false);
      glCanvas.addEventListener('webglcontextrestored', onRestored, false);
      S.fbMeshCache = {}; S.fbGeoCache = S.fbGeoCache || {}; S.cockpitBuild = null; S.cockpitFailed = null;
      S.cars = {}; S.cockpit = null; S.cockpitModel = null; S.cockpitSelfDraw = false; S.post = null; S.postBroken = false;
      S.targets = null; S.sizeKey = ''; S.post2Broken = false; S.probeBroken = false; S.nearBroken = false;
      buildWorld();
      S.liteSwitched = true;
      return true;
    }

    function warn(key, e) {
      if (S.warned[key]) return;
      S.warned[key] = true;
      if (typeof console !== 'undefined' && console.warn) console.warn('[renderer3d] ' + key + ':', e && (e.stack || e.message || e));
    }
    function safe(key, fn, fallback) {
      try { return fn(); } catch (e) { warn(key, e); return fallback; }
    }
    /** closure-free variant of safe() for the per-frame hot path: fn.call(self, a, b, c, d) */
    function call4(key, self, fn, a, b, c, d, fallback) {
      try { return fn.call(self, a, b, c, d); } catch (e) { warn(key, e); return fallback; }
    }
    /** With the built-in lite core, sub-modules (track, cockpit, car, scenery) that feature-detect CB.gl.createMesh
        get the lite mesh factory for the duration of their build, so they produce drawable meshes + resolved
        (textured) materials instead of bare descriptors. */
    function withCore(fn) {
      if (!G.lite) return fn();
      // always swap in the lite factory: when gl-core is loaded but failed to init, its createMesh would be
      // handed the lite context (no bindVAO) and every track/scenery/car build would throw
      var had = Object.prototype.hasOwnProperty.call(CB.gl, 'createMesh'), prev = CB.gl.createMesh;
      CB.gl.createMesh = G.createMesh;
      try { return fn(); } finally { if (had) CB.gl.createMesh = prev; else delete CB.gl.createMesh; }
    }
    function safeBuild(key, fn, fallback) { return safe(key, function () { return withCore(fn); }, fallback); }

    /* ---------------- materials (both plain and uniform-style keys so any drawList convention works) */
    function material(o) {
      var c = o.color || [1, 1, 1, 1];
      if (c.length === 3) c = [c[0], c[1], c[2], 1];
      var m = {
        baseColor: c, color: c, metallic: num(o.metallic, 0), roughness: num(o.roughness, 0.8),
        clearcoat: num(o.clearcoat, 0), emissive: o.emissive || [0, 0, 0], transparent: !!o.transparent,
        opacity: c[3], unlit: !!o.unlit, doubleSided: !!o.doubleSided
      };
      m.uBaseColor = m.baseColor; m.uMetallic = m.metallic; m.uRoughness = m.roughness; m.uClearcoat = m.clearcoat; m.uEmissive = m.emissive;
      return m;
    }
    function mesh(geo) { return G.createMesh(ctx, geo); }

    /* ---------------- world (track, scenery, effects, shadows) */
    var IDENT = m4.create();
    function wrapItem(src, extra) {
      var it = {};
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) it[k] = src[k];
      if (!it.model) it.model = it.matrix || IDENT;
      if (extra) for (var e in extra) it[e] = extra[e];
      return it;
    }

    /** Track-mesh material descriptor (no-core path) -> lite material. */
    function descriptorMaterial(d) {
      d = d || {};
      var c = d.tint || d.color || [1, 1, 1, 1];
      var a = d.color && d.color.length > 3 ? d.color[3] : 1;
      var m = material({ color: [c[0], c[1], c[2], a], metallic: num(d.metallic, 0), roughness: num(d.roughness, 0.8), clearcoat: num(d.clearcoat, 0), emissive: d.emissive || [0, 0, 0], transparent: !!d.transparent });
      if (d.decal) m.polygonOffset = [-1, -2];
      if (d.transparent) m.depthWrite = false;
      return m;
    }

    function buildWorld() {
      S.world = { staticItems: [], groundY: null, roadY: null };
      var W = S.world, built = null;
      // track
      if (M.track && typeof M.track.build === 'function') {
        built = safeBuild('track.build', function () { return M.track.build(ctx, geom, trackDef, { quality: S.quality, timeOfDay: S.timeOfDay, weather: S.weather }); }, null);
      }
      var trackItems = built && (built.meshes || built.items);
      if (trackItems && trackItems.length) {
        W.track = built;
        trackItems.forEach(function (m) {
          if (!m) return;
          if (!m.mesh && m.geometry && G.lite) {
            var g = m.geometry;
            m = wrapItem(m, { mesh: safe('lite track mesh', function () { return mesh(g); }, null), material: descriptorMaterial(g.material || m.material) });
          }
          if (m.mesh) W.staticItems.push(wrapItem(m, { _static: true }));
        });
        if (typeof built.groundY === 'function') W.groundY = built.groundY;
        if (typeof built.carY === 'function') W.roadY = function (car) { return built.carY(car); };
        else if (typeof built.heightAt === 'function') W.roadY = function (car) { return isNum(car.s) ? built.heightAt(car.s) : 0; };
      }
      if (!W.staticItems.length) {
        W.track = null;
        safe('fallback track', function () {
          var fb = fallbackTrackGeometry(geom, colorSize);
          W.staticItems.push({ mesh: mesh(fb.ground), material: material({ color: [1, 1, 1, 1], roughness: 1 }), model: IDENT, castShadow: false, _static: true });
          W.staticItems.push({ mesh: mesh(fb.road), material: material({ color: [1, 1, 1, 1], roughness: 0.85 }), model: IDENT, castShadow: false, _static: true });
          W.staticItems.push({ mesh: mesh(fb.walls), material: material({ color: [1, 1, 1, 1], roughness: 0.6 }), model: IDENT, castShadow: true, _static: true });
        });
      }
      // scenery (its own gantry lights are driven by setCountdown(cd) / update(time, camPos, snap))
      if (M.scenery && typeof M.scenery.build === 'function') {
        W.scenery = safeBuild('scenery.build', function () {
          return M.scenery.build(ctx, geom, trackDef, { quality: S.quality, timeOfDay: S.timeOfDay, weather: S.weather, groundY: W.groundY, track: W.track });
        }, null);
      }
      if (!W.scenery || W.scenery.hasGantry === false) buildFallbackGantry();
      // effects (sky, particles, skids, rain). They auto-emit smoke/skids/sparks from the snapshot.
      if (M.effects && typeof M.effects.create === 'function') {
        W.effects = safe('effects.create', function () {
          return M.effects.create(ctx, { quality: S.quality, maxParticles: S.Q.particles, weather: S.weather, timeOfDay: S.timeOfDay, geom: geom, trackDef: trackDef, seed: hashStr(geom.id || 'fx'), linearOutput: linearPipeline(S.Q.post), autoEmit: !S.manualFx });
        }, null);
      }
      S.lit = mergedLighting();
      // shadows
      createShadow();
      // TV cams
      W.tvCams = safe('tvCams', function () { return buildTvCams(geom, { blockers: W.scenery && W.scenery.placed }); }, []);
      W.tvCams.forEach(function (c) { c.elev = W.groundY ? safe('groundY', function () { return num(W.groundY(c.x, -c.y), 0); }, 0) : 0; });
      // camera occluders (heli line-of-sight) + street-circuit flag (narrow streets between buildings)
      W.occluders = safe('occluders', function () { return buildOccluders(geom, W.scenery && W.scenery.placed, W.groundY); }, []) || [];
      var stl = trackDef.style || (geom.def && geom.def.style) || {}, tags = trackDef.tags || [];
      W.street = !!(stl.street || (tags.indexOf && (tags.indexOf('street') >= 0 || tags.indexOf('city') >= 0)));
      // racing line
      W.racingLineItem = null;
    }

    /** Lighting preset; sun / sky / fog colours come from effects.getLighting() when present so shading matches the sky. */
    function mergedLighting() {
      var L = lightingFor(S.timeOfDay, S.weather);
      var FX = S.world && S.world.effects;
      var src = null;
      if (FX && typeof FX.getLighting === 'function') src = safe('effects.getLighting', function () { return FX.getLighting(S.timeOfDay, S.weather); }, null);
      else if (M.effects && typeof M.effects.getLighting === 'function') src = safe('effects.getLighting', function () { return M.effects.getLighting(S.timeOfDay, S.weather); }, null);
      if (src && src.sunDir) {
        L.sunDir = v3norm(src.sunDir.slice());
        if (src.sunColor) L.sunColor = src.sunColor.slice();
        if (src.ambientSky) L.ambientSky = src.ambientSky.slice();
        if (src.ambientGround) L.ambientGround = src.ambientGround.slice();
        if (src.fogColor) L.fogColor = src.fogColor.slice();
        if (isNum(src.fogDensity)) L.fogDensity = src.fogDensity * 0.55;
        if (src.skyZenith) L.envTop = src.skyZenith.slice();
        if (src.skyHorizon) L.envHorizon = src.skyHorizon.slice();
        if (src.skyGround) L.envBottom = src.skyGround.slice();
        if (isNum(src.exposure)) L.exposure = src.exposure;
        if (typeof src.headlights === 'boolean') L.headlights = src.headlights || L.headlights;
        L.streetLights = src.streetLights !== false && S.timeOfDay !== 'day';
        if (isNum(src.wetness)) L.wetness = src.wetness;
        if (isNum(src.shadowStrength)) L.shadowStrength = src.shadowStrength;
        if (isNum(src.bloom)) L.bloom = src.bloom;
        // the sun may be below the horizon at night (moonlight): keep it above for shading
        if (L.sunDir[1] < 0.05) { L.sunDir[1] = 0.05; v3norm(L.sunDir); }
      }
      // display-referred colours (sky / fog / env) -> linear for the shading pipeline
      var lin = function (c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; };
      L.fogColorDisplay = L.fogColor.slice();
      L.fogColor = lin(L.fogColor); L.envTop = lin(L.envTop); L.envHorizon = lin(L.envHorizon); L.envBottom = lin(L.envBottom);
      return L;
    }

    function createShadow() {
      var W = S.world;
      if (W.shadow && typeof W.shadow.destroy === 'function') safe('shadow.destroy', function () { W.shadow.destroy(); });
      if (W.shadowNear && typeof W.shadowNear.destroy === 'function') safe('shadowNear.destroy', function () { W.shadowNear.destroy(); });
      W.shadow = null; W.shadowSize = 0; W.shadowNear = null; W.shadowNearSize = 0;
      if (!S.Q.shadow || typeof G.createShadowMap !== 'function') return;
      W.shadow = safe('createShadowMap', function () { return G.createShadowMap(ctx, S.Q.shadow); }, null);
      W.shadowSize = W.shadow ? S.Q.shadow : 0;
      // near cascade (WebGL2 hardware depth maps only): a tight soft-shadow (PCSS) map around the cars
      if (W.shadow && isGL2 && !G.lite && S.Q.nearShadow && W.shadow.mode === 'hw' && opts.nearShadow !== false) {
        W.shadowNear = safe('createShadowMap near', function () { return G.createShadowMap(ctx, S.Q.nearShadow, { depthExtra: 50 }); }, null);
        if (W.shadowNear && W.shadowNear.ok === false) { safe('shadowNear.destroy', function () { W.shadowNear.destroy(); }); W.shadowNear = null; }
        W.shadowNearSize = W.shadowNear ? S.Q.nearShadow : 0;
      }
    }

    function buildFallbackGantry() {
      var W = S.world, sl = geom.startLine || (samplesOf(geom)[0]);
      if (!sl) return;
      safe('gantry', function () {
        var hdg = num(sl.heading, 0), hw = num(sl.halfWidth, num(sl.hw, 6)) + 1.5;
        var frame = emptyGeo();
        geoBox(frame, [0, 3.3, -hw], [0.4, 6.6, 0.4], [0.2, 0.21, 0.23, 1]);
        geoBox(frame, [0, 3.3, hw], [0.4, 6.6, 0.4], [0.2, 0.21, 0.23, 1]);
        geoBox(frame, [0, 6.4, 0], [0.5, 0.6, hw * 2 + 0.4], [0.16, 0.17, 0.19, 1]);
        geoBox(frame, [-0.3, 5.7, 0], [0.12, 1.0, 3.6], [0.05, 0.05, 0.06, 1]);
        var m = carMatrix(m4.create(), sl.x, sl.y, 0, hdg, 0, 0);
        W.staticItems.push({ mesh: mesh(finishGeo(frame, colorSize)), material: material({ color: [1, 1, 1, 1], roughness: 0.5, metallic: 0.3 }), model: m, castShadow: true, _static: true });
        var lampMesh = mesh(finishGeo(geoBox(emptyGeo(), [0, 0, 0], [0.1, 0.42, 0.42], [1, 1, 1, 1]), colorSize));
        W.gantryLights = [];
        for (var i = 0; i < 5; i++) {
          var lm = carMatrix(m4.create(), sl.x, sl.y, 0, hdg, 0, 0);
          var off = xformPoint(lm, -0.38, 5.75, (i - 2) * 0.68);
          lm[12] = off[0]; lm[13] = off[1]; lm[14] = off[2];
          var mat = material({ color: [0.12, 0.02, 0.02, 1], roughness: 0.3 });
          var it = { mesh: lampMesh, material: mat, model: lm, castShadow: false, _static: true, _gantry: i };
          W.gantryLights.push(it); W.staticItems.push(it);
        }
      });
    }
    function updateGantry(cd) {
      var W = S.world;
      if (W.scenery) {
        if (typeof W.scenery.setCountdown === 'function') safe('scenery.setCountdown', function () { W.scenery.setCountdown(cd); });
      }
      if (!W.gantryLights) return;
      var on = cd && !cd.lightsOut ? clamp(Math.round(num(cd.lightsOn, 0)), 0, 5) : 0;
      W.gantryLights.forEach(function (it, i) {
        var lit = i < on;
        var e = lit ? [4.0, 0.25, 0.12] : [0, 0, 0];
        it.material.emissive = e; it.material.uEmissive = e;
      });
    }

    buildWorld();

    /* ---------------- 2D map delegate */
    function render2D(snap, alpha) {
      gs.visibility = 'hidden';
      if (!S.r2d && CB.race.renderer && typeof CB.race.renderer.create === 'function') {
        S.r2d = safe('renderer2d.create', function () {
          var r = CB.race.renderer.create(canvas, geom, trackDef, { timeOfDay: S.timeOfDay, weather: S.weather, racingLine: S.racingLine, camera: opts.camera2d || 'chase' });
          if (r && r.setCamera) r.setCamera(opts.camera2d || 'chase');
          return r;
        }, null);
      }
      if (S.r2d) safe('renderer2d.render', function () { S.r2d.render(snap, alpha); });
      else clear2D();
    }
    function clear2D() {
      if (!ctx2d) return;
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    }

    /* ---------------- sizing */
    function ensureSize() {
      ensureDom();
      var cw = canvas.clientWidth || canvas.offsetWidth || 1, ch = canvas.clientHeight || canvas.offsetHeight || 1;
      var dpr = win.devicePixelRatio || 1;
      var hudDpr = Math.min(dpr, 2);
      var w2 = Math.max(1, Math.round(cw * hudDpr)), h2 = Math.max(1, Math.round(ch * hudDpr));
      if (canvas.width !== w2 || canvas.height !== h2) { canvas.width = w2; canvas.height = h2; }
      var gdpr = Math.min(dpr, S.Q.maxDpr) * S.Q.scale;
      var key = cw + 'x' + ch + '@' + gdpr.toFixed(3) + ':' + canvas.offsetLeft + ',' + canvas.offsetTop;
      if (key !== S.sizeKey) {
        S.sizeKey = key; S.cssW = cw; S.cssH = ch;
        gs.left = canvas.offsetLeft + 'px'; gs.top = canvas.offsetTop + 'px';
        gs.width = cw + 'px'; gs.height = ch + 'px';
        var gw = Math.max(1, Math.round(cw * gdpr)), gh = Math.max(1, Math.round(ch * gdpr));
        if (ctx && typeof ctx.resize === 'function') safe('ctx.resize', function () { ctx.resize(cw, ch, gdpr); });
        if (glCanvas.width !== gw || glCanvas.height !== gh) { glCanvas.width = gw; glCanvas.height = gh; }
        gs.width = cw + 'px'; gs.height = ch + 'px';
        S.glW = glCanvas.width; S.glH = glCanvas.height;
        destroyTargets();
      }
    }

    /* ---------------- post FX / render targets */
    function ensurePost() {
      if (S.post || S.postBroken) return S.post;
      S.post = safe('post init', function () {
        var P = {
          composite: compileProgram(gl, POST_VS, COMPOSITE_FS),
          bright: compileProgram(gl, POST_VS, BRIGHT_FS),
          blur: compileProgram(gl, POST_VS, BLUR_FS),
          vbo: gl.createBuffer()
        };
        gl.bindBuffer(gl.ARRAY_BUFFER, P.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return P;
      }, null);
      if (!S.post) S.postBroken = true;
      return S.post;
    }
    function destroyTargets() {
      var T = S.targets;
      if (T) ['scene', 'bloomA', 'bloomB', 'mirror', 'mirrorBack'].forEach(function (k) { if (T[k]) safe('rt.destroy', function () { T[k].destroy(); }); });
      S.targets = null;
    }
    function ensureTargets() {
      if (S.targets) return S.targets;
      var T = S.targets = {};
      var w = S.glW, h = S.glH;
      if (S.Q.post && !usePost2() && ensurePost()) {
        T.scene = safe('rt scene', function () { return createTarget(gl, isGL2, w, h, { depth: true, samples: S.Q.msaa }); }, null);
        if (T.scene && !T.scene.ok) { T.scene.destroy(); T.scene = null; }
        if (T.scene && S.Q.bloom) {
          var bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
          T.bloomA = safe('rt bloom', function () { return createTarget(gl, isGL2, bw, bh, {}); }, null);
          T.bloomB = safe('rt bloom', function () { return createTarget(gl, isGL2, bw, bh, {}); }, null);
        }
      }
      return T;
    }
    function ensureMirrorTarget() {
      var T = ensureTargets();
      var ckm = S.cockpit && S.cockpit.mirror;
      var asp = ckm && isNum(ckm.width) && isNum(ckm.height) && ckm.height > 0 ? clamp(ckm.width / ckm.height, 1.5, 6) : 3.2;
      // multiples of 8 (odd-sized render targets are a needless risk on tiled GPUs)
      var mw = Math.max(64, Math.round(S.glW * S.Q.mirrorScale / 8) * 8), mh = Math.max(24, Math.round(mw / asp / 8) * 8);
      // double-buffered: the mirror pass renders into mirrorBack while the cockpit samples the previous result
      // (T.mirror). Sampling a texture rendered earlier in the same frame was unreliable on ANGLE/Metal.
      ['mirror', 'mirrorBack'].forEach(function (k) {
        if (T[k] && (T[k].w !== mw || T[k].h !== mh)) { T[k].destroy(); T[k] = null; }
        if (!T[k]) {
          // multisampled (WebGL2) + explicit blit resolve: anti-aliased mirror, and the resolve is the same reliable
          // render->texture path the main scene uses
          T[k] = safe('rt mirror', function () { return createTarget(gl, isGL2, mw, mh, { depth: true, samples: isGL2 ? 4 : 0 }); }, null);
          if (T[k] && !T[k].ok) { T[k].destroy(); T[k] = null; }
        }
      });
      return T.mirrorBack || T.mirror;
    }
    function unbindVAO() {
      if (isGL2 && gl.bindVertexArray) gl.bindVertexArray(null);
      else {
        var ext = S.vaoExt === undefined ? (S.vaoExt = gl.getExtension('OES_vertex_array_object')) : S.vaoExt;
        if (ext) ext.bindVertexArrayOES(null);
      }
    }
    function fsPass(prog, setup) {
      var P = S.post;
      gl.useProgram(prog.program);
      unbindVAO();
      gl.bindBuffer(gl.ARRAY_BUFFER, P.vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      setup(prog.u);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(0);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    function postState() {
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      if (gl.disable && gl.SCISSOR_TEST) gl.disable(gl.SCISSOR_TEST);
      gl.depthMask(true);
      gl.colorMask(true, true, true, true);
    }
    function runPost(T, speed) {
      var P = S.post, Q = S.Q;
      postState();
      T.scene.resolve();
      var bloom = !!(Q.bloom && T.bloomA && T.bloomB);
      if (bloom) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.bloomA.fb); gl.viewport(0, 0, T.bloomA.w, T.bloomA.h);
        fsPass(P.bright, function (u) {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.scene.tex);
          gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uTexel, 1 / T.scene.w, 1 / T.scene.h);
          gl.uniform1f(u.uThreshold, S.timeOfDay === 'night' ? 0.62 : 0.8);
        });
        for (var pass = 0; pass < 2; pass++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, T.bloomB.fb);
          fsPass(P.blur, function (u) {
            gl.bindTexture(gl.TEXTURE_2D, T.bloomA.tex); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, (1 + pass) / T.bloomA.w, 0);
          });
          gl.bindFramebuffer(gl.FRAMEBUFFER, T.bloomA.fb);
          fsPass(P.blur, function (u) {
            gl.bindTexture(gl.TEXTURE_2D, T.bloomB.tex); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, 0, (1 + pass) / T.bloomA.h);
          });
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, S.glW, S.glH);
      var gr = S.lit.grade || {};
      var sb = Q.speedBlur && (S.mode === 'chase' || S.mode === 'chase-far' || S.mode === 'bumper' || S.mode === 'hood' || S.mode === 'cockpit')
        ? smoothstep(42, 95, speed) * (S.mode === 'cockpit' ? 0.55 : 1) : 0;
      fsPass(P.composite, function (u) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.scene.tex); gl.uniform1i(u.uScene, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bloom ? T.bloomA.tex : T.scene.tex); gl.uniform1i(u.uBloom, 1);
        gl.uniform2f(u.uTexel, 1 / T.scene.w, 1 / T.scene.h);
        gl.uniform1f(u.uAspect, S.glW / Math.max(1, S.glH));
        gl.uniform1f(u.uBloomStr, bloom ? (S.timeOfDay === 'night' ? 0.9 : S.timeOfDay === 'dusk' ? 0.7 : 0.45) : 0);
        gl.uniform1f(u.uVignette, S.mode === 'tv' ? 0.55 : 0.38);
        gl.uniform1f(u.uSpeedBlur, sb);
        gl.uniform1f(u.uFxaa, Q.fxaa && !T.scene.samples ? 1 : 0);
        gl.uniform1f(u.uTonemap, S.frameLinear ? 1 : 0);
        gl.uniform1f(u.uExposure, num(S.lit.exposure, 1));
        gl.uniform1f(u.uSaturation, num(gr.saturation, 1));
        gl.uniform1f(u.uContrast, num(gr.contrast, 1));
        var lf = gr.lift || [0, 0, 0], gn = gr.gain || [1, 1, 1];
        gl.uniform3f(u.uLift, lf[0], lf[1], lf[2]);
        gl.uniform3f(u.uGain, gn[0], gn[1], gn[2]);
        gl.uniform1f(u.uFlash, clamp01(S.flash || 0));
        gl.uniform3f(u.uFlashColor, 1, 0.92, 0.8);
        gl.uniform1f(u.uTime, (S.time % 100));
        gl.uniform1f(u.uGrain, num(Q.grain, 0));
      });
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.enable(gl.DEPTH_TEST);
    }

    /* ---------------- HDR post chain (CB.gl.post) + reflection probe (CB.gl.envmap) */
    /** The CB.gl.post chain replaces the built-in post (runPost) whenever the module is loaded, the core is the real
        gl-core and the tier enables post FX. Any failure falls back to the built-in path for the session. */
    function usePost2() {
      return !G.lite && !S.post2Broken && !!S.Q.post && opts.hdrPost !== false && !!(CB.gl.post && typeof CB.gl.post.create === 'function');
    }
    function ensurePost2() {
      if (!usePost2()) return null;
      if (S.post2 && S.post2Gen !== ctx.generation) destroyPost2();
      if (!S.post2) {
        S.post2 = safe('post2.create', function () { return CB.gl.post.create(ctx, { quality: S.quality }); }, null);
        S.post2Gen = ctx.generation;
        if (!S.post2) { S.post2Broken = true; return null; }
        destroyTargets();          // frees the legacy scene / bloom targets
      }
      return S.post2;
    }
    function destroyPost2() {
      if (S.post2 && typeof S.post2.destroy === 'function') { var p2 = S.post2; safe('post2.destroy', function () { p2.destroy(); }); }
      S.post2 = null;
    }
    function ensureProbe() {
      if (G.lite || S.probeBroken || opts.envProbe === false || !(CB.gl.envmap && typeof CB.gl.envmap.create === 'function')) return null;
      if (S.envProbe && S.probeGen !== ctx.generation) destroyProbe();
      if (!S.envProbe) {
        S.envProbe = safe('envmap.create', function () {
          return CB.gl.envmap.create(ctx, { quality: S.quality, timeOfDay: S.timeOfDay, weather: S.weather, lighting: S.lit });
        }, null);
        S.probeGen = ctx.generation;
        if (!S.envProbe) S.probeBroken = true;
      }
      return S.envProbe;
    }
    function destroyProbe() {
      if (S.envProbe && typeof S.envProbe.destroy === 'function') { var pr = S.envProbe; safe('envmap.destroy', function () { pr.destroy(); }); }
      S.envProbe = null;
    }
    // envmap SH (coefficients with the basis constants applied in the shader) -> gl-core uSH (constants folded in)
    var SH_BASIS = [0.282095, 0.488603, 0.488603, 0.488603, 1.092548, 1.092548, 0.315392, 1.092548, 0.546274];
    var probeEnvMap = { texture: null, maxLod: 0, rgbm: false }, probeSH = new Float32Array(27);
    var probeScene = { items: null, env: null, drawSky: null, setLinearOutput: null, restoreLinear: false, clearColor: null };
    function probeSetLinear(b) { var FX = S.world && S.world.effects; if (FX && typeof FX.setLinearOutput === 'function') FX.setLinearOutput(b); }
    /** Refresh the probe (time-sliced capture around the player) and hand its cube + SH ambient to the env. */
    function updateProbe(env, items, pos) {
      var pr = ensureProbe();
      env.envMap = undefined; env.sh = null;
      if (!pr) return;
      probeScene.items = items; probeScene.env = env; probeScene.drawSky = drawSky; probeScene.setLinearOutput = probeSetLinear;
      probeScene.clearColor = S.lit.fogColor;
      if (pos) call4('envmap.update', pr, pr.update, probeScene, pos, S.frame, undefined, false);
      probeScene.items = null; probeScene.env = null;
      var tex = pr.texture;
      if (!tex) return;
      probeEnvMap.texture = tex; probeEnvMap.maxLod = num(pr.maxLod, 0); probeEnvMap.rgbm = false;
      env.envMap = probeEnvMap;
      env.envMapIntensity = num(S.lit.envIntensity, 1);
      // ground-parallax lookups (gl-core probeDir): where the probe was captured and the road height under it
      var cpos = pr.capturePos || null;
      env.envProbePos = cpos; env.envProbeGround = cpos ? cpos[1] - 1.0 : undefined;
      var sh = pr.sh;
      if (sh && sh.length >= 27 && pr.valid && opts.probeSH !== false) {
        // blend the captured irradiance with the tuned hemisphere ambient (keeps the presets' overall level)
        var k = num(opts.probeSHMix, 1);
        for (var b = 0; b < 9; b++) for (var c = 0; c < 3; c++) probeSH[b * 3 + c] = sh[b * 3 + c] * SH_BASIS[b] * k;
        env.sh = probeSH;
      }
    }

    /* ---------------- cars */
    function carEntry(c) {
      var e = S.cars[c.id];
      if (!e) {
        e = S.cars[c.id] = {
          id: c.id, build: c.build, models: {}, poseState: {}, view: {}, pose: {}, mat: m4.create(), visMat: m4.create(),
          skidOn: [false, false, false, false], skidLast: [null, null, null, null], elev: 0, dist: 0, items: null, lod: 'low'
        };
      } else if (c.build && e.build !== c.build) {
        var same = false;
        try { same = JSON.stringify(c.build) === JSON.stringify(e.build); } catch (err) { same = false; }
        e.build = c.build;
        if (!same) { e.models = {}; e.poseState = {}; }
      }
      e.seen = S.frame;
      return e;
    }
    function buildCarModel(c, lod) {
      if (M.car && typeof M.car.build === 'function' && c.build) {
        var m = safeBuild('car.build', function () {
          return M.car.build(ctx, c.build, {
            number: c.number, color: c.color, accent: c.accent, lod: lod, id: c.id, name: c.name, team: c.team,
            bodyStyle: c.bodyStyle, length_m: c.length_m, width_m: c.width_m, isPlayer: !!c.isPlayer
          });
        }, null);
        if (m && (m.parts || m.items)) return m;
      }
      return fallbackCarModel(c);
    }
    function fallbackCarModel(c) {
      return safe('fallback car', function () {
        var style = String(c.bodyStyle || (c.build && c.build.body && (c.build.body.style || c.build.body.type)) || 'coupe');
        var L = num(c.length_m, 4.5), W = num(c.width_m, 1.9);
        var H = /suv|van/.test(style) ? 1.75 : /pickup/.test(style) ? 1.7 : /hyper/.test(style) ? 1.12 : /roadster/.test(style) ? 1.22 : 1.32;
        var key = [L.toFixed(2), W.toFixed(2), H, style, colorSize].join('|');
        var fb = S.fbGeoCache[key] || (S.fbGeoCache[key] = fallbackCarGeometry(L, W, H, colorSize, style));
        var rgb = hexToRgb(c.color, [0.8, 0.1, 0.1]).map(function (v) { return Math.pow(v, 2.2); });   // sRGB paint -> linear
        var gm = S.fbMeshCache[key] || (S.fbMeshCache[key] = { body: mesh(fb.body), glass: mesh(fb.glass), dark: mesh(fb.dark), lights: mesh(fb.lights) });
        return {
          parts: [
            { mesh: gm.body, material: material({ color: [rgb[0], rgb[1], rgb[2], 1], metallic: 0.35, roughness: 0.3, clearcoat: 0.8 }), local: IDENT, kind: 'body' },
            { mesh: gm.glass, material: material({ color: [0.04, 0.05, 0.07, 1], metallic: 0.3, roughness: 0.06, clearcoat: 1 }), local: IDENT, kind: 'glass' },
            { mesh: gm.dark, material: material({ color: [1, 1, 1, 1], roughness: 0.6, metallic: 0.2 }), local: IDENT, kind: 'wheels' },
            { mesh: gm.lights, material: material({ color: [1, 1, 1, 1], unlit: true, emissive: [0.15, 0.12, 0.1] }), local: IDENT, kind: 'light-head', castShadow: false }
          ],
          dims: fb.dims, cockpitEye: fb.cockpitEye, hoodCam: fb.hoodCam, bumperCam: fb.bumperCam, _fallback: true
        };
      }, null);
    }
    function getModel(e, c, lod, allowBuild) {
      if (e.models[lod]) return e.models[lod];
      if (!allowBuild) return null;
      var m = buildCarModel(c, lod);
      if (m) { enhanceCarMaterials(m, lod); e.models[lod] = m; }
      return m;
    }
    /** PBR upgrade of the car-mesh materials (renderer side, idempotent, keyed by material name): circular-brushed
        anisotropic rims (wheel-local spin axis = +Z, see car-mesh wheelLocal), sidewall normal + ORM maps on the
        tyres (same UV layout as tireSidewall) and twill normal + ORM maps on the carbon parts (same layout as
        carbonWeave). Maps only on the high LOD and on the real gl-core path; anything missing is skipped. */
    function enhanceCarMaterials(m, lod) {
      if (!m || m._fallback || G.lite || opts.pbrMaps === false) return;
      var parts = m.parts || m.items || [];
      var TX = CB.gl && CB.gl.textures, maps = lod === 'high' && S.quality !== 'low' && TX && ctx && ctx.gl;
      for (var i = 0; i < parts.length; i++) {
        var mt = parts[i] && parts[i].material;
        if (!mt || mt._r3dPbr) continue;
        mt._r3dPbr = true;
        var nm = String(mt.name || '');
        if (nm === 'rim' && num(mt.metallic, 0) > 0.5 && mt.anisotropy == null) {
          mt.anisotropy = 0.55; mt.anisotropyAxis = [0, 0, 1, 1];
        } else if (nm === 'caliper' && mt.clearcoatRoughness == null) {
          mt.clearcoatRoughness = 0.08;
        } else if (nm === 'paint' || nm === 'roof') {
          if (mt.clearcoatRoughness == null) mt.clearcoatRoughness = 0.035;
        } else if (maps && nm === 'tyre' && mt.map && !mt.normalMap) {
          var tn = safe('tex tireSidewallNormal', function () { return TX.tireSidewallNormal ? TX.tireSidewallNormal(ctx) : null; }, null);
          var to = safe('tex tireSidewallOrm', function () { return TX.tireSidewallOrm ? TX.tireSidewallOrm(ctx) : null; }, null);
          if (tn) { mt.normalMap = tn; mt.normalScale = 0.8; }
          if (to) { mt.roughnessMap = to; mt.aoMap = to; mt.aoStrength = 0.6; mt.roughness = 1; }
        } else if (maps && nm === 'carbon' && mt.map && !mt.normalMap) {
          var cn = safe('tex carbonFibreNormal', function () { return TX.carbonFibreNormal ? TX.carbonFibreNormal(ctx) : null; }, null);
          if (cn) { mt.normalMap = cn; mt.normalScale = 0.6; }
        }
      }
    }
    /** HDR pipeline: tail lamps (lights on) and brake lamps get enough emissive range to reach the bloom threshold. */
    function boostLamps(e) {
      var mats = e.poseState && e.poseState.mats, lb = mats && mats['light-brake'];
      if (!lb || !lb.emissive || !S.stats.hdr) return;
      var em = lb.emissive, r = em[0];
      if (!(r > 0.5)) return;
      // tail 0.7 -> 2.0 (clears the night bloom threshold without braking), brake 1.5..3.4 -> 2.4..5.4
      var k = r < 1.4 ? 2.0 / r : 1.6;
      em[0] = r * k; em[1] *= k; em[2] *= k;
    }
    function roadElevation(c) {
      var f = S.world.roadY;
      if (typeof f !== 'function') return 0;
      return safe('roadY', function () { return num(f(c), 0); }, 0);
    }
    function carDims(e, c) {
      var m = e.models.high || e.models.low, d = (m && m.dims) || {};
      var L = num(d.length, num(c.length_m, 4.5)), W = num(d.width, num(c.width_m, 1.9));
      return {
        length: L, width: W, height: num(d.height, 1.3), wheelbase: num(d.wheelbase, L * 0.6), track: num(d.track, W * 0.84),
        wheelRadius: num(d.wheelRadius, 0.33)
      };
    }
    /** Fill e.view (car snapshot copy with interpolated pose & render hints) */
    function carView(e, c, pose) {
      var v = e.view;
      for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) v[k] = c[k];
      v.x = pose.x; v.y = pose.y; v.heading = pose.heading;
      v.simX = c.x; v.simY = c.y; v.simHeading = c.heading;
      v.headlights = !!S.lit.headlights; v.lightsOn = v.headlights;
      v.timeOfDay = S.timeOfDay; v.weather = S.weather; v.wet = S.lit.wetness;
      v.elevation = 0; v.time = S.time;
      return v;
    }
    function poseItems(e, model, v, dt) {
      var items = null;
      if (M.car && typeof M.car.pose === 'function' && !model._fallback) {
        items = safe('car.pose', function () { return M.car.pose(model, v, dt, e.poseState); }, null);
        if (items) boostLamps(e);
      }
      if (!items) {
        // fallback: rigid parts
        carMatrix(e.mat, v.x, v.y, 0, v.heading, 0, 0);
        items = e.fbItems || (e.fbItems = []);
        var parts = model.parts || model.items || [];
        items.length = parts.length;
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i], it = items[i] || (items[i] = { model: m4.create() });
          it.mesh = p.mesh; it.material = p.material; it.program = p.program; it.kind = p.kind;
          it.castShadow = p.castShadow !== false; it.transparent = p.transparent || (p.material && p.material.transparent);
          m4.multiply(it.model, e.mat, p.local || IDENT);
        }
      }
      if (e.elev) for (var j = 0; j < items.length; j++) if (items[j] && items[j].model) items[j].model[13] += e.elev;
      return items;
    }

    /** Pose the player car before the camera so interior cams can attach to the posed body. */
    var invTmp = new Float32Array(16);
    function posePlayerEarly(e, c, dt) {
      var model = e.models.high || e.models.low;
      e.items = null; e.posedFrame = -1;
      if (!model) return;
      var items = poseItems(e, model, carView(e, c, e.pose), dt);
      if (!items) return;
      e.items = items; e.posedFrame = S.frame;
      if (model._fallback) return;
      var parts = model.parts || [], bodyLocal = null, bodyItem = null, i;
      for (i = 0; i < parts.length; i++) if (parts[i] && parts[i].kind === 'body') { bodyLocal = parts[i].local || IDENT; break; }
      for (i = 0; i < items.length; i++) if (items[i] && items[i].kind === 'body' && items[i].model) { bodyItem = items[i]; break; }
      if (!bodyItem) return;
      e.bodyMat = e.bodyMat || m4.create();
      if (bodyLocal && m4.invert(invTmp, bodyLocal)) m4.multiply(e.bodyMat, bodyItem.model, invTmp);
      else m4.copy(e.bodyMat, bodyItem.model);
      // sanity: the posed body must sit on the car (guards against a pose() that returns local matrices)
      if (Math.hypot(e.bodyMat[12] - e.pose.x, e.bodyMat[14] + e.pose.y) < 3 && Math.abs(e.bodyMat[5]) > 0.8) e.bodyFrame = S.frame;
    }

    /* ---------------- player visual dynamics (g-forces for camera & cockpit) */
    function updateDynamics(snap, player, dt) {
      var D = S.dyn;
      if (!player) return;
      var t = num(snap.t, S.time);
      if (D.lastT !== null && t > D.lastT) {
        var ds = t - D.lastT;
        if (ds > 0 && ds < 0.5) {
          var dv = num(player.speed, 0) - D.lastSpeed;
          var dh = wrapAngle(num(player.heading, 0) - D.lastHeading);
          D.rawLong = clamp(dv / ds / 9.81, -3, 3);
          D.rawLat = clamp(num(player.speed, 0) * (dh / ds) / 9.81, -3.5, 3.5);
        }
      } else if (D.lastT !== null && t < D.lastT) { D.rawLat = 0; D.rawLong = 0; }
      if (D.lastT === null || t !== D.lastT) { D.lastT = t; D.lastSpeed = num(player.speed, 0); D.lastHeading = num(player.heading, 0); }
      spring(D.latG, D.rawLat, 7, dt);
      spring(D.longG, D.rawLong, 6, dt);
    }

    /* ---------------- cameras */
    var tmpA = [0, 0, 0], tmpB = [0, 0, 0], tmpC = [0, 0, 0];
    function availableModes() {
      return CAMERA_MODES.filter(function (m) {
        if (m === 'cockpit') return hasCockpitNow();
        if (m === 'map') return !!(CB.race.renderer && typeof CB.race.renderer.create === 'function');
        if (m === 'tv') return true;
        return true;
      });
    }
    // first person is always available: CB.gl.cockpit when present, otherwise the built-in interior
    function hasCockpitNow() { return true; }

    function updateCamera(dt, snap, player, e, pose) {
      var C = S.cam, mode = S.mode, model = e && (e.models.high || e.models.low);
      var dims = e ? carDims(e, player) : { length: 4.5, width: 1.9, height: 1.3 };
      var speed = Math.abs(num(player && player.speed, 0));
      var h = pose ? pose.heading : 0, px = pose ? pose.x : 0, py = pose ? pose.y : 0, elev = e ? e.elev : 0;
      var snapNow = C.snap; C.snap = false;
      var D = S.dyn, latG = D.latG.x, longG = D.longG.x;
      var fov = 65, near = 0.15, far = S.Q.far;
      var eye = C.eye, target = C.target, up = C.up;
      up[0] = 0; up[1] = 1; up[2] = 0;
      var shakeScale = 1;

      // body visual roll/pitch (shared by interior cams and cockpit)
      var rollT = clamp(latG * 0.022, -0.06, 0.06), pitchT = clamp(-longG * 0.014, -0.035, 0.035);
      if (snapNow) { springSet(C.roll, rollT); springSet(C.pitch, pitchT); }
      spring(C.roll, rollT, 9, dt); spring(C.pitch, pitchT, 9, dt);
      if (e) {
        // interior cams ride on the body exactly as car.pose() placed it (suspension roll/pitch), so the hood and
        // cockpit never swim relative to the eye; otherwise use the renderer's own g-force body motion
        if (e.bodyFrame === S.frame && (mode === 'cockpit' || mode === 'hood')) m4.copy(e.visMat, e.bodyMat);
        else carMatrix(e.visMat, px, py, elev, h, C.pitch.x, C.roll.x);
      }

      if (mode === 'cockpit' || mode === 'hood' || mode === 'bumper') {
        var cockpitEye = S.cockpit && (S.cockpit.eye || S.cockpit.cockpitEye);
        var eyeL = mode === 'cockpit' ? (cockpitEye || (model && model.cockpitEye) || [-dims.length * 0.08, dims.height * 0.86, -dims.width * 0.2])
          : mode === 'hood' ? (model && isV3(model.hoodCam) ? hoodEye(model.hoodCam) : [dims.length * 0.16, dims.height * 0.82, 0])
            : ((model && model.bumperCam) || [dims.length / 2 + 0.05, 0.42, 0]);
        var ckc = mode === 'cockpit' && S.cockpit && S.cockpit.camera;
        var ckOk = !!(ckc && isV3(ckc.eye) && isV3(ckc.forward));
        if (ckOk) eyeL = ckc.eye;   // the cockpit's head model (g-force lean, bob) already includes head motion
        var hk = ckOk ? 0 : mode === 'cockpit' ? 1 : 0.35;
        var hT = [-clamp(longG, -2, 2) * 0.03 * hk, -Math.abs(latG) * 0.004 * hk, clamp(latG, -2.5, 2.5) * 0.028 * hk];
        if (S.cockpit && S.cockpit.headOffset && mode === 'cockpit') { hT[0] += S.cockpit.headOffset[0] || 0; hT[1] += S.cockpit.headOffset[1] || 0; hT[2] += S.cockpit.headOffset[2] || 0; }
        if (snapNow) spring3Set(C.head, hT);
        var ho = spring3(C.head, hT, 10, dt, tmpA);
        var M = e ? e.visMat : IDENT;
        xformPoint(M, eyeL[0] + ho[0], eyeL[1] + ho[1], eyeL[2] + ho[2], eye);
        var lookT = mode === 'cockpit' ? clamp(num(player && player.steerAngle, 0) * 0.45, -0.2, 0.2) : 0;
        if (snapNow) springSet(C.look, lookT);
        var a = spring(C.look, lookT, 5, dt) + (S.lookBack ? PI : 0);
        var pitchDown = mode === 'cockpit' ? -0.035 : mode === 'hood' ? -0.012 : -0.012;   // hood: near level, the bonnet filled a quarter of the frame
        var dirL;
        if (ckOk) {
          var cf = ckc.forward;
          var ca = Math.cos(S.lookBack ? PI : 0), sa = Math.sin(S.lookBack ? PI : 0);
          dirL = [cf[0] * ca + cf[2] * sa, cf[1], -cf[0] * sa + cf[2] * ca];
        } else dirL = [Math.cos(a), pitchDown, -Math.sin(a)];
        xformDir(M, dirL[0], dirL[1], dirL[2], tmpB);
        target[0] = eye[0] + tmpB[0] * 10; target[1] = eye[1] + tmpB[1] * 10; target[2] = eye[2] + tmpB[2] * 10;
        if (ckOk && isV3(ckc.up)) xformDir(M, ckc.up[0], ckc.up[1], ckc.up[2], up); else xformDir(M, 0, 1, 0, up);
        var base = mode === 'cockpit' ? 62 : mode === 'hood' ? 60 : 64, mx = mode === 'cockpit' ? 74 : mode === 'hood' ? 75 : 80;
        fov = fovForSpeed(speed, base, mx);
        near = mode === 'cockpit' ? (S.cockpit && isNum(S.cockpit.nearPlane) ? clamp(S.cockpit.nearPlane, 0.01, 0.3) : 0.05) : 0.12;
        shakeScale = mode === 'cockpit' ? 0.5 : 0.6;
      } else if (mode === 'chase' || mode === 'chase-far' || (mode === 'tv' && !S.world.tvCams.length)) {
        var far1 = mode !== 'chase';
        var yawT = h + (S.lookBack ? PI : 0);
        if (snapNow || Math.abs(wrapAngle(yawT - C.yaw.x)) > 2.6) springSet(C.yaw, yawT);
        var yaw = spring(C.yaw, C.yaw.x + wrapAngle(yawT - C.yaw.x), far1 ? 3.6 : 5.2, dt);
        var dBase = far1 ? dims.length * 1.6 + 5.5 : dims.length * 1.05 + 2.4;
        var dWant = dBase + speed * (far1 ? 0.02 : 0.012) + clamp(longG, -1, 1.5) * 0.35;
        var cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
        var hint = player ? sampleIndexAt(geom, player.s) : null;
        var tSafe = chaseSafeFraction(geom, px, py, px - cyaw * dWant, py - syaw * dWant, hint, 0.45);
        var dEff = Math.max(dims.length * 0.6, dWant * tSafe);
        if (snapNow || dEff < C.dist.x) springSet(C.dist, snapNow ? dEff : lerp(C.dist.x, dEff, clamp01(dt * 18)));
        else spring(C.dist, dEff, 2.8, dt);
        var d = C.dist.x;
        var hgt = (far1 ? 2.4 + dims.height * 0.8 : 1.15 + dims.height * 0.5) + Math.max(0, dWant - d) * 0.22;
        eye[0] = px - cyaw * d; eye[2] = -(py - syaw * d); eye[1] = elev + hgt;
        var gY = S.world.groundY ? num(call4('groundY', S.world, S.world.groundY, eye[0], eye[2], undefined, undefined, 0), 0) : 0;
        eye[1] = Math.max(eye[1], gY + 0.5);
        var fwdK = S.lookBack ? -1 : 1, ahead = far1 ? 2.5 : 2.0;
        target[0] = px + Math.cos(h) * ahead * fwdK; target[2] = -(py + Math.sin(h) * ahead * fwdK);
        target[1] = elev + (far1 ? 0.9 : 0.85) + dims.height * 0.15;
        fov = far1 ? fovForSpeed(speed, 56, 68) : fovForSpeed(speed, 60, 75);
        near = 0.2;
        shakeScale = 0.8;
      } else if (mode === 'tv') {
        var cams = S.world.tvCams, L = num(geom.length, num(geom.length_m, 1));
        var spacing = cams.length > 1 ? L / cams.length : 200;
        var idx = pickTvCam(cams, player ? player.s : 0, L, spacing * 0.45);
        var cut = idx !== C.tvIndex || snapNow;
        C.tvIndex = idx;
        var cam = cams[idx];
        eye[0] = cam.x; eye[1] = num(cam.elev, 0) + cam.h; eye[2] = -cam.y;
        // aim = car + smoothed lead offset: springing the OFFSET (not the absolute aim point) removes the ~2v/omega
        // trailing error of a position spring, so the car stays framed at 200+ km/h
        var camD = Math.hypot(px - eye[0], -py - eye[2]);
        var lead = clamp(speed * 0.12, 0, 7) * clamp(camD / 60, 0.25, 1);   // less lead when the car passes close by
        tmpC[0] = Math.cos(h) * lead; tmpC[1] = 0.7; tmpC[2] = -Math.sin(h) * lead;
        if (cut) spring3Set(C.tvTarget, tmpC);
        var off = spring3(C.tvTarget, tmpC, 4, dt, tmpA);
        target[0] = px + off[0]; target[1] = elev + off[1]; target[2] = -py + off[2];
        var dist = Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
        // framing: ~15 m across, widened by any residual aim error so the car never leaves the frame
        var fovT = clamp(2 * Math.atan(7.5 / Math.max(1, dist)) / DEG, 7, 50);
        // the car itself (not just the aim point) must be inside the frame: angle between aim and car + margin
        var ax0 = target[0] - eye[0], ay0 = target[1] - eye[1], az0 = target[2] - eye[2];
        var bx0 = px - eye[0], by0 = elev + 0.7 - eye[1], bz0 = -py - eye[2];
        var la = Math.hypot(ax0, ay0, az0) || 1, lb = Math.hypot(bx0, by0, bz0) || 1;
        var angErr = Math.acos(clamp((ax0 * bx0 + ay0 * by0 + az0 * bz0) / (la * lb), -1, 1));
        fovT = clamp(Math.max(fovT, 2 * (angErr + Math.atan(3.5 / lb)) / DEG * 1.15), 7, 60);
        if (cut) springSet(C.fov, fovT);
        fov = fovT; near = 0.5; shakeScale = 0.3;
      } else { // heli
        var HS = C.heli || (C.heli = { swing: mkSpring(0), rk: mkSpring(1), hk: mkSpring(1), pick: 0, timer: 0, better: 0, near: [] });
        C.heliA += dt * 0.085;
        var street = !!S.world.street;
        // street circuits: buildings line narrow streets -> a steeper, closer, near top-down orbit
        var R = street ? 24 + speed * 0.1 : 52 + speed * 0.25, hh = street ? 66 + speed * 0.1 : 34 + speed * 0.1;
        // line-of-sight search against tall scenery (grandstand roofs, city blocks), re-evaluated 4x per second
        HS.timer -= dt;
        if (snapNow || HS.timer <= 0) {
          var evalDt = snapNow ? 0 : 0.25 - HS.timer;
          HS.timer = 0.25;
          var occN = occludersNear(S.world.occluders, px, py, R + 12, HS.near);
          var best = pickHeliCandidate(occN, px, py, elev, C.heliA, R, hh);
          var cur = HELI_CANDIDATES[HS.pick];
          var curClear = !segmentBlocked(occN, px, py, elev + 0.9, px + Math.cos(C.heliA + cur[0]) * R * cur[1], py - Math.sin(C.heliA + cur[0]) * R * cur[1], elev + hh * cur[2]);
          if (snapNow || !curClear) { HS.pick = best; HS.better = 0; }
          else if (best < HS.pick) { HS.better += evalDt; if (HS.better >= 1.2) { HS.pick = best; HS.better = 0; } }
          else HS.better = 0;
        }
        var pc = HELI_CANDIDATES[HS.pick];
        if (snapNow) { springSet(HS.swing, pc[0]); springSet(HS.rk, pc[1]); springSet(HS.hk, pc[2]); }
        var swing = spring(HS.swing, pc[0], 1.5, dt), rk = spring(HS.rk, pc[1], 1.3, dt), hk = spring(HS.hk, pc[2], 1.3, dt);
        // the orbit is relative to the car (no positional lag at speed); the orbit parameters themselves are smoothed
        var Ah = C.heliA + swing;
        eye[0] = px + Math.cos(Ah) * R * rk; eye[1] = elev + hh * hk; eye[2] = -py + Math.sin(Ah) * R * rk;
        if (S.world.groundY) {
          var gH = num(call4('groundY', S.world, S.world.groundY, eye[0], eye[2], undefined, undefined, 0), 0);
          eye[1] = Math.max(eye[1], gH + 8);
        }
        var lead2 = speed * (street ? 0.2 : 0.35);
        target[0] = px + Math.cos(h) * lead2; target[1] = elev + 0.5; target[2] = -(py + Math.sin(h) * lead2);
        fov = street ? 44 : 38; near = 0.8; shakeScale = 0.15;
      }

      if (snapNow) springSet(C.fov, fov);
      C.fovDeg = mode === 'tv' ? spring(C.fov, fov, fov > C.fov.x ? 14 : 5, dt) : spring(C.fov, fov, 3.2, dt);
      C.near = near; C.far = far;

      // shake: trauma (events) + kerb rumble + high-speed buffeting
      C.trauma = Math.max(0, C.trauma - dt * 1.4);
      var kerb = player && player.surface === 'kerb' ? 0.32 * smoothstep(3, 22, speed) : 0;
      var rough = player && (player.surface === 'grass' || player.surface === 'sand' || player.surface === 'gravel') ? 0.28 * smoothstep(2, 18, speed) : 0;
      var buffet = 0.12 * smoothstep(48, 92, speed);
      var amp = Math.max(C.trauma * C.trauma, kerb, rough, buffet) * shakeScale;
      if (amp > 0.001) {
        var t = S.time, fr = kerb > 0 ? 1.7 : 1;
        var n1 = shakeNoise(t * fr, 1.3), n2 = shakeNoise(t * fr, 7.9), n3 = shakeNoise(t * fr, 3.7);
        var k1 = mode === 'cockpit' ? 0.022 : 0.06;
        eye[1] += n2 * k1 * amp; target[1] += n2 * k1 * 0.4 * amp + n3 * 0.09 * amp;
        // lateral (perpendicular to view)
        var vx = target[0] - eye[0], vz = target[2] - eye[2], vl = Math.hypot(vx, vz) || 1;
        var rx = -vz / vl, rz = vx / vl;
        eye[0] += rx * n1 * k1 * amp; eye[2] += rz * n1 * k1 * amp;
        target[0] += rx * n3 * 0.07 * amp; target[2] += rz * n3 * 0.07 * amp;
      }
      S.flash = Math.max(0, num(S.flash, 0) - dt * 3);
    }

    /* ---------------- camera matrices */
    var camera = {
      view: m4.create(), proj: m4.create(), viewProj: m4.create(), invView: m4.create(),
      position: [0, 0, 0], frustum: new Float32Array(24), viewport: [0, 0, 1, 1]
    };
    var mirrorCam = {
      view: m4.create(), proj: m4.create(), viewProj: m4.create(), invView: m4.create(),
      position: [0, 0, 0], frustum: new Float32Array(24), viewport: [0, 0, 1, 1], mirror: true
    };
    function setupCamera(cam, eye, target, up, fovDeg, aspect, near, far, w, h) {
      m4.lookAt(cam.view, eye, target, up);
      m4.perspective(cam.proj, fovDeg * DEG, aspect, near, far);
      if (cam.mirror) { cam.proj[0] = -cam.proj[0]; }
      m4.multiply(cam.viewProj, cam.proj, cam.view);
      m4.invert(cam.invView, cam.view);
      frustumPlanes(cam.viewProj, cam.frustum);
      cam.position[0] = eye[0]; cam.position[1] = eye[1]; cam.position[2] = eye[2];
      cam.pos = cam.eye = cam.position; cam.target = target; cam.up = up;
      var fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2], fl = Math.hypot(fx, fy, fz) || 1;
      cam.forward = [fx / fl, fy / fl, fz / fl];
      cam.fov = fovDeg * DEG; cam.fovY = cam.fov; cam.fovDeg = fovDeg; cam.aspect = aspect; cam.near = near; cam.far = far;
      cam.width = w; cam.height = h; cam.viewport[2] = w; cam.viewport[3] = h;
      cam.viewMatrix = cam.view; cam.projMatrix = cam.proj; cam.projection = cam.proj; cam.viewProjection = cam.viewProj;
      cam.uView = cam.view; cam.uProj = cam.proj; cam.uCamPos = cam.position;
      cam.mode = S.mode; cam.time = S.time;
      return cam;
    }

    /* ---------------- culling */
    var sphereCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    function itemSphere(it) {
      if (it.bounds && it.bounds.radius && it.bounds.center && it._worldBounds) return [it.bounds.center[0], it.bounds.center[1], it.bounds.center[2], it.bounds.radius];
      if (!sphereCache) return null;
      var c = sphereCache.get(it);
      if (c && c.m === it.model) return c.s;
      var mb = it.worldBounds || null, s = null;
      if (mb) s = boundsSphere(mb);
      else if (it.mesh && it.mesh.bounds) s = worldSphere(boundsSphere(it.mesh.bounds), it.model);
      sphereCache.set(it, { m: it.model, s: s });
      return s;
    }
    function visible(cam, it) {
      if (!it || it.noCull || it.instanced || it.alwaysVisible) return true;
      var s = itemSphere(it);
      if (!s) return true;
      return sphereInFrustum(cam.frustum, s[0], s[1], s[2], s[3]);
    }

    /* ---------------- cockpit */
    function isV3(v) { return v && v.length >= 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]); }
    function ensureCockpit(player, e) {
      if (!player) return null;
      if (!(M.cockpit && typeof M.cockpit.build === 'function')) {
        // built-in interior (CB.gl.cockpit missing / failed to load)
        var fm = e && (e.models.high || e.models.low);
        if (S.cockpit && S.cockpit._fallback && S.cockpitModel === fm) return S.cockpit;
        if (S.cockpit && typeof S.cockpit.destroy === 'function') { var o2 = S.cockpit; safe('cockpit.destroy', function () { o2.destroy(); }); }
        S.cockpit = safe('fallback cockpit', function () { return buildFallbackCockpit(fm); }, null);
        S.cockpitModel = fm; S.cockpitBuild = player.build; S.cockpitItems = []; S.cockpitMirrorTex = null;
        return S.cockpit;
      }
      var model = e && (e.models.high || e.models.low);
      if (S.cockpit && S.cockpitBuild === player.build) {
        if (model && S.cockpitModel !== model) {
          S.cockpitModel = model;
          var ck0 = S.cockpit;
          if (typeof ck0.attach === 'function') safe('cockpit.attach', function () { ck0.attach(model); });
        }
        return S.cockpit;
      }
      if (S.cockpitFailed === player.build) return S.cockpit && S.cockpit._fallback ? S.cockpit : null;
      if (S.cockpit && typeof S.cockpit.destroy === 'function') { var old = S.cockpit; safe('cockpit.destroy', function () { old.destroy(); }); }
      S.cockpit = safeBuild('cockpit.build', function () {
        return M.cockpit.build(ctx, player.build, {
          eye: model && isV3(model.cockpitEye) ? model.cockpitEye : undefined, dims: model && model.dims, geom: geom,
          units: opts.units, quality: S.quality, number: player.number, color: player.color, accent: player.accent, mirrorFlipU: false
        });
      }, null);
      S.cockpitBuild = player.build; S.cockpitModel = model; S.cockpitMirrorTex = null;
      if (!S.cockpit) {
        S.cockpitFailed = player.build;
        S.cockpit = safe('fallback cockpit', function () { return buildFallbackCockpit(model); }, null);
      }
      S.cockpitItems = [];
      return S.cockpit;
    }
    /** Built-in first-person interior: dash, binnacle with a live gauge texture (rpm bar, shift lights, speed, gear),
        A-pillars / header / roof liner, door cards, steering wheel rotating with steerAngle, gloves, and a
        rear-view mirror showing the mirror render target. Same interface the renderer expects of CB.gl.cockpit. */
    function buildFallbackCockpit(model) {
      var dims = (model && model.dims) || {};
      var eye = (model && isV3(model.cockpitEye)) ? model.cockpitEye.slice(0, 3) : [-0.3, 1.05, -0.38];
      var fg = fallbackCockpitGeometry(eye, dims, colorSize);
      var meshes = { shell: mesh(fg.shell), wheel: mesh(fg.wheel), gauges: mesh(fg.gauges), mirror: mesh(fg.mirrorGlass) };
      // live gauge canvas
      var gc = null, g2 = null, gTex = null, lastKey = '';
      try {
        gc = doc.createElement('canvas'); gc.width = 512; gc.height = 168; g2 = gc.getContext('2d');
        gTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, gTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        gl.bindTexture(gl.TEXTURE_2D, null);
      } catch (e) { g2 = null; gTex = null; }
      var mph = opts.units === 'mph' || opts.units === 'imperial';
      function drawGauges(v) {
        if (!g2) return;
        var spd = Math.abs(num(v.speed, 0)) * (mph ? 2.23694 : 3.6), rpm = num(v.rpm, 0), red = Math.max(1000, num(v.redline, 7000));
        var gear = v.reverse ? 'R' : (num(v.speed, 0) < 0.3 && num(v.throttle, 0) < 0.05 && num(v.gear, 1) <= 1 ? 'N' : String(num(v.gear, 1)));
        var key = Math.round(spd) + '|' + Math.round(rpm / 50) + '|' + gear;
        if (key === lastKey) return;
        lastKey = key;
        var W = gc.width, H = gc.height, f = clamp01(rpm / red);
        g2.fillStyle = '#050607'; g2.fillRect(0, 0, W, H);
        // shift lights
        for (var i = 0; i < 10; i++) {
          var on = f > 0.6 + i * 0.038, col = i < 4 ? '#3ddc6a' : i < 8 ? '#ff3b2f' : '#4aa8ff';
          g2.fillStyle = on ? col : '#16191c';
          g2.beginPath(); g2.arc(W / 2 - 4.5 * 30 + i * 30, 18, 9, 0, TAU); g2.fill();
        }
        // rpm bar
        var bx = 24, by = 40, bw = W - 48, bh = 22;
        g2.fillStyle = '#121518'; g2.fillRect(bx, by, bw, bh);
        var grad = g2.createLinearGradient(bx, 0, bx + bw, 0);
        grad.addColorStop(0, '#c8a24a'); grad.addColorStop(0.75, '#f1d27a'); grad.addColorStop(0.9, '#ff5a3c'); grad.addColorStop(1, '#ff2a2a');
        g2.fillStyle = grad; g2.fillRect(bx, by, bw * f, bh);
        g2.fillStyle = 'rgba(255,255,255,.35)';
        for (var k = 1; k < Math.floor(red / 1000) + 1; k++) g2.fillRect(bx + bw * (k * 1000 / red) - 1, by + bh - 7, 2, 7);
        // speed + gear
        g2.textBaseline = 'alphabetic'; g2.textAlign = 'left';
        g2.fillStyle = '#ece8df'; g2.font = '700 78px "SF Mono", Menlo, monospace';
        g2.fillText(String(Math.round(spd)), 30, 150);
        g2.fillStyle = '#8d8a84'; g2.font = '600 20px "SF Mono", Menlo, monospace';
        g2.fillText(mph ? 'MPH' : 'KM/H', 34 + g2.measureText('000').width * 3.6, 150);
        g2.textAlign = 'right'; g2.fillStyle = f > 0.92 ? '#ff4b3a' : '#c8a24a'; g2.font = '800 92px "SF Mono", Menlo, monospace';
        g2.fillText(gear, W - 30, 152);
        gl.bindTexture(gl.TEXTURE_2D, gTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gc); } finally { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); }
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      var gaugeMat = material({ color: [1, 1, 1, 1], unlit: true });
      if (gTex) { gaugeMat.map = gaugeMat.uMap = gTex; gaugeMat.useMap = gaugeMat.uUseMap = 1; }
      // dark glass until the first mirror pass has produced a texture (an untextured 0.92 unlit quad read as a
      // white mirror for the first frames / after a target rebuild); near 1:1 pass-through once textured
      var MIRROR_DARK = [0.1, 0.12, 0.15], MIRROR_LIT = [0.92, 0.94, 0.96];
      var mirrorMat = material({ color: [MIRROR_DARK[0], MIRROR_DARK[1], MIRROR_DARK[2], 1], unlit: true });
      function mirrorTint(c) { var bc = mirrorMat.baseColor; bc[0] = c[0]; bc[1] = c[1]; bc[2] = c[2]; }
      var wheelLocal = m4.create();
      var items = [
        { mesh: meshes.shell, material: material({ color: [1, 1, 1, 1], roughness: 0.85 }), local: IDENT, kind: 'cockpit-shell' },
        { mesh: meshes.wheel, material: material({ color: [1, 1, 1, 1], roughness: 0.55, metallic: 0.1 }), local: wheelLocal, kind: 'steering' },
        { mesh: meshes.gauges, material: gaugeMat, local: IDENT, kind: 'gauges' },
        { mesh: meshes.mirror, material: mirrorMat, local: IDENT, kind: 'mirror' }
      ];
      var steerRot = 0, frame = 0;
      function setWheel(rot) {
        // wheelLocal = T(center) * Rz(-tilt) * Rx(rot)   (column leans down toward the dash; top of rim forward)
        var t = -fg.wheelTilt, ct = Math.cos(t), st = Math.sin(t), cr = Math.cos(rot), sr = Math.sin(rot);
        var c = fg.wheelCenter, o = wheelLocal;
        o[0] = ct; o[1] = st; o[2] = 0; o[3] = 0;
        o[4] = -st * cr; o[5] = ct * cr; o[6] = sr; o[7] = 0;
        o[8] = st * sr; o[9] = -ct * sr; o[10] = cr; o[11] = 0;
        o[12] = c[0]; o[13] = c[1]; o[14] = c[2]; o[15] = 1;
      }
      setWheel(0);
      return {
        _fallback: true, eye: eye, mirror: fg.mirror, nearPlane: 0.04, items: items,
        hideKinds: ['glass'],
        setMirrorTexture: function (tex) {
          if (tex) { mirrorMat.map = mirrorMat.uMap = tex; mirrorMat.useMap = mirrorMat.uUseMap = 1; mirrorTint(MIRROR_LIT); }
          else { mirrorMat.map = mirrorMat.uMap = null; mirrorMat.useMap = mirrorMat.uUseMap = 0; mirrorTint(MIRROR_DARK); }
        },
        update: function (v, dt) {
          var target = clamp(-num(v.steerAngle, 0) * 9, -4.2, 4.2);
          steerRot = lerp(steerRot, target, clamp01(num(dt, 1 / 60) * 22));
          setWheel(steerRot);
          if ((frame++ & 1) === 0) safe('gauges', function () { drawGauges(v); });
        },
        destroy: function () {
          Object.keys(meshes).forEach(function (k) { if (meshes[k] && meshes[k].destroy) meshes[k].destroy(); });
          if (gTex) gl.deleteTexture(gTex);
        }
      };
    }
    /** Steering wheel / gauges / head motion; runs BEFORE the camera so the eye follows the cockpit's head model. */
    /** Point the cockpit mirror material at the current (most recently completed) mirror render target. Called
        before the mirror pass, so the main pass samples the previous frame's result. */
    function syncMirrorTexture() {
      var ck = S.cockpit;
      var mirrorTex = S.targets && S.targets.mirror && S.targets.mirror.tex ? S.targets.mirror.tex : null;
      if (ck && S.cockpitMirrorTex !== mirrorTex) {
        S.cockpitMirrorTex = mirrorTex;
        if (typeof ck.setMirrorTexture === 'function') safe('cockpit.setMirrorTexture', function () { ck.setMirrorTexture(mirrorTex, { flipU: false }); });
        else ck.mirrorTexture = mirrorTex;
      }
      return mirrorTex;
    }
    function updateCockpit(v, dt) {
      var ck = S.cockpit;
      if (!ck) return;
      var mirrorTex = syncMirrorTexture();
      v.lookBack = S.lookBack; v.latG = S.dyn.latG.x; v.longG = S.dyn.longG.x; v.mirrorTexture = mirrorTex;
      if (typeof ck.update === 'function') safe('cockpit.update', function () { ck.update(v, dt, S.time, S.lastSnap); });
    }
    function cockpitItems(e) {
      var ck = S.cockpit;
      S.cockpitSelfDraw = false;
      if (!ck) return [];
      var out = S.cockpitItems || (S.cockpitItems = []);
      out.length = 0;
      var src = null, world = false;
      if (typeof ck.drawItems === 'function') { src = safe('cockpit.drawItems', function () { return ck.drawItems(e.visMat, S.cockpitDrawn || (S.cockpitDrawn = [])); }, null); world = !!src; }
      if (!src) src = (typeof ck.getItems === 'function' ? safe('cockpit.getItems', function () { return ck.getItems(); }, null) : null) || ck.items || ck.parts || [];
      var anyLite = false;
      for (var i = 0; i < src.length; i++) {
        var it = src[i];
        if (!it || !it.mesh) continue;
        if (it.mesh._lite) anyLite = true;
        var w = it._r3dWrap || (it._r3dWrap = { model: m4.create() });
        for (var k in it) if (k !== 'model' && k !== '_r3dWrap' && Object.prototype.hasOwnProperty.call(it, k)) w[k] = it[k];
        if (world || it.world) m4.copy(w.model, it.model || IDENT);
        else m4.multiply(w.model, e.visMat, it.local || it.model || IDENT);
        w.castShadow = false; w.noCull = true;
        // cabin-side glass mirrors the dark interior, not the reflection probe (which sees the road under the car)
        var cm = it.material;
        if (cm && cm._r3dCabin == null && (it.kind === 'cockpit-glass' || /^glass/.test(String(it.name || '')))) {
          cm._r3dCabin = true;
          cm.envIntensity = Math.min(num(cm.envIntensity, 1), 0.12); if (cm.uEnvIntensity != null) cm.uEnvIntensity = cm.envIntensity;
        }
        out.push(w);
      }
      // lite core + cockpit meshes from a foreign factory: let the cockpit draw itself with its own shader
      if (G.lite && src.length && !anyLite && typeof ck.draw === 'function') { out.length = 0; S.cockpitSelfDraw = true; }
      return out;
    }

    /* ---------------- effects: events, skids, smoke, dust */
    var tmpW = [0, 0, 0], tmpV = [0, 0, 0];
    function wheelWorld(e, dims, wi, out) {
      var x = wi < 2 ? dims.wheelbase / 2 : -dims.wheelbase / 2, z = (wi % 2 === 0 ? -1 : 1) * dims.track / 2;
      return xformPoint(e.mat, x, 0.02, z, out);
    }
    function processEffects(snap, dt, camPos, player) {
      var FX = S.world.effects;
      var events = snap.events || [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev || (ev.type !== 'collision' && ev.type !== 'wall')) continue;
        var inten = clamp01(num(ev.intensity, 0.5));
        var car = null;
        for (var j = 0; j < snap.cars.length; j++) if (snap.cars[j].id === ev.carId) { car = snap.cars[j]; break; }
        var ex = num(ev.x, car ? car.x : 0), ey = num(ev.y, car ? car.y : 0);
        var ce = car ? S.cars[car.id] : null;
        // effects auto-emits sparks/smoke from snap.events itself unless manual emission was requested
        if (S.manualFx) {
          var pos = [ex, (ce ? ce.elev : 0) + 0.45, -ey];
          var vel = car ? [num(car.vx, 0) * 0.45, 1.6, -num(car.vy, 0) * 0.45] : [0, 1.5, 0];
          if (FX && typeof FX.emitSparks === 'function') safe('emitSparks', function () { FX.emitSparks(pos, vel, Math.round(8 + inten * 36)); });
          if (FX && typeof FX.emitSmoke === 'function' && inten > 0.35) safe('emitSmoke', function () { FX.emitSmoke(pos, [vel[0] * 0.3, 0.8, vel[2] * 0.3], inten * 0.6); });
        }
        var mine = player && (ev.carId === player.id || ev.otherId === player.id || ev.other === player.id || ev.carB === player.id);
        if (!mine && player) {
          var dp = Math.hypot(ex - player.x, ey - player.y);
          if (dp < 7) mine = true;
        }
        if (mine) {
          S.cam.trauma = Math.min(1, S.cam.trauma + 0.3 + inten * (ev.type === 'wall' ? 0.75 : 0.55));
          if (inten > 0.55) S.flash = Math.max(num(S.flash, 0), (inten - 0.5) * 0.25);
          var ckI = S.cockpit;
          if (ckI && typeof ckI.impulse === 'function' && S.mode === 'cockpit') safe('cockpit.impulse', function () { ckI.impulse(0.25 + inten * 0.75); });
        }
      }
      if (!FX || !S.manualFx) return;
      var near = S.Q.effectsNear;
      for (var c = 0; c < snap.cars.length; c++) {
        var cs = snap.cars[c], e = S.cars[cs.id];
        if (!e || cs.dnf) continue;
        var dims = carDims(e, cs);
        var sp = Math.abs(num(cs.speed, 0));
        var surf = cs.surface || 'asphalt';
        var rubber = surf === 'asphalt' || surf === 'kerb' || surf === 'road' || surf === 'pit';
        var rear = Math.max(num(cs.skidding, 0), num(cs.wheelspin, 0) * 0.9);
        var front = num(cs.skidding, 0) * (num(cs.brake, 0) > 0.5 ? 0.95 : 0.6);
        var vel = [num(cs.vx, 0), 0, -num(cs.vy, 0)];
        for (var w = 0; w < 4; w++) {
          var inten2 = rubber && sp > 1.5 ? (w < 2 ? front : rear) : 0;
          if (inten2 > 0.18 && typeof FX.addSkid === 'function') {
            wheelWorld(e, dims, w, tmpW);
            var last = e.skidLast[w];
            if (!e.skidOn[w] || !last || Math.hypot(tmpW[0] - last[0], tmpW[2] - last[2]) > 0.45) {
              var p = [tmpW[0], tmpW[1], tmpW[2]];
              safe('addSkid', function () { FX.addSkid(cs.id, w, p, clamp01(inten2)); });
              e.skidLast[w] = p; e.skidOn[w] = true;
            }
          } else if (e.skidOn[w]) {
            e.skidOn[w] = false;
            if (typeof FX.addSkid === 'function') {
              var lp = e.skidLast[w];
              safe('addSkid', function () { FX.addSkid(cs.id, w, lp, 0); });
            }
            e.skidLast[w] = null;
          }
        }
        if (e.dist > near) continue;
        var smoke = Math.max(num(cs.wheelspin, 0) - 0.3, num(cs.skidding, 0) - 0.5) * 1.6;
        // drift sessions: sustained slides build a thick, voluminous cloud (2 puffs per rear tyre when heavy)
        if (S.manualFx) smoke = Math.max(smoke, (num(cs.skidding, 0) - 0.4) * 2.2);
        if (rubber && smoke > 0 && sp > 0.5 && typeof FX.emitSmoke === 'function') {
          var puffs = S.manualFx && smoke > 0.55 ? 2 : 1;
          for (var r = 2; r < 4; r++) {
            wheelWorld(e, dims, r, tmpW);
            var p2 = [tmpW[0], tmpW[1] + 0.15, tmpW[2]], v2 = [vel[0] * 0.25, 0.6, vel[2] * 0.25];
            safe('emitSmoke', function () { FX.emitSmoke(p2, v2, clamp01(smoke), puffs); });
          }
        }
        if (!rubber && sp > 4 && typeof FX.emitDust === 'function') {
          for (var r2 = 2; r2 < 4; r2++) {
            wheelWorld(e, dims, r2, tmpW);
            var p3 = [tmpW[0], tmpW[1] + 0.1, tmpW[2]], v3 = [vel[0] * 0.3, 0.9 + sp * 0.02, vel[2] * 0.3];
            safe('emitDust', function () { FX.emitDust(p3, v3, surf); });
          }
        }
      }
    }

    /* ---------------- lights */
    var envObj = {};
    var HL_COS_IN = Math.cos(9 * DEG), HL_COS_OUT = Math.cos(32 * DEG);
    S.hlPool = [];
    var hlRanked = [], hlRankPool = [];
    function byRankD(a, b) { return a.d - b.d; }
    function gatherLights(snap, camPos) {
      var cands = S.lightCands || (S.lightCands = []);
      cands.length = 0;
      if (S.lit.headlights) {
        var ranked = hlRanked, nr = 0;
        ranked.length = 0;
        for (var i = 0; i < snap.cars.length; i++) {
          var c = snap.cars[i], e = S.cars[c.id];
          if (!e || c.dnf) continue;
          var rk = hlRankPool[nr] || (hlRankPool[nr] = { c: null, e: null, d: 0 });
          nr++;
          rk.c = c; rk.e = e; rk.d = c.isPlayer ? -1 : e.dist;
          ranked.push(rk);
        }
        ranked.sort(byRankD);
        for (var k = 0; k < Math.min(4, ranked.length); k++) {
          var r = ranked[k], dims = carDims(r.e, r.c);
          var hl = S.hlPool[k] || (S.hlPool[k] = { pos: [0, 0, 0], dir: [1, 0, 0], color: [0, 0, 0], range: 58, cosInner: HL_COS_IN, cosOuter: HL_COS_OUT, type: 1, priority: 1, kind: 'headlight' });
          // beam pitched ~13 deg down so the light pool lands on the road 4-25 m ahead instead of grazing it; a
          // softer, lower intensity keeps car tails / walls a few metres ahead from saturating to white discs
          // the spot sits 30 cm ahead of the bumper: from inside the nose its cone lit the car's own bumper / wings
          // (white hot-spot under the lamps at night)
          xformPoint(r.e.mat, dims.length / 2 + 0.3, 0.7, 0, hl.pos);
          v3norm(xformDir(r.e.mat, 1, -0.23, 0, hl.dir));
          var kI = S.timeOfDay === 'night' ? 1.45 : S.timeOfDay === 'dusk' ? 1.05 : 0.8;
          hl.color[0] = kI; hl.color[1] = kI * 0.96; hl.color[2] = kI * 0.86;
          hl.priority = r.c.isPlayer ? 2 : 1;
          cands.push(hl);
        }
        for (k = 0; k < nr; k++) { hlRankPool[k].c = null; hlRankPool[k].e = null; }
      }
      var lamps = S.world.scenery && S.world.scenery.lights;
      if (lamps && lamps.length && S.timeOfDay !== 'day') {
        // lamp candidates are static: build them once per lamp list
        if (S.lampSrc !== lamps || !S.lampCands || S.lampCands.length !== lamps.length) {
          S.lampSrc = lamps;
          S.lampCands = lamps.map(function (l) {
            if (!l || !l.pos) return null;
            return { pos: l.pos, dir: l.dir || null, color: l.color || [2, 1.8, 1.4], range: num(l.range, 40), cosInner: num(l.cosInner, Math.cos(35 * DEG)), cosOuter: num(l.cosOuter, Math.cos(60 * DEG)), type: l.dir ? 1 : 0, priority: 0, kind: 'lamp' };
          });
        }
        for (var j = 0; j < S.lampCands.length; j++) if (S.lampCands[j]) cands.push(S.lampCands[j]);
      }
      return pickLights(cands, camPos, 8, lightScratch);
    }
    var lightScratch = {};
    function buildEnv(camPos, lights, shadowOn) {
      var L = S.lit, E = envObj;
      E.sunDir = L.sunDir; E.sunColor = L.sunColor; E.sunIntensity = L.sunIntensity;
      E.ambientSky = L.ambientSky; E.ambientGround = L.ambientGround;
      E.fogColor = L.fogColor; E.fogDensity = L.fogDensity;
      E.envTop = L.envTop; E.envHorizon = L.envHorizon; E.envBottom = L.envBottom;
      E.wetness = L.wetness; E.wet = L.wetness; E.camPos = camPos; E.cameraPos = camPos;
      E.exposure = E.uExposure = num(L.exposure, 1);
      E.time = S.time; E.timeOfDay = S.timeOfDay; E.weather = S.weather; E.quality = S.quality;
      E.uSunDir = E.sunDir; E.uSunColor = E.sunColor; E.uAmbientSky = E.ambientSky; E.uAmbientGround = E.ambientGround;
      E.uFogColor = E.fogColor; E.uFogDensity = E.fogDensity; E.uEnvTop = E.envTop; E.uEnvHorizon = E.envHorizon;
      E.uEnvBottom = E.envBottom; E.uWetness = E.wetness; E.uTime = E.time;
      packLights(lights, E);
      var sm = S.world.shadow;
      E.useShadow = !!(shadowOn && sm); E.uUseShadow = E.useShadow ? 1 : 0;
      E.shadow = E.useShadow ? sm : null;
      E.shadowMap = E.useShadow ? (sm.texture || sm.depthTexture || sm.tex || null) : null;
      E.shadowMatrix = E.useShadow ? (sm.matrix || sm.shadowMatrix || sm.viewProj || null) : null;
      E.uShadowMap = E.shadowMap; E.uShadowMatrix = E.shadowMatrix;
      E.shadowNear = E.useShadow && S.nearShadowOn ? S.world.shadowNear : null;
      return E;
    }

    /* ---------------- shadow pass */
    function shadowPass(casters, center) {
      var sm = S.world.shadow;
      if (!sm || !S.Q.shadow || S.shadowBroken || !casters.length) return false;
      if (S.lit.sunDir[1] < 0.06 || S.timeOfDay === 'night') return false;
      var radius = 95;
      var opts2 = { center: center, sunDir: S.lit.sunDir, radius: radius, camera: camera, ctx: ctx };
      var ok = safe('shadow pass', function () {
        if (typeof sm.render === 'function') { sm.render(casters, opts2); return true; }
        if (typeof G.renderShadows === 'function') { G.renderShadows(ctx, sm, casters, opts2); return true; }
        if (typeof sm.begin === 'function' && typeof sm.end === 'function') {
          var lc = sm.begin(center, S.lit.sunDir, radius, opts2) || sm.camera || sm.lightCamera;
          G.drawList(ctx, casters, lc, { shadowPass: true, depthOnly: true, program: shaders.shadow });
          sm.end();
          return true;
        }
        return false;
      }, false);
      if (ok === false && !S.warned['shadow api']) { S.warned['shadow api'] = true; }
      return !!ok;
    }
    /** Near cascade: depth pass of the casters around `center` into the tight map (after the main shadow pass). */
    var nearOpts = { center: [0, 0, 0], sunDir: null, radius: 18 };
    function shadowNearPass(casters, center) {
      var sn = S.world.shadowNear;
      S.nearShadowOn = false;
      if (!sn || S.nearBroken || !casters.length || typeof sn.render !== 'function') return false;
      nearOpts.center[0] = center[0]; nearOpts.center[1] = center[1]; nearOpts.center[2] = center[2];
      nearOpts.sunDir = S.lit.sunDir; nearOpts.radius = S.Q.nearRadius || 18;
      var ok = call4('shadow near pass', sn, sn.render, casters, nearOpts, undefined, undefined, false);
      if (ok === false && sn.valid !== true) S.nearBroken = true;
      S.nearShadowOn = !!ok;
      return S.nearShadowOn;
    }

    /* ---------------- sky */
    function drawSky(cam) {
      var FX = S.world.effects;
      if (!FX) return;
      safe('sky', function () {
        if (typeof FX.drawSky === 'function') FX.drawSky(cam, S.timeOfDay, S.weather);
        else if (typeof FX.sky === 'function') FX.sky(cam, S.timeOfDay, S.weather);
        else if (FX.sky && typeof FX.sky.draw === 'function') FX.sky.draw(cam, S.timeOfDay, S.weather);
        else if (FX.sky && typeof FX.sky.drawSky === 'function') FX.sky.drawSky(cam, S.timeOfDay, S.weather);
      });
    }

    /* ---------------- racing line */
    function racingLineItem() {
      if (!S.racingLine) return null;
      var W = S.world;
      if (W.racingLineItem === null) {
        W.racingLineItem = safe('racing line', function () {
          var g = racingLineGeometry(geom, colorSize);
          if (!g) return false;
          return { mesh: mesh(g), material: material({ color: [1, 1, 1, 0.75], roughness: 0.7, emissive: [0.12, 0.12, 0.12], transparent: true }), model: IDENT, castShadow: false, transparent: true, noCull: true };
        }, false);
      }
      return W.racingLineItem || null;
    }

    /* ---------------- ghost (time trial) */
    var ghostState = {};
    function ghostItems(snap, dt) {
      var gp = snap.ghost, player = S.player;
      if (!gp || !player || !isNum(gp.x)) return null;
      var e = S.cars[player.id];
      if (!e) return null;
      var model = e.models.low || e.models.high;
      if (!model) return null;
      if (Math.hypot(gp.x - player.x, gp.y - player.y) < 1.2) return null; // don't z-fight the player car
      var v = ghostState.view || (ghostState.view = {});
      for (var k in player) if (Object.prototype.hasOwnProperty.call(player, k)) v[k] = player[k];
      v.x = gp.x; v.y = gp.y; v.heading = num(gp.heading, 0); v.prevX = v.prevY = v.prevHeading = undefined; v.brake = 0; v.id = 'ghost';
      var ge = ghostState.e || (ghostState.e = { mat: m4.create(), poseState: {}, elev: 0, models: {} });
      var items = poseItems(ge, model, v, dt);
      var out = ghostState.items || (ghostState.items = []);
      out.length = 0;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || !it.mesh) continue;
        var g = out[out.length] = ghostState['g' + i] || (ghostState['g' + i] = {});
        g.mesh = it.mesh; g.program = it.program; g.model = it.model; g.castShadow = false; g.transparent = true; g.kind = it.kind;
        var base = it.material || {};
        var mm = g.material || (g.material = {});
        for (var mk in base) if (Object.prototype.hasOwnProperty.call(base, mk)) mm[mk] = base[mk];
        var bc = base.baseColor || base.uBaseColor || [1, 1, 1, 1];
        var gc = [lerp(bc[0], 0.55, 0.5), lerp(bc[1], 0.85, 0.5), lerp(bc[2], 1.0, 0.5), 0.32];
        mm.baseColor = mm.uBaseColor = mm.color = gc; mm.opacity = mm.alpha = 0.32; mm.transparent = true;
        mm.emissive = mm.uEmissive = [0.05, 0.12, 0.18];
      }
      return out;
    }

    /* ---------------- main frame */
    var lists = { main: [], casters: [], mirror: [], carItems: [], nearCasters: [], probe: [] };
    var nearCenterTmp = [0, 0, 0];
    var poseTmp = {};
    var shadowCenterTmp = [0, 0, 0], mEyeTmp = [0, 0, 0], mTgtTmp = [0, 0, 0], mUpTmp = [0, 0, 0], mNrmTmp = [0, 0, 0];
    // player parts hidden from the cockpit eye, memoised per item kind (avoids a regex per part per frame)
    var COCKPIT_HIDE_RE = /^(driver|helmet|seat-driver|glass|window|interior|steering|dash|cabin-inner)/, cockpitHideMemo = Object.create(null);
    function cockpitHides(kind) {
      var v = cockpitHideMemo[kind];
      if (v === undefined) v = cockpitHideMemo[kind] = COCKPIT_HIDE_RE.test(kind);
      return v;
    }
    /** Per-view variants of the player's body material (prototype-linked to the shared cached material, so live
        paint / hue updates still apply):
        - cockpit: back-face culled. Look-back shows the exterior body behind the cabin; drawn double-sided its
          inner faces (pillars, window frames) showed paint through the cockpit's rear side glass. car-mesh orients
          every triangle to its normals, so culling only removes the inner faces.
        - hood: the bonnet is seen at a grazing angle right under the lens, where the Fresnel sky reflection washes
          the paint out (pink / white sheen on reds and oranges); damp the environment term + clearcoat. */
    function bodyCullFor(it, mode) {
      var want = mode === 'cockpit' ? 'cockpit' : mode === 'hood' ? 'hood' : null;
      var base = it._viewOn ? it._viewBase : it.material;
      if (!want) { if (it._viewOn) { it.material = base; it._viewOn = null; } return; }
      if (it._viewOn === want && it._viewBase === base && it._viewMat) { it.material = it._viewMat; return; }
      var vm = Object.create(base);
      if (want === 'cockpit') { vm.cull = true; vm.side = 'front'; vm.doubleSided = false; }
      else {
        var ei = typeof base.envIntensity === 'number' ? base.envIntensity : (typeof base.uEnvIntensity === 'number' ? base.uEnvIntensity : 1);
        vm.envIntensity = vm.uEnvIntensity = ei * 0.5;
        var cc = typeof base.clearcoat === 'number' ? base.clearcoat : (typeof base.uClearcoat === 'number' ? base.uClearcoat : 0);
        vm.clearcoat = vm.uClearcoat = cc * 0.45;
      }
      it._viewMat = vm; it._viewBase = base; it._viewOn = want;
      it.material = vm;
    }
    /** hood cam a little higher than car-mesh's (hoodTop + 0.21 m): from there the bonnet filled about a third of
        the frame on tall-nosed cars (pickups, SUVs, vans) */
    var hoodEyeTmp = [0, 0, 0];
    function hoodEye(hc) { hoodEyeTmp[0] = hc[0]; hoodEyeTmp[1] = hc[1] + 0.1; hoodEyeTmp[2] = hc[2]; return hoodEyeTmp; }
    var MP = { mrt: null, mlist: null, env: null, FX: null };
    function mirrorPassDraw() {
      var mrt = MP.mrt, env = MP.env, FX = MP.FX;
      mrt.bind();
      gl.depthMask(true); gl.colorMask(true, true, true, true); gl.disable(gl.SCISSOR_TEST);
      var fc = S.lit.fogColor;
      gl.clearColor(fc[0], fc[1], fc[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.frontFace(gl.CW);
      env.linearOutput = false;
      if (FX && typeof FX.setLinearOutput === 'function') FX.setLinearOutput(false);
      drawSky(mirrorCam);
      G.drawList(ctx, MP.mlist, mirrorCam, env);
      gl.frontFace(gl.CCW);
      if (mrt.resolve) mrt.resolve();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // Submit the mirror pass before the main pass samples it: on ANGLE/Metal the render-to-texture result
      // was occasionally not visible to the later sampling pass (mirror showed a stale/blank image).
      gl.flush();
    }
    function byCarDist(a, b) { return S.cars[a.id].dist - S.cars[b.id].dist; }
    var p2Contacts = [], p2ContactPool = [], p2Params = {};
    function post2Params(order, player, cam) {
      var cts = p2Contacts;
      cts.length = 0;
      for (var i = 0; i < order.length && cts.length < 8; i++) {
        var qe = S.cars[order[i].id];
        if (!qe || !qe.pose || order[i].dnf) continue;
        if (qe.dist > 140) break;
        var qd = carDims(qe, order[i]);
        var ct = p2ContactPool[cts.length] || (p2ContactPool[cts.length] = {});
        ct.x = qe.pose.x; ct.z = -qe.pose.y; ct.y = qe.elev || 0; ct.heading = qe.pose.heading; ct.length = qd.length; ct.width = qd.width;
        ct.wheelbase = qd.wheelbase; ct.track = qd.track; ct.wheelRadius = qd.wheelRadius;
        cts.push(ct);
      }
      var spd = player ? Math.abs(num(player.speed, 0)) : 0;
      var m = S.mode;
      var P = p2Params;
      P.camera = cam; P.contacts = cts; P.timeOfDay = S.timeOfDay; P.weather = S.weather;
      P.exposure = num(S.lit.exposure, 1);
      P.speedBlur = S.Q.speedBlur && (m === 'chase' || m === 'chase-far' || m === 'bumper' || m === 'hood' || m === 'cockpit') ? smoothstep(42, 95, spd) * (m === 'cockpit' ? 0.55 : 1) : 0;
      P.motionBlur = S.Q.speedBlur ? 1 : 0;
      P.flash = clamp01(S.flash || 0); P.time = S.time; P.cut = !!S.cutFrame;
      P.vignette = m === 'tv' ? 0.42 : undefined;
      return P;
    }
    function render(snap, alpha) {
      if (S.destroyed || !snap) return;
      var t0 = now();
      var dt = S.last ? clamp((t0 - S.last) / 1000, 0, 0.1) : 1 / 60;
      if (S.last) {
        var ms = t0 - S.last;
        if (ms > 0 && ms < 250) { S.frameMs = lerp(S.frameMs, ms, 0.08); S.fps = 1000 / S.frameMs; }
        if (S.autoQuality && S.mode !== 'map') {
          // feed the renderer's own cost (CPU submit + GPU time when measurable), not just the rAF interval, so a
          // 30 Hz display / energy-saver cap or a stall elsewhere does not strip quality for nothing
          var gpuMs = S.gpuTimer ? S.gpuTimer.poll() : -1;
          var gv = S.governor.sample(ms, S.cpuLast, gpuMs >= 0 ? gpuMs : undefined);
          if (gv === 'down') {
            var lq = lowerQuality(S.quality);
            if (lq) { S.autoPrev = S.quality; setQuality(lq, true); S.autoDowngrades = (S.autoDowngrades || 0) + 1; }
            else S.governor.cancelProbe();
          } else if (gv === 'restore' && S.autoPrev) {
            var rq = S.autoPrev; S.autoPrev = null;
            setQuality(rq, true); S.autoRestores = (S.autoRestores || 0) + 1;
          }
        }
      }
      S.last = t0; S.time += dt; S.frame++;
      S.lastSnap = snap;
      if (snap.timeOfDay && snap.timeOfDay !== S.timeOfDay) setTimeOfDay(snap.timeOfDay);
      if (snap.weather && snap.weather !== S.weather) setWeather(snap.weather);
      if (alpha == null) alpha = num(snap.alpha, 1);

      // gl-core keeps failing to draw (3 frames in a row): rebuild on the built-in lite core between frames
      if (S.coreFails >= 3 && !G.lite) { S.coreFails = 0; switchToLite('drawList threw on 3 consecutive frames'); }
      if (S.mode === 'map' || S.lost) { render2D(snap, alpha); return; }
      if (S.gpuTimer) S.gpuTimer.begin();
      if (gs.visibility === 'hidden') { gs.visibility = 'visible'; canvas.style.background = 'transparent'; canvas.style.backgroundColor = 'transparent'; }
      ensureSize();
      clear2D();

      var cars = snap.cars || [];
      var player = null, pid = snap.playerId || 'player';
      for (var i = 0; i < cars.length; i++) if (cars[i].isPlayer || cars[i].id === pid) { player = cars[i]; break; }
      if (!player && cars.length) player = cars[0];
      S.player = player;
      S.playerId = player ? player.id : pid;

      // ---- interpolate poses, update models (LOD)
      var playerEntry = null, playerPose = null;
      var built = 0;
      for (i = 0; i < cars.length; i++) {
        var c = cars[i], e = carEntry(c);
        interpolatePose(c, alpha, e.pose);
        e.elev = roadElevation(c);
        carMatrix(e.mat, e.pose.x, e.pose.y, e.elev, e.pose.heading, 0, 0);
        if (c === player) { playerEntry = e; playerPose = e.pose; }
      }
      updateDynamics(snap, player, dt);
      // camera needs the player's model (eye points), ensure it exists first
      if (player && playerEntry) {
        getModel(playerEntry, player, 'high', true);
        getModel(playerEntry, player, 'low', false);
      }
      if (player && playerEntry) posePlayerEarly(playerEntry, player, dt);
      if (S.mode === 'cockpit' && player && playerEntry) {
        if (ensureCockpit(player, playerEntry)) updateCockpit(carView(playerEntry, player, playerPose), dt);
      }
      var wasSnap = !!S.cam.snap || S.mode !== S.lastMode, prevTv = S.cam.tvIndex;
      S.lastMode = S.mode;
      updateCamera(dt, snap, player, playerEntry, playerPose);
      S.cutFrame = wasSnap || S.cam.tvIndex !== prevTv;
      // optional external camera controller (setCameraController): may override eye/target/up/fov of the built-in
      // result; returning false (or throwing) keeps the built-in camera untouched
      if (S.camCtl && player && playerPose) {
        try {
          var CC = S.cam, ccOut = S.camCtl({
            dt: dt, mode: S.mode, lookBack: S.lookBack, snap: snap, player: player,
            pose: { x: playerPose.x, y: playerPose.y, heading: playerPose.heading, elev: playerEntry ? playerEntry.elev : 0 },
            eye: CC.eye, target: CC.target, up: CC.up, fovDeg: CC.fovDeg, near: CC.near, far: CC.far,
            dims: playerEntry ? carDims(playerEntry, player) : { length: 4.5, width: 1.9, height: 1.3 },
            safeFraction: function (cx, cy, ex, ey, margin) { return chaseSafeFraction(geom, cx, cy, ex, ey, sampleIndexAt(geom, player.s), margin == null ? 0.45 : margin); },
            groundY: function (x, zNeg) { return S.world.groundY ? num(call4('groundY', S.world, S.world.groundY, x, zNeg, undefined, undefined, 0), 0) : 0; }
          });
          if (ccOut && typeof ccOut === 'object') {
            if (isV3(ccOut.eye)) { CC.eye[0] = ccOut.eye[0]; CC.eye[1] = ccOut.eye[1]; CC.eye[2] = ccOut.eye[2]; }
            if (isV3(ccOut.target)) { CC.target[0] = ccOut.target[0]; CC.target[1] = ccOut.target[1]; CC.target[2] = ccOut.target[2]; }
            if (isV3(ccOut.up)) { CC.up[0] = ccOut.up[0]; CC.up[1] = ccOut.up[1]; CC.up[2] = ccOut.up[2]; }
            if (isNum(ccOut.fovDeg)) CC.fovDeg = clamp(ccOut.fovDeg, 10, 120);
            if (isNum(ccOut.near)) CC.near = ccOut.near;
          }
        } catch (ccErr) { warn('cameraController', ccErr); }
      }
      var C = S.cam, aspect = S.glW / Math.max(1, S.glH);
      setupCamera(camera, C.eye, C.target, C.up, C.fovDeg, aspect, C.near, C.far, S.glW, S.glH);
      var camPos = camera.position;

      // distances + LOD assignment
      var order = S.carOrder;
      order.length = 0;
      for (i = 0; i < cars.length; i++) {
        var ce = S.cars[cars[i].id];
        ce.dist = Math.hypot(ce.pose.x - camPos[0], ce.pose.y + camPos[2], ce.elev - camPos[1]);
        order.push(cars[i]);
      }
      order.sort(byCarDist);
      var highCount = 0, ci = lists.carItems;
      ci.length = 0;
      var main = lists.main, casters = lists.casters, mirrorList = lists.mirror;
      main.length = 0; casters.length = 0; mirrorList.length = 0;
      var nearCasters = lists.nearCasters, nearR = S.world.shadowNear ? S.Q.nearRadius || 18 : 0, nearC = nearCenterTmp;
      nearCasters.length = 0;
      if (nearR) {
        // the tight cascade follows the player (every camera frames it) a little ahead of the car, else the camera target
        if (playerPose) { nearC[0] = playerPose.x + Math.cos(playerPose.heading) * nearR * 0.25; nearC[1] = playerEntry ? playerEntry.elev : 0; nearC[2] = -(playerPose.y + Math.sin(playerPose.heading) * nearR * 0.25); }
        else { nearC[0] = S.cam.target[0]; nearC[1] = S.cam.target[1]; nearC[2] = S.cam.target[2]; }
      }
      var hidePlayerAll = S.mode === 'bumper';
      var shadowCenter = shadowCenterTmp;
      if (playerPose) { shadowCenter[0] = playerPose.x + Math.cos(playerPose.heading) * 35; shadowCenter[1] = 0; shadowCenter[2] = -(playerPose.y + Math.sin(playerPose.heading) * 35); }
      else { shadowCenter[0] = camPos[0]; shadowCenter[1] = 0; shadowCenter[2] = camPos[2]; }
      var drawnCars = 0;
      for (i = 0; i < order.length; i++) {
        var oc = order[i], oe = S.cars[oc.id];
        var wantHigh = oc === player || (oe.dist < S.Q.lodNear && highCount < S.Q.maxHigh);
        var model = null;
        if (wantHigh) {
          model = getModel(oe, oc, 'high', oc === player || built < 1);
          if (model && !oe.models.high._counted) built += 0;
          if (!oe.models.high && oc !== player) built++;
          if (model) { highCount++; oe.lod = 'high'; }
        }
        if (!model) {
          model = getModel(oe, oc, 'low', true) || oe.models.high;
          oe.lod = 'low';
        }
        if (!model) continue;
        var dims = carDims(oe, oc);
        var radius = dims.length * 0.62 + 0.6;
        var inView = sphereInFrustum(camera.frustum, oe.pose.x, oe.elev + 0.7, -oe.pose.y, radius);
        var nearShadow = Math.hypot(oe.pose.x - shadowCenter[0], -oe.pose.y - shadowCenter[2]) < 110;
        var inNear = nearR > 0 && Math.hypot(oe.pose.x - nearC[0], -oe.pose.y - nearC[2]) < nearR * 1.45 + radius;
        if (inNear) nearShadow = true;
        var forMirror = S.mode === 'cockpit' && oc !== player && oe.dist < 160;
        if (!inView && !nearShadow && !forMirror) { oe.items = null; continue; }
        var items;
        if (oe.posedFrame === S.frame && oe.items) items = oe.items;    // player: already posed before the camera
        else items = poseItems(oe, model, carView(oe, oc, oe.pose), dt);
        oe.items = items;
        if (!items) continue;
        var isP = oc === player;
        for (var k = 0; k < items.length; k++) {
          var it = items[k];
          if (!it || !it.mesh) continue;
          if (isP && it.kind === 'body' && it.material) bodyCullFor(it, S.mode);
          var castsHere = nearShadow && it.castShadow !== false && !(it.transparent || (it.material && it.material.transparent));
          // parts hidden from the player's own eye (bumper cam: whole car; cockpit: body shell/glass/driver) still
          // go to the shadow-caster list, so the player's car keeps its shadow on the road in those views
          var hiddenP = isP && (hidePlayerAll || (S.mode === 'cockpit' && it.kind &&
            (cockpitHides(it.kind) || (S.cockpit && S.cockpit.hideKinds && S.cockpit.hideKinds.indexOf(it.kind) >= 0))));
          if (castsHere && inNear) nearCasters.push(it);
          if (hiddenP) { if (castsHere) casters.push(it); continue; }
          if (inView) main.push(it);
          if (castsHere) casters.push(it);
          if (forMirror) mirrorList.push(it);
        }
        if (inView) drawnCars++;
      }
      S.stats.cars = drawnCars; S.stats.high = highCount;

      // ---- static world + scenery
      var W = S.world, culled = 0;
      updateGantry(snap.countdown);
      if (W.scenery && typeof W.scenery.update === 'function') call4('scenery.update', W.scenery, W.scenery.update, S.time, camPos, snap, camera);
      var statics = W.staticItems, probeItems = lists.probe;
      probeItems.length = 0;
      for (i = 0; i < statics.length; i++) probeItems.push(statics[i]);
      for (i = 0; i < statics.length; i++) {
        var si = statics[i];
        if (visible(camera, si)) main.push(si); else culled++;
        if (si.castShadow) {
          casters.push(si);
          if (nearR) { var ss = itemSphere(si); if (!ss || Math.hypot(ss[0] - nearC[0], ss[2] - nearC[2]) < nearR * 1.45 + ss[3]) nearCasters.push(si); }
        }
        if (S.mode === 'cockpit') mirrorList.push(si);
      }
      var scen = W.scenery ? (typeof W.scenery.getItems === 'function' ? call4('scenery.getItems', W.scenery, W.scenery.getItems, camPos, undefined, undefined, undefined, null) : W.scenery.items) : null;
      if (scen) {
        for (i = 0; i < scen.length; i++) {
          var sc = scen[i];
          if (!sc || !sc.mesh || sc.visible === false) continue;
          if (!sc.model) sc.model = IDENT;
          probeItems.push(sc);
          if (visible(camera, sc)) main.push(sc); else culled++;
          if (sc.castShadow) {
            var sp = itemSphere(sc);
            if (!sp || Math.hypot(sp[0] - shadowCenter[0], sp[2] - shadowCenter[2]) < 120 + sp[3]) casters.push(sc);
            if (nearR && (!sp || Math.hypot(sp[0] - nearC[0], sp[2] - nearC[2]) < nearR * 1.45 + sp[3])) nearCasters.push(sc);
          }
          if (S.mode === 'cockpit') mirrorList.push(sc);
        }
      }
      var rl = racingLineItem();
      if (rl) main.push(rl);
      var gi = ghostItems(snap, dt);
      if (gi) for (i = 0; i < gi.length; i++) main.push(gi[i]);

      // ---- cockpit interior
      if (S.mode === 'cockpit' && S.cockpit && playerEntry) {
        var ck = cockpitItems(playerEntry);
        for (i = 0; i < ck.length; i++) main.push(ck[i]);
      }

      // ---- effects
      var FX = W.effects;
      processEffects(snap, dt, camPos, player);
      if (FX && typeof FX.update === 'function') call4('effects.update', FX, FX.update, dt, snap, camera);
      if (FX && typeof FX.drawItems === 'function') {
        var fxi = call4('effects.drawItems', FX, FX.drawItems, camera, undefined, undefined, undefined, null);
        if (fxi) for (i = 0; i < fxi.length; i++) if (fxi[i]) { fxi[i].noCull = true; main.push(fxi[i]); }
      }

      // ---- lights + env
      var lights = gatherLights(snap, camPos);

      // ---- shadow pass
      var shadowOn = shadowPass(casters, shadowCenter);
      S.stats.shadow = shadowOn;
      S.nearShadowOn = false;
      if (shadowOn && nearR) shadowNearPass(nearCasters, nearC);
      S.stats.shadowNear = S.nearShadowOn;
      var env = buildEnv(camPos, lights, shadowOn);
      // ---- reflection probe (captured above the player's car: paint / glass / wheels reflect the real track)
      var probePos = null;
      if (playerPose) { probePos = S.probePos || (S.probePos = [0, 0, 0]); probePos[0] = playerPose.x; probePos[1] = (playerEntry ? playerEntry.elev : 0) + 1.0; probePos[2] = -playerPose.y; }
      updateProbe(env, probeItems, probePos);

      // ---- mirror pass (cockpit only)
      var T = ensureTargets();
      S.stats.mirror = false;
      if (S.mode === 'cockpit' && S.cockpit && playerEntry && (S.frame % Math.max(1, S.Q.mirrorEvery) === 0)) {
        var mrt = ensureMirrorTarget();
        if (mrt) {
          var me = playerEntry.visMat, ckm = S.cockpit.mirror;
          var eyeL = S.cockpit.eye || (playerEntry.models.high && playerEntry.models.high.cockpitEye) || [0, 1.1, 0];
          var mEye, mTgt, mUp, mFov = 17;
          if (ckm && isV3(ckm.pos) && isV3(ckm.normal) && isV3(eyeL)) {
            // reflect the eye -> mirror ray about the mirror normal (car-local), camera sits on the mirror
            var dx0 = ckm.pos[0] - eyeL[0], dy0 = ckm.pos[1] - eyeL[1], dz0 = ckm.pos[2] - eyeL[2];
            var dl = Math.hypot(dx0, dy0, dz0) || 1; dx0 /= dl; dy0 /= dl; dz0 /= dl;
            mNrmTmp[0] = ckm.normal[0]; mNrmTmp[1] = ckm.normal[1]; mNrmTmp[2] = ckm.normal[2];
            var nn = v3norm(mNrmTmp), dn = dx0 * nn[0] + dy0 * nn[1] + dz0 * nn[2];
            var rx = dx0 - 2 * dn * nn[0], ry = dy0 - 2 * dn * nn[1], rz = dz0 - 2 * dn * nn[2];
            mEye = xformPoint(me, ckm.pos[0], ckm.pos[1], ckm.pos[2], mEyeTmp);
            mTgt = xformPoint(me, ckm.pos[0] + rx * 20, ckm.pos[1] + ry * 20, ckm.pos[2] + rz * 20, mTgtTmp);
            mUp = isV3(ckm.up) ? xformDir(me, ckm.up[0], ckm.up[1], ckm.up[2], mUpTmp) : xformDir(me, 0, 1, 0, mUpTmp);
            if (isNum(ckm.fovY)) mFov = ckm.fovY < 3.2 ? ckm.fovY / DEG : ckm.fovY;
            mFov = clamp(mFov, 8, 40);
          } else {
            mEye = xformPoint(me, eyeL[0] + 0.25, eyeL[1] + 0.12, 0, mEyeTmp);
            mTgt = xformPoint(me, eyeL[0] - 20, eyeL[1] - 0.6, 0, mTgtTmp);
            mUp = xformDir(me, 0, 1, 0, mUpTmp);
          }
          setupCamera(mirrorCam, mEye, mTgt, mUp, mFov, mrt.w / mrt.h, 0.3, Math.min(900, S.Q.far), mrt.w, mrt.h);
          var mlist = S.mirrorItems || (S.mirrorItems = []);
          mlist.length = 0;
          for (i = 0; i < mirrorList.length; i++) if (visible(mirrorCam, mirrorList[i])) mlist.push(mirrorList[i]);
          MP.mrt = mrt; MP.mlist = mlist; MP.env = env; MP.FX = FX;
          call4('mirror pass', null, mirrorPassDraw);
          MP.mrt = null; MP.mlist = null; MP.env = null; MP.FX = null;
          if (T.mirrorBack && mrt === T.mirrorBack) { T.mirrorBack = T.mirror; T.mirror = mrt; }
          S.stats.mirror = true;
        }
      }
      // the cockpit keeps sampling the PREVIOUS mirror result (one frame behind; sampling this frame's render
      // target was unreliable on ANGLE/Metal). If the targets were recreated this frame (resize / quality change)
      // that texture is deleted: binding it would fail and leave the white 1x1 texture bound -> drop the map.
      if (S.mode === 'cockpit' && S.cockpit && S.cockpitMirrorTex) {
        var T2 = S.targets, live = T2 && ((T2.mirror && T2.mirror.tex === S.cockpitMirrorTex) || (T2.mirrorBack && T2.mirrorBack.tex === S.cockpitMirrorTex));
        if (!live) {
          S.cockpitMirrorTex = null;
          var ck2 = S.cockpit;
          if (typeof ck2.setMirrorTexture === 'function') safe('cockpit.setMirrorTexture', function () { ck2.setMirrorTexture(null, { flipU: false }); });
          else ck2.mirrorTexture = null;
        }
      }

      // ---- main pass
      var P2 = ensurePost2(), p2t = null;
      if (P2) {
        p2t = call4('post2.begin', null, function () { P2.setQuality(S.quality); P2.resize(S.glW, S.glH); return P2.begin(); }, undefined, undefined, undefined, undefined, null);
        if (!p2t) { S.post2Broken = true; destroyPost2(); P2 = null; T = ensureTargets(); }
      }
      var usePost = !P2 && !!(S.Q.post && T.scene && S.post);
      S.stats.post = usePost || !!(p2t && !p2t.direct);
      S.stats.hdr = !!(p2t && !p2t.direct && p2t.hdr);
      S.frameLinear = P2 ? !!(p2t && p2t.linearOutput) : linearPipeline(usePost);
      env.linearOutput = S.frameLinear;
      if (FX && typeof FX.setLinearOutput === 'function') call4('effects.setLinearOutput', FX, FX.setLinearOutput, S.frameLinear);
      if (usePost) T.scene.bind();
      else if (p2t && !p2t.direct && typeof p2t.bind === 'function') p2t.bind();
      else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, S.glW, S.glH); }
      var fog = S.lit.fogColor;
      gl.depthMask(true);
      gl.clearColor(fog[0], fog[1], fog[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawSky(camera);
      if (call4('drawList', G, G.drawList, ctx, main, camera, env, 'err') === 'err' && !G.lite) S.coreFails = (S.coreFails || 0) + 1;
      else S.coreFails = 0;
      if (S.cockpitSelfDraw && S.mode === 'cockpit' && S.cockpit && playerEntry) {
        call4('cockpit.draw', S.cockpit, S.cockpit.draw, camera.view, camera.proj, playerEntry.visMat, env);
      }
      S.stats.drawn = main.length; S.stats.culled = culled;

      // ---- post
      if (usePost) call4('post', null, runPost, T, player ? Math.abs(num(player.speed, 0)) : 0);
      else if (P2 && p2t && !p2t.direct) {
        var prm = post2Params(order, player, camera);
        if (call4('post2.end', P2, P2.end, prm, undefined, undefined, undefined, 'err') === 'err') { S.post2Broken = true; destroyPost2(); }
      }
      if (S.gpuTimer) S.gpuTimer.end();
      S.cpuLast = now() - t0;
      S.cpuMs = lerp(S.cpuMs, S.cpuLast, 0.1);
    }

    /* ---------------- API */
    function normModeLocal(m) { return normMode(m); }
    function setCamera(mode) {
      var m = normModeLocal(mode);
      if (!m) return S.mode;
      if (m === 'map' && !(CB.race.renderer && typeof CB.race.renderer.create === 'function')) return S.mode;
      if (m === 'cockpit' && !hasCockpitNow()) m = 'chase';
      if (m !== S.mode) { S.mode = m; S.cam.snap = true; S.cam.tvIndex = -1; }
      if (m !== 'map') { gs.visibility = 'visible'; canvas.style.background = 'transparent'; canvas.style.backgroundColor = 'transparent'; }
      return S.mode;
    }
    function cycleCamera(dir) {
      var modes = availableModes(), i = modes.indexOf(S.mode);
      var n = modes.length, step = dir < 0 ? -1 : 1;
      return setCamera(modes[mod((i < 0 ? 0 : i) + step, n)]);
    }
    function setQuality(q, auto) {
      var nq = normQuality(q);
      if (!nq) return S.quality;
      var prevShadow = S.Q.shadow;
      S.quality = nq; S.Q = QUALITY[nq];
      if (!auto) { S.governor.cancelProbe(); S.autoPrev = null; }
      S.governor.reset();
      S.sizeKey = '';
      destroyTargets();
      if (S.world) {
        if (prevShadow !== S.Q.shadow) createShadow();
        var FX = S.world.effects, SC = S.world.scenery;
        if (FX && typeof FX.setQuality === 'function') safe('effects.setQuality', function () { FX.setQuality(nq, S.Q.particles); });
        if (S.envProbe && typeof S.envProbe.setQuality === 'function') safe('envmap.setQuality', function () { S.envProbe.setQuality(nq); });
        if (SC && typeof SC.setQuality === 'function') safe('scenery.setQuality', function () { SC.setQuality(nq); });
      }
      return S.quality;
    }
    function setTimeOfDay(tod) {
      var prevTod = S.timeOfDay;
      S.timeOfDay = tod === 'dusk' || tod === 'night' ? tod : 'day';
      if (prevTod !== S.timeOfDay) rebuildSceneryForTod();
      var FX = S.world && S.world.effects;
      if (FX && typeof FX.setTimeOfDay === 'function') safe('effects.setTimeOfDay', function () { FX.setTimeOfDay(S.timeOfDay); });
      S.lit = mergedLighting();
      probeSky();
    }
    /** Scenery bakes lamp heads, lit signs, facade textures and lamp-post lights for one time of day: rebuild it
        when the time of day changes at runtime (snap.timeOfDay / setTimeOfDay), keeping the old set on failure. */
    function rebuildSceneryForTod() {
      var W = S.world, Ms = CB.gl && CB.gl.scenery;
      if (!W || !W.scenery || !Ms || typeof Ms.build !== 'function' || S.destroyed) return;
      var nsc = safeBuild('scenery.rebuild', function () {
        return Ms.build(ctx, geom, trackDef, { quality: S.quality, timeOfDay: S.timeOfDay, weather: S.weather, groundY: W.groundY, track: W.track });
      }, null);
      if (!nsc) return;
      var old = W.scenery;
      W.scenery = nsc;
      if (old && typeof old.destroy === 'function') safe('scenery.destroy', function () { old.destroy(); });
    }
    function setWeather(w) {
      S.weather = w === 'damp' || w === 'wet' ? w : 'dry';
      var FX = S.world && S.world.effects;
      if (FX && typeof FX.setWeather === 'function') safe('effects.setWeather', function () { FX.setWeather(S.weather); });
      S.lit = mergedLighting();
      probeSky();
    }
    function probeSky() {
      if (S.envProbe && typeof S.envProbe.setSky === 'function') safe('envmap.setSky', function () { S.envProbe.setSky(S.timeOfDay, S.weather, S.lit); });
    }
    function resize() {
      S.sizeKey = '';
      if (!S.destroyed && S.mode !== 'map') safe('resize', ensureSize);
      if (S.r2d && typeof S.r2d.resize === 'function') safe('renderer2d.resize', function () { S.r2d.resize(); });
    }
    var ro = null;
    if (typeof win.ResizeObserver === 'function') {
      try { ro = new win.ResizeObserver(function () { S.sizeKey = ''; }); ro.observe(canvas); } catch (e) { ro = null; }
    }
    var onWinResize = function () { S.sizeKey = ''; };
    win.addEventListener('resize', onWinResize);

    function destroy() {
      if (S.destroyed) return;
      S.destroyed = true;
      win.removeEventListener('resize', onWinResize);
      if (ro) try { ro.disconnect(); } catch (e) { /* ignore */ }
      glCanvas.removeEventListener('webglcontextlost', onLost);
      glCanvas.removeEventListener('webglcontextrestored', onRestored);
      if (S.r2d && typeof S.r2d.destroy === 'function') safe('renderer2d.destroy', function () { S.r2d.destroy(); });
      S.r2d = null;
      var W = S.world || {};
      ['effects', 'scenery', 'track', 'shadow'].forEach(function (k) {
        if (W[k] && typeof W[k].destroy === 'function') safe(k + '.destroy', function () { W[k].destroy(); });
      });
      if (S.cockpit && typeof S.cockpit.destroy === 'function') safe('cockpit.destroy', function () { S.cockpit.destroy(); });
      Object.keys(S.fbMeshCache).forEach(function (k) {
        var mm = S.fbMeshCache[k];
        Object.keys(mm).forEach(function (n) { if (mm[n] && typeof mm[n].destroy === 'function') safe('fb mesh destroy', function () { mm[n].destroy(); }); });
      });
      S.fbMeshCache = {};
      destroyTargets();
      destroyPost2(); destroyProbe();
      if (S.post) safe('post.destroy', function () {
        gl.deleteProgram(S.post.composite.program); gl.deleteProgram(S.post.bright.program); gl.deleteProgram(S.post.blur.program);
        gl.deleteBuffer(S.post.vbo);
      });
      if (M.car && M.car.cache && typeof M.car.cache.clear === 'function') safe('car.cache.clear', function () { M.car.cache.clear(ctx); });
      if (S.gpuTimer) safe('gpuTimer.destroy', function () { S.gpuTimer.destroy(); });
      S.gpuTimer = null;
      // procedural textures are cached per GL context by CB.gl.textures: release them explicitly
      var TX = CB.gl && CB.gl.textures;
      if (TX && typeof TX.dispose === 'function' && !(gl.isContextLost && gl.isContextLost())) safe('textures.dispose', function () { TX.dispose(ctx && ctx.gl ? ctx : gl); });
      if (ctx && typeof ctx.destroy === 'function') safe('ctx.destroy', function () { ctx.destroy(); });
      safe('loseContext', function () { var ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); });
      if (glCanvas.parentNode) glCanvas.parentNode.removeChild(glCanvas);
      canvas.style.background = saved.background || '';
      canvas.style.backgroundColor = saved.backgroundColor || '';
      canvas.style.position = saved.position || '';
      S.cars = {}; S.world = null;
    }
    function reset() {
      S.cam.snap = true; S.cam.trauma = 0; S.flash = 0; S.cam.tvIndex = -1;
      S.dyn.lastT = null; S.dyn.rawLat = S.dyn.rawLong = 0; springSet(S.dyn.latG, 0); springSet(S.dyn.longG, 0);
      Object.keys(S.cars).forEach(function (id) { var e = S.cars[id]; e.skidOn = [false, false, false, false]; e.skidLast = [null, null, null, null]; e.poseState = {}; });
      var FX = S.world && S.world.effects;
      if (FX) safe('effects.reset', function () { if (typeof FX.reset === 'function') FX.reset(); else if (typeof FX.clear === 'function') FX.clear(); });
      if (S.r2d && typeof S.r2d.reset === 'function') safe('renderer2d.reset', function () { S.r2d.reset(); });
      if (S.envProbe && typeof S.envProbe.invalidate === 'function') safe('envmap.invalidate', function () { S.envProbe.invalidate(); });
    }

    var api = {
      render: function (snap, alpha) {
        try { render(snap, alpha); }
        catch (e) { warn('render', e); throw e; }
      },
      setCamera: setCamera,
      cycleCamera: cycleCamera,
      /** fn(ctx) -> {eye,target,up,fovDeg,near}|false, called each frame after the built-in camera; null clears */
      setCameraController: function (fn) { S.camCtl = typeof fn === 'function' ? fn : null; S.cam.snap = true; },
      getCamera: function () { return S.mode; },
      cameraModes: function () { return availableModes().slice(); },
      cameraLabel: function (m) { return CAMERA_LABELS[normMode(m) || S.mode] || String(m); },
      setLookBack: function (b) { var nb = !!b; if (nb !== S.lookBack) { S.lookBack = nb; S.cam.snap = S.mode !== 'heli' && S.mode !== 'tv'; } },
      getLookBack: function () { return S.lookBack; },
      resize: resize,
      destroy: destroy,
      setQuality: function (q) { S.autoQuality = S.autoQuality; return setQuality(q, false); },
      getQuality: function () { return S.quality; },
      setAutoQuality: function (b) { S.autoQuality = !!b; S.governor.reset(); },
      setTimeOfDay: setTimeOfDay,
      setWeather: setWeather,
      reset: reset,
      setRacingLine: function (b) {
        S.racingLine = !!b;
        if (S.r2d && typeof S.r2d.setRacingLine === 'function') safe('renderer2d.setRacingLine', function () { S.r2d.setRacingLine(!!b); });
      },
      setLabels: function (b) {
        S.labels = !!b;
        if (S.r2d && typeof S.r2d.setLabels === 'function') safe('renderer2d.setLabels', function () { S.r2d.setLabels(!!b); });
      },
      stats: function () {
        return {
          fps: Math.round(S.fps), frameMs: +S.frameMs.toFixed(2), cpuMs: +S.cpuMs.toFixed(2), quality: S.quality, mode: S.mode,
          webgl2: isGL2, size: [S.glW, S.glH], drawn: S.stats.drawn, culled: S.stats.culled, cars: S.stats.cars, highLod: S.stats.high,
          shadow: S.stats.shadow, shadowNear: !!S.stats.shadowNear, mirror: S.stats.mirror, post: S.stats.post, hdr: !!S.stats.hdr, postChain: !!(S.post2 && !S.post2Broken), probe: S.envProbe ? (S.envProbe.valid ? 'dynamic' : 'static') : null, autoDowngrades: S.autoDowngrades || 0, autoRestores: S.autoRestores || 0, gpuMs: S.gpuTimer && S.gpuTimer.poll() >= 0 ? +S.gpuTimer.poll().toFixed(2) : null, lost: S.lost, lite: !!G.lite,
          modules: {
            track: !!(S.world && S.world.track), scenery: !!(S.world && S.world.scenery), effects: !!(S.world && S.world.effects),
            shadow: !!(S.world && S.world.shadow), car: !!(M.car && M.car.build), cockpit: hasCockpitNow()
          }
        };
      },
      getCameraState: function () {
        var C = S.cam;
        return { mode: S.mode, eye: C.eye.slice(), target: C.target.slice(), up: C.up.slice(), fov: C.fovDeg, near: C.near, far: C.far, lookBack: S.lookBack, tvIndex: C.tvIndex };
      },
      glCanvas: glCanvas,
      is3D: true,
      /** debugging handle (internal state; not part of the contract) */
      _debug: function () { return { S: S, ctx: ctx, gl: gl, G: G }; }
    };
    return api;
  }

  function normMode(m) {
    if (m == null) return null;
    var k = String(m).toLowerCase().trim();
    if (CAMERA_MODES.indexOf(k) >= 0) return k;
    return MODE_ALIASES[k] || null;
  }

  var exported = {
    isSupported: isSupported,
    create: create,
    CAMERA_MODES: CAMERA_MODES.slice(),
    CAMERA_LABELS: CAMERA_LABELS,
    QUALITY: QUALITY,
    QUALITY_ORDER: QUALITY_ORDER.slice(),
    normalizeCamera: normMode,
    _: {
      m4: m4, carMatrix: carMatrix, xformPoint: xformPoint, xformDir: xformDir, simToGL: simToGL,
      spring: spring, springSet: springSet, fovForSpeed: fovForSpeed, shakeNoise: shakeNoise,
      interpolatePose: interpolatePose, frustumPlanes: frustumPlanes, sphereInFrustum: sphereInFrustum,
      boundsSphere: boundsSphere, worldSphere: worldSphere, sampleIndexAt: sampleIndexAt,
      insideWalls: insideWalls, chaseSafeFraction: chaseSafeFraction, buildTvCams: buildTvCams, pickTvCam: pickTvCam,
      lightingFor: lightingFor, pickLights: pickLights, packLights: packLights, createGovernor: createGovernor, createGpuTimer: createGpuTimer,
      buildOccluders: buildOccluders, occludersNear: occludersNear, segmentBlocked: segmentBlocked, pickHeliCandidate: pickHeliCandidate, HELI_CANDIDATES: HELI_CANDIDATES,
      lowerQuality: lowerQuality, normQuality: normQuality, normMode: normMode, hexToRgb: hexToRgb, wrapAngle: wrapAngle,
      fallbackCarGeometry: fallbackCarGeometry, fallbackCockpitGeometry: fallbackCockpitGeometry, fallbackTrackGeometry: fallbackTrackGeometry, racingLineGeometry: racingLineGeometry,
      hasCore: hasCore
    }
  };
  return exported;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.race.renderer3d;

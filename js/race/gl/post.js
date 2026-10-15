/* ==========================================================================
   FORGE Atelier — js/race/gl/post.js
   CB.gl.post : HDR post-processing chain for the 3D race renderer (zero deps, classic script, WebGL2 + WebGL1).

   API
     var post = CB.gl.post.create(ctx, opts)      ctx = CB.gl context ({gl, isWebGL2, ...}) or a raw WebGL context
         opts: {quality:'low'|'medium'|'high'|'ultra', msaa (override samples), hdr (default true), fxaa ('auto'|true|false),
                tonemap ('aces' Hill-fitted RRT+ODT, hue-preserving | 'aces-channel' per-channel | 'aces-fast' Narkowicz), acesScale (exposure match, default 1.8)}
     post.resize(w, h)            scene (render) resolution; targets are (re)allocated lazily on the next begin()
     post.begin()  -> target      binds the HDR scene target (MSAA on WebGL2) and returns
                                  {fb, width, height, hdr, linearOutput, samples, depth, direct, bind()}.
                                  linearOutput === true  => the scene shaders must output LINEAR HDR (env.linearOutput);
                                  direct === true        => post is off (low / lost / broken): it bound the default
                                  framebuffer, the scene must tonemap itself, end() is a no-op.
     post.end(params) -> bool     resolve -> [SSAO + contact shadows (half res) -> bilateral blur] -> [bloom pyramid]
                                  -> composite (motion blur, AO, bloom, ACES, grade, vignette, dither) -> [FXAA] -> screen
         params: {camera {view, proj, near?, far?} (column-major Float32Array(16); enables SSAO / contacts / motion blur),
                  contacts [{x, y, z, dirX, dirZ | heading, halfLength | length, halfWidth | width, strength,
                           wheelbase | halfWheelbase, track | halfTrack, wheelRadius (wheel-arch occlusion)}] (GL world,
                           y = ground height; max 8; see contactsFromCars), timeOfDay, weather,
                  exposure, contrast, saturation, temperature, tint, vignette, lift, gamma, gain (grade overrides),
                  bloom (bool), bloomStrength, threshold, knee, ao (bool), aoStrength, aoRadius,
                  motionBlur (0..1 multiplier of the camera-reprojection blur), speedBlur (0..1 radial fallback amount),
                  blurCenter [u, v], cut (camera cut: no blur this frame), chromatic (default 0 = off), grain,
                  flash (0..1), flashColor, time, debug ('ao' | 'mask' | 'bloom' buffer views), target (WebGLFramebuffer | {fb} | {bind()}), outWidth, outHeight}
     post.setQuality(q)  post.getQuality()  post.stats()  post.destroy()
     post.getSceneTexture()  post.getDepthTexture()  post.isActive()
     CB.gl.post.contactsFromCars(cars, opts)       sim cars {x, y, heading, elev?, length?, width?} -> contacts
     CB.gl.post.gradeFor(timeOfDay, weather)       grade preset
     CB.gl.post._                                  pure helpers for Node tests

   Degradation
     * low quality, lost context or a shader/FBO failure -> passthrough (direct) path.
     * no float color buffers -> RGBA8 LDR scene (linearOutput false: scene tonemaps itself; post grades + blooms).
     * no depth texture (WebGL1 without WEBGL_depth_texture, or a failed MSAA depth resolve) -> no SSAO / contact
       shadows / reprojection blur (radial speed blur instead).
     * no MSAA (WebGL1) -> FXAA on the tonemapped image.
   GL state on exit of end(): DEPTH_TEST on, depthMask true, BLEND/CULL_FACE/SCISSOR off, VAO null, textures unbound,
   output framebuffer bound with a full viewport.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

CB.gl.post = (function () {
  'use strict';

  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function arr3(v, d) { return Array.isArray(v) || (v && v.length >= 3) ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : d.slice(); }

  /* ------------------------------------------------------------------ quality tiers */
  var QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];
  var QUALITY = {
    low: { enabled: false, msaa: 0, ssao: 0, contacts: false, bloomLevels: 0, motion: 0, fxaa: false, grain: 0 },
    medium: { enabled: true, msaa: 2, ssao: 0, contacts: true, bloomLevels: 4, motion: 1, fxaa: true, grain: 0 },
    high: { enabled: true, msaa: 4, ssao: 8, contacts: true, bloomLevels: 5, motion: 2, fxaa: true, grain: 0.008 },
    ultra: { enabled: true, msaa: 4, ssao: 14, contacts: true, bloomLevels: 6, motion: 2, fxaa: true, grain: 0.01 }
  };
  function normQuality(q) {
    if (QUALITY[q]) return q;
    if (q === 'med') return 'medium';
    if (q === 'max' || q === 'epic') return 'ultra';
    return null;
  }
  /** Effective feature set for a quality tier given device capabilities (pure). */
  function qualityConfig(q, caps, opts) {
    var base = QUALITY[normQuality(q) || 'high'];
    caps = caps || {}; opts = opts || {};
    var c = {};
    for (var k in base) c[k] = base[k];
    if (opts.msaa != null) c.msaa = Math.max(0, num(opts.msaa, c.msaa) | 0);
    if (!caps.isGL2) c.msaa = 0;
    c.msaa = Math.min(c.msaa, num(caps.maxSamples, c.msaa));
    if (!caps.depthTexture) { c.ssao = 0; c.contacts = false; if (c.motion === 2) c.motion = 1; }
    c.hdr = !!(caps.hdr && opts.hdr !== false);
    var fx = opts.fxaa == null ? 'auto' : opts.fxaa;
    c.fxaa = fx === true || fx === 'always' ? true : fx === false ? false : (c.fxaa && c.msaa === 0);
    if (!c.enabled) { c.ssao = 0; c.contacts = false; c.bloomLevels = 0; c.motion = 0; c.fxaa = false; c.msaa = 0; }
    return c;
  }

  /* ------------------------------------------------------------------ grading presets (display-referred) */
  var GRADES = {
    day: { exposure: 1, contrast: 1.04, saturation: 1.07, temperature: 0.02, tint: 0, vignette: 0.24, lift: [0, 0, 0.004], gamma: [1, 1, 1], gain: [1, 1, 1], bloomStrength: 0.3, threshold: 1.6 },
    dawn: { exposure: 1.04, contrast: 1.03, saturation: 1.04, temperature: 0.1, tint: 0.04, vignette: 0.28, lift: [0.006, 0.002, 0.012], gamma: [1, 1, 1.01], gain: [1.02, 0.99, 0.97], bloomStrength: 0.36, threshold: 1.4 },
    dusk: { exposure: 1.02, contrast: 1.06, saturation: 1.1, temperature: 0.2, tint: 0.02, vignette: 0.32, lift: [0.008, 0.002, 0.016], gamma: [1, 1, 1.02], gain: [1.03, 0.99, 0.95], bloomStrength: 0.4, threshold: 1.3 },
    night: { exposure: 1.06, contrast: 1.08, saturation: 0.97, temperature: -0.12, tint: 0, vignette: 0.38, lift: [0, 0.004, 0.016], gamma: [1, 1, 0.98], gain: [0.97, 1, 1.05], bloomStrength: 0.5, threshold: 1.15 }
  };
  /** Grade preset for a time of day + weather (pure; returns a fresh object). */
  function gradeFor(timeOfDay, weather) {
    var tod = GRADES[timeOfDay] ? timeOfDay : (timeOfDay === 'morning' || timeOfDay === 'sunrise' ? 'dawn' : timeOfDay === 'sunset' || timeOfDay === 'evening' ? 'dusk' : 'day');
    var g = GRADES[tod], o = {};
    for (var k in g) o[k] = Array.isArray(g[k]) ? g[k].slice() : g[k];
    var wet = weather === 'wet' || weather === 'rain' || weather === 'storm' ? 1 : weather === 'damp' || weather === 'overcast' ? 0.5 : 0;
    if (wet) {
      o.saturation *= 1 - 0.1 * wet; o.contrast *= 1 - 0.025 * wet; o.temperature -= 0.06 * wet;
      o.bloomStrength *= 1 + 0.15 * wet; o.vignette += 0.04 * wet;
    }
    o.timeOfDay = tod;
    return o;
  }
  /** White-balance multiplier from temperature (-1 cool .. +1 warm) and tint (+ = magenta), luma-normalised. */
  function whiteBalance(temperature, tint) {
    var t = clamp(num(temperature, 0), -1, 1), g = clamp(num(tint, 0), -1, 1);
    var r = 1 + 0.16 * t, gg = 1 - 0.08 * g, b = 1 - 0.16 * t;
    var l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    return [r / l, gg / l, b / l];
  }

  /* ------------------------------------------------------------------ tonemapping (JS mirrors of the shader, for tests) */
  function acesFast(x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1); }
  function acesFitted(rgb) {
    var r = rgb[0], g = rgb[1], b = rgb[2];
    var i = [0.59719 * r + 0.35458 * g + 0.04823 * b, 0.07600 * r + 0.90834 * g + 0.01566 * b, 0.02840 * r + 0.13383 * g + 0.83777 * b];
    var f = i.map(function (v) { return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081); });
    return [
      clamp(1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2], 0, 1),
      clamp(-0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2], 0, 1),
      clamp(-0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2], 0, 1)
    ];
  }

  /* ------------------------------------------------------------------ mat4 (column-major) */
  function mul4(o, a, b) {
    var r = o === a || o === b ? new Float32Array(16) : o;
    for (var c = 0; c < 4; c++) {
      var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      for (var rr = 0; rr < 4; rr++) r[c * 4 + rr] = a[rr] * b0 + a[4 + rr] * b1 + a[8 + rr] * b2 + a[12 + rr] * b3;
    }
    if (r !== o) for (var i = 0; i < 16; i++) o[i] = r[i];
    return o;
  }
  function invert4(o, m) {
    var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    var b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    var b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det || !isFinite(det)) return null;
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
  /** near / far planes of a GL perspective projection matrix. */
  function nearFar(proj) {
    var p10 = proj[10], p14 = proj[14];
    var n = p14 / (p10 - 1), f = p14 / (p10 + 1);
    if (!(n > 0) || !isFinite(n)) n = 0.1;
    if (!(f > n) || !isFinite(f)) f = 3000;
    return [n, f];
  }
  /** Camera world position from a view matrix (inverse rotation * -translation). */
  function camPos(view) {
    var tx = view[12], ty = view[13], tz = view[14];
    return [-(view[0] * tx + view[1] * ty + view[2] * tz), -(view[4] * tx + view[5] * ty + view[6] * tz), -(view[8] * tx + view[9] * ty + view[10] * tz)];
  }

  /* ------------------------------------------------------------------ contact shadows */
  var MAX_CONTACTS = 8;
  /** Normalise contact descriptors into two vec4[8] uniform arrays (pure). Returns the count. */
  function packContacts(list, A, B, C) {
    var n = 0;
    for (var i = 0; list && i < list.length && n < MAX_CONTACTS; i++) {
      var c = list[i];
      if (!c) continue;
      var x = num(c.x, NaN), z = num(c.z, NaN);
      if (!isFinite(x) || !isFinite(z)) continue;
      var dx = num(c.dirX, NaN), dz = num(c.dirZ, NaN);
      if (!isFinite(dx) || !isFinite(dz)) { var h = num(c.heading, 0); dx = Math.cos(h); dz = -Math.sin(h); }
      var dl = Math.hypot(dx, dz) || 1;
      var hl = num(c.halfLength, num(c.length, 4.5) / 2), hw = num(c.halfWidth, num(c.width, 1.9) / 2);
      A[n * 4] = x; A[n * 4 + 1] = z; A[n * 4 + 2] = num(c.y, 0); A[n * 4 + 3] = clamp(num(c.strength, 1), 0, 1);
      B[n * 4] = dx / dl; B[n * 4 + 1] = dz / dl; B[n * 4 + 2] = Math.max(0.3, hl); B[n * 4 + 3] = Math.max(0.3, hw);
      if (C) {   // wheel layout for wheel-arch occlusion: half wheelbase, half track, wheel radius
        C[n * 4] = clamp(num(c.halfWheelbase, num(c.wheelbase, hl * 2 * 0.6) / 2), 0.4, Math.max(0.4, hl));
        C[n * 4 + 1] = clamp(num(c.halfTrack, num(c.track, hw * 2 * 0.84) / 2), 0.3, Math.max(0.3, hw));
        C[n * 4 + 2] = clamp(num(c.wheelRadius, 0.33), 0.15, 0.7);
        C[n * 4 + 3] = 1;
      }
      n++;
    }
    for (var j = n * 4; j < MAX_CONTACTS * 4; j++) { A[j] = 0; B[j] = 0; if (C) C[j] = 0; }
    return n;
  }
  /**
   * Sim cars -> contact descriptors. car {x, y (sim plane), heading (rad), elev|z (ground height), length, width,
   * dims {length, width}}. Sim (x, y) maps to GL (x, -y); heading h -> GL forward (cos h, -sin h).
   * opts {camPos [x,y,z] (GL) -> keep the nearest MAX_CONTACTS, maxDist (default 120 m)}.
   */
  function contactsFromCars(cars, opts) {
    opts = opts || {};
    var out = [], cp = opts.camPos, maxD = num(opts.maxDist, 120);
    for (var i = 0; cars && i < cars.length; i++) {
      var c = cars[i];
      if (!c || !isFinite(c.x) || !isFinite(c.y)) continue;
      var d = c.dims || {};
      var e = { x: c.x, y: num(c.elev, num(c.z, 0)), z: -c.y, heading: num(c.heading, 0), length: num(c.length, num(d.length, 4.5)), width: num(c.width, num(d.width, 1.9)), strength: 1 };
      if (cp) { e._d = Math.hypot(e.x - cp[0], e.z - cp[2]); if (e._d > maxD) continue; }
      out.push(e);
    }
    if (cp) out.sort(function (a, b) { return a._d - b._d; });
    if (out.length > MAX_CONTACTS) out.length = MAX_CONTACTS;
    return out;
  }

  /** Bloom pyramid level sizes, starting at half resolution, stopping before 8 px (pure). */
  function bloomSizes(w, h, levels) {
    var out = [], cw = w, ch = h;
    for (var i = 0; i < levels; i++) {
      cw = Math.max(1, cw >> 1); ch = Math.max(1, ch >> 1);
      if (Math.min(cw, ch) < 8 && i > 0) break;
      out.push([cw, ch]);
    }
    return out;
  }

  /* ================================================================== shaders (GLSL ES 1.00: WebGL1 + WebGL2) */
  var VS = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');
  var HEAD = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\nvarying vec2 vUv;\n';

  // bright prefilter: 4 bilinear taps (13-texel footprint lite) with Karis luma weighting (no fireflies) + soft knee
  var PREFILTER_FS = HEAD + [
    'uniform sampler2D uTex; uniform vec2 uTexel; uniform vec4 uThresh;', // threshold, knee, outScale, clampMax
    'vec3 tap(vec2 o, out float w){ vec3 c = min(texture2D(uTex, vUv + o * uTexel).rgb, vec3(uThresh.w)); w = 1.0 / (1.0 + max(c.r, max(c.g, c.b))); return c * w; }',
    'void main(){',
    '  float w0, w1, w2, w3;',
    '  vec3 c = tap(vec2(-1.0,-1.0), w0) + tap(vec2(1.0,-1.0), w1) + tap(vec2(-1.0,1.0), w2) + tap(vec2(1.0,1.0), w3);',
    '  c /= max(w0 + w1 + w2 + w3, 1e-4);',
    '  float br = max(c.r, max(c.g, c.b));',
    '  float k = max(uThresh.y, 1e-4);',
    '  float rq = clamp(br - uThresh.x + k, 0.0, 2.0 * k); rq = rq * rq / (4.0 * k);',
    '  c *= max(rq, br - uThresh.x) / max(br, 1e-4);',
    '  gl_FragColor = vec4(max(c, vec3(0.0)) * uThresh.z, 1.0);',
    '}'
  ].join('\n');
  // dual-filter (Kawase) downsample
  var DOWN_FS = HEAD + [
    'uniform sampler2D uTex; uniform vec2 uTexel;',
    'void main(){',
    '  vec3 c = texture2D(uTex, vUv).rgb * 4.0;',
    '  c += texture2D(uTex, vUv + vec2(-1.0,-1.0) * uTexel).rgb;',
    '  c += texture2D(uTex, vUv + vec2( 1.0,-1.0) * uTexel).rgb;',
    '  c += texture2D(uTex, vUv + vec2(-1.0, 1.0) * uTexel).rgb;',
    '  c += texture2D(uTex, vUv + vec2( 1.0, 1.0) * uTexel).rgb;',
    '  gl_FragColor = vec4(c * 0.125, 1.0);',
    '}'
  ].join('\n');
  // dual-filter upsample (tent), additively blended into the next larger level
  var UP_FS = HEAD + [
    'uniform sampler2D uTex; uniform vec2 uTexel; uniform float uWeight;',
    'void main(){',
    '  vec2 h = uTexel;',
    '  vec3 c = texture2D(uTex, vUv + vec2(-2.0, 0.0) * h).rgb + texture2D(uTex, vUv + vec2(2.0, 0.0) * h).rgb',
    '         + texture2D(uTex, vUv + vec2(0.0, -2.0) * h).rgb + texture2D(uTex, vUv + vec2(0.0, 2.0) * h).rgb;',
    '  c += 2.0 * (texture2D(uTex, vUv + vec2(-1.0,-1.0) * h).rgb + texture2D(uTex, vUv + vec2(1.0,-1.0) * h).rgb',
    '            + texture2D(uTex, vUv + vec2(-1.0, 1.0) * h).rgb + texture2D(uTex, vUv + vec2(1.0, 1.0) * h).rgb);',
    '  gl_FragColor = vec4(c * (uWeight / 12.0), 1.0);',
    '}'
  ].join('\n');

  // SSAO (normal-oriented, golden-spiral, interleaved-gradient rotation) + analytic car contact shadows, half res.
  // out: r = occlusion (1 = open), g = car mask (motion-blur exclusion), b/a = linear view depth / 400 packed in 16 bit
  var AO_FS = HEAD + [
    'uniform sampler2D uDepth; uniform vec2 uTexelFull; uniform vec2 uRes;',
    'uniform vec4 uProj;', // P[0], P[5], near, far
    'uniform mat4 uInvView;',
    'uniform vec4 uAO;', // radius (m), intensity, sample count, fade distance
    'uniform vec4 uContactA[8]; uniform vec4 uContactB[8]; uniform vec4 uContactC[8]; uniform float uContactCount;',
    'float viewZ(float d){ float z = d * 2.0 - 1.0; return 2.0 * uProj.z * uProj.w / (uProj.w + uProj.z - z * (uProj.w - uProj.z)); }',
    'vec3 viewPos(vec2 uv){ float vz = viewZ(texture2D(uDepth, uv).r); return vec3((uv.x * 2.0 - 1.0) * vz / uProj.x, (uv.y * 2.0 - 1.0) * vz / uProj.y, -vz); }',
    'vec3 viewPosD(vec2 uv, float d){ float vz = viewZ(d); return vec3((uv.x * 2.0 - 1.0) * vz / uProj.x, (uv.y * 2.0 - 1.0) * vz / uProj.y, -vz); }',
    'void main(){',
    '  float d = texture2D(uDepth, vUv).r;',
    '  if (d >= 0.99999) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }',
    '  vec3 P = viewPosD(vUv, d);',
    '  float vz = -P.z;',
        '  float occ = 0.0;',
    '  vec3 N = vec3(0.0, 0.0, 1.0);',
    '  if (uAO.z > 0.5 || uContactCount > 0.5) {',
    '    vec3 pr = viewPos(vUv + vec2(uTexelFull.x, 0.0)), pl = viewPos(vUv - vec2(uTexelFull.x, 0.0));',
    '    vec3 pu = viewPos(vUv + vec2(0.0, uTexelFull.y)), pd = viewPos(vUv - vec2(0.0, uTexelFull.y));',
    '    vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;',
    '    vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;',
    '    N = normalize(cross(dx, dy));',
    '    if (dot(N, P) > 0.0) N = -N;',
    '  }',
    '  if (uAO.z > 0.5) {',
    '    float R = uAO.x;',
    '    vec2 rUv = vec2(R * uProj.x * 0.5 / vz, R * uProj.y * 0.5 / vz);',
    '    float rMax = 0.12; float rl = max(rUv.x, rUv.y); if (rl > rMax) rUv *= rMax / rl;',
    '    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '    float ang0 = noise * 6.2831853;',
    '    float sum = 0.0;',
    '    for (int i = 0; i < 16; i++) {',
    '      if (float(i) >= uAO.z) break;',
    '      float fi = (float(i) + 0.5) / uAO.z;',
    '      float a = ang0 + float(i) * 2.3999632;',
    '      vec2 o = vec2(cos(a), sin(a)) * rUv * sqrt(fi);',
    '      vec3 S = viewPos(vUv + o);',
    '      vec3 v = S - P;',
    '      float l2 = dot(v, v);',
    '      float l = sqrt(l2) + 1e-4;',
    '      float fall = max(0.0, 1.0 - l2 / (R * R * 2.25));',
    '      sum += max(0.0, dot(N, v / l) - 0.12) * fall;',
    '    }',
    '    occ = clamp(sum / uAO.z * uAO.y, 0.0, 1.0);',
    '    occ *= 1.0 - smoothstep(uAO.w * 0.6, uAO.w, vz);',
    '  }',
    '  float ao = 1.0 - occ;',
    '  float mask = 0.0;',
    '  if (uContactCount > 0.5) {',
    '    vec3 W = (uInvView * vec4(P, 1.0)).xyz;',
    '    vec3 NW = mat3(uInvView[0].xyz, uInvView[1].xyz, uInvView[2].xyz) * N;',
    '    float sh = 0.0, body = 0.0;',
    '    for (int i = 0; i < 8; i++) {',
    '      if (float(i) >= uContactCount) break;',
    '      vec4 A = uContactA[i]; vec4 B = uContactB[i];',
    '      vec2 rel = W.xz - A.xy;',
    '      vec2 loc = vec2(dot(rel, B.xy), dot(rel, vec2(-B.y, B.x)));',
    '      vec2 q = abs(loc) - B.zw;',
    '      float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);',
    '      float hgt = W.y - A.z;',
    // soft footprint: darkest in the middle of the car, ~0.5 m penumbra beyond the body; only near-ground surfaces
    '      float foot = 1.0 - smoothstep(-0.55, 0.5, sd);',
    '      float hf = (1.0 - smoothstep(0.02, 0.5, hgt)) * step(-0.4, hgt);',
    // ground under / around the car (upward-facing surfaces only, so the car body is handled separately)
    '      float up = smoothstep(0.55, 0.85, NW.y);',
    '      sh = max(sh, foot * hf * A.w * up);',
    // car surfaces inside the footprint: underside, lower-body falloff and the wheel wells
    '      if (sd < 0.12 && hgt > -0.1 && hgt < 1.2) {',
    '        vec4 C = uContactC[i];',
    '        float inb = 1.0 - smoothstep(-0.05, 0.12, sd);',
    '        float low = (1.0 - smoothstep(0.06, 0.7, hgt)) * 0.55;',
    '        float under = smoothstep(-0.15, -0.6, NW.y) * (1.0 - smoothstep(0.3, 0.9, hgt)) * 0.75;',
    '        float wr = max(C.z, 0.15);',
    '        vec2 wd = vec2(abs(loc.x) - C.x, hgt - wr);',
    '        float r = length(wd);',
    '        float well = (1.0 - smoothstep(wr * 0.9, wr * 1.32, r)) * (1.0 - smoothstep(C.y - 0.1, C.y + 0.02, abs(loc.y))) * step(0.5, C.w);',
    '        body = max(body, max(max(low, under), well * 0.82) * inb * A.w * (1.0 - up * 0.6));',
    '      }',
    '      if (sd < 0.35 && hgt > -0.3 && hgt < 2.2) mask = 1.0;',
    '    }',
    '    ao *= (1.0 - 0.8 * sh) * (1.0 - body);',
    '  }',
    '  float dn = clamp(vz / 400.0, 0.0, 1.0) * 255.0;',
    '  gl_FragColor = vec4(ao, mask, floor(dn) / 255.0, fract(dn));',
    '}'
  ].join('\n');
  // depth-aware separable blur of the AO (r) and car mask (g)
  var AOBLUR_FS = HEAD + [
    'uniform sampler2D uTex; uniform vec2 uDir;',
    'float depthOf(vec4 t){ return (t.b * 255.0 + t.a) / 255.0 * 400.0; }',
    'void main(){',
    '  vec4 c = texture2D(uTex, vUv);',
    '  float z0 = depthOf(c);',
    '  vec2 acc = c.rg * 0.2270270; float wsum = 0.2270270;',
    '  for (int i = 1; i <= 2; i++) {',
    '    float fi = float(i); float wg = fi < 1.5 ? 0.3162162 : 0.0702703;',
    '    vec2 o = uDir * (fi < 1.5 ? 1.3846154 : 3.2307692);',
    '    vec4 a = texture2D(uTex, vUv + o); vec4 b = texture2D(uTex, vUv - o);',
    '    float wa = wg * max(0.0, 1.0 - abs(depthOf(a) - z0) / (0.02 * z0 + 0.05));',
    '    float wb = wg * max(0.0, 1.0 - abs(depthOf(b) - z0) / (0.02 * z0 + 0.05));',
    '    acc += a.rg * wa + b.rg * wb; wsum += wa + wb;',
    '  }',
    '  gl_FragColor = vec4(acc / wsum, c.b, c.a);',
    '}'
  ].join('\n');

  var COMPOSITE_FS = HEAD + [
    'uniform sampler2D uScene; uniform sampler2D uBloom; uniform sampler2D uAOTex; uniform sampler2D uDepth;',
    'uniform vec2 uTexel; uniform vec2 uOutRes; uniform float uAspect;',
    'uniform vec4 uMode;', // x: hdr tonemap, y: ao on, z: bloom on, w: motion mode (0 none, 1 radial, 2 reprojection)
    'uniform vec4 uBloomP;', // strength, decode scale, aces scale, tonemap kind (0 fitted, 1 fast)
    'uniform float uAOStr;',
    'uniform mat4 uReproj; uniform vec4 uMB;', // shutter, max uv length, near mask (m), radial amount
    'uniform vec2 uBlurCenter; uniform vec4 uProj;',
    'uniform float uExposure, uContrast, uSaturation, uVignette, uGrain, uTime, uChromatic, uFlash, uLumaAlpha;',
    'uniform float uDebug;',
    'uniform vec3 uLift, uGammaInv, uGain, uWB, uFlashColor;',
    'vec3 rrtOdt(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }',
    'vec3 acesFitted(vec3 c){',
    '  c = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777) * c;',
    '  c = rrtOdt(c);',
    '  c = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602) * c;',
    '  return clamp(c, 0.0, 1.0);',
    '}',
    'vec3 acesFast(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
    // hue-preserving ACES: the curve applied to luminance with chroma restored (saturated paints keep their hue;
    // orange stays orange, red does not go salmon), very bright saturated colours roll toward white like film,
    // blended 60 / 40 with per-channel ACES so highlights still desaturate naturally
    'vec3 acesHue(vec3 x){',
    '  vec3 pc = acesFitted(x);',
    '  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));',
    '  vec3 lt = x * (acesFitted(vec3(l)).g / max(l, 1e-4));',
    '  float mx = max(lt.r, max(lt.g, lt.b)); float tl = dot(lt, vec3(0.2126, 0.7152, 0.0722));',
    '  lt = clamp(mix(lt, vec3(tl), clamp(mx - 1.0, 0.0, 1.0)), 0.0, 1.0);',
    '  return mix(pc, lt, 0.6);',
    '}',
    'vec3 fetch(vec2 uv){',
    '  if (uChromatic > 0.0001) {',
    '    vec2 d = (uv - 0.5) * uChromatic * 0.012;',
    '    return vec3(texture2D(uScene, uv + d).r, texture2D(uScene, uv).g, texture2D(uScene, uv - d).b);',
    '  }',
    '  return texture2D(uScene, uv).rgb;',
    '}',
    'float viewZ(float d){ float z = d * 2.0 - 1.0; return 2.0 * uProj.z * uProj.w / (uProj.w + uProj.z - z * (uProj.w - uProj.z)); }',
    'void main(){',
    '  vec2 uv = vUv;',
    '  vec3 c = fetch(uv);',
    '  vec4 aot = uMode.y > 0.5 ? texture2D(uAOTex, uv) : vec4(1.0, 0.0, 1.0, 1.0);',
    '  if (uMode.w > 1.5) {',
    '    float d = texture2D(uDepth, uv).r;',
    '    vec4 pc = uReproj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);',
    '    vec2 vel = (uv - (pc.xy / max(pc.w, 1e-5) * 0.5 + 0.5)) * uMB.x;',
    '    float vz = viewZ(d);',
    '    vel *= smoothstep(uMB.z, uMB.z * 1.8, vz) * (1.0 - aot.g);',
    '    float vl = length(vel);',
    '    if (vl > uMB.y) vel *= uMB.y / vl;',
    '    if (vl * uOutRes.x > 0.75) {',
    '      vec3 acc = c;',
    '      for (int i = 1; i < 8; i++) { acc += texture2D(uScene, uv + vel * (float(i) / 7.0 - 0.5)).rgb; }',
    '      c = acc / 8.0;',
    '    }',
    '  }',
    '  if (uMB.w > 0.001) {',
    '    vec2 dd = uv - uBlurCenter;',
    '    float r = length(dd * vec2(uAspect, 1.0));',
    '    float m = smoothstep(0.2, 0.85, r) * uMB.w;',
    // depth available: no tunnel blur on geometry near the camera (cockpit interior, rear-view mirror, hood)
    '    if (uMode.w > 1.5) m *= smoothstep(uMB.z * 0.5, uMB.z, viewZ(texture2D(uDepth, uv).r));',
    '    vec3 acc = c;',
    '    for (int i = 1; i < 6; i++) { acc += texture2D(uScene, uv - dd * m * 0.022 * float(i)).rgb; }',
    '    c = acc / 6.0;',
    '  }',
    '  c *= mix(1.0, aot.r, uAOStr);',
    '  vec3 bl = uMode.z > 0.5 ? texture2D(uBloom, uv).rgb * uBloomP.y * uBloomP.x : vec3(0.0);',
    '  if (uMode.x > 0.5) {',
    '    c = (c + bl) * uExposure * uWB;',
    '    c = uBloomP.w > 1.5 ? acesFitted(c * uBloomP.z) : (uBloomP.w > 0.5 ? acesFast(c) : acesHue(c * uBloomP.z));',
    '    c = pow(c, vec3(1.0 / 2.2));',
    '  } else {',
    '    c = clamp(c * uWB, 0.0, 1.0);',
    '    c = vec3(1.0) - (vec3(1.0) - c) * (vec3(1.0) - clamp(bl, 0.0, 1.0));',
    '  }',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = max(mix(vec3(l), c, uSaturation), 0.0);',
    '  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);',
    '  c = pow(max(c * uGain + uLift * (1.0 - c), 0.0), uGammaInv);',
    '  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);',
    '  c *= mix(1.0, smoothstep(1.2, 0.3, length(q)), uVignette);',
    '  c += uFlashColor * uFlash;',
    '  float n1 = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uTime * 37.0, vec2(0.06711056, 0.00583715))));',
    '  float n2 = fract(52.9829189 * fract(dot(gl_FragCoord.yx + uTime * 61.0, vec2(0.06711056, 0.00583715))));',
    '  c += (n1 + n2 - 1.0) * (1.0 / 255.0 + uGrain);',
    '  c = clamp(c, 0.0, 1.0);',
    '  if (uDebug > 0.5) c = uDebug < 1.5 ? vec3(aot.r) : uDebug < 2.5 ? vec3(aot.g) : clamp(bl, 0.0, 1.0);',
    '  gl_FragColor = vec4(c, uLumaAlpha > 0.5 ? sqrt(dot(c, vec3(0.299, 0.587, 0.114))) : 1.0);',
    '}'
  ].join('\n');
  // FXAA (3.11 console-style) on the tonemapped image, luma in alpha
  var FXAA_FS = HEAD + [
    'uniform sampler2D uTex; uniform vec2 uTexel;',
    'void main(){',
    '  vec4 M = texture2D(uTex, vUv);',
    '  float lNW = texture2D(uTex, vUv + vec2(-0.5,-0.5) * uTexel).a, lNE = texture2D(uTex, vUv + vec2(0.5,-0.5) * uTexel).a;',
    '  float lSW = texture2D(uTex, vUv + vec2(-0.5, 0.5) * uTexel).a, lSE = texture2D(uTex, vUv + vec2(0.5, 0.5) * uTexel).a;',
    '  float lM = M.a;',
    '  float lMax = max(max(lNW, lNE), max(lSW, lSE)), lMin = min(min(lNW, lNE), min(lSW, lSE));',
    '  float lMaxM = max(lMax, lM), lMinM = min(lMin, lM);',
    '  if (lMaxM - lMinM < max(0.04, lMaxM * 0.125)) { gl_FragColor = vec4(M.rgb, 1.0); return; }',
    '  vec2 dir = vec2((lSW + lSE) - (lNW + lNE), (lNW + lSW) - (lNE + lSE));',
    '  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);',
    '  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);',
    '  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;',
    '  vec3 a = 0.5 * (texture2D(uTex, vUv - dir * (1.0 / 6.0)).rgb + texture2D(uTex, vUv + dir * (1.0 / 6.0)).rgb);',
    '  vec3 b = a * 0.5 + 0.25 * (texture2D(uTex, vUv - dir * 0.5).rgb + texture2D(uTex, vUv + dir * 0.5).rgb);',
    '  float lB = sqrt(dot(b, vec3(0.299, 0.587, 0.114)));',
    '  gl_FragColor = vec4((lB < lMinM || lB > lMaxM) ? a : b, 1.0);',
    '}'
  ].join('\n');

  /* ================================================================== instance */
  function create(ctxIn, opts) {
    opts = opts || {};
    var ctx = ctxIn && ctxIn.gl ? ctxIn : { gl: ctxIn };
    var gl = ctx.gl;
    if (!gl) throw new Error('CB.gl.post.create: no WebGL context');
    var isGL2 = ctx.isWebGL2 != null ? !!ctx.isWebGL2
      : (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext);

    var S = {
      quality: normQuality(opts.quality) || 'high', Q: null, caps: null, w: 0, h: 0, progs: null, vbo: null, white: null,
      T: null, gen: num(ctx.generation, 0), broken: false, wasLost: false, prevVP: null, prevCam: null,
      depthChecked: false, depthOk: false, cA: new Float32Array(MAX_CONTACTS * 4), cB: new Float32Array(MAX_CONTACTS * 4), cC: new Float32Array(MAX_CONTACTS * 4),
      vp: new Float32Array(16), ivp: new Float32Array(16), ivView: new Float32Array(16), reproj: new Float32Array(16),
      active: false, frame: 0, lastErr: null,
      st: { ssao: false, contacts: 0, bloomLevels: 0, motion: 0, fxaa: false }
    };
    var post = {};

    function lost() { return !!(ctx.lost || (gl.isContextLost && gl.isContextLost())); }
    /** objects made before a context loss belong to the old context: deleting them after the restore only warns */
    function stale() { return lost() || num(ctx.generation, 0) !== S.gen; }
    function ext(n) { try { return gl.getExtension(n); } catch (e) { return null; } }
    function detectCaps() {
      var c = { isGL2: isGL2 };
      c.maxSamples = isGL2 ? (gl.getParameter(gl.MAX_SAMPLES) || 0) : 0;
      if (isGL2) {
        c.cbf = !!(ext('EXT_color_buffer_float') || ext('EXT_color_buffer_half_float'));
        c.hdr = c.cbf; c.hdrLinear = true; c.halfType = gl.HALF_FLOAT; c.hdrInternal = gl.RGBA16F;
        c.depthTexture = true;
      } else {
        var hf = ext('OES_texture_half_float');
        c.hdr = !!(hf && ext('EXT_color_buffer_half_float'));
        c.hdrLinear = !!ext('OES_texture_half_float_linear');
        c.halfType = hf ? hf.HALF_FLOAT_OES : 0; c.hdrInternal = gl.RGBA;
        c.depthExt = ext('WEBGL_depth_texture');
        c.depthTexture = !!c.depthExt;
      }
      return c;
    }

    /* ---------------- GL helpers */
    function compile(fs) {
      function sh(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !lost()) {
          var log = gl.getShaderInfoLog(s); gl.deleteShader(s);
          throw new Error('post shader: ' + log);
        }
        return s;
      }
      var v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, fs), p = gl.createProgram();
      gl.attachShader(p, v); gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      gl.deleteShader(v); gl.deleteShader(f);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !lost()) throw new Error('post link: ' + gl.getProgramInfoLog(p));
      var cache = {};
      return {
        program: p,
        u: function (name) { if (!(name in cache)) cache[name] = gl.getUniformLocation(p, name); return cache[name]; }
      };
    }
    function buildPrograms() {
      S.progs = {
        prefilter: compile(PREFILTER_FS), down: compile(DOWN_FS), up: compile(UP_FS),
        ao: compile(AO_FS), aoBlur: compile(AOBLUR_FS), composite: compile(COMPOSITE_FS), fxaa: compile(FXAA_FS)
      };
      S.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, S.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      S.white = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, S.white);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 255, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    function tex(w, h, kind, filter) {
      var t = gl.createTexture(), C = S.caps;
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (kind === 'depth') {
        if (isGL2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        filter = gl.NEAREST;
      } else if (kind === 'hdr') {
        gl.texImage2D(gl.TEXTURE_2D, 0, C.hdrInternal, w, h, 0, gl.RGBA, C.halfType, null);
        if (!C.hdrLinear) filter = gl.NEAREST;
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      filter = filter || gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return t;
    }
    /** color-texture FBO; returns {fb, tex, w, h} or null when incomplete */
    function colorTarget(w, h, kind) {
      var t = { w: w, h: h, tex: tex(w, h, kind), fb: gl.createFramebuffer(), kind: kind };
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) { freeTarget(t); return null; }
      return t;
    }
    function freeTarget(t) {
      if (!t || stale()) return;
      if (t.fb) gl.deleteFramebuffer(t.fb);
      if (t.msFb) gl.deleteFramebuffer(t.msFb);
      if (t.tex) gl.deleteTexture(t.tex);
      if (t.depthTex) gl.deleteTexture(t.depthTex);
      [t.depthRb, t.msColor, t.msDepth].forEach(function (r) { if (r) gl.deleteRenderbuffer(r); });
    }
    /** scene target: color (HDR when possible) + depth (texture when possible), optional MSAA FBO resolved by blit. */
    function sceneTarget(w, h, Q) {
      var C = S.caps;
      var kinds = Q.hdr ? ['hdr', 'byte'] : ['byte'];
      for (var ki = 0; ki < kinds.length; ki++) {
        var depthModes = C.depthTexture ? ['tex', 'rb'] : ['rb'];
        for (var di = 0; di < depthModes.length; di++) {
          var t = { w: w, h: h, kind: kinds[ki], tex: tex(w, h, kinds[ki]), fb: gl.createFramebuffer(), samples: 0 };
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
          if (depthModes[di] === 'tex') {
            t.depthTex = tex(w, h, 'depth');
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t.depthTex, 0);
          } else {
            t.depthRb = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, t.depthRb);
            gl.renderbufferStorage(gl.RENDERBUFFER, isGL2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16, w, h);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depthRb);
          }
          var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.bindRenderbuffer(gl.RENDERBUFFER, null);
          if (!ok) { freeTarget(t); continue; }
          if (Q.msaa > 0 && isGL2) {
            try {
              t.msFb = gl.createFramebuffer();
              gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFb);
              t.msColor = gl.createRenderbuffer();
              gl.bindRenderbuffer(gl.RENDERBUFFER, t.msColor);
              gl.renderbufferStorageMultisample(gl.RENDERBUFFER, Q.msaa, t.kind === 'hdr' ? gl.RGBA16F : gl.RGBA8, w, h);
              gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.msColor);
              t.msDepth = gl.createRenderbuffer();
              gl.bindRenderbuffer(gl.RENDERBUFFER, t.msDepth);
              gl.renderbufferStorageMultisample(gl.RENDERBUFFER, Q.msaa, gl.DEPTH_COMPONENT24, w, h);
              gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.msDepth);
              if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('msaa incomplete');
              t.samples = Q.msaa;
            } catch (e) {
              if (t.msFb) gl.deleteFramebuffer(t.msFb);
              if (t.msColor) gl.deleteRenderbuffer(t.msColor);
              if (t.msDepth) gl.deleteRenderbuffer(t.msDepth);
              t.msFb = t.msColor = t.msDepth = null; t.samples = 0;
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.bindRenderbuffer(gl.RENDERBUFFER, null);
          }
          return t;
        }
      }
      return null;
    }

    function freeAll() {
      var T = S.T;
      if (T) {
        freeTarget(T.scene); freeTarget(T.aoA); freeTarget(T.aoB); freeTarget(T.ldr);
        (T.bloom || []).forEach(freeTarget);
      }
      S.T = null;
    }
    function allocate() {
      freeAll();
      var Q = S.Q, w = S.w, h = S.h, T = S.T = { bloom: [] };
      T.scene = sceneTarget(w, h, Q);
      if (!T.scene) throw new Error('post: scene target incomplete');
      T.hdr = T.scene.kind === 'hdr';
      T.depth = !!T.scene.depthTex;
      if (T.depth && (Q.ssao > 0 || Q.contacts)) {
        var hw = Math.max(1, (w + 1) >> 1), hh = Math.max(1, (h + 1) >> 1);
        T.aoA = colorTarget(hw, hh, 'byte');
        T.aoB = Q.ssao > 0 ? colorTarget(hw, hh, 'byte') : null;
        if (!T.aoA) { freeTarget(T.aoB); T.aoB = null; }
      }
      if (Q.bloomLevels > 0) {
        var bk = T.hdr && S.caps.hdrLinear ? 'hdr' : 'byte';
        var sizes = bloomSizes(w, h, Q.bloomLevels);
        for (var i = 0; i < sizes.length; i++) {
          var b = colorTarget(sizes[i][0], sizes[i][1], bk);
          if (!b && bk === 'hdr') { bk = 'byte'; b = colorTarget(sizes[i][0], sizes[i][1], bk); }
          if (!b) break;
          T.bloom.push(b);
        }
        T.bloomKind = bk;
      }
      T.fxaa = !!Q.fxaa;
      if (T.fxaa) { T.ldr = colorTarget(w, h, 'byte'); if (!T.ldr) T.fxaa = false; }
      S.depthChecked = !T.scene.msFb || !T.depth; // non-MSAA depth texture needs no blit check
      S.depthOk = T.depth;
      S.prevVP = null;
    }

    function ensure() {
      if (lost()) { S.wasLost = true; return false; }
      var gen = num(ctx.generation, 0);
      if (S.wasLost || gen !== S.gen) {
        // context restored: every GL object is gone — rebuild from scratch
        S.wasLost = false; S.gen = gen; S.progs = null; S.T = null; S.caps = null; S.broken = false;
      }
      if (S.broken) return false;
      try {
        if (!S.caps) { S.caps = detectCaps(); S.Q = null; }
        if (!S.Q) { S.Q = qualityConfig(S.quality, S.caps, opts); freeAll(); }
        if (!S.Q.enabled) return false;
        if (!S.progs) buildPrograms();
        if (!S.w || !S.h) { S.w = gl.drawingBufferWidth || 1; S.h = gl.drawingBufferHeight || 1; }
        if (!S.T) allocate();
        return true;
      } catch (e) {
        S.broken = true; S.lastErr = String(e && e.message || e);
        if (typeof console !== 'undefined' && console.warn) console.warn('[CB.gl.post] disabled:', S.lastErr);
        try { freeAll(); } catch (e2) { /* ignore */ }
        return false;
      }
    }

    function unbindVAO() {
      if (isGL2) gl.bindVertexArray(null);
      else { var e = S.vaoExt === undefined ? (S.vaoExt = ext('OES_vertex_array_object')) : S.vaoExt; if (e) e.bindVertexArrayOES(null); }
    }
    function draw(prog, fb, w, h, setup) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog.program);
      setup(prog.u);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function bindTex(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }

    /* ---------------- public API */
    post.resize = function (w, h) {
      w = Math.max(1, Math.round(num(w, gl.drawingBufferWidth || 1))); h = Math.max(1, Math.round(num(h, gl.drawingBufferHeight || 1)));
      if (w === S.w && h === S.h) return post;
      S.w = w; S.h = h;
      if (S.T && !lost()) freeAll(); else S.T = null;
      return post;
    };
    post.setQuality = function (q) {
      var n = normQuality(q);
      if (!n || n === S.quality) return S.quality;
      S.quality = n; S.Q = null;
      return S.quality;
    };
    post.getQuality = function () { return S.quality; };
    post.isActive = function () { return S.active; };
    post.getSceneTexture = function () { return S.T && S.T.scene ? S.T.scene.tex : null; };
    post.getDepthTexture = function () { return S.T && S.T.scene && S.depthOk ? S.T.scene.depthTex : null; };

    var directTarget = { fb: null, width: 0, height: 0, hdr: false, linearOutput: false, samples: 0, depth: false, direct: true, bind: null };
    directTarget.bind = function () { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); return directTarget; };
    var sceneObj = { fb: null, width: 0, height: 0, hdr: false, linearOutput: false, samples: 0, depth: false, direct: false, bind: null };
    sceneObj.bind = function () {
      var t = S.T && S.T.scene;
      if (!t) return directTarget.bind();
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFb || t.fb);
      gl.viewport(0, 0, t.w, t.h);
      return sceneObj;
    };

    post.begin = function () {
      S.active = ensure();
      if (!S.active) {
        directTarget.width = gl.drawingBufferWidth; directTarget.height = gl.drawingBufferHeight;
        return directTarget.bind();
      }
      var t = S.T.scene;
      sceneObj.fb = t.msFb || t.fb; sceneObj.width = t.w; sceneObj.height = t.h; sceneObj.hdr = S.T.hdr;
      sceneObj.linearOutput = S.T.hdr; sceneObj.samples = t.samples; sceneObj.depth = S.depthOk;
      return sceneObj.bind();
    };

    post.end = function (p) {
      if (!S.active) return false;
      S.active = false;
      if (lost() || !S.T) return false;
      p = p || {};
      var T = S.T, Q = S.Q, P = S.progs, sc = T.scene, i;
      var outW = Math.max(1, num(p.outWidth, gl.drawingBufferWidth)), outH = Math.max(1, num(p.outHeight, gl.drawingBufferHeight));
      var outFb = null, tg = p.target;
      if (tg != null) {
        if (tg.fb !== undefined) outFb = tg.fb;
        else if (typeof tg.bind === 'function') { tg.bind(); outFb = gl.getParameter(gl.FRAMEBUFFER_BINDING); }
        else outFb = tg;
      }
      try {
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
        gl.depthMask(false); gl.colorMask(true, true, true, true);
        unbindVAO();
        gl.bindBuffer(gl.ARRAY_BUFFER, S.vbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        if (isGL2) gl.vertexAttribDivisor(0, 0);

        // ---- resolve MSAA (color + depth)
        if (sc.msFb) {
          if (!S.depthChecked) while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sc.msFb);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sc.fb);
          gl.blitFramebuffer(0, 0, sc.w, sc.h, 0, 0, sc.w, sc.h, gl.COLOR_BUFFER_BIT | (S.depthOk ? gl.DEPTH_BUFFER_BIT : 0), gl.NEAREST);
          if (!S.depthChecked) {
            S.depthChecked = true;
            if (S.depthOk && gl.getError() !== gl.NO_ERROR) {
              S.depthOk = false; // depth resolve unsupported: color-only from now on
              gl.blitFramebuffer(0, 0, sc.w, sc.h, 0, 0, sc.w, sc.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
            }
          }
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        }

        var grade = gradeFor(p.timeOfDay, p.weather);
        var cam = p.camera && p.camera.view && p.camera.proj ? p.camera : null;
        var nf = cam ? (isFinite(cam.near) && isFinite(cam.far) ? [cam.near, cam.far] : nearFar(cam.proj)) : [0.1, 3000];
        var depthOk = S.depthOk && !!cam;

        // ---- AO + contact shadows (half res)
        var nC = depthOk && Q.contacts ? packContacts(p.contacts, S.cA, S.cB, S.cC) : 0;
        var ssao = depthOk && Q.ssao > 0 && p.ao !== false && !!T.aoB;
        var aoOn = !!T.aoA && depthOk && (ssao || nC > 0);
        if (aoOn) {
          if (!invert4(S.ivView, cam.view)) aoOn = false;
        }
        if (aoOn) {
          var aw = T.aoA.w, ah = T.aoA.h;
          bindTex(0, sc.depthTex);
          draw(P.ao, T.aoA.fb, aw, ah, function (u) {
            gl.uniform1i(u('uDepth'), 0);
            gl.uniform2f(u('uTexelFull'), 1 / sc.w, 1 / sc.h);
            gl.uniform2f(u('uRes'), aw, ah);
            gl.uniform4f(u('uProj'), cam.proj[0], cam.proj[5], nf[0], nf[1]);
            gl.uniformMatrix4fv(u('uInvView'), false, S.ivView);
            gl.uniform4f(u('uAO'), num(p.aoRadius, 0.65), num(p.aoIntensity, 2.2), ssao ? Q.ssao : 0, num(p.aoFade, 160));
            gl.uniform4fv(u('uContactA'), S.cA); gl.uniform4fv(u('uContactB'), S.cB); gl.uniform4fv(u('uContactC'), S.cC);
            gl.uniform1f(u('uContactCount'), nC);
          });
          if (ssao) {
            bindTex(0, T.aoA.tex);
            draw(P.aoBlur, T.aoB.fb, aw, ah, function (u) { gl.uniform1i(u('uTex'), 0); gl.uniform2f(u('uDir'), 1 / aw, 0); });
            bindTex(0, T.aoB.tex);
            draw(P.aoBlur, T.aoA.fb, aw, ah, function (u) { gl.uniform1i(u('uTex'), 0); gl.uniform2f(u('uDir'), 0, 1 / ah); });
          }
        }

        // ---- bloom pyramid (prefilter -> dual-filter down -> additive tent up)
        var B = T.bloom, bloomOn = B.length > 0 && p.bloom !== false;
        var bScale = T.bloomKind === 'byte' ? 0.25 : 1;
        if (bloomOn) {
          var thr = num(p.threshold, T.hdr ? grade.threshold : 0.78), knee = num(p.knee, thr * 0.5);
          bindTex(0, sc.tex);
          draw(P.prefilter, B[0].fb, B[0].w, B[0].h, function (u) {
            gl.uniform1i(u('uTex'), 0);
            gl.uniform2f(u('uTexel'), 1 / sc.w, 1 / sc.h);
            gl.uniform4f(u('uThresh'), thr, knee, bScale, T.hdr ? 48 : 1);
          });
          for (i = 1; i < B.length; i++) {
            bindTex(0, B[i - 1].tex);
            draw(P.down, B[i].fb, B[i].w, B[i].h, function (u) { gl.uniform1i(u('uTex'), 0); gl.uniform2f(u('uTexel'), 1 / B[i - 1].w, 1 / B[i - 1].h); });
          }
          gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
          for (i = B.length - 1; i > 0; i--) {
            bindTex(0, B[i].tex);
            draw(P.up, B[i - 1].fb, B[i - 1].w, B[i - 1].h, function (u) {
              gl.uniform1i(u('uTex'), 0); gl.uniform2f(u('uTexel'), 0.5 / B[i].w, 0.5 / B[i].h); gl.uniform1f(u('uWeight'), 1);
            });
          }
          gl.disable(gl.BLEND);
        }

        // ---- motion blur setup
        var mb = 0, mbAmt = clamp(num(p.motionBlur, 1), 0, 2), radial = clamp(num(p.speedBlur, 0), 0, 1.5);
        if (cam) {
          mul4(S.vp, cam.proj, cam.view);
          var cp = camPos(cam.view);
          var jump = S.prevCam ? Math.hypot(cp[0] - S.prevCam[0], cp[1] - S.prevCam[1], cp[2] - S.prevCam[2]) : 0;
          if (Q.motion === 2 && depthOk && S.prevVP && !p.cut && jump < 12 && mbAmt > 0 && invert4(S.ivp, S.vp)) {
            mul4(S.reproj, S.prevVP, S.ivp);
            mb = 2;
          }
          if (!S.prevVP) S.prevVP = new Float32Array(16);
          S.prevVP.set(S.vp);
          S.prevCam = cp;
        }
        if (Q.motion === 0 || p.cut) radial = 0;
        else if (mb === 2) radial *= 0.35; // reprojection already covers the background; keep a hint of tunnel blur

        // ---- composite
        var fx = T.fxaa && T.ldr;
        var compFb = fx ? T.ldr.fb : outFb, cw = fx ? T.ldr.w : outW, ch = fx ? T.ldr.h : outH;
        bindTex(0, sc.tex);
        bindTex(1, bloomOn ? B[0].tex : S.white);
        bindTex(2, aoOn ? T.aoA.tex : S.white);
        bindTex(3, mb === 2 ? sc.depthTex : S.white);
        var wb = whiteBalance(num(p.temperature, grade.temperature), num(p.tint, grade.tint));
        var lift = arr3(p.lift, grade.lift), gam = arr3(p.gamma, grade.gamma), gain = arr3(p.gain, grade.gain);
        var bc = p.blurCenter || [0.5, 0.52];
        var fc = arr3(p.flashColor, [1, 0.92, 0.8]);
        var tmName = p.tonemap || opts.tonemap, tmKind = tmName === 'aces-fast' ? 1 : (tmName === 'aces-channel' ? 2 : 0);
        draw(P.composite, compFb, cw, ch, function (u) {
          gl.uniform1i(u('uScene'), 0); gl.uniform1i(u('uBloom'), 1); gl.uniform1i(u('uAOTex'), 2); gl.uniform1i(u('uDepth'), 3);
          gl.uniform2f(u('uTexel'), 1 / sc.w, 1 / sc.h);
          gl.uniform2f(u('uOutRes'), sc.w, sc.h);
          gl.uniform1f(u('uAspect'), sc.w / Math.max(1, sc.h));
          gl.uniform4f(u('uMode'), T.hdr && p.tonemap !== false ? 1 : 0, aoOn ? 1 : 0, bloomOn ? 1 : 0, mb);
          gl.uniform4f(u('uBloomP'), num(p.bloomStrength, grade.bloomStrength) / Math.max(1, B.length), 1 / bScale, num(opts.acesScale, 1.8), tmKind);
          gl.uniform1f(u('uAOStr'), aoOn ? clamp(num(p.aoStrength, 0.9), 0, 1) : 0);
          gl.uniformMatrix4fv(u('uReproj'), false, S.reproj);
          gl.uniform4f(u('uMB'), 0.5 * mbAmt, num(p.motionBlurMax, 0.03), num(p.motionBlurNear, 9), radial);
          gl.uniform2f(u('uBlurCenter'), bc[0], bc[1]);
          gl.uniform4f(u('uProj'), cam ? cam.proj[0] : 1, cam ? cam.proj[5] : 1, nf[0], nf[1]);
          gl.uniform1f(u('uExposure'), num(p.exposure, 1) * grade.exposure);
          gl.uniform1f(u('uContrast'), num(p.contrast, grade.contrast));
          gl.uniform1f(u('uSaturation'), num(p.saturation, grade.saturation));
          gl.uniform1f(u('uVignette'), num(p.vignette, grade.vignette));
          gl.uniform1f(u('uGrain'), num(p.grain, Q.grain));
          gl.uniform1f(u('uTime'), num(p.time, S.frame * 0.016) % 64);
          gl.uniform1f(u('uChromatic'), num(p.chromatic, 0));
          gl.uniform1f(u('uFlash'), clamp(num(p.flash, 0), 0, 1));
          gl.uniform1f(u('uLumaAlpha'), fx ? 1 : 0);
          gl.uniform1f(u('uDebug'), p.debug === 'ao' ? 1 : p.debug === 'mask' ? 2 : p.debug === 'bloom' ? 3 : 0);
          gl.uniform3f(u('uLift'), lift[0], lift[1], lift[2]);
          gl.uniform3f(u('uGammaInv'), 1 / Math.max(0.2, gam[0]), 1 / Math.max(0.2, gam[1]), 1 / Math.max(0.2, gam[2]));
          gl.uniform3f(u('uGain'), gain[0], gain[1], gain[2]);
          gl.uniform3f(u('uWB'), wb[0], wb[1], wb[2]);
          gl.uniform3f(u('uFlashColor'), fc[0], fc[1], fc[2]);
        });

        // ---- FXAA to the output
        if (fx) {
          bindTex(0, T.ldr.tex);
          draw(P.fxaa, outFb, outW, outH, function (u) { gl.uniform1i(u('uTex'), 0); gl.uniform2f(u('uTexel'), 1 / T.ldr.w, 1 / T.ldr.h); });
        }

        S.st.ssao = ssao; S.st.contacts = aoOn ? nC : 0; S.st.bloomLevels = bloomOn ? B.length : 0; S.st.motion = mb || (radial > 0 ? 1 : 0); S.st.fxaa = !!fx;
        S.frame++;
        return true;
      } catch (e) {
        S.lastErr = String(e && e.message || e);
        return false;
      } finally {
        for (i = 3; i >= 0; i--) bindTex(i, null);
        gl.disableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, outFb || null);
        gl.viewport(0, 0, outW, outH);
      }
    };

    post.stats = function () {
      var T = S.T, Q = S.Q || qualityConfig(S.quality, S.caps || {}, opts);
      return {
        quality: S.quality, enabled: !!Q.enabled && !S.broken, broken: S.broken, error: S.lastErr,
        width: S.w, height: S.h, hdr: !!(T && T.hdr), samples: T && T.scene ? T.scene.samples : 0,
        depth: !!(T && S.depthOk), ssao: S.st.ssao, ssaoSamples: Q.ssao, contacts: S.st.contacts,
        bloomLevels: S.st.bloomLevels, motion: S.st.motion, fxaa: S.st.fxaa, webgl2: isGL2
      };
    };
    post.destroy = function () {
      if (!stale()) {
        freeAll();
        if (S.progs) for (var k in S.progs) gl.deleteProgram(S.progs[k].program);
        if (S.vbo) gl.deleteBuffer(S.vbo);
        if (S.white) gl.deleteTexture(S.white);
      }
      S.progs = null; S.vbo = null; S.white = null; S.T = null; S.broken = true;
    };
    if (opts.width && opts.height) post.resize(opts.width, opts.height);
    return post;
  }

  var api = {
    create: create,
    contactsFromCars: contactsFromCars,
    gradeFor: gradeFor,
    QUALITY: QUALITY, QUALITY_ORDER: QUALITY_ORDER, MAX_CONTACTS: MAX_CONTACTS,
    _: {
      qualityConfig: qualityConfig, normQuality: normQuality, gradeFor: gradeFor, whiteBalance: whiteBalance,
      acesFast: acesFast, acesFitted: acesFitted, mul4: mul4, invert4: invert4, nearFar: nearFar, camPos: camPos,
      packContacts: packContacts, contactsFromCars: contactsFromCars, bloomSizes: bloomSizes,
      shaders: { VS: VS, PREFILTER_FS: PREFILTER_FS, DOWN_FS: DOWN_FS, UP_FS: UP_FS, AO_FS: AO_FS, AOBLUR_FS: AOBLUR_FS, COMPOSITE_FS: COMPOSITE_FS, FXAA_FS: FXAA_FS }
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();

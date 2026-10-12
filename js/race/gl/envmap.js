/* ==========================================================================
   FORGE Atelier — js/race/gl/envmap.js
   CB.gl.envmap : image-based lighting for the 3D renderer (car paint clearcoat, glass, chrome, wet road).
   Zero dependencies, classic script, WebGL2 with a WebGL1 fallback. Load AFTER gl-core.js (anywhere before
   renderer3d.js). Every GL entry point is guarded: if anything fails the probe keeps serving its static cube.

   What it provides
     * A DYNAMIC reflection probe: a cubemap rendered around a point (normally just above the player's car) from
       the renderer's own draw lists in a cheap mode (no shadows, no transparents / self-drawing effects, distance-
       and size-limited item list, per-face cone culling), time-sliced over several frames (facesPerFrame faces per
       frame, a new cycle every `interval` frames; all faces of a cycle use the cycle's start position so faces
       never seam). The finished capture is mip-mapped and PREFILTERED per roughness level with GGX importance
       sampling (filtered importance sampling, WebGL2) or a box-filter mip chain (WebGL1), and a 9-coefficient
       spherical-harmonics irradiance (SH9, cosine-convolved) is projected from a tiny 6xTxT tile render that is read
       back asynchronously (PBO + fence on WebGL2, no pipeline stall; small sync read on WebGL1, rarely).
     * A STATIC fallback cube generated procedurally per timeOfDay / weather (sky gradient, sun aureole, clouds,
       trackside skyline silhouette with a crisp horizon line, stars + city lights at night) or a 'studio' showroom
       (dark floor, big overhead softbox + side strip lights + horizon glow). It is used until the first dynamic
       capture completes, on 'low' quality (dynamic off) and whenever dynamic capture is unavailable.
     * CB.gl.envmap.GLSL: the shader chunk consumers include (uniform declarations + envCubeSpec / envSH helpers).

   API
     var probe = CB.gl.envmap.create(ctx, opts)
       opts: { quality:'low'|'medium'|'high'|'ultra' (default 'high'), size (dynamic cube px, overrides quality),
               staticSize, interval (frames between capture cycles), facesPerFrame (1..6), samples (GGX samples / texel),
               range (m, capture distance), maxItems, near (0.1), timeOfDay, weather, lighting (renderer S.lit: linear
               envTop/envHorizon/envBottom/sunDir/sunColor), studio (bool), dynamic (bool override), hdr (default auto) }
     probe.update(scene, camPos, frame) -> true when it rendered anything this call
       scene: { items: draw items (same objects as drawList's; static world + scenery [+ nearby low-LOD cars]),
                env: the frame's drawList env (renderer buildEnv result), drawSky(cam)?: sky callback,
                setLinearOutput(bool)?: e.g. effects.setLinearOutput (called with true during capture, then
                restoreLinear ?? false), restoreLinear?, exclude(item)?: -> true to skip, clearColor?: linear rgb }
       camPos: probe position (world, GL axes). frame: renderer frame counter (optional; internal counter otherwise).
       Passing scene = null (or quality 'low') only advances the SH blend / async read-back.
     probe.bind(program, unitBase) — useProgram(program) + bind the cube to texture unit `unitBase` (default: the unit
       createProgram assigned to uEnvCube, else 4) and upload uEnvCube, uUseEnvCube, uEnvLod, uEnvSH[9], uEnvScale.
       program: a CB.gl program ({program, u}) or a raw WebGLProgram.
     probe.bindPrograms(list, unit) — bind() for each program in the list (skips nulls / programs without uEnvCube).
     probe.sh        Float32Array(27): 9 RGB SH coefficients, cosine-convolved and divided by PI, so envSH(n) returns
                     the cosine-weighted average incident radiance (same scale as uAmbientSky: diffuse = albedo * envSH(n)).
     probe.texture   WebGLTexture (TEXTURE_CUBE_MAP) currently served (dynamic when valid, else static).
     probe.maxLod, probe.size, probe.hdr, probe.valid (dynamic ready), probe.mode ('prefiltered'|'box')
     probe.setQuality(q), probe.setSky(timeOfDay, weather, lighting, studio?), probe.invalidate(), probe.stats(),
     probe.destroy()
     CB.gl.envmap.preset(timeOfDay, weather, lighting, studio) -> sky parameters (pure)
     CB.gl.envmap.QUALITY, CB.gl.envmap.SAMPLER_UNIT (4), CB.gl.envmap._ (pure helpers for Node tests)

   How renderer3d should call it (integration recipe)
     1. create (after the effects module + lighting exist; once per context generation is handled internally):
          S.envProbe = CB.gl.envmap ? safe('envmap', function () { return CB.gl.envmap.create(ctx,
            { quality: S.quality, timeOfDay: S.timeOfDay, weather: S.weather, lighting: S.lit }); }, null) : null;
        setQuality(q)            -> S.envProbe.setQuality(q)
        setTimeOfDay / weather   -> S.envProbe.setSky(S.timeOfDay, S.weather, S.lit)       (after S.lit is rebuilt)
        reset() / camera cut     -> S.envProbe.invalidate()
        destroy()                -> S.envProbe.destroy()
     2. per frame, AFTER buildEnv() (and the shadow pass) and BEFORE the mirror + main passes:
          probePos = [playerPose.x, elev + 1.0, -playerPose.y]       (roof height above the player's car)
          S.envProbe.update({ items: envItems, env: env, drawSky: drawSky, clearColor: S.lit.fogColor,
                              setLinearOutput: FX && FX.setLinearOutput ? function (b) { FX.setLinearOutput(b); } : null,
                              restoreLinear: false }, probePos, S.frame);
        envItems = W.staticItems + scenery items (NOT the player's car — it would reflect its own inside; optionally
        the 2-3 nearest AI cars' low-LOD items). Reuse one array; the probe never mutates or retains the items list
        beyond the current cycle (it copies the selection at cycle start).
        update() saves/restores the framebuffer binding + viewport; it leaves depthMask(true), blend/cull disabled.
     3. before each drawList that shades with IBL (main pass and mirror pass):
          S.envProbe.bindPrograms([shaders.standard, shaders.standardInstanced], CB.gl.envmap.SAMPLER_UNIT);
        (drawList only touches units 0..2, so the binding survives the whole list.)
     4. shader side (gl-core STANDARD_FS, owned by the shading work): include CB.gl.envmap.GLSL (gl-core can read it
        lazily inside shaders(ctx): `(CB.gl.envmap && CB.gl.envmap.GLSL) || ''`, or inline a copy) and, ideally,
        register `uEnvCube: 4` in SAMPLER_UNITS. Then:
          vec3 envS = uUseEnvCube > 0.5 ? envCubeSpec(R, rough) : envColor(R, rough, L, uSunColor);
          vec3 amb  = uUseEnvCube > 0.5 ? envSH(N) : mix(uAmbientGround, uAmbientSky, hemi);
        (clearcoat: envCubeSpec(Rc, ccRough); wet puddles: envCubeSpec(reflect(-V, Ng), 0.02)). The sun disc is NOT in
        the static cube (the direct GGX sun term already draws it); keep that direct term.
        IMPORTANT: a program that declares uEnvCube must have it on its own unit (never shared with a sampler2D) or
        draws fail with INVALID_OPERATION; createProgram's auto unit assignment (>= 3) already guarantees that.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

(function () {
  'use strict';

  var PI = Math.PI;
  var SAMPLER_UNIT = 4;
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }
  function log2i(n) { return Math.round(Math.log(n) / Math.LN2); }
  function warnOnce(state, key, err) {
    if (state.warned[key]) return;
    state.warned[key] = true;
    if (typeof console !== 'undefined' && console.warn) console.warn('CB.gl.envmap: ' + key, err && err.message ? err.message : err || '');
  }

  /* ======================================================================
     Quality tiers
     ====================================================================== */
  var QUALITY = {
    low: { dynamic: false, size: 64, staticSize: 64, interval: 0, facesPerFrame: 1, samples: 12, range: 0, maxItems: 0, shEvery: 0 },
    medium: { dynamic: true, size: 64, staticSize: 128, interval: 16, facesPerFrame: 1, samples: 16, range: 260, maxItems: 90, shEvery: 2 },
    high: { dynamic: true, size: 256, staticSize: 256, interval: 8, facesPerFrame: 1, samples: 24, range: 420, maxItems: 150, shEvery: 1 },
    ultra: { dynamic: true, size: 512, staticSize: 512, interval: 4, facesPerFrame: 2, samples: 32, range: 650, maxItems: 300, shEvery: 1 }
  };
  function normQuality(q) {
    if (QUALITY[q]) return q;
    if (q === 'med') return 'medium';
    if (q === 'max' || q === 'epic') return 'ultra';
    return 'high';
  }
  function config(q, opts) {
    opts = opts || {};
    var base = QUALITY[normQuality(q)], c = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) c[k] = base[k];
    var pow2 = function (v, d) { v = Math.round(num(v, d)); v = clamp(v, 16, 512); return isPow2(v) ? v : Math.pow(2, Math.round(Math.log(v) / Math.LN2)); };
    if (opts.size != null) c.size = pow2(opts.size, c.size);
    if (opts.staticSize != null) c.staticSize = pow2(opts.staticSize, c.staticSize);
    if (opts.interval != null) c.interval = Math.max(1, Math.round(num(opts.interval, c.interval)));
    if (opts.facesPerFrame != null) c.facesPerFrame = clamp(Math.round(num(opts.facesPerFrame, 1)), 1, 6);
    if (opts.samples != null) c.samples = clamp(Math.round(num(opts.samples, c.samples)), 4, 64);
    if (opts.range != null) c.range = Math.max(10, num(opts.range, c.range));
    if (opts.maxItems != null) c.maxItems = Math.max(1, Math.round(num(opts.maxItems, c.maxItems)));
    if (typeof opts.dynamic === 'boolean') c.dynamic = opts.dynamic;
    if (c.dynamic && !c.interval) c.interval = 8;
    if (c.dynamic && !c.range) c.range = 300;
    if (c.dynamic && !c.maxItems) c.maxItems = 120;
    if (c.dynamic && !c.shEvery) c.shEvery = 1;
    c.interval = Math.max(c.interval, Math.ceil(6 / c.facesPerFrame) + 1);
    return c;
  }

  /* ======================================================================
     Cube face bases (pure). Camera for face i = lookAt(eye, eye + F, upHint); R/U = the camera's right/up, so the
     world direction of a face texel at NDC (x, y) is normalize(F + x R + y U). With GL's bottom-up framebuffer rows
     this matches the cube-map (s, t) convention exactly (see tests/race3d-envmap.test.js).
     ====================================================================== */
  var FACE_DEFS = [
    { F: [1, 0, 0], up: [0, -1, 0] }, { F: [-1, 0, 0], up: [0, -1, 0] },
    { F: [0, 1, 0], up: [0, 0, 1] }, { F: [0, -1, 0], up: [0, 0, -1] },
    { F: [0, 0, 1], up: [0, -1, 0] }, { F: [0, 0, -1], up: [0, -1, 0] }
  ];
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  var FACES = FACE_DEFS.map(function (fd) {
    var z = [-fd.F[0], -fd.F[1], -fd.F[2]];
    var R = norm(cross(fd.up, z));
    var U = cross(z, R);
    var F = fd.F.slice();
    // side-plane normals of the 90 degree frustum (inside: dot(p, n) >= 0)
    var s = Math.SQRT1_2;
    var planes = [
      [(F[0] - R[0]) * s, (F[1] - R[1]) * s, (F[2] - R[2]) * s], [(F[0] + R[0]) * s, (F[1] + R[1]) * s, (F[2] + R[2]) * s],
      [(F[0] - U[0]) * s, (F[1] - U[1]) * s, (F[2] - U[2]) * s], [(F[0] + U[0]) * s, (F[1] + U[1]) * s, (F[2] + U[2]) * s]
    ];
    return { F: F, R: R, U: U, up: fd.up.slice(), planes: planes };
  });
  var FACE_F = new Float32Array(18), FACE_R = new Float32Array(18), FACE_U = new Float32Array(18);
  FACES.forEach(function (f, i) { for (var c = 0; c < 3; c++) { FACE_F[i * 3 + c] = f.F[c]; FACE_R[i * 3 + c] = f.R[c]; FACE_U[i * 3 + c] = f.U[c]; } });

  function faceDir(face, x, y, out) {
    var f = FACES[face];
    out = out || [0, 0, 0];
    var dx = f.F[0] + x * f.R[0] + y * f.U[0], dy = f.F[1] + x * f.R[1] + y * f.U[1], dz = f.F[2] + x * f.R[2] + y * f.U[2];
    var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out[0] = dx / l; out[1] = dy / l; out[2] = dz / l;
    return out;
  }
  /** Sphere (relative centre c, radius r) vs a face's 90 degree frustum. */
  function sphereInFace(face, cx, cy, cz, r) {
    var P = FACES[face].planes;
    for (var i = 0; i < 4; i++) { var n = P[i]; if (cx * n[0] + cy * n[1] + cz * n[2] < -r) return false; }
    return true;
  }

  /* ======================================================================
     Spherical harmonics (pure). Order: Y00, Y1-1(y), Y10(z), Y11(x), Y2-2(xy), Y2-1(yz), Y20(3z^2-1), Y21(xz), Y22(x^2-y^2)
     ====================================================================== */
  function shBasis(d, o) {
    var x = d[0], y = d[1], z = d[2];
    o[0] = 0.282095;
    o[1] = 0.488603 * y; o[2] = 0.488603 * z; o[3] = 0.488603 * x;
    o[4] = 1.092548 * x * y; o[5] = 1.092548 * y * z; o[6] = 0.315392 * (3 * z * z - 1);
    o[7] = 1.092548 * x * z; o[8] = 0.546274 * (x * x - y * y);
    return o;
  }
  var SH_BAND = [PI, 2 * PI / 3, 2 * PI / 3, 2 * PI / 3, PI / 4, PI / 4, PI / 4, PI / 4, PI / 4];
  /**
   * Project radiance samples of a cube (6 faces x T x T texels at texel centres) into SH9, cosine-convolve and divide
   * by PI. sampleFn(face, ix, iy, dir) -> [r, g, b] (linear radiance). Returns Float32Array(27).
   */
  function shProject(T, sampleFn, out) {
    out = out || new Float32Array(27);
    var acc = new Float64Array(27), Y = new Float64Array(9), d = [0, 0, 0], wsum = 0;
    for (var f = 0; f < 6; f++) {
      for (var iy = 0; iy < T; iy++) {
        var y = (iy + 0.5) / T * 2 - 1;
        for (var ix = 0; ix < T; ix++) {
          var x = (ix + 0.5) / T * 2 - 1;
          var w = 1 / Math.pow(1 + x * x + y * y, 1.5);
          faceDir(f, x, y, d);
          var c = sampleFn(f, ix, iy, d);
          if (!c) continue;
          shBasis(d, Y);
          for (var k = 0; k < 9; k++) {
            var yw = Y[k] * w;
            acc[k * 3] += c[0] * yw; acc[k * 3 + 1] += c[1] * yw; acc[k * 3 + 2] += c[2] * yw;
          }
          wsum += w;
        }
      }
    }
    var norm4pi = wsum > 0 ? 4 * PI / wsum : 0;
    for (var k2 = 0; k2 < 9; k2++) {
      var s = norm4pi * SH_BAND[k2] / PI;
      out[k2 * 3] = acc[k2 * 3] * s; out[k2 * 3 + 1] = acc[k2 * 3 + 1] * s; out[k2 * 3 + 2] = acc[k2 * 3 + 2] * s;
    }
    return out;
  }
  /** Decode the RGBA8 tile read-back (6T x T, rows bottom-up, Reinhard-encoded c / (1 + c)) into SH9. */
  function shFromTiles(u8, T, out) {
    var W = T * 6, tmp = [0, 0, 0];
    return shProject(T, function (f, ix, iy) {
      var i = (iy * W + f * T + ix) * 4;
      for (var c = 0; c < 3; c++) { var e = Math.min(u8[i + c] / 255, 0.996); tmp[c] = e / (1 - e); }
      return tmp;
    }, out);
  }
  function shEval(sh, n, out) {
    var Y = shBasis(n, new Float64Array(9));
    out = out || [0, 0, 0];
    out[0] = out[1] = out[2] = 0;
    for (var k = 0; k < 9; k++) { out[0] += sh[k * 3] * Y[k]; out[1] += sh[k * 3 + 1] * Y[k]; out[2] += sh[k * 3 + 2] * Y[k]; }
    return out;
  }
  /** Lod mapping used by the GLSL chunk (kept in sync): prefiltered -> sqrt(rough) * maxLod (mip m holds (m/maxLod)^2); box chain -> lobe width based. */
  function lodForRoughness(rough, maxLod, mode, size) {
    rough = clamp(rough, 0, 1);
    if (mode !== 'box') return Math.sqrt(rough) * maxLod;
    var a = Math.max(rough * rough, 1e-4);
    return clamp(Math.log(a * size * 1.3) / Math.LN2, 0, maxLod);
  }

  /* ======================================================================
     Sky presets (pure). Colours are LINEAR. `lighting` (renderer3d S.lit) wins over the built-in defaults.
     ====================================================================== */
  function lin(c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; }
  function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function v3(v, d) { return v && v.length >= 3 && isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2]) ? [v[0], v[1], v[2]] : d; }
  function preset(timeOfDay, weather, lighting, studio) {
    var tod = timeOfDay === 'dusk' || timeOfDay === 'night' || timeOfDay === 'studio' ? timeOfDay : 'day';
    if (studio) tod = 'studio';
    var L = lighting || {};
    var P;
    if (tod === 'studio') {
      P = {
        zenith: lin([0.10, 0.10, 0.11]), horizon: lin([0.36, 0.36, 0.38]), ground: lin([0.10, 0.10, 0.105]),
        sunDir: norm([-0.3, 0.85, 0.4]), sunColor: [0, 0, 0], cloud: 0, night: 0, sil: 0, silColor: [0, 0, 0],
        city: 0, haze: 0, lights: [5.2, 5.1, 4.9], cloudColor: [0, 0, 0], studio: 1, seed: 0.37
      };
    } else if (tod === 'dusk') {
      P = {
        zenith: lin([0.18, 0.22, 0.44]), horizon: lin([0.98, 0.58, 0.36]), ground: lin([0.16, 0.12, 0.12]),
        sunDir: norm([0.82, 0.16, -0.55]), sunColor: [1.35, 0.74, 0.42], cloud: 0.45, night: 0.15, sil: 0.92,
        silColor: lin([0.10, 0.07, 0.10]), city: 0.5, haze: 0.8, lights: [2.4, 1.5, 0.8], cloudColor: null, studio: 0, seed: 1.7
      };
    } else if (tod === 'night') {
      P = {
        zenith: lin([0.01, 0.015, 0.04]), horizon: lin([0.08, 0.09, 0.14]), ground: lin([0.02, 0.02, 0.025]),
        sunDir: norm([0.3, 0.62, 0.42]), sunColor: [0.16, 0.19, 0.28], cloud: 0.2, night: 1, sil: 0.95,
        silColor: lin([0.012, 0.012, 0.018]), city: 1, haze: 0.5, lights: [2.6, 1.9, 1.1], cloudColor: null, studio: 0, seed: 4.1
      };
    } else {
      P = {
        zenith: lin([0.30, 0.50, 0.84]), horizon: lin([0.80, 0.86, 0.93]), ground: lin([0.26, 0.25, 0.22]),
        sunDir: norm([-0.42, 0.78, -0.46]), sunColor: [1.28, 1.2, 1.06], cloud: 0.32, night: 0, sil: 0.85,
        silColor: lin([0.13, 0.16, 0.12]), city: 0, haze: 0.6, lights: [0, 0, 0], cloudColor: null, studio: 0, seed: 0.9
      };
    }
    if (tod !== 'studio') {
      P.zenith = v3(L.envTop, P.zenith); P.horizon = v3(L.envHorizon, P.horizon); P.ground = v3(L.envBottom, P.ground);
      P.sunDir = norm(v3(L.sunDir, P.sunDir)); P.sunColor = v3(L.sunColor, P.sunColor);
      var w = weather === 'wet' || weather === 'rain' ? 1 : weather === 'damp' || weather === 'overcast' ? 0.55 : weather === 'fog' ? 0.7 : 0;
      if (w > 0) {
        P.cloud = Math.max(P.cloud, 0.6 + 0.35 * w);
        P.haze = Math.min(1, P.haze + 0.4 * w);
        if (!L.sunColor) P.sunColor = scale3(P.sunColor, 1 - 0.55 * w);
      }
      if (!P.cloudColor) {
        P.cloudColor = tod === 'night' ? mix3(P.zenith, P.horizon, 0.6) :
          tod === 'dusk' ? mix3(P.horizon, scale3(P.sunColor, 0.55), 0.45) :
          mix3(P.horizon, [1, 1, 1], 0.45 * (1 - w * 0.5));
        if (w > 0) P.cloudColor = mix3(P.cloudColor, scale3(P.horizon, 0.85), 0.5 * w);
      }
    }
    P.timeOfDay = tod; P.weather = weather || 'dry';
    P.key = [tod, P.weather, P.zenith.join(','), P.horizon.join(','), P.ground.join(','), P.sunDir.join(','), P.sunColor.join(',')].join('|');
    return P;
  }

  /* ======================================================================
     GLSL
     ====================================================================== */
  var FS_VS = [
    'attribute vec3 aPos;',
    'varying vec2 vNdc;',
    'void main() { vNdc = aPos.xy; gl_Position = vec4(aPos.xy, 0.0, 1.0); }'
  ].join('\n');

  var COMMON = [
    'float saturate(float x) { return clamp(x, 0.0, 1.0); }',
    'float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    'float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }',
    'float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y); }'
  ].join('\n');

  /* procedural sky / studio, linear HDR output (no sun disc: the direct GGX sun term draws it) */
  var SKY_FS = [
    COMMON,
    'varying vec2 vNdc;',
    'uniform vec3 uF; uniform vec3 uR; uniform vec3 uU;',
    'uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunColor;',
    'uniform vec3 uSilCol; uniform vec3 uCloudCol; uniform vec3 uLightsCol;',
    'uniform vec4 uSkyP;',   // x cloud cover, y studio, z night, w seed
    'uniform vec4 uSkyP2;',  // x silhouette strength, y city lights, z haze, w output clamp (0 = none)
    'float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }',
    'vec3 studioSky(vec3 d) {',
    '  float y = d.y; float az = atan(d.z, d.x);',
    '  vec3 col = mix(uGround, uHorizon, smoothstep(-0.30, 0.0, y));',
    '  col = mix(col, uZenith, smoothstep(0.0, 0.45, y));',
    '  col += uHorizon * 0.9 * exp(-abs(y) * 45.0);',                                  // cyclorama horizon glow
    '  if (y > 0.25) {',                                                                  // overhead softbox (2 x 1 panels)
    '    vec2 p = d.xz / y;',
    '    float b = (1.0 - smoothstep(0.26, 0.29, abs(p.y))) * (1.0 - smoothstep(0.62, 0.66, abs(p.x)));',
    '    float seam = 1.0 - (1.0 - smoothstep(0.0, 0.015, abs(p.x))) * 0.85;',
    '    col += uLightsCol * b * seam;',
    '  }',
    '  float side = (1.0 - smoothstep(0.07, 0.10, abs(abs(az) - 1.5708))) * smoothstep(0.04, 0.08, y) * (1.0 - smoothstep(0.52, 0.58, y));',
    '  col += uLightsCol * 0.6 * side;',                                                  // side strip lights
    '  float fill = (1.0 - smoothstep(0.25, 0.3, abs(az - 0.6))) * smoothstep(0.1, 0.14, y) * (1.0 - smoothstep(0.32, 0.36, y));',
    '  col += uLightsCol * 0.25 * fill;',                                                 // front-quarter key fill
    '  return col;',
    '}',
    'vec3 outdoorSky(vec3 d) {',
    '  float y = d.y; float az = atan(d.z, d.x);',
    '  vec3 sky = mix(uHorizon, uZenith, pow(saturate(y), 0.45));',
    '  sky = mix(sky, uHorizon * 1.06, exp(-max(y, 0.0) * 16.0) * uSkyP2.z);',
    '  float sd = max(dot(d, uSunDir), 0.0);',
    '  float day = 1.0 - uSkyP.z;',
    '  sky += uSunColor * (pow(sd, 6.0) * 0.16 + pow(sd, 48.0) * 0.5 + pow(sd, 400.0) * 1.6) * day;',
    '  if (y > 0.0 && uSkyP.x > 0.01) {',
    '    vec2 p = d.xz / (y + 0.12) * 1.3 + vec2(uSkyP.w * 7.0, uSkyP.w * 3.0);',
    '    float n = fbm(p);',
    '    float m = smoothstep(1.0 - uSkyP.x - 0.12, 1.0 - uSkyP.x + 0.38, n) * smoothstep(0.0, 0.10, y);',
    '    vec3 cc = uCloudCol * (0.8 + 0.6 * pow(sd, 3.0) * day) * (0.85 + 0.3 * fbm(p * 2.7));',
    '    sky = mix(sky, cc, m * 0.92);',
    '  }',
    '  if (uSkyP.z > 0.01 && y > 0.04) { float h = hash13(floor(d * 180.0)); sky += vec3(0.55, 0.6, 0.75) * step(0.9972, h) * uSkyP.z * 0.6 * saturate(y * 3.0); }',
    '  vec3 gnd = mix(uHorizon * 0.5 + uGround * 0.5, uGround, pow(saturate(-y * 5.0), 0.5));',
    '  vec3 col = y >= 0.0 ? sky : gnd;',
    // trackside skyline: trees / stands / buildings with a crisp top edge (the classic horizon line on paint)
    '  float h = 0.018 + 0.05 * vnoise(vec2(az * 6.0 + uSkyP.w * 13.0, 1.7)) + 0.03 * vnoise(vec2(az * 23.0, 5.3)) + 0.012 * vnoise(vec2(az * 90.0, 2.1));',
    '  float band = (1.0 - smoothstep(h - 0.003, h + 0.003, y)) * smoothstep(-0.04, -0.01, y);',
    '  col = mix(col, uSilCol, band * uSkyP2.x);',
    '  if (uSkyP2.y > 0.0) {',
    '    vec2 cell = vec2(floor(az * 110.0), floor(y * 380.0));',
    '    float lv = step(0.955, hash12(cell)) * band;',
    '    col += uLightsCol * lv * uSkyP2.y * (0.5 + hash12(cell + 7.0));',
    '  }',
    '  return col;',
    '}',
    'void main() {',
    '  vec3 d = normalize(uF + vNdc.x * uR + vNdc.y * uU);',
    '  vec3 c = uSkyP.y > 0.5 ? studioSky(d) : outdoorSky(d);',
    '  c = max(c, vec3(0.0));',
    '  if (uSkyP2.w > 0.0) c = min(c, vec3(uSkyP2.w));',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  /* GGX prefilter (WebGL2 only: textureLod + uint bit ops), filtered importance sampling */
  var PREFILTER_FS = [
    'varying vec2 vNdc;',
    'uniform samplerCube uSrc;',
    'uniform vec3 uF; uniform vec3 uR; uniform vec3 uU;',
    'uniform float uRough; uniform float uSrcSize; uniform float uSrcMaxLod; uniform int uSamples;',
    'const float PI = 3.14159265359;',
    'float radicalInverse(uint b) { b = (b << 16u) | (b >> 16u); b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);',
    '  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u); b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);',
    '  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u); return float(b) * 2.3283064365386963e-10; }',
    'void main() {',
    '  vec3 N = normalize(uF + vNdc.x * uR + vNdc.y * uU);',
    '  if (uRough < 0.002) { gl_FragColor = vec4(textureLod(uSrc, N, 0.0).rgb, 1.0); return; }',
    '  float a = uRough * uRough; float a2 = a * a;',
    '  vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);',
    '  vec3 T = normalize(cross(up, N)); vec3 B = cross(N, T);',
    '  float saTexel = 4.0 * PI / (6.0 * uSrcSize * uSrcSize);',
    '  vec3 sum = vec3(0.0); float wsum = 0.0;',
    '  for (int i = 0; i < 64; i++) {',
    '    if (i >= uSamples) break;',
    '    vec2 Xi = vec2(float(i) / float(uSamples), radicalInverse(uint(i)));',
    '    float phi = 2.0 * PI * Xi.x;',
    '    float cosT = sqrt((1.0 - Xi.y) / (1.0 + (a2 - 1.0) * Xi.y));',
    '    float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));',
    '    vec3 H = T * (sinT * cos(phi)) + B * (sinT * sin(phi)) + N * cosT;',
    '    vec3 L = 2.0 * dot(N, H) * H - N;',
    '    float NoL = dot(N, L);',
    '    if (NoL <= 0.0) continue;',
    '    float f = (cosT * a2 - cosT) * cosT + 1.0;',
    '    float D = a2 / (PI * f * f);',
    '    float pdf = D * 0.25;',                     // V = N  ->  pdf(L) = D * NoH / (4 VoH) = D / 4
    '    float saSample = 1.0 / (float(uSamples) * pdf + 1e-5);',
    '    float lod = clamp(0.5 * log2(saSample / saTexel) + 1.0, 0.0, uSrcMaxLod);',
    '    sum += textureLod(uSrc, L, lod).rgb * NoL;',
    '    wsum += NoL;',
    '  }',
    '  gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);',
    '}'
  ].join('\n');

  /* 6 x (T x T) tile render of the cube for SH projection; Reinhard-encoded into RGBA8 */
  var TILE_FS = [
    'uniform samplerCube uSrc; uniform float uTile; uniform float uLod;',
    'uniform vec3 uFF[6]; uniform vec3 uFR[6]; uniform vec3 uFU[6];',
    'void main() {',
    '  float fi = floor(gl_FragCoord.x / uTile);',
    '  float x = (gl_FragCoord.x - fi * uTile) / uTile * 2.0 - 1.0;',
    '  float y = gl_FragCoord.y / uTile * 2.0 - 1.0;',
    '  vec3 F = uFF[0], R = uFR[0], U = uFU[0];',
    '  for (int i = 1; i < 6; i++) { if (float(i) == fi) { F = uFF[i]; R = uFR[i]; U = uFU[i]; } }',
    '  vec3 d = normalize(F + x * R + y * U);',
    '#ifdef WEBGL2',
    '  vec3 c = textureLod(uSrc, d, uLod).rgb;',
    '#else',
    '  vec3 c = textureCube(uSrc, d).rgb;',
    '#endif',
    '  c = max(c, vec3(0.0));',
    '  gl_FragColor = vec4(c / (1.0 + c), 1.0);',
    '}'
  ].join('\n');

  /* Consumer chunk: include once in a fragment shader (needs nothing else; define-guarded). */
  var GLSL = [
    '#ifndef FORGE_ENVMAP',
    '#define FORGE_ENVMAP 1',
    'uniform samplerCube uEnvCube;',
    'uniform float uUseEnvCube;',          // 1 when a probe is bound (0 -> keep the procedural envColor path)
    'uniform vec4 uEnvLod;',               // x maxLod, y mode (0 prefiltered, 1 box chain), z log2(size), w unused
    'uniform vec3 uEnvSH[9];',             // cosine-convolved / PI: envSH(n) = average incident radiance around n
    'uniform float uEnvScale;',
    'float envLodFor(float rough) {',
    '  rough = clamp(rough, 0.0, 1.0);',
    '  if (uEnvLod.y < 0.5) return sqrt(rough) * uEnvLod.x;',
    '  float a = max(rough * rough, 1e-4);',
    '  return clamp(log2(a * exp2(uEnvLod.z) * 1.3), 0.0, uEnvLod.x);',
    '}',
    'vec3 envCubeSpec(vec3 R, float rough) {',
    '  float lod = envLodFor(rough);',
    '#ifdef WEBGL2',
    '  return textureLod(uEnvCube, R, lod).rgb * uEnvScale;',
    '#else',
    '  return textureCube(uEnvCube, R, lod).rgb * uEnvScale;',   // WebGL1: lod as bias (no shader_texture_lod)
    '#endif',
    '}',
    'vec3 envSH(vec3 n) {',
    '  float x = n.x, y = n.y, z = n.z;',
    '  vec3 c = uEnvSH[0] * 0.282095',
    '    + uEnvSH[1] * (0.488603 * y) + uEnvSH[2] * (0.488603 * z) + uEnvSH[3] * (0.488603 * x)',
    '    + uEnvSH[4] * (1.092548 * x * y) + uEnvSH[5] * (1.092548 * y * z) + uEnvSH[6] * (0.315392 * (3.0 * z * z - 1.0))',
    '    + uEnvSH[7] * (1.092548 * x * z) + uEnvSH[8] * (0.546274 * (x * x - y * y));',
    '  return max(c, vec3(0.0)) * uEnvScale;',
    '}',
    '#endif'
  ].join('\n');

  /* ======================================================================
     create
     ====================================================================== */
  function create(ctxIn, opts) {
    var G = CB.gl;
    var ctx = G.toContext ? G.toContext(ctxIn) : ctxIn;
    if (!ctx || !ctx.gl) throw new Error('CB.gl.envmap.create: no WebGL context');
    var gl = ctx.gl;
    opts = opts || {};
    var gl2 = !!ctx.isWebGL2;
    var P = {
      ctx: ctx, gen: -1, warned: {}, quality: normQuality(opts.quality), cfg: null, opts: opts,
      sky: preset(opts.timeOfDay, opts.weather, opts.lighting, opts.studio), studio: !!opts.studio,
      progs: null, hdr: false, fmt: null,
      stat: null, dyn: null, tile: null, fbo: null, depthRb: null, depthSize: 0,
      sh: new Float32Array(27), shTarget: new Float32Array(27), shHave: false, shPending: null, cycles: 0,
      phase: -1, lastStart: -1e9, pos: [0, 0, 0], sel: [], faceList: [], frame: 0, valid: false,
      cam: makeCam(), env: null, envBase: null, destroyed: false,
      st: { captures: 0, faces: 0, items: 0, lastCycleMs: 0, shReads: 0 }
    };
    P.cfg = config(P.quality, opts);
    var sphereCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

    function makeCam() {
      var m4 = CB.gl.mat4;
      var c = { view: m4.create(), proj: m4.create(), viewProj: m4.create(), invView: m4.create(), position: [0, 0, 0], viewport: [0, 0, 1, 1], envmap: true };
      c.viewMatrix = c.view; c.projMatrix = c.proj; c.projection = c.proj; c.viewProjection = c.viewProj;
      c.uView = c.view; c.uProj = c.proj; c.uCamPos = c.position; c.pos = c.eye = c.position;
      return c;
    }

    /* ---------------- resources */
    function program(name, fs) {
      return G.createProgram(ctx, FS_VS, fs, { name: 'envmap-' + name });
    }
    function chooseFormat() {
      if (opts.hdr === false) return ldrFormat();
      if (gl2) {
        var ext = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
        if (ext) return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, hdr: true };
      }
      return ldrFormat();
    }
    function ldrFormat() { return { internal: gl2 ? gl.RGBA8 : gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, hdr: false }; }

    function makeCube(size, levels, fmt) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
      if (gl2) gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, fmt.internal, size, size);
      else for (var f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, fmt.internal, size, size, 0, fmt.format, fmt.type, null);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, levels > 1 || !gl2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (gl2) gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, levels - 1);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
      return t;
    }
    /** A capture chain: cap (full mip chain, render target) + out (prefiltered on WebGL2 / ping-pong on WebGL1). */
    function makeChain(size, fmt, single) {
      var capLevels = log2i(size) + 1;
      var outLevels = gl2 ? Math.max(1, log2i(size) - 2) : capLevels;   // WebGL2: down to 8x8 (rough 1)
      var ch = { size: size, fmt: fmt, capLevels: capLevels, outLevels: outLevels, cap: null, out: null, tex: null, filled: false };
      ch.cap = makeCube(size, capLevels, fmt);
      if (gl2 || !single) ch.out = makeCube(size, gl2 ? outLevels : capLevels, fmt);
      ch.mode = gl2 ? 'prefiltered' : 'box';
      ch.maxLod = gl2 ? outLevels - 1 : capLevels - 1;
      return ch;
    }
    function freeChain(ch) {
      if (!ch || gl.isContextLost()) return;
      if (ch.cap) gl.deleteTexture(ch.cap);
      if (ch.out) gl.deleteTexture(ch.out);
      ch.cap = ch.out = ch.tex = null;
    }
    function ensureDepth(size) {
      if (P.depthRb && P.depthSize === size) return;
      if (!P.depthRb) P.depthRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, P.depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16, size, size);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      P.depthSize = size;
    }
    function attachFace(tex, face, level, withDepth) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, P.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, tex, level);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, withDepth ? P.depthRb : null);
    }
    function ensureTile() {
      if (P.tile) return P.tile;
      var T = 8, W = T * 6;
      var t = { T: T, W: W, tex: gl.createTexture(), fbo: gl.createFramebuffer(), u8: new Uint8Array(W * T * 4), pbo: null };
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, T, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      if (gl2) {
        t.pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, t.pbo);
        // STREAM_COPY, not STREAM_READ: Chrome shadows READ-usage buffers and logs a 'READ-usage buffer was written, then
        // fenced, but written again' performance warning on every probe refresh (then 'WebGL: too many errors'). The read
        // only happens after the fence signals, so a plain mapped read is cheap.
        gl.bufferData(gl.PIXEL_PACK_BUFFER, t.u8.byteLength, gl.STREAM_COPY);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      }
      return (P.tile = t);
    }

    function build() {
      P.gen = ctx.generation;
      P.progs = { sky: program('sky', SKY_FS), tile: program('tile', TILE_FS), prefilter: gl2 ? program('prefilter', PREFILTER_FS) : null };
      P.fbo = gl.createFramebuffer();
      P.depthRb = null; P.depthSize = 0; P.tile = null; P.shPending = null; P.dyn = null; P.stat = null;
      P.fmt = chooseFormat();
      // verify the format is renderable as a cube face; else drop to RGBA8
      var test = makeCube(16, 1, P.fmt);
      attachFace(test, 0, 0, false);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(test);
      if (!ok && P.fmt.hdr) P.fmt = ldrFormat();
      P.hdr = P.fmt.hdr;
      buildStatic();
      P.phase = -1; P.lastStart = -1e9; P.valid = false;
    }
    function ensure() {
      if (P.destroyed || ctx.lost || gl.isContextLost()) return false;
      if (P.gen !== ctx.generation) {
        try { build(); }
        catch (e) { warnOnce(P, 'build failed', e); P.gen = ctx.generation; P.progs = null; return false; }
      }
      return !!P.progs;
    }

    /* ---------------- GL state save / restore */
    var saved = { fb: null, vp: null };
    function saveState() {
      saved.fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      saved.vp = gl.getParameter(gl.VIEWPORT);
      if (ctx.bindVAO && ctx.ext && ctx.ext.vao) ctx.bindVAO(null);
    }
    function restoreState() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved.fb || null);
      if (saved.vp) gl.viewport(saved.vp[0], saved.vp[1], saved.vp[2], saved.vp[3]);
      gl.activeTexture(gl.TEXTURE0);
      gl.depthMask(true); gl.colorMask(true, true, true, true);
      gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      saved.fb = null;
    }
    function fsState() {
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
      gl.depthMask(false); gl.colorMask(true, true, true, true);
    }

    /* ---------------- sky (procedural) */
    function setSkyUniforms(u, sky, clampMax) {
      gl.uniform3fv(u.uZenith, sky.zenith); gl.uniform3fv(u.uHorizon, sky.horizon); gl.uniform3fv(u.uGround, sky.ground);
      gl.uniform3fv(u.uSunDir, sky.sunDir); gl.uniform3fv(u.uSunColor, sky.sunColor);
      gl.uniform3fv(u.uSilCol, sky.silColor); gl.uniform3fv(u.uCloudCol, sky.cloudColor); gl.uniform3fv(u.uLightsCol, sky.lights);
      gl.uniform4f(u.uSkyP, sky.cloud, sky.studio, sky.night, sky.seed);
      gl.uniform4f(u.uSkyP2, sky.sil, sky.city, sky.haze, clampMax || 0);
    }
    function drawSkyFace(face) {
      var pr = P.progs.sky, f = FACES[face];
      G.drawFullscreen(ctx, pr, function (u) {
        setSkyUniforms(u, P.sky, P.hdr ? 0 : 1);
        gl.uniform3fv(u.uF, f.F); gl.uniform3fv(u.uR, f.R); gl.uniform3fv(u.uU, f.U);
      });
    }

    /* ---------------- finish a capture: mips + prefilter (or swap), SH */
    function finishChain(ch, swap) {
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, ch.cap);
      gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
      var shSrc = ch.cap;
      if (gl2 && P.progs.prefilter) {
        var pr = P.progs.prefilter;
        fsState();
        for (var m = 0; m < ch.outLevels; m++) {
          var s = ch.size >> m, rough = ch.outLevels > 1 ? m / (ch.outLevels - 1) : 0;
          rough *= rough;   // squared: low mips get the glossy range (lookup lod = sqrt(rough) * maxLod)
          for (var f = 0; f < 6; f++) {
            attachFace(ch.out, f, m, false);
            gl.viewport(0, 0, s, s);
            (function (face, r) {
              G.drawFullscreen(ctx, pr, function (u) {
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_CUBE_MAP, ch.cap);
                if (u.uSrc) gl.uniform1i(u.uSrc, 0);
                gl.uniform3fv(u.uF, FACES[face].F); gl.uniform3fv(u.uR, FACES[face].R); gl.uniform3fv(u.uU, FACES[face].U);
                gl.uniform1f(u.uRough, r); gl.uniform1f(u.uSrcSize, ch.size); gl.uniform1f(u.uSrcMaxLod, ch.capLevels - 1);
                gl.uniform1i(u.uSamples, r < 0.002 ? 1 : P.cfg.samples);
              });
            })(f, rough);
          }
        }
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
        ch.tex = ch.out;
      } else if (swap && ch.out) {
        var t = ch.out; ch.out = ch.cap; ch.cap = t;   // finished capture becomes the served texture
        ch.tex = ch.out; shSrc = ch.tex;
      } else {
        ch.tex = ch.cap;
      }
      ch.filled = true;
      return shSrc;
    }
    function renderTiles(src, srcSize) {
      var t = ensureTile(), pr = P.progs.tile;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, t.W, t.T);
      fsState();
      G.drawFullscreen(ctx, pr, function (u) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_CUBE_MAP, src);
        if (u.uSrc) gl.uniform1i(u.uSrc, 0);
        gl.uniform1f(u.uTile, t.T); gl.uniform1f(u.uLod, Math.max(0, log2i(srcSize) - log2i(t.T)));
        gl.uniform3fv(u.uFF, FACE_F); gl.uniform3fv(u.uFR, FACE_R); gl.uniform3fv(u.uFU, FACE_U);
      });
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
      return t;
    }
    function shSync(src, srcSize) {
      var t = renderTiles(src, srcSize);
      gl.readPixels(0, 0, t.W, t.T, gl.RGBA, gl.UNSIGNED_BYTE, t.u8);
      shFromTiles(t.u8, t.T, P.shTarget);
      P.st.shReads++;
      return true;
    }
    function shAsync(src, srcSize) {
      if (P.shPending) return false;
      if (!gl2) return shSync(src, srcSize);
      var t = renderTiles(src, srcSize);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, t.pbo);
      gl.readPixels(0, 0, t.W, t.T, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      P.shPending = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      return false;
    }
    function pollSH() {
      if (P.shPending && gl2) {
        var st = gl.getSyncParameter(P.shPending, gl.SYNC_STATUS);
        if (st === gl.SIGNALED) {
          var t = P.tile;
          gl.deleteSync(P.shPending); P.shPending = null;
          if (t && t.pbo) {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, t.pbo);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, t.u8);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            shFromTiles(t.u8, t.T, P.shTarget);
            P.st.shReads++;
          }
        }
      }
      // smooth SH changes (no lighting pops when the probe refreshes)
      var k = 0.2;
      for (var i = 0; i < 27; i++) P.sh[i] += (P.shTarget[i] - P.sh[i]) * k;
    }

    /* ---------------- static cube */
    function buildStatic() {
      var size = P.cfg.staticSize;
      if (P.stat && (P.stat.size !== size)) { freeChain(P.stat); P.stat = null; }
      if (!P.stat) P.stat = makeChain(size, P.fmt, true);
      saveState();
      try {
        fsState();
        for (var f = 0; f < 6; f++) {
          attachFace(P.stat.cap, f, 0, false);
          gl.viewport(0, 0, size, size);
          drawSkyFace(f);
        }
        var src = finishChain(P.stat, false);
        shSync(src, size);
        for (var i = 0; i < 27; i++) P.sh[i] = P.shTarget[i];
        P.shHave = true;
      } finally { restoreState(); }
    }

    /* ---------------- dynamic capture */
    function itemSphere(it) {
      var mesh = it.mesh, b = it.worldBounds || (mesh && mesh.bounds) || null;
      if (!b || !(b.center || b.min)) return null;
      var m = it.worldBounds ? null : it.model;
      var key = sphereCache ? sphereCache.get(it) : null;
      if (key && key.b === b && key.m === m && (!m || (key.x === m[12] && key.y === m[13] && key.z === m[14]))) return key.s;
      var c = b.center || [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      var r = num(b.radius, b.min ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 : 1);
      var s;
      if (m) {
        var sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
        s = [m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13],
          m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14], r * Math.max(sx, sy, sz)];
      } else s = [c[0], c[1], c[2], r];
      if (sphereCache) sphereCache.set(it, { b: b, m: m, x: m ? m[12] : 0, y: m ? m[13] : 0, z: m ? m[14] : 0, s: s });
      return s;
    }
    function selectItems(scene, pos) {
      var src = scene.items || [], sel = P.sel, range = P.cfg.range, ex = typeof scene.exclude === 'function' ? scene.exclude : null;
      sel.length = 0;
      for (var i = 0; i < src.length; i++) {
        var it = src[i];
        if (!it || it.visible === false || it.envSkip) continue;
        if (!it.envCapture) {
          if (!it.mesh || typeof it.draw === 'function') continue;                    // self-drawing (effects, cockpit)
          var mt = it.material;
          if (it.transparent || it.additive || (mt && (mt.transparent || mt.additive || mt.unlitAdditive))) continue;
        }
        if (ex && ex(it)) continue;
        var s = itemSphere(it), score;
        if (s) {
          var dx = s[0] - pos[0], dy = s[1] - pos[1], dz = s[2] - pos[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d - s[3] > range) continue;
          score = s[3] / Math.max(1, d - s[3] * 0.5);
        } else score = 1e9;
        sel.push({ it: it, s: s, score: score });
      }
      if (sel.length > P.cfg.maxItems) {
        sel.sort(function (a, b) { return b.score - a.score; });
        sel.length = P.cfg.maxItems;
      }
      return sel;
    }
    function ensureDyn() {
      var size = P.cfg.size;
      if (P.dyn && P.dyn.size === size) return P.dyn;
      if (P.dyn) freeChain(P.dyn);
      P.dyn = makeChain(size, P.fmt, false);
      P.valid = false;
      return P.dyn;
    }
    function captureFace(scene, face, ch) {
      var m4 = G.mat4, cam = P.cam, f = FACES[face], pos = P.pos;
      var tgt = [pos[0] + f.F[0], pos[1] + f.F[1], pos[2] + f.F[2]];
      m4.lookAt(cam.view, pos, tgt, f.up);
      m4.perspective(cam.proj, PI / 2, 1, num(opts.near, 0.1), P.cfg.range * 1.6 + 50);
      m4.multiply(cam.viewProj, cam.proj, cam.view);
      m4.invert(cam.invView, cam.view);
      cam.position[0] = pos[0]; cam.position[1] = pos[1]; cam.position[2] = pos[2];
      cam.target = tgt; cam.up = f.up; cam.forward = f.F; cam.fov = cam.fovY = PI / 2; cam.fovDeg = 90; cam.aspect = 1;
      cam.near = num(opts.near, 0.1); cam.far = P.cfg.range * 1.6 + 50; cam.width = cam.height = ch.size;
      cam.viewport[2] = cam.viewport[3] = ch.size;
      attachFace(ch.cap, face, 0, true);
      gl.viewport(0, 0, ch.size, ch.size);
      gl.disable(gl.SCISSOR_TEST);
      gl.depthMask(true); gl.colorMask(true, true, true, true);
      var cc = v3(scene.clearColor, P.sky.horizon);
      gl.clearColor(cc[0], cc[1], cc[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (typeof scene.drawSky === 'function') {
        try { scene.drawSky(cam); } catch (e) { warnOnce(P, 'scene.drawSky', e); }
      } else {
        fsState(); drawSkyFace(face);
      }
      var list = P.faceList, sel = P.sel;
      list.length = 0;
      for (var i = 0; i < sel.length; i++) {
        var e = sel[i], s = e.s;
        if (!s || sphereInFace(face, s[0] - pos[0], s[1] - pos[1], s[2] - pos[2], s[3])) list.push(e.it);
      }
      if (list.length) G.drawList(ctx, list, cam, P.env);
      P.st.faces++; P.st.items += list.length;
    }
    function cheapEnv(base) {
      if (P.envBase !== base || !P.env) {
        P.envBase = base;
        P.env = Object.create(base || {});
        P.env.linearOutput = true;
        P.env.useShadow = false; P.env.uUseShadow = 0; P.env.shadow = null; P.env.shadowMap = null; P.env.uShadowMap = null;
      }
      return P.env;
    }

    function update(scene, camPos, frame) {
      P.frame = typeof frame === 'number' && isFinite(frame) ? frame : P.frame + 1;
      if (!ensure()) return false;
      try { pollSH(); } catch (e) { warnOnce(P, 'sh poll', e); P.shPending = null; }
      if (!P.cfg.dynamic || !scene || !camPos || !(camPos.length >= 3)) return false;
      var t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      if (P.phase < 0) {
        var due = P.frame - P.lastStart >= P.cfg.interval;
        var jumped = P.valid && Math.hypot(camPos[0] - P.pos[0], camPos[1] - P.pos[1], camPos[2] - P.pos[2]) > 80;
        if (!due && !jumped && P.valid) return false;
        if (!due && !jumped && !P.valid && P.frame - P.lastStart < 1) return false;
        P.pos[0] = camPos[0]; P.pos[1] = camPos[1]; P.pos[2] = camPos[2];
        selectItems(scene, P.pos);
        P.phase = 0; P.lastStart = P.frame;
      }
      var ch;
      try { ch = ensureDyn(); } catch (e) { warnOnce(P, 'dynamic alloc', e); P.cfg.dynamic = false; return false; }
      cheapEnv(scene.env);
      saveState();
      var linSet = typeof scene.setLinearOutput === 'function';
      try {
        ensureDepth(ch.size);
        if (linSet) scene.setLinearOutput(true);
        var n = Math.min(P.cfg.facesPerFrame, 6 - P.phase);
        for (var i = 0; i < n; i++) captureFace(scene, P.phase + i, ch);
        P.phase += n;
        if (P.phase >= 6) {
          var src = finishChain(ch, true);
          P.phase = -1; P.valid = true; P.cycles++; P.st.captures++;
          P.texPos = P.texPos || [0, 0, 0]; P.texPos[0] = P.pos[0]; P.texPos[1] = P.pos[1]; P.texPos[2] = P.pos[2];
          P.sel.length = 0;
          var shN = gl2 ? P.cfg.shEvery : P.cfg.shEvery * 4;   // WebGL1 read-back is synchronous: rarer
          if (P.cfg.shEvery > 0 && (P.cycles - 1) % shN === 0) {
            try { shAsync(src, ch.size); } catch (e2) { warnOnce(P, 'sh readback', e2); }
          }
        }
      } catch (e) {
        warnOnce(P, 'capture failed (dynamic probe disabled)', e);
        P.cfg.dynamic = false; P.phase = -1; P.valid = false;
      } finally {
        if (linSet) { try { scene.setLinearOutput(scene.restoreLinear != null ? !!scene.restoreLinear : false); } catch (e3) { /* ignore */ } }
        restoreState();
      }
      var t1 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      P.st.lastCycleMs = t1 - t0;
      return true;
    }

    /* ---------------- binding */
    var rawLocs = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    function locsFor(program) {
      if (program && program.u && program.program) return { p: program.program, u: program.u, U: program.uniforms || {} };
      if (!program || !rawLocs) return null;
      var c = rawLocs.get(program);
      if (!c) {
        var gu = function (n) { return gl.getUniformLocation(program, n); };
        c = { p: program, u: { uEnvCube: gu('uEnvCube'), uUseEnvCube: gu('uUseEnvCube'), uEnvLod: gu('uEnvLod'), uEnvSH: gu('uEnvSH[0]') || gu('uEnvSH'), uEnvScale: gu('uEnvScale') }, U: {} };
        rawLocs.set(program, c);
      }
      return c;
    }
    function current() {
      if (P.valid && P.dyn && P.dyn.filled && P.cfg.dynamic) return P.dyn;
      return P.stat && P.stat.filled ? P.stat : null;
    }
    function bind(program, unitBase) {
      if (!ensure()) return false;
      var L = locsFor(program);
      if (!L || !L.u.uEnvCube) return false;
      var ch = current();
      var unit = typeof unitBase === 'number' ? unitBase : (L.U.uEnvCube && L.U.uEnvCube.unit != null ? L.U.uEnvCube.unit : SAMPLER_UNIT);
      gl.useProgram(L.p);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, ch ? ch.tex : null);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(L.u.uEnvCube, unit);
      if (L.U.uEnvCube) L.U.uEnvCube.unit = unit;
      if (L.u.uUseEnvCube) gl.uniform1f(L.u.uUseEnvCube, ch ? 1 : 0);
      if (L.u.uEnvLod && ch) gl.uniform4f(L.u.uEnvLod, ch.maxLod, ch.mode === 'box' ? 1 : 0, log2i(ch.size), 0);
      if (L.u.uEnvSH) gl.uniform3fv(L.u.uEnvSH, P.sh);
      if (L.u.uEnvScale) gl.uniform1f(L.u.uEnvScale, num(opts.intensity, 1));
      return !!ch;
    }
    function bindPrograms(list, unit) {
      var n = 0;
      if (!list) return 0;
      for (var i = 0; i < list.length; i++) if (list[i] && bind(list[i], unit)) n++;
      return n;
    }

    /* ---------------- control */
    function setQuality(q) {
      var nq = normQuality(q);
      var prev = P.cfg;
      P.quality = nq;
      P.cfg = config(nq, { size: opts.size, staticSize: opts.staticSize, interval: opts.interval, facesPerFrame: opts.facesPerFrame, samples: opts.samples, range: opts.range, maxItems: opts.maxItems, dynamic: opts.dynamic });
      P.phase = -1; P.sel.length = 0;
      if (!P.cfg.dynamic && P.dyn && P.gen === ctx.generation) { freeChain(P.dyn); P.dyn = null; P.valid = false; }
      if (P.progs && P.gen === ctx.generation && prev && prev.staticSize !== P.cfg.staticSize) {
        try { buildStatic(); } catch (e) { warnOnce(P, 'static rebuild', e); }
      }
      return nq;
    }
    function setSky(timeOfDay, weather, lighting, studio) {
      if (typeof studio === 'boolean') P.studio = studio;
      var sky = preset(timeOfDay, weather, lighting, P.studio);
      if (P.sky && sky.key === P.sky.key && P.stat && P.stat.filled) return false;
      P.sky = sky;
      if (P.progs && P.gen === ctx.generation && !gl.isContextLost()) {
        try { buildStatic(); } catch (e) { warnOnce(P, 'static rebuild', e); }
      }
      invalidate();
      return true;
    }
    function invalidate() { P.lastStart = -1e9; P.phase = -1; P.sel.length = 0; P.valid = false; }
    function destroy() {
      if (P.destroyed) return;
      P.destroyed = true;
      if (P.gen === ctx.generation && !gl.isContextLost()) {
        freeChain(P.stat); freeChain(P.dyn);
        if (P.fbo) gl.deleteFramebuffer(P.fbo);
        if (P.depthRb) gl.deleteRenderbuffer(P.depthRb);
        if (P.tile) { gl.deleteTexture(P.tile.tex); gl.deleteFramebuffer(P.tile.fbo); if (P.tile.pbo) gl.deleteBuffer(P.tile.pbo); }
        if (P.shPending) gl.deleteSync(P.shPending);
        if (P.progs) for (var k in P.progs) if (P.progs[k] && P.progs[k].destroy) P.progs[k].destroy();
      }
      P.stat = P.dyn = P.tile = P.progs = null; P.fbo = P.depthRb = null; P.shPending = null; P.sel.length = 0;
    }

    var probe = {
      update: update, bind: bind, bindPrograms: bindPrograms, setQuality: setQuality, setSky: setSky,
      invalidate: invalidate, destroy: destroy,
      stats: function () {
        var ch = current();
        return { quality: P.quality, dynamic: !!P.cfg.dynamic, valid: P.valid, size: ch ? ch.size : 0, hdr: P.hdr, mode: ch ? ch.mode : null,
          captures: P.st.captures, faces: P.st.faces, itemsDrawn: P.st.items, lastMs: P.st.lastCycleMs, shReads: P.st.shReads, phase: P.phase };
      },
      _state: P
    };
    Object.defineProperty(probe, 'texture', { enumerable: true, get: function () { var ch = current(); return ch ? ch.tex : null; } });
    Object.defineProperty(probe, 'sh', { enumerable: true, get: function () { return P.sh; } });
    Object.defineProperty(probe, 'maxLod', { enumerable: true, get: function () { var ch = current(); return ch ? ch.maxLod : 0; } });
    Object.defineProperty(probe, 'size', { enumerable: true, get: function () { var ch = current(); return ch ? ch.size : 0; } });
    Object.defineProperty(probe, 'mode', { enumerable: true, get: function () { var ch = current(); return ch ? ch.mode : null; } });
    Object.defineProperty(probe, 'hdr', { enumerable: true, get: function () { return P.hdr; } });
    // where the cube currently bound was captured (dynamic probe only; null for the static sky probe)
    Object.defineProperty(probe, 'capturePos', { enumerable: true, get: function () { return current() === P.dyn && P.texPos ? P.texPos : null; } });
    Object.defineProperty(probe, 'valid', { enumerable: true, get: function () { return !!(P.valid && P.cfg.dynamic); } });
    Object.defineProperty(probe, 'quality', { enumerable: true, get: function () { return P.quality; } });

    ensure();
    return probe;
  }

  var envmap = {
    create: create,
    preset: preset,
    GLSL: GLSL,
    QUALITY: QUALITY,
    SAMPLER_UNIT: SAMPLER_UNIT,
    _: {
      FACES: FACES, faceDir: faceDir, sphereInFace: sphereInFace, shBasis: shBasis, shProject: shProject, shFromTiles: shFromTiles,
      shEval: shEval, lodForRoughness: lodForRoughness, config: config, normQuality: normQuality,
      shaders: { FS_VS: FS_VS, SKY_FS: SKY_FS, PREFILTER_FS: PREFILTER_FS, TILE_FS: TILE_FS }
    }
  };
  CB.gl.envmap = envmap;
  if (typeof module !== 'undefined' && module.exports) module.exports = envmap;
})();

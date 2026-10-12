/* FORGE Atelier — 3D race effects (CB.gl.effects)
 *
 *  - GPU particle system: one interleaved ring buffer of point sprites. The CPU only writes the
 *    spawn record of each new particle (bufferSubData of the dirty ring range); the vertex shader
 *    evaluates the closed-form trajectory (drag toward wind + gravity/buoyancy, ground bounce),
 *    size over life, alpha over life, fog and lighting. Kinds: smoke, dust, spray mist, sparks
 *    (velocity-stretched capsule streaks, additive), debris, droplets (streaks), exhaust flames.
 *    Premultiplied alpha lets additive and alpha-blended particles share one draw call.
 *  - Skid marks: per-wheel ribbons in a persistent ring buffer (quads, static index buffer),
 *    procedural tread pattern, fade by age and before ring overwrite.
 *  - Rain: camera-anchored, world-wrapped streak quads (slant from camera motion), ground splashes.
 *  - Sky: full-screen triangle at the far plane (early-z friendly): gradient per timeOfDay, sun disc
 *    + Mie halo, procedural fbm clouds with self-shadowing, overcast for wet, stars, milky way, moon.
 *  - getLighting(timeOfDay, weather): sunDir/sunColor/ambient/fog/env colors for every other shader.
 *
 *  Pure (DOM/GL free) helpers are exported through CB.gl.effects._internal for Node tests.
 *  World axes per RACE3D-SPEC: sim (x, y) -> GL (x, 0, -y), up = +Y.
 */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.gl = CB.gl || {};

  /* ------------------------------------------------------------------ utils */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function norm3(a) {
    var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }
  function grey(c) { var g = c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15; return [g, g, g]; }
  function desat(c, t) { return mix3(c, grey(c), t); }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* --------------------------------------------------------------- quality */
  var QUALITY = {
    low:    { maxParticles: 1200, skidSegments: 1500,  rainDrops: 700,  emitScale: 0.4,  cloudOctaves: 3, cloudShadow: false, maxPointPx: 64,  skidFade: 45,  emitRadius: 120, splashRate: 0,   softBudget: 300 },
    medium: { maxParticles: 2500, skidSegments: 3000,  rainDrops: 1500, emitScale: 0.65, cloudOctaves: 4, cloudShadow: false, maxPointPx: 140, skidFade: 70,  emitRadius: 170, splashRate: 40,  softBudget: 700 },
    high:   { maxParticles: 5000, skidSegments: 6000,  rainDrops: 3000, emitScale: 1.0,  cloudOctaves: 5, cloudShadow: true,  maxPointPx: 224, skidFade: 100, emitRadius: 240, splashRate: 90,  softBudget: 1300 },
    ultra:  { maxParticles: 9000, skidSegments: 10000, rainDrops: 5000, emitScale: 1.3,  cloudOctaves: 6, cloudShadow: true,  maxPointPx: 300, skidFade: 140, emitRadius: 320, splashRate: 160, softBudget: 2200 }
  };
  function qualityCaps(q) { return QUALITY[q] || QUALITY.high; }

  /* -------------------------------------------------------------- lighting */
  var BASE = {
    day: {
      sunDir: norm3([-0.42, 0.78, -0.46]), sunColor: [1.34, 1.22, 1.02], sunIntensity: 1.0, sunSize: 0.02,
      moonDir: norm3([0.5, 0.35, 0.8]), moonVisible: 0,
      ambientSky: [0.45, 0.53, 0.66], ambientGround: [0.25, 0.24, 0.16],
      fogColor: [0.70, 0.78, 0.88], fogDensity: 0.00088,
      envTop: [0.30, 0.50, 0.84], envHorizon: [0.80, 0.86, 0.93], envBottom: [0.26, 0.25, 0.22],
      skyZenith: [0.16, 0.36, 0.70], skyBand: [0.36, 0.56, 0.84], skyHorizon: [0.68, 0.80, 0.93], skyGround: [0.40, 0.40, 0.38],
      sunGlow: [1.0, 0.92, 0.75], glowAmount: 0.25,
      cloudCover: 0.38, cloudColor: [1.0, 0.99, 0.97], cloudShade: [0.60, 0.65, 0.74],
      stars: 0, lightPollution: [0, 0, 0], exposure: 1.0, shadowStrength: 1.0,
      headlights: false, streetLights: false, bloom: 0.35
    },
    dusk: {
      sunDir: norm3([0.82, 0.12, -0.55]), sunColor: [1.52, 0.76, 0.36], sunIntensity: 0.85, sunSize: 0.028,
      moonDir: norm3([-0.55, 0.30, 0.78]), moonVisible: 0.35,
      ambientSky: [0.42, 0.36, 0.50], ambientGround: [0.22, 0.15, 0.11],
      fogColor: [0.66, 0.47, 0.42], fogDensity: 0.00125,
      envTop: [0.18, 0.22, 0.44], envHorizon: [0.98, 0.58, 0.36], envBottom: [0.16, 0.12, 0.12],
      skyZenith: [0.12, 0.13, 0.33], skyBand: [0.50, 0.30, 0.50], skyHorizon: [0.98, 0.56, 0.32], skyGround: [0.30, 0.20, 0.20],
      sunGlow: [1.0, 0.42, 0.16], glowAmount: 0.9,
      cloudCover: 0.46, cloudColor: [1.0, 0.62, 0.44], cloudShade: [0.36, 0.24, 0.34],
      stars: 0.18, lightPollution: [0.05, 0.03, 0.02], exposure: 1.05, shadowStrength: 0.72,
      headlights: true, streetLights: true, bloom: 0.5
    },
    night: {
      sunDir: norm3([0.3, 0.62, 0.42]), sunColor: [0.16, 0.19, 0.28], sunIntensity: 0.15, sunSize: 0.0,
      moonDir: norm3([0.3, 0.62, 0.42]), moonVisible: 1,
      ambientSky: [0.10, 0.12, 0.20], ambientGround: [0.05, 0.05, 0.06],
      fogColor: [0.035, 0.045, 0.075], fogDensity: 0.0015,
      envTop: [0.01, 0.015, 0.04], envHorizon: [0.08, 0.09, 0.14], envBottom: [0.02, 0.02, 0.025],
      skyZenith: [0.008, 0.012, 0.035], skyBand: [0.02, 0.03, 0.07], skyHorizon: [0.07, 0.08, 0.14], skyGround: [0.04, 0.04, 0.05],
      sunGlow: [0.4, 0.45, 0.6], glowAmount: 0.15,
      cloudCover: 0.28, cloudColor: [0.20, 0.22, 0.28], cloudShade: [0.05, 0.055, 0.075],
      stars: 1, lightPollution: [0.14, 0.09, 0.06], exposure: 1.2, shadowStrength: 0.45,
      headlights: true, streetLights: true, bloom: 0.75
    }
  };
  var WEATHER = {
    dry:  { cloudAdd: 0, sunMul: 1, fogMul: 1, desat: 0, wetness: 0, rain: 0, overcast: 0, wind: 1.8, greyMix: 0, envMix: 0, ambMul: 1 },
    damp: { cloudAdd: 0.32, sunMul: 0.75, fogMul: 1.6, desat: 0.25, wetness: 0.45, rain: 0, overcast: 0.35, wind: 2.8, greyMix: 0.4, envMix: 0.35, ambMul: 1 },
    wet:  { cloudAdd: 0.6, sunMul: 0.45, fogMul: 2.6, desat: 0.7, wetness: 1, rain: 1, overcast: 1, wind: 5.5, greyMix: 0.75, envMix: 0.7, ambMul: 1.05 }
  };
  var LIGHT_CACHE = {};

  function normTod(t) { return t === 'dusk' || t === 'night' ? t : 'day'; }
  function normWeather(w) { return w === 'damp' || w === 'wet' ? w : 'dry'; }

  /* The core lighting keys (sunDir, sunColor, ambient*, fog*, env*, wetness, headlights) reproduce
     renderer3d's own lightingFor() table exactly, so the sky dome's sun disc, horizon haze and fog colour
     match the shading/shadows of every other shader whether or not renderer3d consumes getLighting(). */
  function computeLighting(tod, weather) {
    var b = BASE[tod], w = WEATHER[weather];
    var oc = w.overcast;
    var overcastGrey = tod === 'night' ? [0.06, 0.065, 0.08] : tod === 'dusk' ? [0.45, 0.4, 0.42] : [0.6, 0.64, 0.68];
    var L = {
      timeOfDay: tod, weather: weather,
      sunDir: b.sunDir.slice(), moonDir: b.moonDir.slice(),
      sunIntensity: b.sunIntensity * w.sunMul,
      sunSize: b.sunSize,
      sunVisible: b.sunSize > 0 ? clamp01(1 - oc * 1.15) : 0,
      moonVisible: b.moonVisible * clamp01(1 - oc * 1.1),
      sunColor: scale3(b.sunColor, w.sunMul),
      ambientSky: scale3(b.ambientSky, w.ambMul),
      ambientGround: b.ambientGround.slice(),
      fogColor: mix3(b.fogColor, overcastGrey, w.greyMix),
      fogDensity: b.fogDensity * w.fogMul,
      envTop: mix3(b.envTop, scale3(overcastGrey, 0.8), w.envMix),
      envHorizon: mix3(b.envHorizon, overcastGrey, w.envMix),
      envBottom: b.envBottom.slice(),
      skyZenith: mix3(b.skyZenith, scale3(overcastGrey, 0.78), oc * 0.9),
      skyBand: mix3(b.skyBand, scale3(overcastGrey, 0.92), oc * 0.9),
      skyHorizon: mix3(b.skyHorizon, overcastGrey, Math.max(oc * 0.9, w.greyMix)),
      skyGround: mix3(b.skyGround, grey(b.skyGround), w.desat),
      sunGlow: b.sunGlow.slice(), glowAmount: b.glowAmount * (1 - oc * 0.8),
      cloudCover: clamp01(b.cloudCover + w.cloudAdd),
      overcast: oc,
      cloudColor: mix3(b.cloudColor, scale3(overcastGrey, 1.1), oc * 0.8),
      cloudShade: mix3(b.cloudShade, scale3(overcastGrey, 0.5), oc * 0.8),
      stars: b.stars * clamp01(1 - oc * 1.2),
      lightPollution: scale3(b.lightPollution, 1 + oc * 1.5),
      exposure: b.exposure,
      shadowStrength: b.shadowStrength * (1 - oc * 0.75),
      headlights: b.headlights || weather === 'wet',
      streetLights: b.streetLights,
      bloom: b.bloom,
      wetness: w.wetness, rain: w.rain,
      windDir: norm3([0.8, 0, 0.6]), windSpeed: w.wind
    };
    // sky-dependent ambient: keep the tuned ambient level but pull its hue toward the actual sky dome colour
    // (zenith / horizon average after weather), so overcast skies give grey fill and dusk skies a violet-rose fill
    var skyAvg = mix3(L.skyZenith, L.skyHorizon, 0.45), lumOf = function (c) { return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; };
    var la = lumOf(L.ambientSky), ls = Math.max(1e-4, lumOf(skyAvg)), hueK = tod === 'night' ? 0.25 : 0.4;
    L.ambientSky = mix3(L.ambientSky, scale3(skyAvg, la / ls), hueK).map(function (v) { return Math.max(0, v); });
    L.uAmbientSky = L.ambientSky;
    L.ambient = scale3([L.ambientSky[0] + L.ambientGround[0], L.ambientSky[1] + L.ambientGround[1], L.ambientSky[2] + L.ambientGround[2]], 0.5);
    L.wind = [L.windDir[0] * L.windSpeed, 0, L.windDir[2] * L.windSpeed];
    // uniform-style aliases so the object can be fed straight into a material/env
    L.uSunDir = L.sunDir; L.uSunColor = L.sunColor; L.uAmbientSky = L.ambientSky; L.uAmbientGround = L.ambientGround;
    L.uFogColor = L.fogColor; L.uFogDensity = L.fogDensity; L.uEnvTop = L.envTop; L.uEnvHorizon = L.envHorizon; L.uEnvBottom = L.envBottom;
    L.uWetness = L.wetness;
    // light reaching particles (smoke etc.): ambient + sun from above (sunColor is HDR, clamp)
    var sunUp = clamp01(L.sunDir[1] * 1.5 + 0.2);
    L.particleLight = [
      Math.min(1.0, L.ambientSky[0] * 0.95 + L.sunColor[0] * 0.42 * sunUp),
      Math.min(1.0, L.ambientSky[1] * 0.95 + L.sunColor[1] * 0.42 * sunUp),
      Math.min(1.0, L.ambientSky[2] * 0.95 + L.sunColor[2] * 0.42 * sunUp)
    ];
    return L;
  }

  function cloneLighting(L) {
    var o = {};
    for (var k in L) o[k] = Array.isArray(L[k]) ? L[k].slice() : L[k];
    return o;
  }

  /** getLighting(timeOfDay, weather) -> fresh lighting object (colors in display space 0..1, sunColor pre-scaled by intensity). */
  function getLighting(timeOfDay, weather) {
    var tod = normTod(timeOfDay), w = normWeather(weather), key = tod + '|' + w;
    if (!LIGHT_CACHE[key]) LIGHT_CACHE[key] = computeLighting(tod, w);
    return cloneLighting(LIGHT_CACHE[key]);
  }

  /* ---------------------------------------------------------- car geometry */
  /** Contact-patch positions (GL world) of a snapshot car: [FL, FR, RL, RR], plus basis vectors. */
  function carFrame(car) {
    var h = num(car.heading, 0);
    var fx = Math.cos(h), fz = -Math.sin(h);           // forward in GL
    var rx = Math.sin(h), rz = Math.cos(h);            // right in GL (sim right = (sin h, -cos h))
    var len = num(car.length_m, 4.4), wid = num(car.width_m, 1.9);
    var b = car.build && car.build.body;
    var halfWB = b && num(b.wheelbase_mm, 0) > 0 ? b.wheelbase_mm / 2000 : len * 0.31;
    var halfTr = b && num(b.trackWidth_mm, 0) > 0 ? b.trackWidth_mm / 2000 : wid * 0.42;
    halfWB = Math.min(halfWB, len * 0.45);
    halfTr = Math.min(halfTr, wid * 0.5);
    var cx = num(car.x, 0), cz = -num(car.y, 0);
    var wheels = [
      [cx + fx * halfWB - rx * halfTr, 0, cz + fz * halfWB - rz * halfTr],
      [cx + fx * halfWB + rx * halfTr, 0, cz + fz * halfWB + rz * halfTr],
      [cx - fx * halfWB - rx * halfTr, 0, cz - fz * halfWB - rz * halfTr],
      [cx - fx * halfWB + rx * halfTr, 0, cz - fz * halfWB + rz * halfTr]
    ];
    var vel;
    if (typeof car.vx === 'number' && typeof car.vy === 'number') vel = [car.vx, 0, -car.vy];
    else { var s = num(car.speed, 0); vel = [fx * s, 0, fz * s]; }
    return {
      center: [cx, 0, cz], fwd: [fx, 0, fz], right: [rx, 0, rz], wheels: wheels, vel: vel,
      speed: num(car.speed, Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2])), halfLength: len / 2, halfWidth: wid / 2
    };
  }

  function driveLayout(car) {
    var d = car.build && car.build.drivetrain && car.build.drivetrain.layout;
    return d === 'fwd' || d === 'awd' ? d : 'rwd';
  }

  /** Per-wheel slip intensities 0..1 [FL, FR, RL, RR] from a snapshot car (pure). */
  function wheelSlip(car) {
    var sk = clamp01(num(car.skidding, 0)), ws = clamp01(num(car.wheelspin, 0));
    var br = clamp01(num(car.brake, 0)), spd = num(car.speed, 0);
    var sf = Math.abs(num(car.slipF, 0)), sr = Math.abs(num(car.slipR, 0));
    var out = [0, 0, 0, 0];
    if (spd < 1.2) { if (ws > 0.3) { /* burnout in place */ } else return out; }
    // lateral slide: weighted toward the axle that is sliding more
    if (sk > 0.12) {
      var tot = sf + sr + 1e-6, rearW = sf + sr > 0.01 ? sr / tot : 0.6;
      var front = sk * clamp01(1.25 - rearW) , rear = sk * clamp01(0.35 + rearW);
      if (br > 0.55) { front = Math.max(front, sk * 0.95); rear = Math.max(rear, sk * 0.7); } // lockup
      out[0] = Math.max(out[0], front); out[1] = Math.max(out[1], front);
      out[2] = Math.max(out[2], rear); out[3] = Math.max(out[3], rear);
    }
    if (ws > 0.15) {
      var lay = driveLayout(car);
      if (lay === 'fwd') { out[0] = Math.max(out[0], ws); out[1] = Math.max(out[1], ws); }
      else if (lay === 'awd') { for (var i = 0; i < 4; i++) out[i] = Math.max(out[i], ws * 0.7); }
      else { out[2] = Math.max(out[2], ws); out[3] = Math.max(out[3], ws); }
    }
    if (car.handbrake && spd > 3) { out[2] = Math.max(out[2], 0.85); out[3] = Math.max(out[3], 0.85); }
    for (var j = 0; j < 4; j++) out[j] = clamp01(out[j]);
    return out;
  }

  /* --------------------------------------------------------- particle pool */
  var P_STRIDE = 18; // pos3 vel3 time4(birth,life,size0,size1) params4(drag,gravity,kind,seed) color4
  var KIND = { smoke: 0, dust: 1, mist: 2, spark: 3, debris: 4, droplet: 5, flame: 6 };

  function ParticlePool(cap) {
    this.cap = Math.max(16, cap | 0);
    this.data = new Float32Array(this.cap * P_STRIDE);
    for (var i = 0; i < this.cap; i++) this.data[i * P_STRIDE + 7] = -1; // life -1 => dead
    this.head = 0; this.total = 0;
    this.dirtyStart = 0; this.dirtyCount = 0;
    this.maxDeath = 0;
  }
  ParticlePool.prototype.emit = function (px, py, pz, vx, vy, vz, birth, life, s0, s1, drag, grav, kind, seed, r, g, b, a) {
    var i = this.head, o = i * P_STRIDE, d = this.data;
    d[o] = px; d[o + 1] = py; d[o + 2] = pz;
    d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = birth; d[o + 7] = life; d[o + 8] = s0; d[o + 9] = s1;
    d[o + 10] = Math.max(0.05, drag); d[o + 11] = grav; d[o + 12] = kind; d[o + 13] = seed;
    d[o + 14] = r; d[o + 15] = g; d[o + 16] = b; d[o + 17] = a;
    if (this.dirtyCount === 0) this.dirtyStart = i;
    if (this.dirtyCount < this.cap) this.dirtyCount++;
    this.head = (i + 1) % this.cap;
    this.total++;
    if (birth + life > this.maxDeath) this.maxDeath = birth + life;
    return i;
  };
  /** Contiguous dirty ranges as [[startIndex, count], ...] (max 2, ring wrap). Clears the dirty state. */
  ParticlePool.prototype.takeDirty = function () {
    var out = [];
    if (this.dirtyCount > 0) {
      var s = this.dirtyStart, n = this.dirtyCount;
      if (n >= this.cap) out.push([0, this.cap]);
      else if (s + n <= this.cap) out.push([s, n]);
      else { out.push([s, this.cap - s]); out.push([0, n - (this.cap - s)]); }
    }
    this.dirtyCount = 0;
    return out;
  };
  ParticlePool.prototype.count = function () { return Math.min(this.total, this.cap); };
  ParticlePool.prototype.alive = function (now) {
    var n = 0, c = this.count(), d = this.data;
    for (var i = 0; i < c; i++) { var o = i * P_STRIDE; if (now >= d[o + 6] && now - d[o + 6] <= d[o + 7]) n++; }
    return n;
  };
  /** Alive particles whose kind <= maxKind (soft, large, alpha-blended sprites: smoke, dust, mist). */
  ParticlePool.prototype.aliveSoft = function (now, maxKind) {
    var n = 0, c = this.count(), d = this.data;
    for (var i = 0; i < c; i++) { var o = i * P_STRIDE; if (d[o + 12] <= maxKind && now >= d[o + 6] && now - d[o + 6] <= d[o + 7]) n++; }
    return n;
  };
  ParticlePool.prototype.clear = function () {
    for (var i = 0; i < this.cap; i++) this.data[i * P_STRIDE + 7] = -1;
    this.head = 0; this.total = 0; this.dirtyStart = 0; this.dirtyCount = this.cap; this.maxDeath = 0;
  };

  /* ------------------------------------------------------------ skid ribbons */
  var S_STRIDE = 8; // pos3, u, v, intensity, birth, seq   (4 verts per segment)

  function SkidBuffer(cap) {
    this.cap = Math.max(8, Math.min(16000, cap | 0)); // Uint16 indices: 4 * 16000 < 65536
    this.data = new Float32Array(this.cap * 4 * S_STRIDE);
    for (var i = 0; i < this.cap * 4; i++) this.data[i * S_STRIDE + 5] = 0;
    this.head = 0; this.seq = 0; this.total = 0;
    this.dirtyStart = 0; this.dirtyCount = 0;
    this.wheels = {};
    this.minLen = 0.3; this.maxGap = 4.5; this.maxIdle = 0.6;
  }
  /** Add a ribbon point for (key) at GL position p with intensity 0..1 at time now; width in m. Returns true if a segment was written. */
  SkidBuffer.prototype.add = function (key, p, intensity, now, width) {
    var st = this.wheels[key], w = (width || 0.24) * 0.5, y = num(p[1], 0) + 0.014;
    var x = p[0], z = p[2];
    if (!st || now - st.t > this.maxIdle) {
      this.wheels[key] = { x: x, y: y, z: z, t: now, i: intensity, u: st ? st.u : 0, edges: null };
      return false;
    }
    var dx = x - st.x, dz = z - st.z, dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > this.maxGap) { this.wheels[key] = { x: x, y: y, z: z, t: now, i: intensity, u: st.u, edges: null }; return false; }
    if (dist < this.minLen) { st.t = now; st.i = Math.max(st.i * 0.7, intensity); return false; }
    var nx = -dz / dist * w, nz = dx / dist * w; // left normal (GL xz)
    var e = st.edges || [st.x + nx, st.z + nz, st.x - nx, st.z - nz];
    var lx = x + nx, lz = z + nz, rx = x - nx, rz = z - nz;
    var seg = this.head, o = seg * 4 * S_STRIDE, d = this.data, s = this.seq, u0 = st.u, u1 = st.u + dist;
    var i0 = st.i, i1 = intensity;
    // v0: start-left, v1: start-right, v2: end-left, v3: end-right
    d[o] = e[0]; d[o + 1] = st.y; d[o + 2] = e[1]; d[o + 3] = u0; d[o + 4] = 0; d[o + 5] = i0; d[o + 6] = now; d[o + 7] = s; o += S_STRIDE;
    d[o] = e[2]; d[o + 1] = st.y; d[o + 2] = e[3]; d[o + 3] = u0; d[o + 4] = 1; d[o + 5] = i0; d[o + 6] = now; d[o + 7] = s; o += S_STRIDE;
    d[o] = lx;   d[o + 1] = y;    d[o + 2] = lz;   d[o + 3] = u1; d[o + 4] = 0; d[o + 5] = i1; d[o + 6] = now; d[o + 7] = s; o += S_STRIDE;
    d[o] = rx;   d[o + 1] = y;    d[o + 2] = rz;   d[o + 3] = u1; d[o + 4] = 1; d[o + 5] = i1; d[o + 6] = now; d[o + 7] = s;
    if (this.dirtyCount === 0) this.dirtyStart = seg;
    if (this.dirtyCount < this.cap) this.dirtyCount++;
    this.head = (seg + 1) % this.cap;
    this.seq++; this.total++;
    st.x = x; st.y = y; st.z = z; st.t = now; st.i = intensity; st.u = u1; st.edges = [lx, lz, rx, rz];
    return true;
  };
  SkidBuffer.prototype.end = function (key) { var st = this.wheels[key]; if (st) st.t = -1e9; };
  SkidBuffer.prototype.prune = function (now) {
    for (var k in this.wheels) if (now - this.wheels[k].t > 5) delete this.wheels[k];
  };
  SkidBuffer.prototype.takeDirty = ParticlePool.prototype.takeDirty;
  SkidBuffer.prototype.count = function () { return Math.min(this.total, this.cap); };
  SkidBuffer.prototype.clear = function () {
    this.data.fill(0); this.head = 0; this.seq = 0; this.total = 0; this.wheels = {};
    this.dirtyStart = 0; this.dirtyCount = this.cap;
  };

  /* ---------------------------------------------------------- camera utils */
  function camPosFromView(v) {
    // eye = -R^T t  (column-major: R columns at 0..2,4..6,8..10; t at 12..14)
    var tx = v[12], ty = v[13], tz = v[14];
    return [
      -(v[0] * tx + v[1] * ty + v[2] * tz),
      -(v[4] * tx + v[5] * ty + v[6] * tz),
      -(v[8] * tx + v[9] * ty + v[10] * tz)
    ];
  }
  function camFwdFromView(v) { return norm3([-v[2], -v[6], -v[10]]); }
  /** inverse of the rotation part (transpose) as column-major mat3 */
  function invViewRot3(v, out) {
    out = out || new Float32Array(9);
    out[0] = v[0]; out[1] = v[4]; out[2] = v[8];
    out[3] = v[1]; out[4] = v[5]; out[5] = v[9];
    out[6] = v[2]; out[7] = v[6]; out[8] = v[10];
    return out;
  }
  function readCamera(camera) {
    if (!camera) return null;
    var view = camera.view || camera.viewMatrix || camera.uView;
    var proj = camera.proj || camera.projection || camera.projMatrix || camera.uProj;
    if (!view || !proj) return null;
    var pos = camera.pos || camera.eye || camera.position || camPosFromView(view);
    return { view: view, proj: proj, pos: [pos[0], pos[1], pos[2]], fwd: camFwdFromView(view), viewport: camera.viewport || null };
  }

  /* -------------------------------------------------------------- shaders */
  var HEADER_FS = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

  var PARTICLE_VS = [
    'precision highp float;',
    'attribute vec3 aPos; attribute vec3 aVel; attribute vec4 aTime; attribute vec4 aParams; attribute vec4 aColor;',
    'uniform mat4 uView; uniform mat4 uProj; uniform float uTime; uniform vec3 uWind;',
    'uniform vec2 uViewport; uniform float uMaxPoint; uniform vec3 uLight; uniform vec3 uFogColor; uniform float uFogDensity;',
    'varying vec4 vColor; varying vec2 vDir; varying float vHalf; varying float vRad; varying float vKind; varying float vSeed; varying float vAge;',
    // soft-ground term: (sprite centre height, world radius, camera right.y, camera up.y) -> per-fragment height on the billboard plane
    'varying vec4 vGround;',
    'void hide(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec4(0.0); vDir = vec2(1.0,0.0); vHalf = 0.0; vRad = 1.0; vKind = 0.0; vSeed = 0.0; vAge = 0.0; vGround = vec4(1.0, 0.0, 0.0, 1.0); }',
    'void main(){',
    '  float age = uTime - aTime.x; float life = aTime.y;',
    '  if (life <= 0.0 || age < 0.0 || age > life) { hide(); return; }',
    '  float x = age / life; float kind = aParams.z;',
    '  float isSpark = step(2.5, kind) * step(kind, 3.5);',
    '  float isDrop = step(4.5, kind) * step(kind, 5.5);',
    '  float isFlame = step(5.5, kind);',
    '  float isAdd = max(isSpark, isFlame);',
    '  float windScale = kind < 2.5 ? 1.0 : (isSpark > 0.5 ? 0.05 : (isDrop > 0.5 ? 0.4 : 0.25));',
    '  float k = max(aParams.x, 0.05); float e = exp(-k * age); float f = (1.0 - e) / k;',
    '  vec3 w = uWind * windScale; vec3 g = vec3(0.0, -aParams.y, 0.0);',
    '  vec3 p = aPos + w * age + (aVel - w) * f + g / k * (age - f);',
    '  vec3 vel = w + (aVel - w) * e + g / k * (1.0 - e);',
    '  if (p.y < 0.03) { p.y = 0.03 + (0.03 - p.y) * 0.22; vel.y = -vel.y * 0.22; }',
    // slow curl-ish turbulence for smoke (grows with age so fresh puffs stay attached to the tyre)
    '  if (kind < 0.5) { float sd = aParams.w * 37.0; float tx = age * 0.55; p += vec3(sin(tx + sd) + 0.5 * sin(tx * 2.3 + sd * 1.7), 0.35 * sin(tx * 1.3 + sd * 2.9), cos(tx * 0.9 + sd * 1.3) + 0.5 * cos(tx * 2.1 + sd * 0.7)) * (0.55 * x * min(age, 2.5)); p.y = max(p.y, 0.05); }',
    '  vec4 vp = uView * vec4(p, 1.0); float dist = -vp.z;',
    '  if (dist < 0.08) { hide(); return; }',
    '  float g2 = 1.0 - (1.0 - x) * (1.0 - x);',
    '  float size = mix(aTime.z, aTime.w, g2);',
    '  float pxScale = uProj[1][1] * uViewport.y * 0.5;',
    '  float px = size * pxScale / dist;',
    '  float a = aColor.a;',
    '  vec3 col = aColor.rgb;',
    '  if (isAdd > 0.5) {',
    '    vec3 hot = isSpark > 0.5 ? mix(vec3(1.0, 0.96, 0.82), vec3(1.0, 0.36, 0.06), clamp(x * 1.3, 0.0, 1.0)) : mix(vec3(1.0, 0.85, 0.5), vec3(1.0, 0.25, 0.03), x);',
    '    col *= hot * (isSpark > 0.5 ? 2.2 : 1.8);',
    '    a *= isSpark > 0.5 ? pow(1.0 - x, 0.7) : (1.0 - x) * smoothstep(0.0, 0.1, x);',
    '  } else {',
    '    col *= uLight;',
    '    if (kind < 0.5) a *= smoothstep(0.0, 0.05, x) * (1.0 - smoothstep(0.3, 1.0, x)) * (1.0 - 0.25 * x);',  // lingers, then thins out
    '    else a *= smoothstep(0.0, kind > 3.5 ? 0.02 : 0.08, x) * pow(1.0 - x, kind > 3.5 ? 0.6 : 1.35);',
    '    a *= smoothstep(0.6, 3.5, dist);',
    // big puffs that reach the camera fade out (no fog wall in chase view, bounded fill cost)
    '    if (kind < 2.5) a *= smoothstep(size * 0.12, size * 0.45 + 0.8, dist);',  // near-camera sprites fade out (and are culled below): bounds overdraw
    '  }',
    '  float fogF = exp(-pow(uFogDensity * dist, 2.0));',
    '  vec4 clip = uProj * vp;',
    '  vDir = vec2(1.0, 0.0); vHalf = 0.0; vRad = 1.0;',
    '  if (isSpark + isDrop > 0.5) {',
    '    float stretch = isSpark > 0.5 ? 0.045 : 0.03;',
    '    vec4 c1 = uProj * (uView * vec4(p - vel * stretch, 1.0));',
    '    if (c1.w < 0.08) c1 = clip;',
    '    vec2 s0 = clip.xy / clip.w * 0.5 * uViewport; vec2 s1 = c1.xy / c1.w * 0.5 * uViewport;',
    '    vec2 d = s0 - s1; float len = length(d);',
    '    float thick = max(px * 0.5, 0.75);',
    '    if (px < 1.5) a *= max(px / 1.5, 0.35);',
    '    float tot = min(len + thick * 2.0 + 1.0, uMaxPoint);',
    '    len = max(tot - thick * 2.0 - 1.0, 0.0);',
    '    vec2 mid = (s0 + s1) * 0.5; if (len < 0.001) mid = s0;',
    '    clip = vec4(mid / (0.5 * uViewport) * clip.w, clip.z, clip.w);',
    '    vDir = len > 0.001 ? vec2(d.x, -d.y) / max(length(d), 0.001) : vec2(1.0, 0.0);',
    '    vHalf = len / tot; vRad = 2.0 * thick / tot; px = tot;',
    '  } else {',
    '    if (px > uMaxPoint) { a *= (uMaxPoint / px); px = uMaxPoint; }',
    '  }',
    '  if (isAdd > 0.5) { vColor = vec4(col * a * fogF, 0.0); }',
    '  else { col = mix(uFogColor, col, fogF); vColor = vec4(col * a, a); }',
    '  if (a < 0.002) { hide(); return; }',
    '  gl_Position = clip; gl_PointSize = max(px, 1.0);',
    '  vKind = kind; vSeed = aParams.w; vAge = age;',
    '  vGround = vec4(p.y, 0.5 * max(px, 1.0) * dist / max(pxScale, 1e-4), uView[1][0], uView[1][1]);',
    '}'
  ].join('\n');

  var PARTICLE_FS = HEADER_FS + [
    'varying vec4 vColor; varying vec2 vDir; varying float vHalf; varying float vRad; varying float vKind; varying float vSeed; varying float vAge;',
    'varying vec4 vGround;',
    'void main(){',
    '  vec2 c = gl_PointCoord * 2.0 - 1.0;',
    '  float m;',
    '  if ((vKind > 2.5 && vKind < 3.5) || (vKind > 4.5 && vKind < 5.5)) {',
    '    float t = clamp(dot(c, vDir), -vHalf, vHalf);',
    '    float r = length(c - vDir * t) / max(vRad, 0.001);',
    '    if (r > 1.0) discard;',
    '    float along = vHalf > 0.0 ? (dot(c, vDir) / vHalf) * 0.5 + 0.5 : 1.0;',
    '    m = (1.0 - r * r) * mix(0.35, 1.0, clamp(along, 0.0, 1.0));',
    '  } else {',
    '    float r2 = dot(c, c);',
    '    if (r2 > 1.0) discard;',
    '    if (vKind > 3.5 && vKind < 4.5) { m = smoothstep(1.0, 0.55, r2); }',
    '    else {',
    '      float ang = vSeed * 6.2831 + vAge * (0.25 + vSeed * 0.5);',
    '      float ca = cos(ang), sa = sin(ang);',
    '      vec2 q = vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y);',
    '      float lump = 0.62 + 0.2 * sin(q.x * 3.7 + vSeed * 17.0) * sin(q.y * 4.3 - vSeed * 9.0) + 0.18 * sin((q.x + q.y) * 6.1 + vSeed * 31.0);',
    '      m = pow(1.0 - r2, 1.6) * lump;',
    '      if (vKind > 5.5) m = pow(1.0 - r2, 2.2);',
    '    }',
    '  }',
    '  if (vKind < 2.5) {',
    // Soft particles vs the road: a camera-facing sprite has a single depth, so the ground plane used to slice
    // every puff with a hard horizontal edge where it crosses y = 0 (stacked puffs read as horizontal banding).
    // Fade each fragment by its height on the billboard plane instead, so puffs meet the road softly.
    '    float fy = vGround.x + (c.x * vGround.z - c.y * vGround.w) * vGround.y;',
    '    m *= smoothstep(0.0, clamp(vGround.y * 0.45, 0.12, 1.4), fy);',
    // self-shadowing in world height (darker at the road, lighter up top) instead of per-sprite top->bottom:
    // a per-sprite gradient repeats on every stacked puff and reads as horizontal stripes through the cloud
    '    float sh = mix(0.74, 1.05, smoothstep(-0.2, 2.6, fy)) * (1.0 - 0.06 * c.y);',
    '    vec4 o = vec4(vColor.rgb * (m * sh), vColor.a * m);',
    // ordered-noise dither (+-0.5 LSB) breaks up 8-bit quantisation steps in large, thin, overlapping sprites
    '    float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;',
    '    o += vec4(dn / 255.0) * step(0.004, o.a);',
    '    gl_FragColor = clamp(o, 0.0, 1.0);',
    '  }',
    '  else gl_FragColor = vColor * m;',
    '}'
  ].join('\n');

  var SKID_VS = [
    'precision highp float;',
    'attribute vec3 aPos; attribute vec4 aData; attribute float aSeq;',
    'uniform mat4 uView; uniform mat4 uProj; uniform float uTime; uniform float uFade; uniform float uHeadSeq; uniform float uCap;',
    'uniform float uFogDensity; uniform float uWetMul;',
    'varying vec2 vUV; varying float vAlpha;',
    'void main(){',
    '  float age = uTime - aData.w;',
    '  float fade = 1.0 - smoothstep(uFade * 0.3, uFade, age);',
    '  float ring = smoothstep(0.0, uCap * 0.12, uCap - (uHeadSeq - aSeq));',
    '  vec4 vp = uView * vec4(aPos, 1.0);',
    '  float fogF = exp(-pow(uFogDensity * -vp.z, 2.0));',
    '  vAlpha = aData.z * fade * ring * fogF * uWetMul;',
    '  vUV = aData.xy;',
    '  gl_Position = uProj * vp;',
    '}'
  ].join('\n');

  var SKID_FS = HEADER_FS + [
    'varying vec2 vUV; varying float vAlpha;',
    'float h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }',
    'void main(){',
    '  if (vAlpha < 0.004) discard;',
    '  float v = vUV.y;',
    '  float edge = smoothstep(0.0, 0.18, v) * smoothstep(1.0, 0.82, v);',
    '  float groove = 0.72 + 0.28 * smoothstep(0.35, 0.5, abs(fract(v * 4.0) - 0.5) * 2.0);',
    '  float streak = 0.75 + 0.25 * h11(floor(v * 14.0) + floor(vUV.x * 0.7) * 7.0);',
    '  float a = vAlpha * edge * groove * streak * 0.62;',
    '  gl_FragColor = vec4(vec3(0.018, 0.017, 0.016) * a, a);',
    '}'
  ].join('\n');

  var RAIN_VS = [
    'precision highp float;',
    'attribute vec3 aSeed; attribute vec2 aCorner;',
    'uniform mat4 uView; uniform mat4 uProj; uniform float uTime; uniform vec3 uCenter; uniform vec3 uBox;',
    'uniform vec3 uFall; uniform vec3 uCamVel; uniform float uStreak; uniform vec2 uViewport; uniform vec3 uCamPos; uniform float uWidthPx;',
    'varying float vAlpha; varying vec2 vC;',
    'void main(){',
    '  float spd = 0.85 + 0.3 * fract(aSeed.x * 7.13 + aSeed.z * 3.1);',
    '  vec3 base = aSeed * uBox + uFall * spd * uTime;',
    '  vec3 lo = uCenter - uBox * 0.5;',
    '  vec3 p = lo + mod(base - lo, uBox);',
    '  vec3 rel = uFall * spd - uCamVel;',
    '  vec3 tail = p - rel * uStreak;',
    '  vec4 c0 = uProj * (uView * vec4(p, 1.0)); vec4 c1 = uProj * (uView * vec4(tail, 1.0));',
    '  if (c0.w < 0.2 || c1.w < 0.2) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; vC = vec2(0.0); return; }',
    '  vec2 s0 = c0.xy / c0.w * uViewport; vec2 s1 = c1.xy / c1.w * uViewport;',
    '  vec2 d = s1 - s0; float l = length(d); vec2 n = l > 0.001 ? vec2(-d.y, d.x) / l : vec2(1.0, 0.0);',
    '  vec4 c = aCorner.y > 0.5 ? c1 : c0;',
    '  c.xy += n * aCorner.x * uWidthPx / uViewport * c.w;',
    '  float dist = length(p - uCamPos);',
    '  vAlpha = smoothstep(0.4, 1.6, dist) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, dist)) * (0.6 + 0.4 * aSeed.y);',
    '  vC = aCorner;',
    '  gl_Position = c;',
    '}'
  ].join('\n');

  var RAIN_FS = HEADER_FS + [
    'uniform vec3 uColor; uniform float uAlpha;',
    'varying float vAlpha; varying vec2 vC;',
    'void main(){',
    '  float a = vAlpha * uAlpha * (1.0 - abs(vC.x)) * mix(1.0, 0.15, vC.y);',
    '  if (a < 0.003) discard;',
    '  gl_FragColor = vec4(uColor * a, a);',
    '}'
  ].join('\n');

  var SKY_VS = [
    'precision highp float;',
    'attribute vec2 aPos;',
    'uniform mat3 uInvViewRot; uniform vec4 uProjInfo;', // 1/p00, 1/p11, p20(off-x), p21(off-y)
    'varying vec3 vRay;',
    'void main(){',
    '  vec3 vd = vec3((aPos.x + uProjInfo.z) * uProjInfo.x, (aPos.y + uProjInfo.w) * uProjInfo.y, -1.0);',
    '  vRay = uInvViewRot * vd;',
    '  gl_Position = vec4(aPos, 1.0, 1.0);',
    '}'
  ].join('\n');

  function skyFS(octaves, shadow) {
    return HEADER_FS + '#define OCT ' + octaves + '\n' + (shadow ? '#define CLOUD_SHADOW 1\n' : '') + [
      'varying vec3 vRay;',
      'uniform vec3 uSunDir; uniform vec3 uMoonDir; uniform vec3 uSunColor; uniform float uSunSize; uniform float uSunVis; uniform float uMoonVis;',
      'uniform vec3 uZenith; uniform vec3 uBand; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uFogColor;',
      'uniform vec3 uGlow; uniform float uGlowAmt; uniform vec3 uLightPol;',
      'uniform float uCover; uniform float uOvercast; uniform vec3 uCloudCol; uniform vec3 uCloudShade; uniform vec2 uCloudOff;',
      'uniform float uStars; uniform float uTime; uniform float uLinearOut;',
      'float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
      'float h13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }',
      'vec3 h33(vec3 p3){ p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }',
      'float vn(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), u.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), u.x), u.y); }',
      'float fbm(vec2 p){ float s = 0.0; float a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);',
      '  for (int i = 0; i < OCT; i++) { s += a * vn(p); p = m * p; a *= 0.5; } return s; }',
      'void main(){',
      '  vec3 d = normalize(vRay);',
      '  float y = d.y;',
      '  float up = max(y, 0.0);',
      // gradient
      '  vec3 col = mix(uHorizon, uBand, smoothstep(0.0, 0.22, up));',
      '  col = mix(col, uZenith, smoothstep(0.12, 0.85, up));',
      '  col += uLightPol * exp(-up * 9.0);',
      '  vec2 sXZ = normalize(uSunDir.xz + vec2(1e-4));',
      '  float sunAz = max(dot(normalize(d.xz + vec2(1e-4)), sXZ), 0.0);',
      '  col += uGlow * uGlowAmt * pow(sunAz, 3.0) * pow(1.0 - up, 5.0) * 0.8;',
      '  float cs = max(dot(d, uSunDir), 0.0);',
      '  col += uGlow * uSunVis * (pow(cs, 48.0) * 0.45 + pow(cs, 6.0) * 0.12 * uGlowAmt);',
      // night sky
      '  vec3 bodies = vec3(0.0);',
      '  if (uStars > 0.01 && y > -0.02) {',
      '    vec3 sp = d * 260.0; vec3 cell = floor(sp); float hs = h13(cell);',
      '    if (hs > 0.972) {',
      '      vec3 ctr = cell + 0.5 + (h33(cell) - 0.5) * 0.7;',
      '      float sd = length(sp - ctr);',
      '      float tw = 0.65 + 0.35 * sin(uTime * (2.0 + hs * 9.0) + hs * 80.0);',
      '      float br = (hs - 0.972) / 0.028; br = br * br * 1.6 + 0.15;',
      '      vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.85, 0.7), h13(cell + 7.0));',
      '      bodies += tint * br * tw * smoothstep(0.45, 0.0, sd);',
      '    }',
      '    vec3 bn = normalize(vec3(0.35, 0.25, 0.9));',
      '    float band = exp(-pow(dot(d, bn) * 3.2, 2.0));',
      '    float mw = fbm(d.xz * 7.0 + d.y * 3.0);',
      '    bodies += vec3(0.11, 0.11, 0.16) * band * smoothstep(0.35, 0.8, mw);',
      '    bodies *= uStars * smoothstep(-0.02, 0.18, y);',
      '  }',
      '  if (uMoonVis > 0.01) {',
      '    vec3 m = uMoonDir; float rad = 0.022;',
      '    vec3 t1 = normalize(cross(m, vec3(0.0, 1.0, 0.0))); vec3 t2 = cross(t1, m);',
      '    vec2 q = vec2(dot(d, t1), dot(d, t2)) / rad; float r2 = dot(q, q); float md = dot(d, m);',
      '    if (r2 < 1.0 && md > 0.0) {',
      '      vec3 n = vec3(q, sqrt(1.0 - r2));',
      '      float lit = smoothstep(-0.05, 0.25, dot(n, normalize(vec3(0.7, 0.25, 0.65))));',
      '      float crater = 0.72 + 0.28 * smoothstep(0.3, 0.7, vn(q * 3.0 + 4.0)) - 0.18 * smoothstep(0.55, 0.75, vn(q * 7.0));',
      '      float limb = mix(0.75, 1.0, n.z);',
      '      bodies += vec3(0.96, 0.94, 0.86) * (lit * crater * limb * 1.15 + 0.04) * uMoonVis * smoothstep(1.0, 0.92, r2);',
      '    }',
      '    float mg = max(md, 0.0);',
      '    col += vec3(0.5, 0.55, 0.7) * uMoonVis * (pow(mg, 900.0) * 0.35 + pow(mg, 40.0) * 0.06);',
      '  }',
      '  if (uSunVis > 0.01 && uSunSize > 0.0) {',
      '    float disc = smoothstep(cos(uSunSize), cos(uSunSize * 0.85), cs);',
      '    bodies += uSunColor * disc * uSunVis * 6.0 + vec3(1.0, 0.98, 0.9) * disc * uSunVis * 2.0;',
      '  }',
      // clouds
      '  float cA = 0.0; vec3 cCol = uCloudCol;',
      '  if (y > 0.0 && uCover > 0.01) {',
      '    vec2 uv = d.xz / (y * 0.85 + 0.09) * 0.9 + uCloudOff;',
      '    float n = fbm(uv);',
      '    float base = fbm(uv * 0.23 + 3.7);',
      '    float thr = 1.0 - uCover;',
      '    float dens = smoothstep(thr * 0.92, thr * 0.92 + 0.32, n * 0.75 + base * 0.45);',
      '    dens = mix(dens, 0.82 + 0.18 * n, uOvercast);',
      '#ifdef CLOUD_SHADOW',
      '    float n2 = fbm(uv + sXZ * 0.22);',
      '    float shade = clamp(0.55 + (n - n2) * 2.6, 0.0, 1.0);',
      '#else',
      '    float shade = clamp(1.15 - n * 0.9, 0.0, 1.0);',
      '#endif',
      '    shade = mix(shade, clamp(0.12 + 1.15 * (1.0 - base) - 0.4 * n, 0.0, 1.0), uOvercast);',
      '    cCol = mix(uCloudShade, uCloudCol, shade);',
      '    cCol += uGlow * uSunVis * pow(cs, 10.0) * (1.0 - dens) * 0.9;',
      '    cCol += uGlow * uGlowAmt * pow(sunAz, 4.0) * 0.25 * (1.0 - up);',
      '    cA = dens * smoothstep(0.0, 0.16, y);',
      '    cCol = mix(cCol, uHorizon, (1.0 - smoothstep(0.0, 0.35, y)) * 0.55);',
      '  }',
      '  col += bodies * (1.0 - cA);',
      '  col = mix(col, cCol, cA);',
      // horizon haze and below-horizon fog match
      '  float haze = exp(-up * 10.0) * 0.55;',
      '  col = mix(col, uFogColor, haze);',
      '  if (y < 0.0) col = mix(uFogColor, uGround, smoothstep(0.0, 0.35, -y) * 0.5);',
      '  if (uLinearOut > 0.5) col = pow(max(col, vec3(0.0)), vec3(2.2));',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n');
  }

  /* ----------------------------------------------------------- GL helpers */
  function compileProgram(gl, vsSrc, fsSrc, name) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('[CB.gl.effects] ' + name + ' shader compile failed: ' + log);
      }
      return s;
    }
    var vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      throw new Error('[CB.gl.effects] ' + name + ' link failed: ' + log);
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    var nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) | 0, u = {};
    for (var i = 0; i < nu; i++) {
      var info = gl.getActiveUniform(p, i);
      if (!info) continue;
      var nm = info.name.replace(/\[0\]$/, '');
      u[nm] = gl.getUniformLocation(p, info.name);
    }
    var na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES) | 0, a = {};
    for (var j = 0; j < na; j++) {
      var ai = gl.getActiveAttrib(p, j);
      if (ai) a[ai.name] = gl.getAttribLocation(p, ai.name);
    }
    return { program: p, u: u, a: a, name: name };
  }

  /* ---------------------------------------------------------------- create */
  function create(ctx, opts) {
    opts = opts || {};
    var gl = ctx && ctx.gl ? ctx.gl : ctx;
    if (!gl || typeof gl.createBuffer !== 'function') throw new Error('[CB.gl.effects] create(ctx): no WebGL context');
    var isGL2 = !!(ctx && ctx.isWebGL2) || (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext);
    var vaoExt = !isGL2 && gl.getExtension ? gl.getExtension('OES_vertex_array_object') : null;
    var instExt = !isGL2 && gl.getExtension ? gl.getExtension('ANGLE_instanced_arrays') : null;
    var maxPointHW = 64;
    try { var pr = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE); if (pr && pr[1]) maxPointHW = pr[1]; } catch (e) { /* keep default */ }

    var quality = QUALITY[opts.quality] ? opts.quality : 'high';
    var particleOverride = num(opts.maxParticles, 0);
    var caps;
    function resolveCaps() {
      var base = qualityCaps(quality), c = {};
      for (var k in base) c[k] = base[k];
      // a caller-provided particle budget is honoured, but never below 60% of the tier's own cap
      if (particleOverride > 0) c.maxParticles = Math.round(clamp(Math.max(particleOverride, base.maxParticles * 0.6), 256, 20000));
      caps = c;
    }
    resolveCaps();
    var rng = mulberry32(num(opts.seed, 1337));
    var now = 0;
    var autoEmit = opts.autoEmit !== false;
    var linearOut = !!opts.linearOutput;
    var lighting = getLighting(opts.timeOfDay, opts.weather);
    var curTod = lighting.timeOfDay, curWeather = lighting.weather;
    var rainIntensity = lighting.rain, rainOverride = null;
    var wetness = lighting.wetness;
    var destroyed = false;
    // environment given explicitly (opts / setters) wins over snapshot fields
    var explicitEnv = !!(opts.timeOfDay || opts.weather);

    var progs = {
      particles: compileProgram(gl, PARTICLE_VS, PARTICLE_FS, 'particles'),
      skids: compileProgram(gl, SKID_VS, SKID_FS, 'skids'),
      rain: compileProgram(gl, RAIN_VS, RAIN_FS, 'rain'),
      sky: null
    };
    var skyKey = '';
    function skyProgram() {
      var k = caps.cloudOctaves + (caps.cloudShadow ? 's' : '');
      if (k !== skyKey || !progs.sky) {
        if (progs.sky) gl.deleteProgram(progs.sky.program);
        progs.sky = compileProgram(gl, SKY_VS, skyFS(caps.cloudOctaves, caps.cloudShadow), 'sky');
        skyKey = k;
      }
      return progs.sky;
    }

    var pool, skids, pBuf, sBuf, sIdx, rBuf, rIdx, rainCount = 0;
    var skyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    function allocate() {
      if (pBuf) gl.deleteBuffer(pBuf);
      if (sBuf) gl.deleteBuffer(sBuf);
      if (sIdx) gl.deleteBuffer(sIdx);
      if (rBuf) gl.deleteBuffer(rBuf);
      if (rIdx) gl.deleteBuffer(rIdx);
      var oldSkids = skids;
      pool = new ParticlePool(caps.maxParticles);
      skids = new SkidBuffer(caps.skidSegments);
      // carry over the newest skid segments when changing quality
      if (oldSkids && oldSkids.count()) {
        var n = Math.min(oldSkids.count(), skids.cap), segF = 4 * S_STRIDE;
        for (var i = n - 1; i >= 0; i--) {
          var src = ((oldSkids.head - 1 - i) % oldSkids.cap + oldSkids.cap) % oldSkids.cap;
          var dst = n - 1 - i;
          skids.data.set(oldSkids.data.subarray(src * segF, src * segF + segF), dst * segF);
          for (var v = 0; v < 4; v++) skids.data[dst * segF + v * S_STRIDE + 7] = dst;
        }
        skids.head = n % skids.cap; skids.seq = n; skids.total = n;
      }
      skids.dirtyStart = 0; skids.dirtyCount = skids.cap;
      pBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pool.data, gl.DYNAMIC_DRAW);
      pool.dirtyCount = 0;
      sBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, sBuf);
      gl.bufferData(gl.ARRAY_BUFFER, skids.data, gl.DYNAMIC_DRAW);
      skids.dirtyCount = 0;
      var idx = new Uint16Array(skids.cap * 6);
      for (var s = 0; s < skids.cap; s++) {
        var b = s * 4, o = s * 6;
        idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2; idx[o + 3] = b + 2; idx[o + 4] = b + 1; idx[o + 5] = b + 3;
      }
      sIdx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      // rain drops
      rainCount = Math.min(caps.rainDrops, 16000);
      var rv = new Float32Array(rainCount * 4 * 5), rr = mulberry32(99);
      var ri = new Uint16Array(rainCount * 6);
      for (var d = 0; d < rainCount; d++) {
        var sx = rr(), sy = rr(), sz = rr();
        for (var c = 0; c < 4; c++) {
          var vo = (d * 4 + c) * 5;
          rv[vo] = sx; rv[vo + 1] = sy; rv[vo + 2] = sz;
          rv[vo + 3] = (c & 1) ? 1 : -1; rv[vo + 4] = (c & 2) ? 1 : 0;
        }
        var bo = d * 4, io = d * 6;
        ri[io] = bo; ri[io + 1] = bo + 1; ri[io + 2] = bo + 2; ri[io + 3] = bo + 2; ri[io + 4] = bo + 1; ri[io + 5] = bo + 3;
      }
      rBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, rBuf);
      gl.bufferData(gl.ARRAY_BUFFER, rv, gl.STATIC_DRAW);
      rIdx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, rIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ri, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }
    allocate();

    /* ------------------------------------------------------- emitters */
    var emitBudget = 0; // per-frame cap on emissions so a burst never wipes the whole ring
    function budgetOk() { return emitBudget-- > 0; }
    function rs(a) { return (rng() * 2 - 1) * a; }
    /* Adaptive soft-sprite budget: big smoke/dust sprites are fill-rate bound. Above the budget,
       emissions are thinned and survivors grow (size & opacity) so the cloud reads the same. */
    var softAlive = 0, softBoost = 1;
    function softKeep() {
      if (softAlive <= caps.softBudget) { softBoost = 1; return true; }
      var r = caps.softBudget / softAlive, keep = r * r * r; // steep: steady state stays close to the budget
      softBoost = Math.min(1.6, 1 / Math.sqrt(r));
      return rng() < keep;
    }

    function emitRaw(p, v, life, s0, s1, drag, grav, kind, r, g, b, a, back) {
      var bt = now - (back || 0);
      if (kind <= KIND.mist) softAlive++;
      return pool.emit(p[0], p[1], p[2], v[0], v[1], v[2], bt, life, s0, s1, drag, grav, kind, rng(), r, g, b, a);
    }

    function vec(p) { return [num(p && p[0], 0), num(p && p[1], 0), num(p && p[2], 0)]; }

    /** Tire smoke (wheelspin / lockup / drift). pos & vel in GL world; intensity 0..1. */
    function emitSmoke(pos, vel, intensity, count) {
      var p = vec(pos), v = vec(vel), it = clamp01(num(intensity, 0.6));
      var n = count != null ? count : 1;
      for (var i = 0; i < n; i++) {
        if (!softKeep()) continue;
        if (!budgetOk()) return;
        // thick, lingering drift smoke: small dense puff at the tyre that billows to a 4-8 m cloud over 3-5 s,
        // sheds the car's velocity quickly (drag), then rises slowly and drifts with the wind (VS turbulence)
        var shade = 0.8 + rng() * 0.13, sb = softBoost, warm = rng() * 0.03;
        emitRaw([p[0] + rs(0.35), p[1] + 0.1 + rng() * 0.18, p[2] + rs(0.35)],
          [v[0] * 0.3 + rs(1.2), 0.35 + rng() * 0.9, v[2] * 0.3 + rs(1.2)],
          2.2 + rng() * 1.3 + it * 1.8, (0.5 + rng() * 0.3) * sb, (3.4 + it * 3.4 + rng() * 1.2) * sb,
          1.05 + rng() * 0.5, -0.4 - rng() * 0.3, KIND.smoke,
          shade + warm, shade, shade * 1.02 - warm, Math.min(0.85, (0.26 + it * 0.4) * (0.8 + rng() * 0.4) * Math.sqrt(sb)));
      }
    }
    /** Sparks burst (collisions, wall scrapes, bottoming). */
    function emitSparks(pos, vel, n) {
      var p = vec(pos), v = vec(vel), cnt = Math.round(clamp(num(n, 20), 0, 400) * caps.emitScale);
      for (var i = 0; i < cnt; i++) {
        if (!budgetOk()) return;
        var sp = 3 + rng() * 9, th = rng() * Math.PI * 2, up = 0.2 + rng() * 0.8;
        emitRaw([p[0] + rs(0.2), p[1] + rs(0.1), p[2] + rs(0.2)],
          [v[0] * 0.55 + Math.cos(th) * sp * (1 - up * 0.5), up * sp * 0.8, v[2] * 0.55 + Math.sin(th) * sp * (1 - up * 0.5)],
          0.25 + rng() * 0.6, 0.03 + rng() * 0.03, 0.015, 0.45, 9.8, KIND.spark,
          1, 1, 1, 0.9 + rng() * 0.1, rng() * 0.012);
      }
      // a hot flash at the contact point
      if (cnt > 6 && budgetOk()) emitRaw(p, [v[0] * 0.5, 0.3, v[2] * 0.5], 0.12, 0.6, 1.1, 2, 0, KIND.flame, 1, 0.9, 0.7, 0.8);
    }
    /** Dust / debris off-road. surface: 'grass' | 'sand' | 'gravel' | other (dirt). */
    function emitDust(pos, vel, surface, intensity) {
      var p = vec(pos), v = vec(vel), it = clamp01(num(intensity, 0.7));
      var col = surface === 'grass' ? [0.46, 0.40, 0.28] : surface === 'sand' ? [0.80, 0.70, 0.52] : surface === 'gravel' ? [0.62, 0.60, 0.56] : [0.58, 0.48, 0.36];
      var wetDamp = 1 - wetness * 0.6;
      if (softKeep() && budgetOk()) {
        emitRaw([p[0] + rs(0.3), p[1] + 0.15 + rng() * 0.2, p[2] + rs(0.3)],
          [v[0] * 0.35 + rs(1.6), 0.6 + rng() * 1.6, v[2] * 0.35 + rs(1.6)],
          1.4 + rng() * 1.8, 0.4 + rng() * 0.3, (surface === 'grass' ? 1.8 : 3.2) + it * 1.8,
          1.1, -0.12, KIND.dust, col[0], col[1], col[2], (surface === 'grass' ? 0.2 : 0.34) * (0.6 + it * 0.6) * wetDamp);
      }
      // flung chunks: grass clippings / sand grains / stones
      var chunks = rng() < 0.65 ? 2 : 1;
      var cc = surface === 'grass' ? [0.22, 0.38, 0.12] : surface === 'sand' ? [0.72, 0.62, 0.44] : [0.45, 0.43, 0.4];
      for (var i = 0; i < chunks; i++) {
        if (!budgetOk()) return;
        emitRaw([p[0] + rs(0.15), p[1] + 0.05, p[2] + rs(0.15)],
          [v[0] * 0.45 + rs(2.5), 1.5 + rng() * 3.5 * (0.5 + it), v[2] * 0.45 + rs(2.5)],
          0.5 + rng() * 0.7, 0.035 + rng() * 0.04, 0.03, 0.4, 9.8, KIND.debris, cc[0], cc[1], cc[2], 0.95);
      }
    }
    /** Wet-weather tire spray: mist cloud + droplets. */
    function emitSpray(pos, vel, intensity) {
      var p = vec(pos), v = vec(vel), it = clamp01(num(intensity, 0.7));
      if (softKeep() && budgetOk()) {
        emitRaw([p[0] + rs(0.25), p[1] + 0.2 + rng() * 0.25, p[2] + rs(0.25)],
          [v[0] * 0.55 + rs(1.6), 0.8 + rng() * 1.4, v[2] * 0.55 + rs(1.6)],
          0.8 + rng() * 0.8, 0.45, 2.4 + it * 2.6, 1.8, 0.4, KIND.mist,
          0.82, 0.85, 0.9, (0.1 + it * 0.16) * wetness);
      }
      if (rng() < 0.7 && budgetOk()) {
        emitRaw([p[0] + rs(0.2), p[1] + 0.1, p[2] + rs(0.2)],
          [v[0] * 0.65 + rs(2), 1.5 + rng() * 2.5, v[2] * 0.65 + rs(2)],
          0.35 + rng() * 0.35, 0.02, 0.02, 0.5, 9.8, KIND.droplet, 0.85, 0.9, 1.0, 0.35 * wetness);
      }
    }
    /** Exhaust backfire flame pop. dir = car forward (GL). */
    function emitFlame(pos, dir, count) {
      var p = vec(pos), d = vec(dir), n = count || 3;
      for (var i = 0; i < n; i++) {
        if (!budgetOk()) return;
        var s = 2 + rng() * 4;
        emitRaw([p[0] + rs(0.04), p[1] + rs(0.04), p[2] + rs(0.04)], [-d[0] * s + rs(0.5), 0.3 + rs(0.3), -d[2] * s + rs(0.5)],
          0.08 + rng() * 0.1, 0.12 + rng() * 0.08, 0.32 + rng() * 0.2, 3, -1, KIND.flame, 1, 0.75, 0.45, 0.9);
      }
    }
    function emitSplash(pos) {
      if (!budgetOk()) return;
      var p = vec(pos);
      for (var i = 0; i < 2; i++) {
        emitRaw([p[0], 0.02, p[2]], [rs(1.2), 1.2 + rng() * 1.2, rs(1.2)], 0.18 + rng() * 0.12, 0.012, 0.012, 0.5, 9.8, KIND.droplet, 0.8, 0.85, 0.95, 0.45);
      }
    }
    /** Add a skid ribbon point for (carId, wheelIdx) at GL position pos. */
    function addSkid(carId, wheelIdx, pos, intensity, width) {
      var key = String(carId) + ':' + (wheelIdx | 0), it = clamp01(num(intensity, 0.8));
      if (!pos) { skids.end(key); return; }
      skids.add(key, vec(pos), it, now, width || carTyreW[carId] || 0.24);
      if (it <= 0) skids.end(key); // intensity 0 = lift-off: write a fading tail segment, then break the ribbon
    }

    /* External callers (renderer3d) may drive emission themselves. The first external call of each kind
       switches the matching built-in auto-emitter off, so nothing is ever emitted twice. */
    var ext = { skid: false, smoke: false, dust: false, sparks: false };
    var carTyreW = {};
    function pubSmoke(pos, vel, intensity, count) { ext.smoke = true; emitSmoke(pos, vel, intensity, count); }
    function pubSparks(pos, vel, n) { ext.sparks = true; emitSparks(pos, vel, n); }
    function pubDust(pos, vel, surface, intensity) { ext.dust = true; emitDust(pos, vel, surface, intensity); }
    function pubSkid(carId, wheelIdx, pos, intensity, width) { ext.skid = true; addSkid(carId, wheelIdx, pos, intensity, width); }

    /* ------------------------------------------------------ auto emission */
    var carState = {};
    var lastSnap = null;
    var camInfo = null, prevCamPos = null, camVel = [0, 0, 0];
    var splashAcc = 0;

    function setEnvironment(tod, weather) {
      var t = normTod(tod), w = normWeather(weather);
      if (t === curTod && w === curWeather) return;
      lighting = getLighting(t, w); curTod = t; curWeather = w;
      rainIntensity = rainOverride != null ? rainOverride : lighting.rain;
      wetness = lighting.wetness;
    }

    function processCar(car, dt) {
      if (!car || car.dnf && num(car.speed, 0) < 0.5) return;
      var id = car.id != null ? car.id : 'car';
      var st = carState[id] || (carState[id] = { acc: [0, 0, 0, 0], dustAcc: 0, sprayAcc: 0, sparkAcc: 0, thr: 0, popT: 0 });
      st.seen = now;
      var fr = carFrame(car);
      var dist = 0;
      if (camInfo) {
        var dx = fr.center[0] - camInfo.pos[0], dz = fr.center[2] - camInfo.pos[2];
        dist = Math.sqrt(dx * dx + dz * dz);
      }
      var surface = car.surface || 'asphalt';
      var onRoad = surface === 'asphalt' || surface === 'kerb' || surface === 'wall' || surface === 'pit' || surface === 'road';
      var slip = wheelSlip(car);
      var tyreW = 0.24;
      var tw = car.build && car.build.tires && num(car.build.tires.width_mm, 0);
      if (tw > 0) tyreW = clamp(tw / 1000, 0.17, 0.36);
      carTyreW[id] = tyreW;
      // skid marks (always, regardless of camera distance: they persist)
      for (var w = 0; w < 4 && !ext.skid; w++) {
        var si = slip[w];
        if (onRoad && si > 0.18 && fr.speed > 1.0) {
          addSkid(id, w, fr.wheels[w], clamp01((si - 0.1) * 1.25) * (1 - wetness * 0.6), tyreW);
        } else if (skids.wheels[id + ':' + w]) skids.end(id + ':' + w);
      }
      if (dist > caps.emitRadius) { st.thr = num(car.throttle, 0); return; }
      var lod = (dist < 60 ? 1 : dist < 140 ? 0.5 : 0.25) * caps.emitScale;
      // tyre smoke (dry-ish road)
      if (onRoad && wetness < 0.8 && !ext.smoke) {
        for (var k = 0; k < 4; k++) {
          var sv = slip[k];
          if (sv > 0.32) {
            st.acc[k] += dt * 42 * Math.pow(sv, 1.5) * lod * (1 - wetness);
            while (st.acc[k] >= 1) { st.acc[k] -= 1; emitSmoke(fr.wheels[k], fr.vel, sv, 1); }
          } else st.acc[k] = 0;
        }
      }
      // off-road dust & debris
      if (!onRoad && fr.speed > 2 && !ext.dust) {
        var di = clamp01(fr.speed / 30);
        st.dustAcc += dt * 34 * di * lod;
        while (st.dustAcc >= 1) { st.dustAcc -= 1; emitDust(fr.wheels[2 + (rng() < 0.5 ? 0 : 1)], fr.vel, surface, di); if (rng() < 0.35) emitDust(fr.wheels[rng() < 0.5 ? 0 : 1], fr.vel, surface, di * 0.7); }
      } else st.dustAcc = 0;
      // wet spray
      if (wetness > 0.2 && fr.speed > 6) {
        var spi = clamp01((fr.speed - 6) / 42) * wetness;
        st.sprayAcc += dt * 46 * spi * lod;
        while (st.sprayAcc >= 1) {
          st.sprayAcc -= 1;
          var wi = rng() < 0.78 ? 2 + (rng() < 0.5 ? 0 : 1) : (rng() < 0.5 ? 0 : 1);
          var wp = fr.wheels[wi];
          emitSpray([wp[0] - fr.fwd[0] * 0.35, 0, wp[2] - fr.fwd[2] * 0.35], fr.vel, spi);
        }
      } else st.sprayAcc = 0;
      // bottoming / kerb-strike sparks for low cars
      var rh = car.build && car.build.suspension && num(car.build.suspension.rideHeight_mm, 120);
      if (surface === 'kerb' && fr.speed > 20 && rh != null && rh <= 85) {
        st.sparkAcc += dt * 5 * (1 + (85 - rh) / 30);
        while (st.sparkAcc >= 1) {
          st.sparkAcc -= 1;
          emitSparks([fr.center[0] + rs(0.6), 0.05, fr.center[2] + rs(0.6)], fr.vel, 6);
        }
      }
      // exhaust backfire on sharp lift at high rpm
      var thr = num(car.throttle, 0), rpmFrac = num(car.rpm, 0) / Math.max(1, num(car.redline, 7000));
      if (dist < 80 && st.thr > 0.85 && thr < 0.25 && rpmFrac > 0.72 && now - st.popT > 0.35) {
        st.popT = now;
        var ex = [fr.center[0] - fr.fwd[0] * (fr.halfLength - 0.05) + fr.right[0] * 0.35, 0.33, fr.center[2] - fr.fwd[2] * (fr.halfLength - 0.05) + fr.right[2] * 0.35];
        emitFlame(ex, fr.fwd, 3 + Math.floor(rng() * 3));
      }
      st.thr = thr;
    }

    function carVelById(snap, id) {
      var cars = snap.cars || [];
      for (var i = 0; i < cars.length; i++) if (cars[i] && cars[i].id === id) return carFrame(cars[i]).vel;
      return [0, 0, 0];
    }

    function processEvents(snap) {
      var ev = snap.events || [];
      for (var i = 0; i < ev.length; i++) {
        var e = ev[i];
        if (!e || (e.type !== 'collision' && e.type !== 'wall')) continue;
        if (typeof e.x !== 'number' || typeof e.y !== 'number') continue;
        var it = clamp01(num(e.intensity, 0.5));
        var p = [e.x, 0.35 + rng() * 0.2, -e.y], v = carVelById(snap, e.carId);
        if (e.type === 'wall') {
          emitSparks(p, v, 14 + 70 * it);
          for (var d = 0; d < 3 + it * 6; d++) emitDust([p[0], 0.3, p[2]], [v[0] * 0.3, 0, v[2] * 0.3], 'gravel', 0.4 + it * 0.4);
        } else {
          emitSparks(p, v, 8 + 45 * it);
          if (it > 0.4) emitSmoke(p, v, it * 0.6, 2);
        }
      }
    }

    function update(dt, snap, camera) {
      if (destroyed) return;
      dt = clamp(num(dt, 1 / 60), 0, 0.1);
      now += dt;
      emitBudget = Math.max(64, Math.floor(caps.maxParticles * 0.25));
      softAlive = pool.aliveSoft(now, KIND.mist);
      var ci = readCamera(camera);
      if (ci) {
        if (prevCamPos && dt > 0) {
          var k = 1 - Math.exp(-dt * 10);
          for (var a = 0; a < 3; a++) camVel[a] += ((ci.pos[a] - prevCamPos[a]) / dt - camVel[a]) * k;
          if (Math.abs(ci.pos[0] - prevCamPos[0]) + Math.abs(ci.pos[2] - prevCamPos[2]) > 60 * Math.max(dt, 1 / 60) * 4) camVel = [0, 0, 0]; // camera cut
        }
        prevCamPos = ci.pos.slice();
        camInfo = ci;
      }
      if (snap) {
        if (!explicitEnv) setEnvironment(snap.timeOfDay || curTod, snap.weather || curWeather);
        if (autoEmit) {
          var cars = snap.cars || [];
          for (var i = 0; i < cars.length; i++) processCar(cars[i], dt);
          if (snap !== lastSnap && !ext.sparks) processEvents(snap);
        }
        lastSnap = snap;
      }
      // rain splashes around the camera
      if (rainIntensity > 0.05 && camInfo && caps.splashRate > 0) {
        splashAcc += dt * caps.splashRate * rainIntensity;
        while (splashAcc >= 1) {
          splashAcc -= 1;
          var f = camInfo.fwd, dd = 2 + rng() * 22, side = rs(dd * 0.8);
          emitSplash([camInfo.pos[0] + f[0] * dd - f[2] * side, 0, camInfo.pos[2] + f[2] * dd + f[0] * side]);
        }
      }
      // prune cars that left the session
      if (Math.floor(now) !== Math.floor(now - dt)) {
        for (var cid in carState) if (now - carState[cid].seen > 3) delete carState[cid];
        skids.prune(now);
      }
    }

    /* ------------------------------------------------------- GL drawing */
    var savedState = null;
    function beginState() {
      var vao = null;
      try {
        if (isGL2) vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        else if (vaoExt) vao = gl.getParameter(vaoExt.VERTEX_ARRAY_BINDING_OES);
      } catch (e) { vao = null; }
      if (isGL2) gl.bindVertexArray(null);
      else if (vaoExt) vaoExt.bindVertexArrayOES(null);
      savedState = {
        blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE),
        poly: gl.isEnabled(gl.POLYGON_OFFSET_FILL), program: gl.getParameter(gl.CURRENT_PROGRAM), vao: vao
      };
    }
    function endState() {
      var s = savedState || { blend: false, depth: true, cull: false, poly: false };
      gl.depthMask(true);
      gl.depthFunc(gl.LESS);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (s.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      if (s.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      if (s.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
      if (s.poly) gl.enable(gl.POLYGON_OFFSET_FILL); else gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      if (s.vao) { if (isGL2) gl.bindVertexArray(s.vao); else if (vaoExt) vaoExt.bindVertexArrayOES(s.vao); }
      else gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      gl.useProgram(s.program || null);
      savedState = null;
    }
    var enabledAttribs = [];
    function attrib(prog, name, size, stride, offset) {
      var loc = prog.a[name];
      if (loc == null || loc < 0) return;
      gl.enableVertexAttribArray(loc);
      if (isGL2) gl.vertexAttribDivisor(loc, 0); else if (instExt) instExt.vertexAttribDivisorANGLE(loc, 0);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      enabledAttribs.push(loc);
    }
    function disableAttribs() {
      for (var i = 0; i < enabledAttribs.length; i++) gl.disableVertexAttribArray(enabledAttribs[i]);
      enabledAttribs.length = 0;
    }
    function viewportSize(ci) {
      if (ci.viewport) {
        var vp = ci.viewport;
        return vp.length >= 4 ? [vp[2], vp[3]] : [vp[0], vp[1]];
      }
      var v = gl.getParameter(gl.VIEWPORT);
      if (v && v[2]) return [v[2], v[3]];
      return [gl.drawingBufferWidth || 1, gl.drawingBufferHeight || 1];
    }
    function u(prog, name) { return prog.u[name]; }
    function uploadDirty(buf, src, floatsPerItem, ranges) {
      if (!ranges.length) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (var i = 0; i < ranges.length; i++) {
        var s = ranges[i][0] * floatsPerItem, n = ranges[i][1] * floatsPerItem;
        gl.bufferSubData(gl.ARRAY_BUFFER, s * 4, src.subarray(s, s + n));
      }
    }

    function drawSkidsGL(ci) {
      var n = skids.count();
      uploadDirty(sBuf, skids.data, 4 * S_STRIDE, skids.takeDirty());
      if (!n) return;
      var p = progs.skids;
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(u(p, 'uView'), false, ci.view);
      gl.uniformMatrix4fv(u(p, 'uProj'), false, ci.proj);
      gl.uniform1f(u(p, 'uTime'), now);
      gl.uniform1f(u(p, 'uFade'), caps.skidFade);
      gl.uniform1f(u(p, 'uHeadSeq'), skids.seq);
      gl.uniform1f(u(p, 'uCap'), skids.cap);
      gl.uniform1f(u(p, 'uFogDensity'), lighting.fogDensity);
      gl.uniform1f(u(p, 'uWetMul'), 1 - wetness * 0.35);
      gl.bindBuffer(gl.ARRAY_BUFFER, sBuf);
      attrib(p, 'aPos', 3, S_STRIDE, 0);
      attrib(p, 'aData', 4, S_STRIDE, 3);
      attrib(p, 'aSeq', 1, S_STRIDE, 7);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIdx);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -4);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      disableAttribs();
    }

    function drawParticlesGL(ci) {
      var n = pool.count();
      uploadDirty(pBuf, pool.data, P_STRIDE, pool.takeDirty());
      if (!n || now > pool.maxDeath + 0.1) return;
      var p = progs.particles, vs = viewportSize(ci);
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(u(p, 'uView'), false, ci.view);
      gl.uniformMatrix4fv(u(p, 'uProj'), false, ci.proj);
      gl.uniform1f(u(p, 'uTime'), now);
      gl.uniform3fv(u(p, 'uWind'), lighting.wind);
      gl.uniform2f(u(p, 'uViewport'), vs[0], vs[1]);
      gl.uniform1f(u(p, 'uMaxPoint'), Math.min(caps.maxPointPx * Math.max(1, vs[1] / 900), maxPointHW));
      gl.uniform3fv(u(p, 'uLight'), lighting.particleLight);
      gl.uniform3fv(u(p, 'uFogColor'), lighting.fogColor);
      gl.uniform1f(u(p, 'uFogDensity'), lighting.fogDensity);
      gl.bindBuffer(gl.ARRAY_BUFFER, pBuf);
      attrib(p, 'aPos', 3, P_STRIDE, 0);
      attrib(p, 'aVel', 3, P_STRIDE, 3);
      attrib(p, 'aTime', 4, P_STRIDE, 6);
      attrib(p, 'aParams', 4, P_STRIDE, 10);
      attrib(p, 'aColor', 4, P_STRIDE, 14);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, n);
      disableAttribs();
    }

    function drawRainGL(ci) {
      var inten = rainIntensity;
      if (inten <= 0.02 || !rainCount) return;
      var count = Math.max(1, Math.floor(rainCount * clamp01(inten)));
      var p = progs.rain, vs = viewportSize(ci);
      var box = [34, 20, 34], f = ci.fwd;
      var center = [ci.pos[0] + f[0] * 12, ci.pos[1] + 5, ci.pos[2] + f[2] * 12];
      var fall = [lighting.wind[0] * 0.6, -10.5, lighting.wind[2] * 0.6];
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(u(p, 'uView'), false, ci.view);
      gl.uniformMatrix4fv(u(p, 'uProj'), false, ci.proj);
      gl.uniform1f(u(p, 'uTime'), now);
      gl.uniform3fv(u(p, 'uCenter'), center);
      gl.uniform3fv(u(p, 'uBox'), box);
      gl.uniform3fv(u(p, 'uFall'), fall);
      gl.uniform3fv(u(p, 'uCamVel'), [clamp(camVel[0], -90, 90), clamp(camVel[1], -20, 20), clamp(camVel[2], -90, 90)]);
      gl.uniform1f(u(p, 'uStreak'), 0.045);
      gl.uniform2f(u(p, 'uViewport'), vs[0], vs[1]);
      gl.uniform3fv(u(p, 'uCamPos'), ci.pos);
      gl.uniform1f(u(p, 'uWidthPx'), Math.max(1.25, vs[1] / 560));
      // drops refract the bright sky: mostly horizon colour, a little lit-particle colour
      var lc = lighting.particleLight, hz = lighting.skyHorizon;
      gl.uniform3fv(u(p, 'uColor'), [Math.min(1, hz[0] * 0.6 + lc[0] * 0.5 + 0.1), Math.min(1, hz[1] * 0.6 + lc[1] * 0.5 + 0.1), Math.min(1, hz[2] * 0.6 + lc[2] * 0.5 + 0.12)]);
      gl.uniform1f(u(p, 'uAlpha'), 0.6 * clamp01(inten));
      gl.bindBuffer(gl.ARRAY_BUFFER, rBuf);
      attrib(p, 'aSeed', 3, 5, 0);
      attrib(p, 'aCorner', 2, 5, 3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, rIdx);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_SHORT, 0);
      disableAttribs();
    }

    var invRot = new Float32Array(9);
    function drawSkyGL(ci, tod, weather) {
      var L = (tod || weather) ? getLightingCached(tod || curTod, weather || curWeather) : lighting;
      var p = skyProgram(), pr = ci.proj;
      gl.useProgram(p.program);
      gl.uniformMatrix3fv(u(p, 'uInvViewRot'), false, invViewRot3(ci.view, invRot));
      gl.uniform4f(u(p, 'uProjInfo'), 1 / pr[0], 1 / pr[5], -pr[8], -pr[9]);
      gl.uniform3fv(u(p, 'uSunDir'), L.sunDir);
      gl.uniform3fv(u(p, 'uMoonDir'), L.moonDir);
      gl.uniform3fv(u(p, 'uSunColor'), L.sunColor);
      gl.uniform1f(u(p, 'uSunSize'), L.sunSize);
      gl.uniform1f(u(p, 'uSunVis'), L.sunVisible);
      gl.uniform1f(u(p, 'uMoonVis'), L.moonVisible);
      gl.uniform3fv(u(p, 'uZenith'), L.skyZenith);
      gl.uniform3fv(u(p, 'uBand'), L.skyBand);
      gl.uniform3fv(u(p, 'uHorizon'), L.skyHorizon);
      gl.uniform3fv(u(p, 'uGround'), L.skyGround);
      gl.uniform3fv(u(p, 'uFogColor'), L.fogColor);
      gl.uniform3fv(u(p, 'uGlow'), L.sunGlow);
      gl.uniform1f(u(p, 'uGlowAmt'), L.glowAmount);
      gl.uniform3fv(u(p, 'uLightPol'), L.lightPollution);
      gl.uniform1f(u(p, 'uCover'), L.cloudCover);
      gl.uniform1f(u(p, 'uOvercast'), L.overcast);
      gl.uniform3fv(u(p, 'uCloudCol'), L.cloudColor);
      gl.uniform3fv(u(p, 'uCloudShade'), L.cloudShade);
      gl.uniform2f(u(p, 'uCloudOff'), now * L.windDir[0] * L.windSpeed * 0.0035, now * L.windDir[2] * L.windSpeed * 0.0035);
      gl.uniform1f(u(p, 'uStars'), L.stars);
      gl.uniform1f(u(p, 'uTime'), now);
      gl.uniform1f(u(p, 'uLinearOut'), linearOut ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, skyBuf);
      var loc = p.a.aPos;
      gl.enableVertexAttribArray(loc);
      if (isGL2) gl.vertexAttribDivisor(loc, 0); else if (instExt) instExt.vertexAttribDivisorANGLE(loc, 0);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 8, 0);
      enabledAttribs.push(loc);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
      gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      disableAttribs();
    }
    var skyLCache = {};
    function getLightingCached(t, w) {
      var k = normTod(t) + '|' + normWeather(w);
      return skyLCache[k] || (skyLCache[k] = getLighting(t, w));
    }

    function guard(fn) {
      return function (camera) {
        if (destroyed) return;
        var ci = readCamera(camera) || camInfo;
        if (!ci) return;
        beginState();
        try { fn(ci, arguments[1], arguments[2]); }
        finally { disableAttribs(); endState(); }
      };
    }
    var drawSky = guard(drawSkyGL);
    var drawSkids = guard(drawSkidsGL);
    var drawParticles = guard(drawParticlesGL);
    var drawRain = guard(drawRainGL);
    /** Draw all world-space transparent effects (skids, particles, rain) — call after opaque geometry. */
    var draw = guard(function (ci) { drawSkidsGL(ci); drawParticlesGL(ci); drawRainGL(ci); });

    /* Draw items usable by any drawList convention: a custom item exposes draw(camera); a mesh-style
       drawList that calls item.mesh.draw(program) gets the same effect (program argument ignored).
       Items are huge-bounded (never frustum-culled), transparent, cast no shadow and carry an identity
       model + a far-away sort depth so they render after the other transparents in back-to-front order. */
    var IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    var BIG = { min: [-1e6, -1e3, -1e6], max: [1e6, 1e4, 1e6], center: [0, 0, 0], radius: 1e7 };
    var itemCache = null, itemCam = null;
    function fxItem(kind, order, fn) {
      var it = {
        kind: kind, custom: true, transparent: true, order: order, castShadow: false, noCull: true, model: IDENT,
        bounds: BIG, sortDepth: -1e9 + order, material: { transparent: true }, program: null,
        draw: function (cam) { fn(cam && (cam.view || cam.viewMatrix) ? cam : itemCam); }
      };
      it.mesh = { custom: true, bounds: BIG, vertexCount: 0, draw: function () { fn(itemCam); }, destroy: function () {} };
      return it;
    }
    function drawItems(camera) {
      itemCam = camera || itemCam;
      if (!itemCache) itemCache = [fxItem('effects-skids', 10, drawSkids), fxItem('effects-particles', 20, drawParticles), fxItem('effects-rain', 30, drawRain)];
      return itemCache;
    }

    function setQuality(q, maxParticles) {
      var po = num(maxParticles, particleOverride);
      if (!QUALITY[q] || (q === quality && po === particleOverride)) return;
      quality = q; particleOverride = po; resolveCaps();
      allocate();
    }

    function stats() {
      return {
        quality: quality, time: now, particlesAlive: pool.alive(now), particleCap: pool.cap,
        skidSegments: skids.count(), skidCap: skids.cap, rainDrops: rainIntensity > 0.02 ? Math.floor(rainCount * clamp01(rainIntensity)) : 0,
        cars: Object.keys(carState).length
      };
    }

    function clear() { pool.clear(); skids.clear(); carState = {}; carTyreW = {}; lastSnap = null; prevCamPos = null; camVel = [0, 0, 0]; }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      [pBuf, sBuf, sIdx, rBuf, rIdx, skyBuf].forEach(function (b) { if (b) gl.deleteBuffer(b); });
      ['particles', 'skids', 'rain', 'sky'].forEach(function (k) { if (progs[k]) gl.deleteProgram(progs[k].program); });
    }

    var api = {
      emitSmoke: pubSmoke, emitSparks: pubSparks, emitDust: pubDust, emitSpray: emitSpray, emitFlame: emitFlame,
      addSkid: pubSkid,
      update: update,
      draw: draw, render: draw, drawSkids: drawSkids, drawParticles: drawParticles, drawRain: drawRain, drawItems: drawItems,
      drawSky: drawSky,
      sky: {
        draw: drawSky,
        getLighting: function (t, w) { return getLighting(t || curTod, w || curWeather); }
      },
      rain: {
        draw: drawRain,
        get intensity() { return rainIntensity; },
        setIntensity: function (v) { rainOverride = v == null ? null : clamp01(num(v, 0)); rainIntensity = rainOverride != null ? rainOverride : lighting.rain; },
        get wetness() { return wetness; }
      },
      getLighting: function (t, w) { return t || w ? getLighting(t || curTod, w || curWeather) : cloneLighting(lighting); },
      setEnvironment: function (t, w) { explicitEnv = true; setEnvironment(t, w); },
      setTimeOfDay: function (t) { explicitEnv = true; setEnvironment(t, curWeather); },
      setWeather: function (w) { explicitEnv = true; setEnvironment(curTod, w); },
      reset: clear,
      setQuality: setQuality,
      getQuality: function () { return quality; },
      setAutoEmit: function (b) { autoEmit = !!b; },
      setLinearOutput: function (b) { linearOut = !!b; },
      clear: clear, stats: stats, destroy: destroy,
      get time() { return now; }
    };
    if (!skyProgram()) throw new Error('[CB.gl.effects] sky program failed');
    return api;
  }

  var effects = {
    create: create,
    getLighting: getLighting,
    QUALITY: QUALITY,
    _internal: {
      ParticlePool: ParticlePool, SkidBuffer: SkidBuffer, carFrame: carFrame, wheelSlip: wheelSlip, driveLayout: driveLayout,
      camPosFromView: camPosFromView, camFwdFromView: camFwdFromView, invViewRot3: invViewRot3, readCamera: readCamera,
      qualityCaps: qualityCaps, mulberry32: mulberry32, KIND: KIND, P_STRIDE: P_STRIDE, S_STRIDE: S_STRIDE,
      shaders: { PARTICLE_VS: PARTICLE_VS, PARTICLE_FS: PARTICLE_FS, SKID_VS: SKID_VS, SKID_FS: SKID_FS, RAIN_VS: RAIN_VS, RAIN_FS: RAIN_FS, SKY_VS: SKY_VS, skyFS: skyFS }
    }
  };
  CB.gl.effects = effects;
  if (typeof module !== 'undefined' && module.exports) module.exports = effects;
})();

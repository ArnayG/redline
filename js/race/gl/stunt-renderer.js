/* ==========================================================================
   Redline — js/race/gl/stunt-renderer.js
   CB.arcade.stunt.renderer : WebGL renderer for the 3D stunt tracks — same surface as CB.race.renderer3d:
     isSupported() -> bool
     create(canvas, sessionOrTrack, opts {quality 'low'|'medium'|'high'|'ultra', camera, timeOfDay, autoQuality})
       -> { render(snap, alpha?), setCamera(mode), cycleCamera(), getCamera(), cameraModes(), setLookBack(bool),
            resize(), setQuality(q), getQuality(), stats(), destroy() }
   `canvas` is the HUD 2D canvas: we insert our own GL canvas right before it (absolutely positioned on top of the same
   box, pointer-events none), make the 2D canvas transparent and clear it every frame (HUD draws after render()).
   We also paint two cheap 2D overlays into it before the HUD: arcade speed lines while boosting and the respawn fade.

   Uses CB.gl core (context, meshes, drawList, shadow map, post FX, particles), CB.gl.stunt (track meshes),
   CB.gl.car (car models + pose; box fallback) and CB.gl.effects (sky + lighting presets) — all feature-detected.
   Cameras: 'chase' (default; follows the TRACK UP vector with critically damped vector springs so it rolls through
   loops / corkscrews without ever flipping), 'chase-far', 'hood', 'cockpit', 'tv' (replay-style trackside cams).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};
CB.arcade.stunt = CB.arcade.stunt || {};

(function (S) {
  'use strict';

  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  var MODES = ['chase', 'chase-far', 'hood', 'cockpit', 'tv'];
  var LABELS = { chase: 'Chase', 'chase-far': 'Chase (far)', hood: 'Hood', cockpit: 'Cockpit', tv: 'Replay cams' };
  var QUALITY = {
    low: { dpr: 1, scale: 0.8, shadow: 0, post: false, particles: 300, lodHigh: 1, far: 2200 },
    medium: { dpr: 1.25, scale: 1, shadow: 1024, post: true, particles: 600, lodHigh: 3, far: 2800 },
    high: { dpr: 1.5, scale: 1, shadow: 2048, post: true, particles: 1200, lodHigh: 5, far: 3600 },
    ultra: { dpr: 2, scale: 1, shadow: 2048, post: true, particles: 2000, lodHigh: 12, far: 4200 }
  };
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function madd(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rotAxis(v, k, a) {
    var c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  }
  function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function hexRgb(h, d) {
    if (typeof h !== 'string') return d;
    h = h.replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16); if (!isFinite(n)) return d;
    return [Math.pow(((n >> 16) & 255) / 255, 2.2), Math.pow(((n >> 8) & 255) / 255, 2.2), Math.pow((n & 255) / 255, 2.2)];
  }

  /* ------------------------------------------------------------------ pure camera helpers (Node-testable) */
  /** Critically damped smoothing of a unit vector toward a target (never flips: renormalised, rate-limited slerp-ish). */
  function smoothDir(cur, target, rate, dt) {
    var k = 1 - Math.exp(-rate * dt);
    var d = clamp(dot(cur, target), -1, 1);
    if (d < -0.995) {   // exactly opposite: rotate through a perpendicular instead of collapsing through zero
      var perp = norm(cross(cur, Math.abs(cur[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      return norm(rotAxis(cur, perp, PI * k));
    }
    return norm(lerp3(cur, target, k));
  }
  /** Chase-camera rig: returns {eye, target, up}; state {fwd, up, init} is carried between frames. */
  function chaseRig(st, pose, dt, o) {
    o = o || {};
    var dist = num(o.dist, 7.2), height = num(o.height, 2.4), look = num(o.look, 4);
    if (!st.init) { st.fwd = pose.fwd.slice(); st.up = pose.up.slice(); st.init = true; }
    st.up = smoothDir(st.up, pose.up, num(o.upRate, 5.5), dt);
    st.fwd = smoothDir(st.fwd, pose.fwd, num(o.fwdRate, 7), dt);
    // orthonormalise (forward wins) so lookAt never sees a degenerate up
    var up = norm(madd(st.up, st.fwd, -dot(st.up, st.fwd)));
    if (!isFinite(up[0]) || Math.abs(dot(up, st.fwd)) > 0.98) up = pose.up.slice();
    st.up = up;
    var back = num(o.back, 1);
    var eye = add(add(pose.pos, mul(st.fwd, -dist * back)), mul(up, height));
    var target = add(add(pose.pos, mul(up, 1.1)), mul(st.fwd, look * back));
    return { eye: eye, target: target, up: up };
  }

  function isSupported() {
    var G = CB.gl;
    if (!G || typeof G.createContext !== 'function' || typeof G.drawList !== 'function' || !CB.gl.stunt) return false;
    return typeof G.isSupported === 'function' ? !!G.isSupported() : true;
  }

  /* ================================================================== create */
  function create(canvas, source, opts) {
    opts = opts || {};
    var G = CB.gl, M4 = G.mat4;
    var track = source && typeof source.sample === 'function' ? source : source && source.track ? source.track : null;
    if (!track) throw new Error('stunt renderer: needs a stunt session or track');
    var R = {
      quality: QUALITY[opts.quality] ? opts.quality : 'high', mode: ['chase-far', 'hood', 'tv'].indexOf(opts.camera) >= 0 ? opts.camera : 'chase', lookBack: false,
      cars: {}, frame: 0, lastT: 0, time: 0, stats: { fps: 0, ms: 0, draws: 0, tris: 0 }, shake: 0, fov: 70, rig: {}, tvIdx: -1, tvT: 0, prevPlayer: null,
      ema: 16, slowT: 0
    };
    var Q = QUALITY[R.quality];
    /* ---- DOM ---- */
    var doc = canvas.ownerDocument || document;
    var glc = doc.createElement('canvas');
    glc.className = 'stunt-gl-canvas';
    glc.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block;';
    var parent = canvas.parentNode;
    if (parent) {
      parent.insertBefore(glc, canvas);
      var cs = (doc.defaultView && doc.defaultView.getComputedStyle) ? doc.defaultView.getComputedStyle(parent) : null;
      if (cs && cs.position === 'static') parent.style.position = 'relative';
    }
    function placeGL() {
      glc.style.left = canvas.offsetLeft + 'px'; glc.style.top = canvas.offsetTop + 'px';
      glc.style.width = canvas.clientWidth + 'px'; glc.style.height = canvas.clientHeight + 'px';
    }
    var prevBg = canvas.style.background;
    canvas.style.background = 'transparent';
    var ctx = G.createContext(glc, { antialias: !Q.post, alpha: false });
    if (!ctx) throw new Error('stunt renderer: WebGL unavailable');
    var gl = ctx.gl;
    var world = G.stunt.build(ctx, track, { quality: R.quality });
    var shadow = null, post = null, particles = null, fx = null;
    function setupQuality() {
      Q = QUALITY[R.quality];
      if (shadow) { try { shadow.destroy(); } catch (e) { /* ignore */ } shadow = null; }
      if (Q.shadow) { try { shadow = G.createShadowMap(ctx, Q.shadow); if (shadow && shadow.ok === false) shadow = null; } catch (e) { shadow = null; } }
      if (post) { try { post.destroy(); } catch (e) { /* ignore */ } post = null; }
      if (Q.post && typeof G.createPostFX === 'function') { try { post = G.createPostFX(ctx, { samples: 4, bloomScale: 0.25 }); } catch (e) { post = null; } }
      if (particles) { try { particles.destroy(); } catch (e) { /* ignore */ } }
      particles = typeof G.createParticles === 'function' ? G.createParticles(ctx, Q.particles) : null;
    }
    setupQuality();
    try { if (CB.gl.effects && typeof CB.gl.effects.create === 'function') fx = CB.gl.effects.create(ctx, { quality: R.quality, timeOfDay: 'day', weather: 'dry', geom: track.geom2D, autoEmit: false, linearOutput: !!post }); } catch (e) { fx = null; }

    /* ---- lighting per time of day / theme ---- */
    var LIGHT = {};
    function lighting(tod) {
      if (LIGHT[tod]) return LIGHT[tod];
      var L = null;
      try { if (fx && fx.getLighting) L = fx.getLighting(tod, 'dry'); else if (CB.gl.effects && CB.gl.effects.getLighting) L = CB.gl.effects.getLighting(tod, 'dry'); } catch (e) { L = null; }
      var base = tod === 'night' ? { sunDir: [0.3, 0.62, 0.42], sunColor: [0.22, 0.24, 0.34], ambientSky: [0.12, 0.12, 0.22], ambientGround: [0.05, 0.04, 0.07], fogColor: [0.03, 0.03, 0.07], fogDensity: 0.0012, envTop: [0.01, 0.01, 0.04], envHorizon: [0.1, 0.06, 0.16], envBottom: [0.02, 0.02, 0.03], exposure: 1.15 }
        : tod === 'dusk' ? { sunDir: [0.82, 0.22, -0.55], sunColor: [1.5, 0.82, 0.48], ambientSky: [0.36, 0.32, 0.46], ambientGround: [0.18, 0.13, 0.1], fogColor: [0.66, 0.46, 0.42], fogDensity: 0.0009, envTop: [0.18, 0.22, 0.44], envHorizon: [0.98, 0.58, 0.36], envBottom: [0.16, 0.12, 0.12], exposure: 1.0 }
          : { sunDir: [-0.42, 0.78, -0.46], sunColor: [1.35, 1.27, 1.12], ambientSky: [0.5, 0.58, 0.7], ambientGround: [0.26, 0.24, 0.19], fogColor: [0.72, 0.8, 0.9], fogDensity: 0.0006, envTop: [0.3, 0.5, 0.84], envHorizon: [0.8, 0.86, 0.93], envBottom: [0.26, 0.25, 0.22], exposure: 0.95 };
      if (L && L.sunDir) {
        base.sunDir = L.sunDir.slice(); if (L.sunColor) base.sunColor = L.sunColor.slice();
        if (L.ambientSky) base.ambientSky = L.ambientSky.slice(); if (L.ambientGround) base.ambientGround = L.ambientGround.slice();
        if (L.fogColor) base.fogColor = L.fogColor.slice(); if (L.skyZenith) base.envTop = L.skyZenith.slice(); if (L.skyHorizon) base.envHorizon = L.skyHorizon.slice();
        if (L.skyGround) base.envBottom = L.skyGround.slice();
        if (tod === 'night') { base.ambientSky = mul(base.ambientSky, 1.8); base.sunColor = mul(base.sunColor, 1.6); }
      }
      if (base.sunDir[1] < 0.15) { base.sunDir[1] = 0.15; }
      base.sunDir = norm(base.sunDir);
      var lin = function (c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; };
      base.fogColor = lin(base.fogColor); base.envTop = lin(base.envTop); base.envHorizon = lin(base.envHorizon); base.envBottom = lin(base.envBottom);
      base.fogDensity *= 0.6;
      LIGHT[tod] = base;
      return base;
    }

    /* ---- cars ---- */
    var IDENT = M4.create();
    var fallbackGeo = null;
    function fallbackModel(c) {
      if (!fallbackGeo) {
        var Gm = CB.gl.stunt._.Geo, g = new Gm(), col = [1, 1, 1, 1];
        g.box([0, 0.62, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 2.2, 0.32, 0.92, col);
        g.box([-0.2, 1.08, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1.1, 0.22, 0.78, [0.15, 0.17, 0.2, 1]);
        var wg = new Gm();
        [[1.35, 0.95], [1.35, -0.95], [-1.35, 0.95], [-1.35, -0.95]].forEach(function (w) { wg.cyl([w[0], 0.36, w[1] - 0.14], [w[0], 0.36, w[1] + 0.14], 0.36, 0.36, 10, [0.04, 0.04, 0.045, 1], true); });
        fallbackGeo = { body: G.createMesh(ctx, g.out()), wheels: G.createMesh(ctx, wg.out()) };
      }
      var rgb = hexRgb(c.color, [0.8, 0.1, 0.1]);
      return {
        _fallback: true, dims: { length: 4.4, width: 1.9, height: 1.3, wheelRadius: 0.36 }, cockpitEye: [-0.2, 1.15, -0.35], hoodCam: [0.6, 1.25, 0],
        parts: [
          { mesh: fallbackGeo.body, material: { color: [rgb[0], rgb[1], rgb[2], 1], roughness: 0.3, clearcoat: 0.9, metallic: 0.3 }, local: IDENT, kind: 'body' },
          { mesh: fallbackGeo.wheels, material: { color: [1, 1, 1, 1], roughness: 0.8 }, local: IDENT, kind: 'wheels', attach: 'car' }
        ]
      };
    }
    function defaultBuild() { try { return CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null; } catch (e) { return null; } }
    function carEntry(c) {
      var e = R.cars[c.id];
      if (!e) e = R.cars[c.id] = { models: {}, pst: {}, items: [], M: M4.create(), prev: null, view: {}, flameT: 0, lastLand: 0 };
      return e;
    }
    function modelFor(e, c, lod) {
      if (e.models[lod]) return e.models[lod];
      var m = null;
      var b = c.build || defaultBuild();
      if (CB.gl.car && typeof CB.gl.car.build === 'function' && b) {
        try { m = CB.gl.car.build(ctx, b, { number: c.number, color: c.color, accent: c.accent, lod: lod, id: c.id, name: c.name, isPlayer: !!c.isPlayer, bodyStyle: c.bodyStyle }); } catch (err) { m = null; }
      }
      if (!m || !m.parts) m = fallbackModel(c);
      e.models[lod] = m;
      return m;
    }
    /** World matrix from a frame (car-local +X forward, +Y up, +Z right). */
    function frameMatrix(o, pos, fwd, up) {
      var r = cross(fwd, up);
      o[0] = fwd[0]; o[1] = fwd[1]; o[2] = fwd[2]; o[3] = 0;
      o[4] = up[0]; o[5] = up[1]; o[6] = up[2]; o[7] = 0;
      o[8] = r[0]; o[9] = r[1]; o[10] = r[2]; o[11] = 0;
      o[12] = pos[0]; o[13] = pos[1]; o[14] = pos[2]; o[15] = 1;
      return o;
    }
    var tmpM = M4.create(), bodyOff = M4.create();
    function poseCar(e, c, pose, dt, out) {
      var model = e.model;
      var items = null, P = CB.gl.car && CB.gl.car.pose;
      var cv = e.view;
      cv.x = 0; cv.y = 0; cv.heading = 0; cv.speed = c.speed; cv.steerAngle = c.steerAngle; cv.brake = c.brake; cv.throttle = c.throttle;
      cv.gear = c.vSigned < -0.5 ? -1 : 1; cv.headlights = R.tod !== 'day'; cv.lightsOn = cv.headlights; cv.wheelspin = 0; cv.skidding = 0; cv.surface = 'asphalt';
      if (P && !model._fallback) { try { items = P(model, cv, dt, e.pst); } catch (err) { items = null; } }
      if (!items) {
        items = e.fbItems || (e.fbItems = model.parts.map(function (p) { return { mesh: p.mesh, material: p.material, model: M4.create(), kind: p.kind, part: p, castShadow: true }; }));
        for (var q = 0; q < items.length; q++) M4.copy(items[q].model, items[q].part.local || IDENT);
      }
      // visual spin (items / respawn spins) about the car's up axis, suspension heave, hop
      var fwd = pose.fwd, up = pose.up;
      if (c.visualYaw) fwd = norm(rotAxis(fwd, up, c.visualYaw));
      var pos = madd(pose.pos, up, num(c.hop, 0));
      frameMatrix(e.M, pos, fwd, up);
      M4.identity(bodyOff); bodyOff[13] = clamp(num(c.susp, 0), -0.3, 0.2);
      out.length = 0;
      var W = e.items;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var w = W[i] || (W[i] = { model: M4.create() });
        w.mesh = it.mesh; w.material = it.material; w.program = it.program; w.kind = it.kind; w.castShadow = it.castShadow !== false;
        w.transparent = it.transparent || (it.material && it.material.transparent);
        var attach = it.part && it.part.attach;
        if (attach === 'wheel' || attach === 'caliper' || attach === 'car') M4.multiply(w.model, e.M, it.model);
        else { M4.multiply(tmpM, bodyOff, it.model); M4.multiply(w.model, e.M, tmpM); }
        out.push(w);
      }
      W.length = items.length;
      return out;
    }

    /* ---- particles (CPU, uploaded each frame) ---- */
    var PS = [], PMAX = Q.particles;
    function spawn(p) { if (PS.length >= PMAX) PS.shift(); PS.push(p); }
    function emitSparks(pos, vel, n, col) {
      for (var i = 0; i < n; i++) {
        var a = Math.random() * TAU, b = Math.random() * 0.8;
        spawn({ p: pos.slice(), v: add(mul(vel, 0.5), [Math.cos(a) * 6 * b, 2 + Math.random() * 5, Math.sin(a) * 6 * b]), life: 0.35 + Math.random() * 0.35, age: 0, size: 0.18, col: col || [3, 1.6, 0.4, 1], add: true, g: 1 });
      }
    }
    function emitDust(pos, n, col) {
      for (var i = 0; i < n; i++) {
        var a = Math.random() * TAU;
        spawn({ p: madd(pos, [Math.cos(a), 0, Math.sin(a)], Math.random() * 1.5), v: [Math.cos(a) * 3, 1 + Math.random() * 2, Math.sin(a) * 3], life: 0.8 + Math.random() * 0.6, age: 0, size: 1.6, grow: 2.5, col: col || [0.7, 0.68, 0.62, 0.5], add: false, g: -0.2 });
      }
    }
    /** exhaust flame puffs: they inherit the car's velocity (vel) and are pre-stepped by one frame, so they leave the
        tip itself instead of trailing metres behind the car at speed */
    function emitFlame(pos, back, vel, strength, blue, dt) {
      for (var i = 0; i < 2; i++) {
        var j = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
        var v = add(add(vel, mul(back, 6 + Math.random() * 4)), mul(j, 0.6));
        spawn({ p: madd(madd(pos, j, 0.04), v, -num(dt, 0)), v: v, life: 0.08 + Math.random() * 0.06, age: 0, size: 0.26 * strength, grow: -1.2, col: blue ? [0.6, 1.4, 4, 1] : [4, 1.6, 0.4, 1], add: true, g: 0 });
      }
    }
    /** world exhaust tips of a posed car: the model's anchors.exhaust (def.exhaust overrides included) through the
        frame poseCar() drew (interpolated pose + visual spin / slide yaw + hop, suspension heave, car.pose() body pitch) */
    var exTmp = [0, 0, 0];
    function exhaustTips(e, c) {
      var m = e.model, ex = m && m.anchors && m.anchors.exhaust, out = [];
      if ((!ex || !ex.length) && e.models.high && e.models.high.anchors) ex = e.models.high.anchors.exhaust;   // low LOD: no anchors
      var B = e.pst && e.pst.bodyMatrix, M = e.M, sy = clamp(num(c.susp, 0), -0.3, 0.2);
      function put(x, y, z) {
        var q = exTmp;
        if (B) { q[0] = B[0] * x + B[4] * y + B[8] * z + B[12]; q[1] = B[1] * x + B[5] * y + B[9] * z + B[13] + sy; q[2] = B[2] * x + B[6] * y + B[10] * z + B[14]; }
        else { q[0] = x; q[1] = y + sy; q[2] = z; }
        out.push([M[0] * q[0] + M[4] * q[1] + M[8] * q[2] + M[12], M[1] * q[0] + M[5] * q[1] + M[9] * q[2] + M[13], M[2] * q[0] + M[6] * q[1] + M[10] * q[2] + M[14]]);
      }
      if (ex && ex.length) { for (var i = 0; i < ex.length && i < 4; i++) if (ex[i]) put(num(ex[i][0], 0), num(ex[i][1], 0.3), num(ex[i][2], 0)); }
      else if (!ex || !e.models.high) {
        var d = (m && m.dims) || {}, L = num(d.length, 4.4) / 2, W = num(d.width, 1.9) / 2;
        put(-L * 0.98, 0.32, W * 0.4); put(-L * 0.98, 0.32, -W * 0.4);
      }
      return out;
    }
    function stepParticles(dt) {
      for (var i = PS.length - 1; i >= 0; i--) {
        var p = PS[i];
        p.age += dt;
        if (p.age >= p.life) { PS.splice(i, 1); continue; }
        p.v[1] -= 9.8 * p.g * dt;
        p.p[0] += p.v[0] * dt; p.p[1] += p.v[1] * dt; p.p[2] += p.v[2] * dt;
      }
      if (!particles) return;
      var n = Math.min(PS.length, particles.max);
      for (var k = 0; k < n; k++) {
        var q = PS[k], t = q.age / q.life, a = q.col[3] * (1 - t);
        particles.set(k, q.p[0], q.p[1], q.p[2], q.col[0] * a, q.col[1] * a, q.col[2] * a, a, Math.max(0.02, q.size + num(q.grow, 0) * q.age), 0, q.add ? 0.2 : 0.7, q.add);
      }
      particles.upload(n);
    }

    /* ---- dynamic feature items ---- */
    var dynItems = [];
    var MAT = {
      box: { color: [1, 1, 1, 0.85], unlit: true, transparent: true, castShadow: false },
      can: { color: [1, 1, 1, 1], roughness: 0.25, metallic: 0.6, clearcoat: 0.8 },
      coin: { color: [1, 1, 1, 1], unlit: true, castShadow: false },
      ring: { color: [1, 1, 1, 1], unlit: true, castShadow: false },
      lampOff: { color: [0.05, 0.02, 0.02, 1], roughness: 0.4 },
      lampRed: { color: [1, 1, 1, 1], unlit: true, emissive: [0, 0, 0], castShadow: false },
      lampGreen: { color: [1, 1, 1, 1], unlit: true, castShadow: false },
      ent: { color: [1, 1, 1, 1], unlit: true, castShadow: false },
      oil: { color: [0.02, 0.02, 0.04, 0.92], transparent: true, roughness: 0.05, metallic: 0.3, castShadow: false },
      rocket: { color: [1, 0.2, 0.15, 1], unlit: true, castShadow: false }
    };
    MAT.lampRed.color = [4, 0.15, 0.1, 1]; MAT.lampGreen.color = [0.3, 4, 0.6, 1];
    var dynPool = [];
    function dynItem(mesh, mat, pos, fwd, up, scale, spin) {
      var it = dynPool[dynItems.length] || (dynPool[dynItems.length] = { model: M4.create() });
      var f = fwd, u = up;
      if (spin) f = norm(rotAxis(fwd, up, spin));
      var r = cross(f, u), s = scale || 1, m = it.model;
      m[0] = f[0] * s; m[1] = f[1] * s; m[2] = f[2] * s; m[3] = 0; m[4] = u[0] * s; m[5] = u[1] * s; m[6] = u[2] * s; m[7] = 0;
      m[8] = r[0] * s; m[9] = r[1] * s; m[10] = r[2] * s; m[11] = 0; m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
      it.mesh = mesh; it.material = mat; it.castShadow = false; it.transparent = !!mat.transparent; it.kind = 'stunt-dyn';
      dynItems.push(it);
      return it;
    }
    function buildDynamic(snap, camPos) {
      dynItems.length = 0;
      var fm = world.meshes, t = R.time, D = world.dyn;
      var far2 = 420 * 420;
      function near(p) { var dx = p[0] - camPos[0], dy = p[1] - camPos[1], dz = p[2] - camPos[2]; return dx * dx + dy * dy + dz * dz < far2; }
      var arc = arcadeEntities(snap);
      if (arc) {
        for (var i = 0; i < arc.length; i++) {
          var e = arc[i];
          if (e.active === false && e.type !== 'pad') continue;
          var sm = track.sample(e.s), pos = track.pointAt(e.s, e.lat, 0);
          if (!near(pos)) continue;
          if (e.type === 'box') dynItem(fm.box, MAT.box, madd(pos, sm.up, 1.0 + Math.sin(t * 2 + e.s) * 0.12), sm.tangent, sm.up, 1, t * 1.6 + e.s);
          else if (e.type === 'can') dynItem(fm.can, MAT.can, madd(pos, sm.up, 0.9), sm.tangent, sm.up, 1, t * 2);
          else if (e.type === 'coin') dynItem(fm.coin, MAT.coin, madd(pos, sm.up, 0.9), sm.tangent, sm.up, 1, t * 3 + e.s);
          else if (e.type === 'ring') { var rr = num(e.r, 2.8); dynItem(fm.ring, MAT.ring, madd(pos, sm.up, num(e.z, 0.5) + rr), sm.tangent, sm.up, rr, 0); }
          else if (e.type === 'oil') dynItem(fm.coin, MAT.oil, madd(pos, sm.up, 0.03), sm.up, mul(sm.tangent, -1), 3.2, 0);
          else if (e.type === 'rocket') dynItem(fm.can, MAT.rocket, madd(pos, sm.up, 0.8), sm.up, mul(sm.tangent, -1), 0.9, 0);
        }
      } else {
        var hidden = {}; ((snap && snap.stunt && snap.stunt.pickupsHidden) || []).forEach(function (id) { hidden[id] = 1; });
        D.boxes.forEach(function (b) { if (!hidden[b.id] && near(b.pos)) dynItem(fm.box, MAT.box, madd(b.pos, b.up, Math.sin(t * 2 + b.s) * 0.12), b.fwd, b.up, 1, t * 1.6 + b.s); });
        D.cans.forEach(function (b) { if (!hidden[b.id] && near(b.pos)) dynItem(fm.can, MAT.can, b.pos, b.fwd, b.up, 1, t * 2); });
        D.coins.forEach(function (b) { if (!hidden[b.id] && near(b.pos)) dynItem(fm.coin, MAT.coin, b.pos, b.fwd, b.up, 1, t * 3 + b.s); });
        D.rings.forEach(function (b) { if (near(b.pos)) dynItem(fm.ring, MAT.ring, b.pos, b.fwd, b.up, b.r, 0); });
      }
      // hook-spawned entities (generic glowing markers)
      var ents = snap && snap.stunt && snap.stunt.entities;
      if (ents) ents.forEach(function (e) {
        var sm2 = track.sample(num(e.s, 0)), p2 = track.pointAt(num(e.s, 0), num(e.lat, 0), num(e.z, 0) + 0.8);
        if (near(p2)) dynItem(fm.coin, MAT.ent, p2, sm2.tangent, sm2.up, num(e.size, 1.2), t * 2);
      });
      // countdown lamps
      var cd = snap && snap.countdown, on = cd ? num(cd.lightsOn, 0) : 0, out = cd && cd.lightsOut, sinceGo = cd && cd.goTime != null ? snap.t - cd.goTime : 99;
      var s0 = track.sample(0);
      D.lights.forEach(function (l, k) {
        var mat = out ? (sinceGo < 2.5 ? MAT.lampGreen : MAT.lampOff) : (k < on ? MAT.lampRed : MAT.lampOff);
        dynItem(fm.lamp, mat, l.pos, s0.up, mul(s0.tangent, -1), 1, 0);
      });
      // pulse boost pads
      var pm = world.padMaterial;
      var pulse = 0.75 + 0.35 * Math.sin(t * 9);
      pm.color = [pulse * 1.6, pulse * 1.6, pulse * 1.6, 1];
      return dynItems;
    }

    function arcadeEntities(snap) {
      var a = snap && snap.arcade;
      if (!a) return null;
      if (Array.isArray(a.entities)) return a.entities;
      var g = a.ext && a.ext.gameplay;
      return g && Array.isArray(g.entities) ? g.entities : null;
    }
    /** Normalise arcade visuals onto the snapshot car (boost / nitro flags, item spin yaw, hop). */
    function arcadeCar(c) {
      var A = c.arcade;
      if (A && typeof A === 'object') {
        if (A.nitroOn) { c.boosting = true; c.nitroOn = true; }
        else if (A.boost) c.boosting = true;
      }
      if (c.fwd && Math.abs(c.fwd[1]) < 0.9 && typeof c.heading === 'number' && !c.visualYaw) {
        var h0 = Math.atan2(-c.fwd[2], c.fwd[0]), d = c.heading - h0;
        d = ((d + PI) % TAU + TAU) % TAU - PI;
        if (Math.abs(d) > 0.01) c.visualYaw = d;
      }
      if (typeof c.arcadeHop === 'number' && !c.hop) c.hop = c.arcadeHop;
    }

    /* ---- TV / replay cams: trackside points every ~150 m ---- */
    var TV = [];
    (function () {
      for (var s = 30; s < track.length; s += 150) {
        var sm = track.sample(s);
        if (sm.up[1] < 0.6) continue;
        var side = (Math.floor(s / 150) % 2) ? 1 : -1;
        TV.push({ s: s, pos: add(add(sm.pos, mul(sm.left, side * (sm.halfWidth + 14))), [0, 7 + (s % 3) * 3, 0]) });
      }
    })();

    /* ---- size ---- */
    function ensureSize() {
      var cw = Math.max(1, canvas.clientWidth || canvas.width || 1), ch = Math.max(1, canvas.clientHeight || canvas.height || 1);
      var wdpr = num(typeof window !== 'undefined' && window.devicePixelRatio, 1);
      var dpr = Math.min(wdpr, Q.dpr) * Q.scale;
      // the HUD canvas is sized by the renderer (renderer3d contract): CSS px x min(dpr, 2)
      var hw = Math.max(1, Math.round(cw * Math.min(wdpr, 2))), hh = Math.max(1, Math.round(ch * Math.min(wdpr, 2)));
      if (canvas.width !== hw || canvas.height !== hh) { canvas.width = hw; canvas.height = hh; }
      placeGL();
      var w = Math.round(cw * dpr), h = Math.round(ch * dpr);
      if (glc.width !== w || glc.height !== h) {
        if (typeof ctx.resize === 'function') ctx.resize(cw, ch, dpr); else { glc.width = w; glc.height = h; }
      }
      return { w: glc.width, h: glc.height, cw: cw, ch: ch };
    }

    /* ---- camera ---- */
    var cam = { view: M4.create(), proj: M4.create(), viewProj: M4.create(), position: [0, 0, 0] };
    function setCam(eye, target, up, fovDeg, aspect) {
      M4.lookAt(cam.view, eye, target, up);
      M4.perspective(cam.proj, fovDeg * DEG, aspect, 0.15, Q.far);
      M4.multiply(cam.viewProj, cam.proj, cam.view);
      cam.position[0] = eye[0]; cam.position[1] = eye[1]; cam.position[2] = eye[2];
      cam.eye = cam.position; cam.target = target; cam.up = up; cam.fovDeg = fovDeg; cam.aspect = aspect;
      cam.viewMatrix = cam.view; cam.projMatrix = cam.proj; cam.uView = cam.view; cam.uProj = cam.proj; cam.uCamPos = cam.position;
      var fx2 = sub(target, eye); cam.forward = norm(fx2); cam.near = 0.15; cam.far = Q.far;
      return cam;
    }
    function applyCtl(cm, mode) {
      if (typeof R.ctl !== 'function') return cm;
      var out = null;
      try { out = R.ctl({ eye: cm.position.slice(), target: cm.target.slice(), up: cm.up.slice(), fovDeg: cm.fovDeg, mode: mode, dt: R.dt }); } catch (e) { out = null; }
      if (out && (out.eye || typeof out.fovDeg === 'number')) setCam(out.eye || cm.position.slice(), out.target || cm.target, out.up || cm.up, typeof out.fovDeg === 'number' ? out.fovDeg : cm.fovDeg, cm.aspect);
      return cam;
    }
    function cameraFor(pose, c, dt, aspect, e) { R.dt = dt; return applyCtl(cameraBase(pose, c, dt, aspect, e), R.mode); }
    function cameraBase(pose, c, dt, aspect, e) {
      var speed = num(c.speed, 0), boost = c.boosting ? 1 : 0;
      var fovT = 66 + clamp01((speed - 20) / 45) * 8 + boost * 10;
      R.fov += (fovT - R.fov) * (1 - Math.exp(-dt * 4));
      var shake = R.shake, sh = shake > 0 ? [Math.sin(R.time * 53) * shake * 0.12, Math.sin(R.time * 61 + 1) * shake * 0.1, Math.sin(R.time * 47 + 2) * shake * 0.12] : [0, 0, 0];
      R.shake = Math.max(0, R.shake - dt * 2.5);
      var mode = R.mode;
      if (mode === 'chase' || mode === 'chase-far') {
        var far = mode === 'chase-far';
        var rig = chaseRig(R.rig, pose, dt, { dist: far ? 12 : 7.2, height: far ? 4.2 : 2.4, look: far ? 6 : 4, back: R.lookBack ? -1 : 1 });
        // near-lens protection: rise over an opponent whose body would cut the near plane (cheap box test, smoothed)
        var need = 0, others = R.camCars || [];
        for (var oi = 0; oi < others.length; oi++) {
          var oc = others[oi], op = R.camPoses && R.camPoses[oc.id];
          if (!op || oc.id === c.id || oc.fade > 0.98) continue;
          var dv = sub(rig.eye, op.pos);
          if (dot(dv, dv) > 64) continue;
          var od = (carEntry(oc).model && carEntry(oc).model.dims) || {}, ort = cross(op.fwd, op.up);
          var oout = Math.max(Math.abs(dot(dv, op.fwd)) - num(od.length, 4.4) / 2, Math.abs(dot(dv, ort)) - num(od.width, 1.9) / 2, 0);
          var otop = num(od.height, 1.35) + 0.6, olu = dot(dv, op.up);
          if (oout < 1.6 && olu < otop) need = Math.max(need, (otop - olu) * (1 - oout / 1.6));
        }
        R.camLift = num(R.camLift, 0) + (need - num(R.camLift, 0)) * (1 - Math.exp(-dt * (need > num(R.camLift, 0) ? 18 : 2.5)));
        if (R.camLift > 0.005) { rig.eye = madd(rig.eye, rig.up, R.camLift); rig.target = madd(rig.target, rig.up, R.camLift * 0.35); }
        return setCam(add(rig.eye, sh), rig.target, rig.up, R.fov, aspect);
      }
      if (mode === 'hood' || mode === 'cockpit') {
        var model = e && e.model, ce = mode === 'hood' ? (model && model.hoodCam) || [0.6, 1.25, 0] : (model && model.cockpitEye) || [-0.2, 1.15, -0.35];
        R.rig.init = false;
        R.fpUp = R.fpUp ? smoothDir(R.fpUp, pose.up, 12, dt) : pose.up.slice();
        var up = norm(madd(R.fpUp, pose.fwd, -dot(R.fpUp, pose.fwd)));
        var right = cross(pose.fwd, up);
        var eye = add(add(add(pose.pos, mul(pose.fwd, ce[0])), mul(up, ce[1] + num(c.susp, 0))), mul(right, ce[2]));
        var dir = R.lookBack ? mul(pose.fwd, -1) : pose.fwd;
        return setCam(add(eye, mul(sh, 0.4)), add(eye, mul(dir, 10)), up, R.fov + 4, aspect);
      }
      // tv: pick the nearest trackside cam ahead/behind, cut when out of range
      var best = R.tvIdx >= 0 ? TV[R.tvIdx] : null, d2 = best ? Math.hypot(best.pos[0] - pose.pos[0], best.pos[1] - pose.pos[1], best.pos[2] - pose.pos[2]) : 1e9;
      if (!best || d2 > 120) {
        var bi = -1, bd = 1e9;
        for (var i = 0; i < TV.length; i++) { var dd = Math.hypot(TV[i].pos[0] - pose.pos[0], TV[i].pos[2] - pose.pos[2]); if (dd < bd) { bd = dd; bi = i; } }
        R.tvIdx = bi; best = TV[bi];
      }
      if (!best) return setCam(add(pose.pos, [0, 30, 30]), pose.pos, [0, 1, 0], 55, aspect);
      var dist = Math.hypot(best.pos[0] - pose.pos[0], best.pos[1] - pose.pos[1], best.pos[2] - pose.pos[2]);
      return setCam(best.pos, add(pose.pos, mul(pose.up, 1)), [0, 1, 0], clamp(2400 / Math.max(10, dist), 18, 60), aspect);
    }

    /* ---- 2D overlays (speed lines + fade) ---- */
    function overlay2D(snap, player, size) {
      var c2 = canvas.getContext && canvas.getContext('2d');
      if (!c2) return;
      var dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
      c2.save();
      c2.setTransform(1, 0, 0, 1, 0, 0);
      c2.clearRect(0, 0, canvas.width, canvas.height);
      var W = canvas.width, H = canvas.height;
      var extLines = !!(snap && snap.arcade && snap.arcade.ext && snap.arcade.ext.gameplay);   // arcade-fx draws its own
      if (!extLines && player && (player.boosting || player.speed > 52) && R.mode !== 'tv') {
        var k = player.boosting ? 1 : clamp01((player.speed - 52) / 20) * 0.5;
        c2.strokeStyle = 'rgba(255,255,255,' + (0.22 * k).toFixed(3) + ')';
        c2.lineWidth = Math.max(1, 1.6 * dpr);
        var cx = W / 2, cy = H * 0.48, n = 26;
        c2.beginPath();
        for (var i = 0; i < n; i++) {
          var a = (i / n) * TAU + Math.sin(R.time * 7 + i * 13.1) * 0.08, ph = (R.time * 2.6 + i * 0.37) % 1;
          var r0 = (0.42 + ph * 0.5) * Math.max(W, H) * 0.5, r1 = r0 + (0.08 + 0.12 * k) * Math.max(W, H) * 0.5;
          c2.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.8);
          c2.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.8);
        }
        c2.stroke();
      }
      var fade = snap && snap.stunt ? num(snap.stunt.fade, 0) : 0;
      if (fade > 0.001) { c2.fillStyle = 'rgba(8,8,14,' + clamp01(fade).toFixed(3) + ')'; c2.fillRect(0, 0, W, H); }
      c2.restore();
    }

    function toScreen(p) {
      var vp = cam.viewProj, x = p[0], y = p[1], z = p[2];
      var cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (!(cw > 0.05)) return { x: 0, y: 0, visible: false, scale: 0 };
      var W = canvas.clientWidth || 1, H = canvas.clientHeight || 1;
      return { x: (cx / cw * 0.5 + 0.5) * W, y: (0.5 - cy / cw * 0.5) * H, visible: Math.abs(cx / cw) < 1.2 && Math.abs(cy / cw) < 1.2, scale: H * 0.5 * cam.proj[5] / cw, depth: cw };
    }

    /* ---- frame ---- */
    var carLists = [], casters = [], main = [];
    function render(snap, alpha) {
      if (!snap || !snap.cars || ctx.lost) return;
      var t0 = now(), dt = R.lastT ? clamp((t0 - R.lastT) / 1000, 0, 0.1) : 1 / 60;
      R.lastT = t0; R.time += dt; R.frame++;
      R.tod = snap.timeOfDay || (track.theme === 'neon' ? 'night' : 'day');
      var size = ensureSize();
      var Lt = lighting(R.tod);
      var player = null, i;
      for (i = 0; i < snap.cars.length; i++) arcadeCar(snap.cars[i]);
      for (i = 0; i < snap.cars.length; i++) if (snap.cars[i].isPlayer || snap.cars[i].id === snap.playerId) { player = snap.cars[i]; break; }
      player = player || snap.cars[0];
      // car poses (interpolated between snapshots)
      var poses = {};
      for (i = 0; i < snap.cars.length; i++) {
        var c = snap.cars[i], e = carEntry(c);
        var cur = { pos: c.pos || [c.x, 0, -c.y], fwd: c.fwd || [Math.cos(c.heading), 0, -Math.sin(c.heading)], up: c.up || [0, 1, 0] };
        var a = clamp01(num(alpha, num(snap.alpha, 1)));
        var p = cur;
        if (e.prev && e.prevT !== snap.t) {
          var jump = Math.hypot(cur.pos[0] - e.prev.pos[0], cur.pos[1] - e.prev.pos[1], cur.pos[2] - e.prev.pos[2]);
          if (jump < 12) p = { pos: lerp3(e.prev.pos, cur.pos, a), fwd: norm(lerp3(e.prev.fwd, cur.fwd, a)), up: norm(lerp3(e.prev.up, cur.up, a)) };
        }
        if (e.prevT !== snap.t) { e.prev = cur; e.prevT = snap.t; }
        poses[c.id] = p;
      }
      // events -> effects
      (snap.events || []).forEach(function (ev) {
        var pc = null; for (var k = 0; k < snap.cars.length; k++) if (snap.cars[k].id === ev.carId) pc = snap.cars[k];
        if (!pc) return;
        var pp = poses[pc.id];
        if (ev.type === 'land') {
          var imp = num(ev.impact, 4);
          if (imp > 3) emitSparks(pp.pos, mul(pp.fwd, pc.speed * 0.4), Math.min(40, Math.round(imp * 3)));
          emitDust(pp.pos, Math.min(10, Math.round(imp)), track.theme === 'canyon' ? [0.8, 0.55, 0.35, 0.45] : [0.7, 0.7, 0.72, 0.35]);
          if (pc.isPlayer) R.shake = Math.min(1.5, R.shake + imp / 10);
        } else if (ev.type === 'rail') {
          emitSparks(madd(pp.pos, cross(pp.fwd, pp.up), num(ev.side, 1) * -1.0), mul(pp.fwd, pc.speed * 0.6), 10);
          if (pc.isPlayer) R.shake = Math.min(1, R.shake + 0.3);
        } else if (ev.type === 'contact' && pc.isPlayer) { R.shake = Math.min(1, R.shake + 0.25); emitSparks(pp.pos, mul(pp.fwd, pc.speed * 0.5), 8); }
      });
      // camera
      var pe = carEntry(player);
      pe.model = pe.model || modelFor(pe, player, 'high');
      var ppose = poses[player.id];
      var aspect = size.cw / Math.max(1, size.ch);
      R.camCars = snap.cars; R.camPoses = poses;
      cameraFor(ppose, player, dt, aspect, pe);
      // cars: LOD by distance, pose, flames
      main.length = 0; casters.length = 0;
      var order = snap.cars.slice().sort(function (A, B) {
        var pa = poses[A.id].pos, pb = poses[B.id].pos;
        return Math.hypot(pa[0] - cam.position[0], pa[1] - cam.position[1], pa[2] - cam.position[2]) - Math.hypot(pb[0] - cam.position[0], pb[1] - cam.position[1], pb[2] - cam.position[2]);
      });
      var highN = 0;
      for (i = 0; i < order.length; i++) {
        var cc = order[i], ce = carEntry(cc), pz = poses[cc.id];
        var dcam = Math.hypot(pz.pos[0] - cam.position[0], pz.pos[1] - cam.position[1], pz.pos[2] - cam.position[2]);
        if (dcam > Q.far * 0.6) continue;
        if (cc.fade > 0.98 && !cc.isPlayer) continue;
        var lod = (cc.id === player.id || (highN < Q.lodHigh && dcam < 90)) ? 'high' : 'low';
        if (lod === 'high') highN++;
        ce.model = modelFor(ce, cc, lod);
        if ((R.mode === 'cockpit') && cc.id === player.id) continue;
        var list = carLists[i] || (carLists[i] = []);
        poseCar(ce, cc, pz, dt, list);
        for (var q = 0; q < list.length; q++) { main.push(list[q]); if (list[q].castShadow && dcam < 80) casters.push(list[q]); }
        // boost flames from the exhaust
        if (cc.boosting && dcam < 160) {
          var M0 = ce.M, back = [-M0[0], -M0[1], -M0[2]], tips = exhaustTips(ce, cc), cvel = mul(pz.fwd, num(cc.vSigned, num(cc.speed, 0)));
          for (var ti = 0; ti < tips.length; ti++) emitFlame(tips[ti], back, cvel, tips.length > 2 ? 0.8 : 1, !!cc.nitroOn, dt);
        }
        if (cc.airborne && cc.speed > 25 && dcam < 120 && Math.random() < 0.3) spawn({ p: madd(pz.pos, pz.fwd, -2), v: [0, 0, 0], life: 0.25, age: 0, size: 0.25, col: [1, 1, 1, 0.5], add: true, g: 0 });
      }
      stepParticles(dt);
      var dyn = buildDynamic(snap, cam.position);
      for (i = 0; i < world.items.length; i++) { main.push(world.items[i]); if (world.items[i].castShadow) casters.push(world.items[i]); }
      for (i = 0; i < dyn.length; i++) main.push(dyn[i]);
      // shadow pass around the player
      var env = {
        sunDir: Lt.sunDir, sunColor: Lt.sunColor, ambientSky: Lt.ambientSky, ambientGround: Lt.ambientGround, fogColor: Lt.fogColor, fogDensity: Lt.fogDensity,
        envTop: Lt.envTop, envHorizon: Lt.envHorizon, envBottom: Lt.envBottom, exposure: Lt.exposure, time: R.time, timeOfDay: R.tod, weather: 'dry'
      };
      // night / dusk: a soft fill light riding above the player's car + headlight spots for the nearest cars
      if (R.tod !== 'day') {
        var lights = [{ pos: madd(madd(ppose.pos, ppose.up, 4.5), ppose.fwd, -3), color: R.tod === 'night' ? [2.2, 1.9, 2.6] : [1.2, 1.0, 0.9], range: 22, type: 0 }];
        for (i = 0; i < order.length && lights.length < 5; i++) {
          var lc = poses[order[i].id];
          lights.push({ pos: madd(madd(lc.pos, lc.fwd, 2.4), lc.up, 0.7), dir: norm(madd(lc.fwd, lc.up, -0.08)), color: [5, 4.6, 4], range: 45, cosInner: 0.93, cosOuter: 0.8, type: 1 });
        }
        env.lights = lights;
      }
      if (shadow) {
        try { if (shadow.render(casters, { center: ppose.pos, sunDir: Lt.sunDir, radius: 70 })) env.shadow = shadow; } catch (e2) { shadow = null; }
      }
      // main pass
      var usePost = !!post;
      if (usePost) { try { var pb = post.begin(size.w, size.h); env.linearOutput = !!(pb && pb.linearOutput); } catch (e3) { usePost = false; post = null; } }
      if (!usePost) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, size.w, size.h); }
      gl.clearColor(Lt.fogColor[0], Lt.fogColor[1], Lt.fogColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      try {
        if (fx && typeof fx.drawSky === 'function') { if (fx.setLinearOutput) fx.setLinearOutput(!!env.linearOutput); fx.drawSky(cam, R.tod, 'dry'); }
        else if (G.drawSky) G.drawSky(ctx, cam, env, { night: R.tod === 'night' ? 1 : 0 });
      } catch (e4) { /* sky optional */ }
      R.stats.draws = G.drawList(ctx, main, cam, env);
      if (particles && PS.length) { try { particles.draw(cam, env, { viewportHeight: size.h }); } catch (e5) { /* optional */ } }
      if (usePost) {
        try {
          post.end({ bloom: true, bloomStrength: track.theme === 'neon' ? 0.9 : 0.6, threshold: env.linearOutput ? 1.1 : 0.82, vignette: 0.3,
            speedBlur: player.boosting ? 0.55 : clamp01((num(player.speed, 0) - 45) / 30) * 0.25, exposure: Lt.exposure, saturation: 1.12, contrast: 1.05, time: R.time });
        } catch (e6) { post = null; }
      }
      overlay2D(snap, player, size);
      // stats + adaptive quality (frame time EMA)
      var ms = now() - t0;
      R.ema += (dt * 1000 - R.ema) * 0.05;
      R.stats.ms = ms; R.stats.fps = R.ema > 0 ? 1000 / R.ema : 0; R.stats.particles = PS.length; R.stats.tris = world.stats.total;
      if (opts.autoQuality !== false && R.frame > 120) {
        if (R.ema > 24) R.slowT += dt; else R.slowT = Math.max(0, R.slowT - dt);
        if (R.slowT > 2.5) { R.slowT = 0; var qi = ['low', 'medium', 'high', 'ultra'].indexOf(R.quality); if (qi > 0) api.setQuality(['low', 'medium', 'high', 'ultra'][qi - 1]); }
      }
    }

    var api = {
      is3D: true, drawsArcadeWorld: true, kind: 'stunt',
      render: render,
      reset: function () { R.rig.init = false; R.fpUp = null; PS.length = 0; Object.keys(R.cars).forEach(function (k) { R.cars[k].prev = null; }); },
      setAutoQuality: function (b) { opts.autoQuality = !!b; },
      setRacingLine: function () { /* stunt tracks: no racing-line overlay */ },
      setLabels: function () {},
      setEntities: function (list) { R.extEntities = list || null; },
      setCameraController: function (fn) { R.ctl = typeof fn === 'function' ? fn : null; },
      getCameraState: function () {
        return { eye: cam.position.slice(), target: (cam.target || cam.position).slice(), up: (cam.up || [0, 1, 0]).slice(), fov: cam.fovDeg || 70, fovDeg: cam.fovDeg || 70, near: 0.15, far: Q.far, mode: R.mode, aspect: cam.aspect };
      },
      /** sim axes (x, y = -z, z = up) -> CSS px {x, y, visible, scale} */
      worldToScreen: function (x, y, z) { return toScreen([x, num(z, 0), -y]); },
      toScreen: function (x, y, z) { return toScreen([x, num(z, 0), -y]); },
      _debug: function () {
        var cars = {};
        Object.keys(R.cars).forEach(function (id) { var e = R.cars[id], p = e.prev; if (p) cars[id] = { pose: { x: p.pos[0], y: -p.pos[2], heading: Math.atan2(-p.fwd[2], p.fwd[0]) }, elev: p.pos[1] }; });
        return { S: { cars: cars, mode: R.mode }, track: track };
      },
      setCamera: function (m) {
        // a saved first-person preference restored before the first frame keeps the arcade chase cam (stunt cars have
        // no interior model); every later explicit choice (C / camera button) is honoured
        if ((m === 'cockpit' || m === 'bumper') && R.frame === 0) return R.mode;
        if (m === 'bumper') m = 'hood';
        if (MODES.indexOf(m) >= 0) { R.mode = m; R.rig.init = false; }
        return R.mode;
      },
      cycleCamera: function () { R.mode = MODES[(MODES.indexOf(R.mode) + 1) % MODES.length]; R.rig.init = false; return R.mode; },
      getCamera: function () { return R.mode; },
      cameraLabel: function () { return LABELS[R.mode]; },
      cameraModes: function () { return MODES.slice(); },
      setLookBack: function (b) { R.lookBack = !!b; },
      resize: function () { ensureSize(); },
      getQuality: function () { return R.quality; },
      setQuality: function (q) {
        if (!QUALITY[q] || q === R.quality) return R.quality;
        R.quality = q; setupQuality(); PMAX = Q.particles;
        try { world.destroy(); } catch (e) { /* ignore */ }
        world = G.stunt.build(ctx, track, { quality: q });
        return q;
      },
      stats: function () { return Object.assign({ quality: R.quality, camera: R.mode, frame: R.frame, cars: Object.keys(R.cars).length }, R.stats); },
      camera: function () { return cam; },
      destroy: function () {
        try { world.destroy(); } catch (e) { /* ignore */ }
        if (shadow) try { shadow.destroy(); } catch (e) { /* ignore */ }
        if (post) try { post.destroy(); } catch (e) { /* ignore */ }
        if (particles) try { particles.destroy(); } catch (e) { /* ignore */ }
        if (CB.gl.car && CB.gl.car.cache && CB.gl.car.cache.clear) try { CB.gl.car.cache.clear(ctx); } catch (e) { /* ignore */ }
        if (ctx && ctx.destroy) try { ctx.destroy(); } catch (e) { /* ignore */ }
        if (glc.parentNode) glc.parentNode.removeChild(glc);
        canvas.style.background = prevBg || '';
      },
      _world: function () { return world; }, _ctx: function () { return ctx; }
    };
    return api;
  }

  S.renderer = { isSupported: isSupported, create: create, MODES: MODES, LABELS: LABELS, QUALITY: QUALITY, _: { smoothDir: smoothDir, chaseRig: chaseRig } };
  if (typeof module !== 'undefined' && module.exports) module.exports = S.renderer;
})(CB.arcade.stunt);

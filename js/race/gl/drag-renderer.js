/* ==========================================================================
   Redline — js/race/gl/drag-renderer.js
   CB.drag.renderer : WebGL renderer for Drag Racing (docs/DRAG-SPEC.md).

     isSupported() -> bool
     create(canvas, opts {quality 'low'|'medium'|'high'|'ultra', camera, venue 'strip'|'street', night, distance (def | id | m),
                          autoQuality, seed})   (create(canvas, session, opts) is accepted too, derby style)
       -> { render(snap, alpha?), setCamera(m), cycleCamera(), getCamera(), cameraModes(), cameraLabel(), setFollow(lane|null),
            getFollow(), shake(amount), resize(), setQuality(q), getQuality(), stats(), destroy(), reset(),
            worldToScreen(x, y, z) -> {x, y, visible, scale}, getCameraState(), is3D: true, kind: 'drag' }
     createPreview(canvas, {build, color}) -> { update(opts), destroy(), ok }   (setup-screen turntable)
   `canvas` (create) is the HUD 2D canvas: an own GL canvas is inserted right before it (same box, pointer-events none),
   the 2D canvas is made transparent, sized to CSS px x min(dpr, 2) and cleared every frame (the HUD draws after render()).

   Scene: CB.gl.dragStrip (strip / street, night) rebuilt when snap.venue / snap.night / the distance change. Dynamic:
   Christmas-tree bulbs + halos from snap.tree.lanes[i], timing boards (canvas textures: ET / MPH per lane, redrawn
   on change), win lights, the street flagger's arms (snap.tree.flag), cars (CB.gl.car models from lane.build;
   wheel spin, brake lights, headlights at night), wheelie (lane.wheelie 0..1 -> up to 6 deg about the rear axle) +
   wheelie bars on RWD cars, tyre smoke (lane.smoke / lane.burnout), exhaust flames ('bang' / 'launch' events),
   nitrous flames (lane.nitrous.active) and purge, parachute (lane.chute 0..1).
   Cameras: 'chase' (frames the tree while staging), 'low', 'side' (TV tracking shot), 'bumper', 'cockpit'
   (CB.gl.cockpit interior when available, else a hood cam). Pure helpers in `_` load in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.drag = CB.drag || {};

(function () {
  'use strict';
  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  var MODES = ['chase', 'low', 'side', 'bumper', 'cockpit'];
  var LABELS = { chase: 'Chase', low: 'Low chase', side: 'Side (TV)', bumper: 'Bumper', cockpit: 'Cockpit' };
  var QUALITY = {
    low: { dpr: 1, scale: 0.8, shadow: 0, post: false, particles: 500, far: 2600, smoke: 0.45 },
    medium: { dpr: 1.25, scale: 1, shadow: 1024, post: true, particles: 1200, far: 3200, smoke: 0.75 },
    high: { dpr: 1.5, scale: 1, shadow: 2048, post: true, particles: 2200, far: 3800, smoke: 1 },
    ultra: { dpr: 2, scale: 1, shadow: 2048, post: true, particles: 3200, far: 4200, smoke: 1.25 }
  };
  var MPH = 2.236936;
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
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rotAxis(v, k, a) {
    var c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  }
  function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function W(x, y, z) { return [x, num(z, 0), -y]; }

  /* ================================================================== pure helpers (Node-testable) */
  function fmtET(t) { return typeof t === 'number' && isFinite(t) && t > 0 ? (t >= 100 ? t.toFixed(2) : t.toFixed(3)) : '--.---'; }
  function fmtMPH(v, units) {
    if (!(typeof v === 'number' && isFinite(v) && v > 0)) return units === 'kph' ? '---.-' : '---.--';
    return units === 'kph' ? (v * 3.6).toFixed(1) : (v * MPH).toFixed(2);
  }
  /** what a lane's timing board shows (pure) */
  function boardInfo(lane, snap, units) {
    lane = lane || {};
    var idx = num(lane.lane, 0), speedRace = !!(snap && snap.distance && snap.distance.speed);
    var info = { title: idx === 0 ? 'LEFT LANE' : 'RIGHT LANE', name: String(lane.name || '').toUpperCase().slice(0, 18), et: fmtET(lane.et), speed: fmtMPH(lane.trap, units),
      unit: units === 'kph' ? 'KM/H' : 'MPH', red: !!lane.red, win: !!(snap && snap.winner === idx), rt: null, speedRace: speedRace };
    if (typeof lane.rt === 'number' && isFinite(lane.rt)) info.rt = (lane.rt < 0 ? '-' : '') + Math.abs(lane.rt).toFixed(3);
    if (speedRace) info.speed = '';
    info.key = [info.name, info.et, info.speed, info.red ? 1 : 0, info.win ? 1 : 0, info.rt].join('|');
    return info;
  }
  /** wheelie pitch (rad, nose up) from lane.wheelie 0..1 */
  function wheeliePitch(w) { return clamp01(num(w, 0)) * 6 * DEG; }
  /** tyre-smoke emission rate (particles / s) for a lane at a quality smoke factor */
  function smokeRate(lane, k) {
    if (!lane) return 0;
    var s = clamp01(num(lane.smoke, 0));
    if (lane.burnout) s = Math.max(s, 0.85);
    if (s < 0.03) return 0;
    return s * (lane.burnout ? 95 : 80) * num(k, 1);
  }
  /** flagger arm angle target (rad from hanging down) */
  function flagArm(flag) { return flag === 'ready' ? 2.75 : flag === 'drop' ? 0.55 : 0.18; }
  /** driven-wheel axle(s) for smoke: [{x (car-local fwd), w}] */
  function smokeAxles(layout, dims) {
    var fA = num(dims && dims.frontAxle, 1.35), rA = num(dims && dims.rearAxle, -1.35);
    if (layout === 'fwd') return [{ x: fA, w: 1 }];
    if (layout === 'awd') return [{ x: rA, w: 0.6 }, { x: fA, w: 0.4 }];
    return [{ x: rA, w: 1 }];
  }
  /** chase camera that frames the tree while staging (pure): pose {pos, fwd, up}, tree [x,y,z] GL, k 0..1 */
  function chaseEye(pose, opts, k, tree, outer) {
    opts = opts || {};
    var dist = num(opts.dist, 7.4), h = num(opts.height, 2.2), right = cross(pose.fwd, pose.up);
    var eye = add(add(pose.pos, mul(pose.fwd, -dist - k * 1.4)), mul(pose.up, h + k * 0.9));
    eye = madd(eye, right, k * 2.2 * num(outer, 1));
    var target = add(add(pose.pos, mul(pose.up, 1.0)), mul(pose.fwd, num(opts.look, 5)));
    // only while the tree is still ahead of the car (no pull-back once it has gone by)
    var kt = tree ? k * clamp01((tree[0] - pose.pos[0] + 2) / 6) : 0;
    if (kt > 0) target = lerp3(target, tree, 0.42 * kt);
    return { eye: eye, target: target, up: [0, 1, 0] };
  }
  /** side TV camera (pure): car GL pos, outer side sign (+1: sim +y), opponent pos|null */
  function sideEye(st, pos, side, opp, dt, laneY) {
    // a tracking camera on the dolly between the player's lane and its outer wall, low, looking across the strip
    var tx = pos[0];
    var both = opp && Math.abs(opp[0] - pos[0]) < 18;
    if (both) tx = (pos[0] + opp[0]) / 2;
    if (!st.init || Math.abs(st.x - tx) > 60) { st.x = tx - 2; st.init = true; }
    st.x += (tx - 2 - st.x) * (1 - Math.exp(-num(dt, 0.016) * 4));
    var ly = num(laneY, side * 3.1), ey = ly + side * 3.9;
    var eye = [st.x, 1.05, -ey];
    var target = [tx + 1.2, 0.75, both ? (pos[2] + opp[2]) / 2 : pos[2]];
    var d = Math.hypot(target[0] - eye[0], target[2] - eye[2]);
    return { eye: eye, target: target, up: [0, 1, 0], fov: clamp(2 * Math.atan((both ? 6.4 : 3.6) / Math.max(2, d)) / DEG, 34, 78) };
  }

  function isSupported() {
    var G = CB.gl;
    if (!G || typeof G.createContext !== 'function' || typeof G.drawList !== 'function' || !G.dragStrip) return false;
    return typeof G.isSupported === 'function' ? !!G.isSupported() : true;
  }

  /* ================================================================== lighting */
  function makeLighting(fx) {
    var cache = {};
    return function (tod, weather) {
      var key = tod + '|' + weather;
      if (cache[key]) return cache[key];
      var L = null;
      try { if (fx && fx.getLighting) L = fx.getLighting(tod, weather); else if (CB.gl.effects && CB.gl.effects.getLighting) L = CB.gl.effects.getLighting(tod, weather); } catch (e) { L = null; }
      var base = tod === 'night' ? { sunDir: [0.3, 0.62, 0.42], sunColor: [0.22, 0.24, 0.34], ambientSky: [0.12, 0.12, 0.2], ambientGround: [0.05, 0.04, 0.06], fogColor: [0.025, 0.03, 0.06], fogDensity: 0.0011, envTop: [0.01, 0.01, 0.04], envHorizon: [0.08, 0.06, 0.12], envBottom: [0.02, 0.02, 0.03], exposure: 1.0 }
        : { sunDir: [-0.42, 0.78, -0.46], sunColor: [1.35, 1.27, 1.12], ambientSky: [0.5, 0.58, 0.7], ambientGround: [0.26, 0.24, 0.19], fogColor: [0.72, 0.8, 0.9], fogDensity: 0.0005, envTop: [0.3, 0.5, 0.84], envHorizon: [0.8, 0.86, 0.93], envBottom: [0.26, 0.25, 0.22], exposure: 0.95 };
      if (L && L.sunDir) {
        base.sunDir = L.sunDir.slice(); if (L.sunColor) base.sunColor = L.sunColor.slice();
        if (L.ambientSky) base.ambientSky = L.ambientSky.slice(); if (L.ambientGround) base.ambientGround = L.ambientGround.slice();
        if (L.fogColor) base.fogColor = L.fogColor.slice(); if (L.skyZenith) base.envTop = L.skyZenith.slice(); if (L.skyHorizon) base.envHorizon = L.skyHorizon.slice();
        if (L.skyGround) base.envBottom = L.skyGround.slice();
        if (tod === 'night') { base.ambientSky = mul(base.ambientSky, 1.6); base.sunColor = mul(base.sunColor, 1.3); }
      }
      if (base.sunDir[1] < 0.2) base.sunDir[1] = 0.2;
      base.sunDir = norm(base.sunDir);
      var lin = function (c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; };
      base.fogColor = lin(base.fogColor); base.envTop = lin(base.envTop); base.envHorizon = lin(base.envHorizon); base.envBottom = lin(base.envBottom);
      base.fogDensity *= 0.5;
      cache[key] = base;
      return base;
    };
  }

  /* ================================================================== board canvas */
  function drawBoard(g, Wd, H, info) {
    g.fillStyle = '#07080a'; g.fillRect(0, 0, Wd, H);
    g.strokeStyle = '#2a2d33'; g.lineWidth = 8; g.strokeRect(4, 4, Wd - 8, H - 8);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#9aa3ad'; g.font = '700 30px "Arial Narrow", Arial, sans-serif';
    g.fillText(info.title + (info.name ? '  ·  ' + info.name : ''), Wd / 2, 34, Wd - 30);
    if (info.red) {
      g.fillStyle = '#ff2a1a'; g.font = '900 104px "Courier New", monospace';
      g.fillText('RED', Wd / 2, H * 0.46);
      g.font = '700 40px "Courier New", monospace'; g.fillText(info.rt ? 'RT ' + info.rt : 'FOUL START', Wd / 2, H * 0.8);
      return;
    }
    // seven-segment-ish digits: amber ET, red speed
    g.shadowColor = 'rgba(255,170,40,0.85)'; g.shadowBlur = 18;
    g.fillStyle = '#ffb21e'; g.font = '900 ' + (info.et.length > 6 ? 108 : 120) + 'px "Courier New", monospace';
    g.fillText(info.et, Wd / 2, H * 0.43);
    if (info.speed) {
      g.shadowColor = 'rgba(255,60,40,0.85)'; g.fillStyle = '#ff4a2e'; g.font = '900 72px "Courier New", monospace';
      g.fillText(info.speed, Wd / 2 - 40, H * 0.77);
      g.shadowBlur = 0; g.fillStyle = '#c9cfd6'; g.font = '700 30px Arial, sans-serif'; g.fillText(info.unit, Wd / 2 + 150, H * 0.79);
    }
    g.shadowBlur = 0;
    if (info.win) { g.fillStyle = '#ffffff'; g.font = '900 30px Arial, sans-serif'; g.fillText('WIN', Wd - 60, 34); }
  }

  /* ================================================================== create */
  function create(canvas, a1, a2) {
    var opts = a2 && typeof a2 === 'object' ? a2 : (a1 && typeof a1 === 'object' && typeof a1.snapshot !== 'function' ? a1 : {}) || {};
    var G = CB.gl, M4 = G.mat4, DS = G.dragStrip;
    if (!DS) throw new Error('drag renderer: CB.gl.dragStrip missing');
    var R = {
      quality: QUALITY[opts.quality] ? opts.quality : 'high', mode: MODES.indexOf(opts.camera) >= 0 ? opts.camera : 'chase', follow: null,
      cars: {}, frame: 0, lastT: 0, time: 0, stats: { fps: 0, ms: 0, draws: 0, tris: 0 }, shake: 0, fov: 64, rig: {}, side: {},
      ema: 16, slowT: 0, stageK: 1, flagA: 0.18, units: opts.units === 'kph' ? 'kph' : 'mph', worldKey: ''
    };
    var Q = QUALITY[R.quality];
    /* ---- DOM ---- */
    var doc = canvas.ownerDocument || document;
    var glc = doc.createElement('canvas');
    glc.className = 'drag-gl-canvas';
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
    if (!ctx) throw new Error('drag renderer: WebGL unavailable');
    var gl = ctx.gl;
    var world = null, shadow = null, post = null, particles = null, fx = null;
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
    try { if (CB.gl.effects && typeof CB.gl.effects.create === 'function') fx = CB.gl.effects.create(ctx, { quality: R.quality, timeOfDay: 'day', weather: 'dry', autoEmit: false, linearOutput: !!post }); } catch (e) { fx = null; }
    var lighting = makeLighting(fx);

    /* ---- world (lazy, rebuilt when venue / night / length / quality change) ---- */
    function lengthOf(d) {
      if (typeof d === 'number' && d > 0) return d;
      if (CB.drag.strip && typeof CB.drag.strip.stripLength === 'function') { try { return CB.drag.strip.stripLength(d || 'quarter'); } catch (e) { /* fallthrough */ } }
      if (d && typeof d === 'object') return d.m || d.stripM || 402.336;
      return 402.336;
    }
    var W0 = { venue: opts.venue === 'street' ? 'street' : 'strip', night: !!opts.night, length: lengthOf(opts.distance) };
    var boards = [];
    function destroyBoards() { boards.forEach(function (b) { try { if (b.mesh) b.mesh.destroy(); if (b.tex) gl.deleteTexture(b.tex); } catch (e) { /* ignore */ } }); boards = []; }
    function ensureWorld(snap) {
      var venue = snap && (snap.venue === 'street' || snap.venue === 'strip') ? snap.venue : W0.venue;
      var night = snap && typeof snap.night === 'boolean' ? snap.night : W0.night;
      var len = snap && snap.distance ? lengthOf(snap.distance) : W0.length;
      var key = venue + '|' + (night ? 1 : 0) + '|' + Math.round(len) + '|' + R.quality;
      if (key === R.worldKey && world) return world;
      if (world) { try { world.destroy(); } catch (e) { /* ignore */ } }
      destroyBoards();
      world = DS.build(ctx, { venue: venue, night: night, length: len, quality: R.quality, seed: num(opts.seed, 7) });
      R.worldKey = key; R.night = night; R.venue = venue; R.length = len;
      // timing boards: canvas textures
      world.dyn.boards.forEach(function (b) {
        var cv = doc.createElement('canvas'); cv.width = 512; cv.height = 384;
        var g2 = cv.getContext('2d'), tex = null, mesh = null;
        if (g2) {
          drawBoard(g2, 512, 384, boardInfo({ lane: b.lane }, null, R.units));
          tex = G.createTexture(ctx, cv, { wrap: 'clamp', mipmaps: false });
          var Geo = DS._.Geo, P = DS._.P, gq = new Geo(); gq.uv = [];
          var s = b.sim, hw = b.w / 2, hh = b.h / 2;
          gq.quad(P(s[0], s[1] + hw, s[2] - hh), P(s[0], s[1] - hw, s[2] - hh), P(s[0], s[1] - hw, s[2] + hh), P(s[0], s[1] + hw, s[2] + hh), [1, 1, 1, 1], [-1, 0, 0], [[0, 1], [1, 1], [1, 0], [0, 0]]);
          mesh = G.createMesh(ctx, gq.out());
        }
        boards.push({ lane: b.lane, canvas: cv, g: g2, tex: tex, mesh: mesh, key: '', item: mesh ? { mesh: mesh, material: { name: 'drag-board', color: [1.6, 1.6, 1.6, 1], map: tex, unlit: true, castShadow: false }, model: M4.create(), kind: 'drag-board', castShadow: false } : null });
      });
      return world;
    }
    function updateBoards(snap) {
      for (var i = 0; i < boards.length; i++) {
        var b = boards[i], lane = snap.lanes && snap.lanes[b.lane];
        if (!b.g || !b.tex) continue;
        var info = boardInfo(lane || { lane: b.lane }, snap, R.units);
        if (info.key === b.key) continue;
        b.key = info.key;
        drawBoard(b.g, 512, 384, info);
        gl.bindTexture(gl.TEXTURE_2D, b.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b.canvas);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }

    /* ---- cars ---- */
    var IDENT = M4.create();
    function defaultBuild() { try { return CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null; } catch (e) { return null; } }
    function buildKey(b) { try { return b ? JSON.stringify([b.body, b.exterior, b.wheels, b.tires, b.aero, b.engine && b.engine.layout]) : 'none'; } catch (e) { return String(Math.random()); } }
    function carEntry(lane) {
      var id = 'lane' + num(lane.lane, 0);
      var e = R.cars[id];
      var bk = buildKey(lane.build) + '|' + (lane.color || '');
      if (e && e.bk !== bk) { e.models = {}; e.pst = {}; e.cockpit = null; e.bk = bk; }
      if (!e) e = R.cars[id] = { id: id, bk: bk, models: {}, pst: {}, items: [], M: M4.create(), CW: M4.create(), prev: null, view: {}, wheelieSeen: false, purgeT: 0, lastPhase: '' };
      return e;
    }
    function fallbackModel(lane) {
      var Geo = DS._.Geo, g = new Geo(), col = DS.hex(lane.color || '#c8202a');
      g.box([0, 0.62, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 2.2, 0.32, 0.92, col);
      g.box([-0.2, 1.08, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1.1, 0.22, 0.78, [0.08, 0.09, 0.1, 1]);
      [[1.35, 0.8], [1.35, -0.8], [-1.35, 0.8], [-1.35, -0.8]].forEach(function (w) { g.cyl([w[0], 0.34, w[1] - 0.14], [w[0], 0.34, w[1] + 0.14], 0.34, 0.34, 10, [0.04, 0.04, 0.045, 1], true); });
      var mesh = G.createMesh(ctx, g.out());
      return { _fallback: true, dims: { length: 4.4, width: 1.9, height: 1.3, wheelRadius: 0.34, frontAxle: 1.35, rearAxle: -1.35, track: 1.6 }, cockpitEye: [-0.2, 1.15, -0.35], hoodCam: [0.6, 1.25, 0], bumperCam: [2.25, 0.5, 0],
        parts: [{ mesh: mesh, material: { color: [1, 1, 1, 1], roughness: 0.35, clearcoat: 0.8 }, local: IDENT, kind: 'body' }] };
    }
    function modelFor(e, lane, lod) {
      if (e.models[lod]) return e.models[lod];
      var m = null, b = lane.build || defaultBuild();
      if (CB.gl.car && typeof CB.gl.car.build === 'function' && b) {
        try { m = CB.gl.car.build(ctx, b, { color: lane.color, lod: lod, id: e.id, name: lane.name, isPlayer: !!lane.isPlayer }); } catch (err) { m = null; }
      }
      if (!m || !m.parts) m = fallbackModel(lane);
      e.models[lod] = m;
      return m;
    }
    var tmpW = M4.create();
    /** rotation about the world axis k through point p (column-major mat4) */
    function rotAbout(o, p, k, ang) {
      var c = Math.cos(ang), s = Math.sin(ang), t = 1 - c, x = k[0], y = k[1], z = k[2];
      o[0] = t * x * x + c; o[1] = t * x * y + s * z; o[2] = t * x * z - s * y; o[3] = 0;
      o[4] = t * x * y - s * z; o[5] = t * y * y + c; o[6] = t * y * z + s * x; o[7] = 0;
      o[8] = t * x * z + s * y; o[9] = t * y * z - s * x; o[10] = t * z * z + c; o[11] = 0;
      o[12] = p[0] - (o[0] * p[0] + o[4] * p[1] + o[8] * p[2]); o[13] = p[1] - (o[1] * p[0] + o[5] * p[1] + o[9] * p[2]); o[14] = p[2] - (o[2] * p[0] + o[6] * p[1] + o[10] * p[2]); o[15] = 1;
      return o;
    }
    function poseLane(e, lane, pose, dt, out, hideKinds) {
      var model = e.model, P = CB.gl.car && CB.gl.car.pose, cv = e.view, sp = num(lane.speed, Math.abs(num(lane.vx, 0)));
      var h = Math.atan2(-pose.fwd[2], pose.fwd[0]);
      cv.x = pose.pos[0]; cv.y = -pose.pos[2]; cv.heading = h; cv.speed = sp; cv.vx = sp * Math.cos(h); cv.vy = sp * Math.sin(h);
      cv.brake = num(lane.brake, 0); cv.throttle = num(lane.throttle, 0); cv.gear = num(lane.gear, 1) < 0 ? -1 : 1;
      cv.wheelspin = lane.burnout ? 1 : clamp01(num(lane.wheelspin, 0) * 1.5); cv.skidding = 0; cv.surface = 'asphalt'; cv.steerAngle = 0;
      cv.headlights = !!R.night; cv.lightsOn = cv.headlights;
      var items = null;
      if (P && !model._fallback) { try { items = P(model, cv, dt, e.pst); } catch (err) { items = null; } }
      if (!items) {
        items = e.fbItems || (e.fbItems = model.parts.map(function (p) { return { mesh: p.mesh, material: p.material, model: M4.create(), kind: p.kind, part: p, castShadow: true }; }));
        var hh = h;
        var cm = M4.create(); cm[0] = Math.cos(hh); cm[2] = -Math.sin(hh); cm[8] = Math.sin(hh); cm[10] = Math.cos(hh); cm[12] = pose.pos[0]; cm[13] = pose.pos[1]; cm[14] = pose.pos[2];
        for (var q = 0; q < items.length; q++) M4.multiply(items[q].model, cm, items[q].part.local || IDENT);
        e.pst.bodyMatrix = cm;
      }
      // wheelie: rotate the whole car about the rear contact line (nose up)
      var d = model.dims || {}, ang = wheeliePitch(lane.wheelie), right = norm(cross(pose.fwd, [0, 1, 0]));
      var pivot = madd(pose.pos, pose.fwd, num(d.rearAxle, -num(d.length, 4.4) * 0.3));
      rotAbout(tmpW, pivot, right, ang);
      e.pitch = ang;
      out.length = 0;
      var Wl = e.items;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (hideKinds && hideKinds.indexOf(it.kind) >= 0) continue;
        var w = Wl[out.length] || (Wl[out.length] = { model: M4.create() });
        w.mesh = it.mesh; w.material = it.material; w.program = it.program; w.kind = it.kind; w.castShadow = it.castShadow !== false;
        w.transparent = it.transparent || (it.material && it.material.transparent);
        M4.multiply(w.model, tmpW, it.model);
        out.push(w);
      }
      var B = e.pst && e.pst.bodyMatrix;
      M4.multiply(e.CW, tmpW, B || IDENT);
      return out;
    }
    /** car-local (GL: +X fwd, +Y up, +Z right) point -> world through the car's (wheelie) body matrix */
    function toWorld(e, x, y, z) {
      var M = e.CW;
      return [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
    }
    function exhaustTips(e) {
      var m = e.model, ex = m && m.anchors && m.anchors.exhaust, out = [];
      if ((!ex || !ex.length) && e.models.high && e.models.high.anchors) ex = e.models.high.anchors.exhaust;
      if (ex && ex.length) { for (var i = 0; i < ex.length && i < 4; i++) if (ex[i]) out.push(toWorld(e, num(ex[i][0], 0), num(ex[i][1], 0.3), num(ex[i][2], 0))); }
      else { var d = (m && m.dims) || {}, L = num(d.length, 4.4) / 2, Wd = num(d.width, 1.9) / 2; out.push(toWorld(e, -L * 0.98, 0.32, Wd * 0.4), toWorld(e, -L * 0.98, 0.32, -Wd * 0.4)); }
      return out;
    }

    /* ---- particles ---- */
    var PS = [], PMAX = Q.particles;
    function spawn(p) { if (PS.length >= PMAX) PS.shift(); PS.push(p); }
    function rnd() { return Math.random(); }
    function emitSmoke(pos, vel, big) {
      spawn({ p: pos.slice(), v: vel, life: big ? 2.6 + rnd() * 1.8 : 1.6 + rnd() * 1.2, age: 0, size: big ? 1.0 : 0.7, grow: big ? 2.1 : 1.6, maxSize: big ? 7.5 : 5,
        col: big ? [0.88, 0.88, 0.9, 0.24] : [0.8, 0.8, 0.82, 0.34], add: false, g: -0.04, drag: 1.6 });
    }
    function emitFlame(pos, back, vel, strength, blue) {
      for (var i = 0; i < 3; i++) {
        var j = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        var v = add(add(vel, mul(back, 5 + rnd() * 5)), mul(j, 0.8));
        spawn({ p: madd(pos, j, 0.05), v: v, life: 0.07 + rnd() * 0.08, age: 0, size: 0.3 * strength, grow: -1.2, col: blue ? [0.6, 1.3, 4.5, 1] : [4.2, 1.7, 0.4, 1], add: true, g: 0 });
      }
    }
    function emitPurge(pos, dir) {
      for (var i = 0; i < 4; i++) {
        var j = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        spawn({ p: pos.slice(), v: add(mul(dir, 9 + rnd() * 5), mul(j, 1.5)), life: 0.5 + rnd() * 0.4, age: 0, size: 0.25, grow: 2.2, col: [0.95, 0.97, 1, 0.55], add: false, g: -0.1, drag: 2.5 });
      }
    }
    function stepParticles(dt) {
      for (var i = PS.length - 1; i >= 0; i--) {
        var p = PS[i];
        p.age += dt;
        if (p.age >= p.life) { PS.splice(i, 1); continue; }
        p.v[1] -= 9.8 * p.g * dt;
        if (p.drag) { var k = Math.exp(-p.drag * dt); p.v[0] *= k; p.v[2] *= k; if (p.v[1] > 0) p.v[1] *= Math.exp(-0.4 * dt); }
        p.p[0] += p.v[0] * dt; p.p[1] += p.v[1] * dt; p.p[2] += p.v[2] * dt;
        if (p.p[1] < 0.05) { p.p[1] = 0.05; if (p.v[1] < 0) p.v[1] = 0; }
      }
      if (!particles) return;
      var n = Math.min(PS.length, particles.max);
      for (var q = 0; q < n; q++) {
        var s = PS[q], t = s.age / s.life, a = s.col[3] * (s.add ? 1 - t : (1 - t) * (1 - t) * Math.min(1, s.age * 6));
        var size = Math.max(0.02, s.size + num(s.grow, 0) * s.age);
        if (s.maxSize) size = Math.min(size, s.maxSize);
        particles.set(q, s.p[0], s.p[1], s.p[2], s.col[0] * a, s.col[1] * a, s.col[2] * a, a, size, s.age * 0.6, s.add ? 0.2 : 0.75, s.add);
      }
      particles.upload(n);
    }

    /* ---- dynamic items ---- */
    var dynItems = [], dynPool = [];
    var MAT = {
      bulbOff: { preStage: [0.16, 0.13, 0.05], stage: [0.16, 0.13, 0.05], amber: [0.14, 0.07, 0.01], green: [0.02, 0.08, 0.03], red: [0.1, 0.01, 0.01] },
      bulbOn: { preStage: [5, 4.2, 2.2], stage: [5, 4.2, 2.2], amber: [6, 2.9, 0.25], green: [0.5, 6, 1.0], red: [6, 0.25, 0.12] },
      halo: { preStage: [1.4, 1.1, 0.5], stage: [1.4, 1.1, 0.5], amber: [1.8, 0.8, 0.08], green: [0.15, 1.8, 0.3], red: [1.8, 0.08, 0.04] }
    };
    var matCache = {};
    function mat(kind, on) {
      var k = kind.indexOf('amber') === 0 ? 'amber' : kind, key = k + (on ? 1 : 0);
      if (!matCache[key]) {
        var c = (on ? MAT.bulbOn : MAT.bulbOff)[k] || [1, 1, 1];
        matCache[key] = on ? { name: 'drag-bulb-on', color: [c[0], c[1], c[2], 1], unlit: true, castShadow: false } : { name: 'drag-bulb', color: [c[0], c[1], c[2], 1], roughness: 0.15, clearcoat: 1, castShadow: false };
      }
      return matCache[key];
    }
    function haloMat(kind) {
      var k = kind.indexOf('amber') === 0 ? 'amber' : kind, key = 'h' + k;
      if (!matCache[key]) { var c = MAT.halo[k] || [1, 1, 1]; matCache[key] = { name: 'drag-halo', color: [c[0], c[1], c[2], 1], unlit: true, transparent: true, additive: true, depthWrite: false, castShadow: false, doubleSided: true }; }
      return matCache[key];
    }
    var MATX = {
      steel: { color: [0.5, 0.52, 0.55, 1], roughness: 0.3, metallic: 0.85 },
      tyre: { color: [0.03, 0.03, 0.03, 1], roughness: 0.85 },
      line: { color: [0.85, 0.85, 0.85, 1], roughness: 0.6, castShadow: false },
      chute: { color: [1, 1, 1, 1], roughness: 0.7, doubleSided: true, castShadow: false },
      arm: { color: [1, 1, 1, 1], roughness: 0.7 },
      flagG: { color: [0.05, 0.6, 0.12, 1], roughness: 0.8, doubleSided: true },
      winOn: { color: [5, 4.4, 1.2, 1], unlit: true, castShadow: false },
      winOff: { color: [0.12, 0.1, 0.05, 1], roughness: 0.3 }
    };
    function dynItem(mesh, mt, pos, fwd, up, scale) {
      if (!mesh) return null;
      var it = dynPool[dynItems.length] || (dynPool[dynItems.length] = { model: M4.create() });
      var f = norm(fwd), u = norm(sub(up, mul(f, dot(up, f)))), r = cross(f, u), m = it.model, sx, sy, sz;
      if (scale && scale.length) { sx = scale[0]; sy = scale[1]; sz = scale[2]; } else sx = sy = sz = num(scale, 1);
      m[0] = f[0] * sx; m[1] = f[1] * sx; m[2] = f[2] * sx; m[3] = 0; m[4] = u[0] * sy; m[5] = u[1] * sy; m[6] = u[2] * sy; m[7] = 0;
      m[8] = r[0] * sz; m[9] = r[1] * sz; m[10] = r[2] * sz; m[11] = 0; m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
      it.mesh = mesh; it.material = mt; it.castShadow = false; it.transparent = !!(mt.transparent || mt.additive); it.kind = 'drag-dyn';
      dynItems.push(it);
      return it;
    }
    /** segment item: unit 'line' mesh (0..1 along +Y) stretched from a to b */
    function segItem(a, b, r, mt) {
      var d = sub(b, a), l = Math.sqrt(dot(d, d)); if (l < 1e-4) return;
      var y = mul(d, 1 / l), x = Math.abs(y[1]) < 0.95 ? norm(cross(y, [0, 1, 0])) : [1, 0, 0];
      dynItem(world.meshes.line, mt, a, x, y, [r, l, r]);
    }
    function buildDynamic(snap, lanes, camPos) {
      dynItems.length = 0;
      var fm = world.meshes, D = world.dyn, tree = snap.tree || {}, TL = tree.lanes || [];
      // tree bulbs + halos
      if (D.tree && D.tree.bulbs) {
        var camFar = Math.hypot(camPos[0] - D.tree.x, camPos[2]) > 700;
        for (var i = 0; i < D.tree.bulbs.length; i++) {
          var b = D.tree.bulbs[i], on = DS.bulbLit(b.kind, TL[b.lane]);
          dynItem(fm.bulb, mat(b.kind, on), b.pos, [1, 0, 0], [0, 1, 0], [b.r * 0.55, b.r, b.r]);
          if (on && !camFar) {
            var pulse = 1 + 0.06 * Math.sin(R.time * 40 + i);
            dynItem(fm.halo, haloMat(b.kind), add(b.pos, [-0.03, 0, 0]), [1, 0, 0], [0, 1, 0], [1, b.r * 3.4 * pulse, b.r * 3.4 * pulse]);
          }
        }
      }
      // win lights on the boards
      for (i = 0; i < D.winLights.length; i++) {
        var wl = D.winLights[i], won = snap.winner === wl.lane && (snap.phase === 'shutdown' || snap.phase === 'done' || snap.phase === 'finish');
        dynItem(fm.bulb, won && Math.sin(R.time * 10) > -0.3 ? MATX.winOn : MATX.winOff, wl.pos, [1, 0, 0], [0, 1, 0], [0.25, 0.42, 0.42]);
        if (won) dynItem(fm.halo, haloMat('amber'), add(wl.pos, [-0.2, 0, 0]), [1, 0, 0], [0, 1, 0], [1, 1.6, 1.6]);
      }
      // street flagger
      if (D.flagger) {
        var ft = flagArm(tree.flag), rate = tree.flag === 'drop' ? 14 : 4;
        R.flagA += clamp(ft - R.flagA, -rate * R.dt, rate * R.dt);
        var sides = [{ s: D.flagger.shoulderL, sg: 1 }, { s: D.flagger.shoulderR, sg: -1 }];
        sides.forEach(function (sd) {
          // arm hangs along local -Y; rotate about GL X (left arm swings toward -z = sim +y)
          var a = R.flagA * sd.sg, up = [0, Math.cos(a), Math.sin(a)];
          dynItem(fm.arm, MATX.arm, sd.s, [1, 0, 0], up, [1, 0.72, 1]);
          var hand = madd(sd.s, up, -0.76);
          dynItem(fm.box, MATX.flagG, madd(hand, up, -0.2), [1, 0, 0], up, [0.02, 0.22, 0.3]);
        });
      }
      // per lane extras: wheelie bars, parachute
      for (i = 0; i < lanes.length; i++) {
        var L = lanes[i], e = L.e, pz = L.pose;
        if (!e || !e.model) continue;
        var dm = e.model.dims || {}, hl = num(dm.length, 4.4) / 2;
        if (e.wheelieSeen && (L.lane.layout || 'rwd') === 'rwd') {
          for (var zs = -1; zs <= 1; zs += 2) {
            var a0 = toWorld(e, -hl + 0.1, 0.3, zs * 0.4), a1 = toWorld(e, -hl - 0.95, 0.12, zs * 0.4);
            segItem(a0, a1, 0.022, MATX.steel);
            dynItem(fm.wheel, MATX.tyre, a1, pz.fwd, [0, 1, 0], [0.09, 0.09, 0.035]);
          }
        }
        var ch = clamp01(num(L.lane.chute, 0));
        if (ch > 0.01) {
          var attach = toWorld(e, -hl, 0.75, 0), fl = Math.sin(R.time * 9 + i) * 0.05;
          var cpos = madd(madd(attach, pz.fwd, -(1.2 + 6.5 * ch)), [0, 1, 0], 0.3 + 0.75 * ch);
          var rad = 0.25 + 0.85 * ch, cf = norm(add(pz.fwd, [0, fl, fl]));
          dynItem(fm.chute, MATX.chute, cpos, cf, [0, 1, 0], [rad * 0.9, rad, rad]);
          var rr = norm(cross(cf, [0, 1, 0]));
          for (var k = 0; k < 4; k++) {
            var ang = k / 4 * TAU + PI / 4, rim = add(cpos, add(mul([0, 1, 0], Math.cos(ang) * rad * 0.92), mul(rr, Math.sin(ang) * rad * 0.92)));
            segItem(attach, rim, 0.012, MATX.line);
          }
        }
      }
      return dynItems;
    }

    /* ---- size ---- */
    function ensureSize() {
      var cw = Math.max(1, canvas.clientWidth || canvas.width || 1), ch = Math.max(1, canvas.clientHeight || canvas.height || 1);
      var wdpr = num(typeof window !== 'undefined' && window.devicePixelRatio, 1);
      var dpr = Math.min(wdpr, Q.dpr) * Q.scale;
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
    function setCam(eye, target, up, fovDeg, aspect, near) {
      near = near || 0.15;
      M4.lookAt(cam.view, eye, target, up);
      M4.perspective(cam.proj, fovDeg * DEG, aspect, near, Q.far);
      M4.multiply(cam.viewProj, cam.proj, cam.view);
      cam.position[0] = eye[0]; cam.position[1] = eye[1]; cam.position[2] = eye[2];
      cam.eye = cam.position; cam.target = target; cam.up = up; cam.fovDeg = fovDeg; cam.aspect = aspect;
      cam.viewMatrix = cam.view; cam.projMatrix = cam.proj; cam.uView = cam.view; cam.uProj = cam.proj; cam.uCamPos = cam.position;
      cam.forward = norm(sub(target, eye)); cam.near = near; cam.far = Q.far;
      return cam;
    }
    function smoothVec(st, key, v, rate, dt) {
      if (!st[key]) { st[key] = v.slice(); return st[key]; }
      var k = 1 - Math.exp(-rate * dt), c = st[key];
      c[0] += (v[0] - c[0]) * k; c[1] += (v[1] - c[1]) * k; c[2] += (v[2] - c[2]) * k;
      return c;
    }
    function cameraFor(snap, lane, pose, e, opp, dt, aspect) {
      var speed = num(lane.speed, 0), phase = snap.phase;
      var staging = phase === 'burnout' || phase === 'staging' || phase === 'tree' || (phase === 'run' && speed < 3);
      R.stageK += ((staging ? 1 : 0) - R.stageK) * (1 - Math.exp(-dt * (staging ? 2 : 1.3)));
      var shake = R.shake, sh = shake > 0 ? [Math.sin(R.time * 53) * shake * 0.1, Math.sin(R.time * 61 + 1) * shake * 0.08, Math.sin(R.time * 47 + 2) * shake * 0.1] : [0, 0, 0];
      R.shake = Math.max(0, R.shake - dt * 2.2);
      var fovT = 60 + clamp01((speed - 15) / 60) * 12 + num(R.fovKick, 0);
      R.fovKick = Math.max(0, num(R.fovKick, 0) - dt * 14);
      R.fov += (fovT - R.fov) * (1 - Math.exp(-dt * 3));
      var outer = num(lane.lane, 0) === 0 ? -1 : 1;   // GL right of the car = sim -y: the left lane's outer side is GL -right
      var mode = R.mode;
      if (mode === 'chase' || mode === 'low') {
        var tree = world.dyn.tree && world.venue !== 'street' ? [world.dyn.tree.x, 2.2, 0] : world.dyn.flagger ? add(world.dyn.flagger.pos, [0, 1.4, 0]) : null;
        var chK = clamp01(num(lane.chute, 0)), burn = lane.burnout ? 1 : 0;
        R.burnK = num(R.burnK, 0) + (burn - num(R.burnK, 0)) * (1 - Math.exp(-dt * 2));
        var o = mode === 'low' ? { dist: 5.3 + chK * 9, height: 0.62 + chK * 1.6, look: 7 } : { dist: 7.4 + chK * 8 + R.burnK * 2.5, height: 2.15 + chK * 2.2 + R.burnK * 1.8, look: 5 };
        var k = mode === 'low' ? R.stageK * 0.35 : R.stageK;
        var r = chaseEye(pose, o, k, tree, outer);
        // smooth the rig RELATIVE to the car (a 20 m/s² launch never drags the camera behind / around)
        var eo = smoothVec(R.rig, 'eo', sub(r.eye, pose.pos), 6, dt), to = smoothVec(R.rig, 'to', sub(r.target, pose.pos), 6, dt);
        var eye = add(pose.pos, eo), tgt = add(pose.pos, to);
        return setCam(add(eye, sh), tgt, [0, 1, 0], mode === 'low' ? R.fov + 10 : R.fov, aspect);
      }
      if (mode === 'side') {
        var s = sideEye(R.side, pose.pos, outer < 0 ? 1 : -1, opp ? opp.pose.pos : null, dt, -pose.pos[2]);
        return setCam(add(s.eye, mul(sh, 0.5)), s.target, [0, 1, 0], s.fov, aspect);
      }
      var model = e && e.model, right = norm(cross(pose.fwd, [0, 1, 0]));
      if (mode === 'cockpit' && e && e.cockpit && e.cockpit.camera) {
        try {
          var cc = e.cockpit.camera, el = cc.eye || model.cockpitEye, fl = cc.forward || [1, 0, 0], ul = cc.up || [0, 1, 0];
          var eyeW = toWorld(e, el[0], el[1], el[2]);
          var fw = norm(sub(toWorld(e, el[0] + fl[0], el[1] + fl[1], el[2] + fl[2]), eyeW)), uw = norm(sub(toWorld(e, el[0] + ul[0], el[1] + ul[1], el[2] + ul[2]), eyeW));
          return setCam(add(eyeW, mul(sh, 0.45)), add(eyeW, mul(fw, 10)), uw, R.fov + 6, aspect, num(e.cockpit.nearPlane, 0.05));   // FOV stretches with speed + launch kick
        } catch (err) { /* fall through to hood */ }
      }
      var ce = mode === 'bumper' ? (model && model.bumperCam) || [2.2, 0.5, 0] : (model && model.cockpitEye) || (model && model.hoodCam) || [0.6, 1.25, 0];
      var eyeP = toWorld(e, ce[0], ce[1], ce[2]);
      var fwdW = norm(sub(toWorld(e, ce[0] + 1, ce[1], ce[2]), eyeP));
      void right;
      return setCam(add(eyeP, mul(sh, 0.35)), add(eyeP, mul(fwdW, 10)), [0, 1, 0], mode === 'bumper' ? R.fov + 6 : 66, aspect, 0.06);
    }

    function toScreen(p) {
      var vp = cam.viewProj, x = p[0], y = p[1], z = p[2];
      var cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (!(cw > 0.05)) return { x: 0, y: 0, visible: false, scale: 0 };
      var Wd = canvas.clientWidth || 1, H = canvas.clientHeight || 1;
      return { x: (cx / cw * 0.5 + 0.5) * Wd, y: (0.5 - cy / cw * 0.5) * H, visible: Math.abs(cx / cw) < 1.2 && Math.abs(cy / cw) < 1.2, scale: H * 0.5 * cam.proj[5] / cw, depth: cw };
    }

    /* ---- frame ---- */
    var carLists = [[], []], casters = [], main = [], laneViews = [];
    function render(snap, alpha) {
      if (!snap || !snap.lanes || ctx.lost) return;
      var t0 = now(), dt = R.lastT ? clamp((t0 - R.lastT) / 1000, 0, 0.1) : 1 / 60;
      R.lastT = t0; R.time += dt; R.frame++; R.dt = dt;
      ensureWorld(snap);
      var size = ensureSize();
      var tod = R.night ? 'night' : 'day', weather = snap.surface === 'wet' ? 'wet' : 'dry';
      var Lt = lighting(tod, weather);
      var lanes = snap.lanes.filter(function (l) { return l && l.kind !== 'none' && typeof l.x === 'number'; });
      if (!lanes.length) return;
      var fi = R.follow != null ? R.follow : snap.playerLane != null ? snap.playerLane : null;
      var player = null, i;
      for (i = 0; i < lanes.length; i++) if (fi != null ? num(lanes[i].lane, i) === fi : lanes[i].isPlayer) { player = lanes[i]; break; }
      player = player || lanes[0];
      var a = clamp01(num(alpha, 1));
      // poses
      laneViews.length = 0;
      for (i = 0; i < lanes.length; i++) {
        var ln = lanes[i], e = carEntry(ln);
        var h = num(ln.heading, 0), z = num(ln.z, 0);
        var cur = { pos: W(ln.x, num(ln.y, 0), z), fwd: [Math.cos(h), 0, -Math.sin(h)], up: [0, 1, 0] };
        var p = cur;
        if (e.prev && a < 1 && Math.abs(cur.pos[0] - e.prev.pos[0]) < 20) p = { pos: lerp3(e.prev.pos, cur.pos, a), fwd: norm(lerp3(e.prev.fwd, cur.fwd, a)), up: [0, 1, 0] };
        if (e.prevT !== snap.t) { e.prev = cur; e.prevT = snap.t; }
        if (snap.phase === 'burnout' && e.lastPhase !== 'burnout') e.wheelieSeen = false;
        e.lastPhase = snap.phase;
        if (num(ln.wheelie, 0) > 0.3 && (ln.layout || 'rwd') === 'rwd') e.wheelieSeen = true;   // big RWD launches: drag-prepped car, bars stay for the run
        laneViews.push({ lane: ln, e: e, pose: p, isPlayer: ln === player });
      }
      var pv = null, ov = null;
      for (i = 0; i < laneViews.length; i++) { if (laneViews[i].isPlayer) pv = laneViews[i]; else ov = ov || laneViews[i]; }
      // events -> effects
      (snap.events || []).forEach(function (ev) {
        var v = null; for (var k = 0; k < laneViews.length; k++) if (num(laneViews[k].lane.lane, k) === ev.lane) v = laneViews[k];
        if (!v || !v.e.model) return;
        var mine = v === pv;
        if (ev.type === 'bang' || ev.type === 'shift' && ev.grade === 'late') {
          var tips = exhaustTips(v.e), back = mul(v.pose.fwd, -1);
          for (var t = 0; t < tips.length; t++) for (var r2 = 0; r2 < 2; r2++) emitFlame(tips[t], back, mul(v.pose.fwd, num(v.lane.speed, 0)), 1.4, false);
          if (mine) R.shake = Math.min(1.2, R.shake + 0.3);
        } else if (ev.type === 'shift') { if (mine) R.shake = Math.min(1, R.shake + 0.18); }
        else if (ev.type === 'launch') {
          var tps = exhaustTips(v.e);
          for (var t2 = 0; t2 < tps.length; t2++) for (var r3 = 0; r3 < 3; r3++) emitFlame(tps[t2], mul(v.pose.fwd, -1), [0, 0, 0], 1.5, false);
          if (mine) { R.shake = Math.min(1.6, R.shake + 0.7 + num(ev.spin, 0) * 0.5); R.fovKick = 6; }
        } else if (ev.type === 'chute' && mine) R.shake = Math.min(1, R.shake + 0.25);
        else if (ev.type === 'stage' && v.lane.nitrous && v.lane.nitrous.armed) v.e.purgeT = 0.6;
      });
      // camera (player model first)
      var pe = pv.e;
      pe.model = pe.model || modelFor(pe, pv.lane, 'high');
      // cockpit interior for the player (lazy)
      var hide = null;
      if (R.mode === 'cockpit' && CB.gl.cockpit && typeof CB.gl.cockpit.build === 'function' && !pe.cockpitFailed) {
        if (!pe.cockpit) { try { pe.cockpit = CB.gl.cockpit.build(ctx, pv.lane.build || defaultBuild(), { eye: pe.model.cockpitEye, dims: pe.model.dims, quality: R.quality, units: R.units }); } catch (err) { pe.cockpit = null; pe.cockpitFailed = true; } }
        if (pe.cockpit) hide = pe.cockpit.hideKinds || null;
      }
      var aspect = size.cw / Math.max(1, size.ch);
      // pose cars
      main.length = 0; casters.length = 0;
      for (i = 0; i < laneViews.length; i++) {
        var lv = laneViews[i], ce = lv.e;
        ce.model = modelFor(ce, lv.lane, 'high');
        var list = carLists[i] || (carLists[i] = []);
        poseLane(ce, lv.lane, lv.pose, dt, list, lv === pv && R.mode === 'cockpit' && pe.cockpit ? hide : null);
        if (!(lv === pv && R.mode === 'cockpit' && !pe.cockpit)) for (var q = 0; q < list.length; q++) { main.push(list[q]); if (list[q].castShadow) casters.push(list[q]); }
      }
      if (pv.lane.gLong > 0.7) R.shake = Math.max(R.shake, clamp((pv.lane.gLong - 0.7) * 0.5, 0, 0.5));
      cameraFor(snap, pv.lane, pv.pose, pe, ov, dt, aspect);
      if (R.mode === 'cockpit' && pe.cockpit) {
        try {
          // drag: exaggerated head pitch-back on launch / forward on braking (the race head model is tuned for ~1 g corners)
          var csnap = { speed: num(pv.lane.speed, 0), rpm: num(pv.lane.rpm, 0), redline: pv.lane.redline, gear: pv.lane.gear, throttle: pv.lane.throttle, brake: pv.lane.brake, steerAngle: 0, longG: clamp(num(pv.lane.gLong, 0) * 2.4, -3, 3), latG: 0, headlights: R.night };
          if (pe.cockpit.update) pe.cockpit.update(csnap, dt, R.time, snap);
          var cki = pe.cockpit.drawItems ? pe.cockpit.drawItems(pe.CW) : [];
          for (var c2 = 0; c2 < cki.length; c2++) main.push(cki[c2]);
        } catch (err) { pe.cockpit = null; pe.cockpitFailed = true; }
      }
      // particles: smoke, nitrous, purge
      for (i = 0; i < laneViews.length; i++) {
        var L2 = laneViews[i], e2 = L2.e, ln2 = L2.lane;
        if (!e2.model) continue;
        var rate = smokeRate(ln2, Q.smoke);
        if (rate > 0) {
          e2.smokeAcc = num(e2.smokeAcc, 0) + rate * dt;
          var axles = smokeAxles(ln2.layout || (ln2.build && ln2.build.drivetrain && ln2.build.drivetrain.layout), e2.model.dims), trk = num(e2.model.dims && e2.model.dims.track, 1.6) / 2;
          while (e2.smokeAcc >= 1) {
            e2.smokeAcc -= 1;
            var ax = axles[rnd() < (axles[0].w) ? 0 : axles.length - 1];
            var wp = toWorld(e2, ax.x - 0.25, 0.25, (rnd() < 0.5 ? -1 : 1) * (trk + 0.1));
            var vel = ln2.burnout ? add(mul(L2.pose.fwd, -(1.0 + rnd() * 2.5)), [(rnd() - 0.5) * 4.5, 0.9 + rnd() * 1.6, (rnd() - 0.5) * 4.5]) : [(rnd() - 0.5) * 1.6, 0.4 + rnd() * 0.8, (rnd() - 0.5) * 1.6];
            emitSmoke(wp, vel, !!ln2.burnout);
          }
        }
        if (ln2.nitrous && ln2.nitrous.active) {
          var nt = exhaustTips(e2);
          for (var n2 = 0; n2 < nt.length; n2++) emitFlame(nt[n2], mul(L2.pose.fwd, -1), mul(L2.pose.fwd, num(ln2.speed, 0)), 1.1, true);
        }
        if (e2.purgeT > 0) {
          e2.purgeT -= dt;
          var hl2 = num(e2.model.dims && e2.model.dims.length, 4.4) / 2;
          emitPurge(toWorld(e2, hl2 - 0.3, 0.55, 0.45), [0, 1, 0]);
        } else if (ln2.nitrous && ln2.nitrous.armed && snap.phase === 'staging' && rnd() < dt * 0.3) e2.purgeT = 0.45;
      }
      stepParticles(dt);
      var dyn = buildDynamic(snap, laneViews, cam.position);
      for (i = 0; i < world.items.length; i++) { main.push(world.items[i]); if (world.items[i].castShadow) casters.push(world.items[i]); }
      updateBoards(snap);
      for (i = 0; i < boards.length; i++) if (boards[i].item) main.push(boards[i].item);
      for (i = 0; i < dyn.length; i++) main.push(dyn[i]);
      var env = {
        sunDir: Lt.sunDir, sunColor: Lt.sunColor, ambientSky: Lt.ambientSky, ambientGround: Lt.ambientGround, fogColor: Lt.fogColor, fogDensity: Lt.fogDensity,
        envTop: Lt.envTop, envHorizon: Lt.envHorizon, envBottom: Lt.envBottom, exposure: Lt.exposure, time: R.time, timeOfDay: tod, weather: weather
      };
      if (R.night) {
        var lights = [];
        for (i = 0; i < laneViews.length && lights.length < 2; i++) {
          var lc = laneViews[i].pose;
          lights.push({ pos: madd(madd(lc.pos, lc.fwd, 2.4), [0, 1, 0], 0.7), dir: norm(madd(lc.fwd, [0, 1, 0], -0.07)), color: [5, 4.6, 4], range: 70, cosInner: 0.94, cosOuter: 0.8, type: 1 });
        }
        var lamps = world.dyn.lamps.slice().sort(function (A, B) { return Math.abs(A.pos[0] - cam.position[0] - 25) - Math.abs(B.pos[0] - cam.position[0] - 25); });
        for (i = 0; i < lamps.length && lights.length < 8; i++) lights.push({ pos: lamps[i].pos, color: world.venue === 'street' ? [1.5, 1.15, 0.72] : [1.9, 1.85, 1.7], range: world.venue === 'street' ? 24 : 42, type: 0 });
        env.lights = lights;
      }
      if (shadow) {
        try { if (shadow.render(casters, { center: pv.pose.pos, sunDir: Lt.sunDir, radius: 60 })) env.shadow = shadow; } catch (e2b) { shadow = null; }
      }
      var usePost = !!post;
      if (usePost) { try { var pb = post.begin(size.w, size.h); env.linearOutput = !!(pb && pb.linearOutput); } catch (e3) { usePost = false; post = null; } }
      if (!usePost) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, size.w, size.h); }
      gl.clearColor(Lt.fogColor[0], Lt.fogColor[1], Lt.fogColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      try {
        if (fx && typeof fx.drawSky === 'function') { if (fx.setLinearOutput) fx.setLinearOutput(!!env.linearOutput); fx.drawSky(cam, tod, weather); }
        else if (G.drawSky) G.drawSky(ctx, cam, env, { night: R.night ? 1 : 0 });
      } catch (e4) { /* sky optional */ }
      R.stats.draws = G.drawList(ctx, main, cam, env);
      if (particles && PS.length) { try { particles.draw(cam, env, { viewportHeight: size.h }); } catch (e5) { /* optional */ } }
      if (usePost) {
        try {
          post.end({ bloom: true, bloomStrength: R.night ? 0.95 : 0.55, threshold: env.linearOutput ? 1.1 : 0.82, vignette: 0.3,
            speedBlur: clamp01((num(pv.lane.speed, 0) - 45) / 40) * 0.3, exposure: Lt.exposure, saturation: 1.1, contrast: 1.05, time: R.time });
        } catch (e6) { post = null; }
      }
      var c2d = canvas.getContext && canvas.getContext('2d');
      if (c2d) { c2d.setTransform(1, 0, 0, 1, 0, 0); c2d.clearRect(0, 0, canvas.width, canvas.height); }
      var ms = now() - t0;
      R.ema += (dt * 1000 - R.ema) * 0.05;
      R.stats.ms = ms; R.stats.fps = R.ema > 0 ? 1000 / R.ema : 0; R.stats.particles = PS.length; R.stats.tris = world.stats.total;
      if (opts.autoQuality !== false && R.frame > 120) {
        if (R.ema > 26) R.slowT += dt; else R.slowT = Math.max(0, R.slowT - dt);
        if (R.slowT > 2.5) { R.slowT = 0; var qi = ['low', 'medium', 'high', 'ultra'].indexOf(R.quality); if (qi > 0) api.setQuality(['low', 'medium', 'high', 'ultra'][qi - 1]); }
      }
    }

    var api = {
      is3D: true, kind: 'drag',
      render: render,
      reset: function () { R.rig = {}; R.side = {}; R.stageK = 1; PS.length = 0; Object.keys(R.cars).forEach(function (k) { R.cars[k].prev = null; R.cars[k].wheelieSeen = false; }); },
      getCameraState: function () { return { eye: cam.position.slice(), target: (cam.target || cam.position).slice(), up: (cam.up || [0, 1, 0]).slice(), fov: cam.fovDeg || 64, fovDeg: cam.fovDeg || 64, mode: R.mode, aspect: cam.aspect }; },
      worldToScreen: function (x, y, z) { return toScreen([x, num(z, 0), -y]); },
      setCamera: function (m) { if (m === 'chase-far' || m === 'far') m = 'chase'; if (m === 'hood') m = 'bumper'; if (m === 'tv') m = 'side'; if (MODES.indexOf(m) >= 0) { R.mode = m; R.rig = {}; R.side = {}; } return R.mode; },
      cycleCamera: function () { R.mode = MODES[(MODES.indexOf(R.mode) + 1) % MODES.length]; R.rig = {}; R.side = {}; return R.mode; },
      getCamera: function () { return R.mode; },
      cameraLabel: function () { return LABELS[R.mode]; },
      cameraModes: function () { return MODES.slice(); },
      setFollow: function (lane) { R.follow = lane == null ? null : num(lane, null); R.rig = {}; R.side = {}; },
      getFollow: function () { return R.follow; },
      setUnits: function (u) { R.units = u === 'kph' ? 'kph' : 'mph'; boards.forEach(function (b) { b.key = ''; }); },
      shake: function (amount) { R.shake = Math.min(2, R.shake + num(amount, 0.5)); },
      resize: function () { ensureSize(); },
      getQuality: function () { return R.quality; },
      setQuality: function (q) {
        if (!QUALITY[q] || q === R.quality) return R.quality;
        R.quality = q; setupQuality(); PMAX = Q.particles;
        R.worldKey = '';   // rebuilt on the next frame (crowd / tree LOD)
        return q;
      },
      setAutoQuality: function (b) { opts.autoQuality = !!b; },
      stats: function () { return Object.assign({ quality: R.quality, camera: R.mode, frame: R.frame, venue: R.venue, night: R.night }, R.stats); },
      camera: function () { return cam; },
      destroy: function () {
        try { if (world) world.destroy(); } catch (e) { /* ignore */ }
        destroyBoards();
        Object.keys(R.cars).forEach(function (k) { var c = R.cars[k]; if (c.cockpit && c.cockpit.destroy) try { c.cockpit.destroy(); } catch (e) { /* ignore */ } });
        if (shadow) try { shadow.destroy(); } catch (e) { /* ignore */ }
        if (post) try { post.destroy(); } catch (e) { /* ignore */ }
        if (particles) try { particles.destroy(); } catch (e) { /* ignore */ }
        if (fx && fx.destroy) try { fx.destroy(); } catch (e) { /* ignore */ }
        if (CB.gl.car && CB.gl.car.cache && CB.gl.car.cache.clear) try { CB.gl.car.cache.clear(ctx); } catch (e) { /* ignore */ }
        if (ctx && ctx.destroy) try { ctx.destroy(); } catch (e) { /* ignore */ }
        if (glc.parentNode) glc.parentNode.removeChild(glc);
        canvas.style.background = prevBg || '';
      },
      _world: function () { return world; }, _ctx: function () { return ctx; }
    };
    if (opts.venue || opts.distance) ensureWorld(null);
    return api;
  }

  /* ================================================================== setup-screen preview (turntable) */
  function createPreview(canvas, o) {
    o = o || {};
    var G = CB.gl, M4 = G && G.mat4, ctx = null;
    try { ctx = G.createContext(canvas, { antialias: true, alpha: true }); } catch (e) { ctx = null; }
    if (!ctx) return { ok: false, update: function () {}, destroy: function () {} };
    var gl = ctx.gl, model = null, pst = {}, cur = Object.assign({}, o), raf = 0, ang = 0.6, last = 0, dead = false;
    var lighting = makeLighting(null)('day', 'dry');
    var Geo = G.dragStrip._.Geo, gg = new Geo(), n = 40, c0 = gg.v([0, 0, 0], [0, 1, 0], [0.6, 0.6, 0.62, 1]);
    for (var i = 0; i <= n; i++) { var a = i / n * TAU; gg.v([Math.cos(a) * 4, 0, Math.sin(a) * 4], [0, 1, 0], [0.42, 0.42, 0.45, 1]); }
    for (i = 0; i < n; i++) gg.i.push(c0, c0 + 1 + i, c0 + 2 + i);
    var disc = G.createMesh(ctx, gg.out()), discItem = { mesh: disc, material: { color: [1, 1, 1, 1], roughness: 0.8, castShadow: false }, model: M4.create() };
    var cam = { view: M4.create(), proj: M4.create(), viewProj: M4.create(), position: [0, 0, 0] };
    function rebuild() {
      model = null; pst = {};
      try { if (CB.gl.car && cur.build) model = CB.gl.car.build(ctx, cur.build, { color: cur.color, lod: 'high', id: 'drag-preview' }); } catch (e) { model = null; }
    }
    rebuild();
    function frame(t) {
      if (dead) return;
      raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(frame) : 0;
      var dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016; last = t; ang += dt * 0.35;
      var cw = canvas.clientWidth || 320, ch = canvas.clientHeight || 180, dpr = Math.min(2, num(typeof window !== 'undefined' && window.devicePixelRatio, 1));
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { if (ctx.resize) ctx.resize(cw, ch, dpr); else { canvas.width = cw * dpr; canvas.height = ch * dpr; } }
      var L = model && model.dims ? num(model.dims.length, 4.5) : 4.5, r = L * 1.15;
      var eye = [Math.cos(ang) * r, 1.5, Math.sin(ang) * r];
      M4.lookAt(cam.view, eye, [0, 0.55, 0], [0, 1, 0]); M4.perspective(cam.proj, 34 * DEG, cw / Math.max(1, ch), 0.1, 100);
      M4.multiply(cam.viewProj, cam.proj, cam.view); cam.position = eye; cam.eye = eye; cam.near = 0.1; cam.far = 100;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      var items = [discItem];
      if (model && CB.gl.car.pose) { try { var its = CB.gl.car.pose(model, { x: 0, y: 0, heading: 0, speed: 0 }, dt, pst); for (var k = 0; k < its.length; k++) items.push(its[k]); } catch (e) { /* ignore */ } }
      var env = { sunDir: lighting.sunDir, sunColor: lighting.sunColor, ambientSky: mul(lighting.ambientSky, 1.2), ambientGround: lighting.ambientGround, fogColor: [0.8, 0.8, 0.8], fogDensity: 0, envTop: lighting.envTop, envHorizon: lighting.envHorizon, envBottom: lighting.envBottom, exposure: 1.0 };
      try { G.drawList(ctx, items, cam, env); } catch (e) { /* ignore */ }
    }
    raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(frame) : 0;
    return {
      ok: true,
      update: function (u) { u = u || {}; var rb = u.build !== cur.build || u.color !== cur.color; Object.assign(cur, u); if (rb) rebuild(); },
      destroy: function () { dead = true; if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); try { if (CB.gl.car && CB.gl.car.cache) CB.gl.car.cache.clear(ctx); } catch (e) { /* ignore */ } try { if (ctx.destroy) ctx.destroy(); } catch (e) { /* ignore */ } }
    };
  }

  CB.drag.renderer = {
    isSupported: isSupported, create: create, createPreview: createPreview, MODES: MODES, LABELS: LABELS, QUALITY: QUALITY,
    _: { boardInfo: boardInfo, fmtET: fmtET, fmtMPH: fmtMPH, wheeliePitch: wheeliePitch, smokeRate: smokeRate, flagArm: flagArm, smokeAxles: smokeAxles, chaseEye: chaseEye, sideEye: sideEye, drawBoard: drawBoard }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.drag.renderer;
})();

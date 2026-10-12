/* ==========================================================================
   FORGE Atelier — js/race/drift/camera.js
   CB.race.drift.camera : the drift chase camera.

   A chase camera that follows the car's TRAVEL direction (velocity) with soft, critically damped lag
   instead of being bolted to the body, so a 40 deg slide reads as the car swinging sideways in frame
   (not the world whipping round). FOV widens with speed and drift angle, a subtle low-frequency shake
   rides on slip x speed, and wall kisses add a short trauma kick.

   Pure logic (no DOM / GL). Classic <script> in browsers, require()-able in Node.

     var cam = CB.race.drift.camera.create({ far: false });
     renderer3d.setCameraController(cam.controller);   // additive hook in js/race/gl/renderer3d.js
     cam.setFx(snap.drift.fx)  each frame (optional: slip / angle / drifting hints from the session)
     cam.kick(0..1)            wall hit / impact trauma
     cam.update(ctx) -> { eye, target, up, fovDeg } | false     (ctx: see renderer3d setCameraController)
     cam.reset(), cam.debug()

   World convention (renderer3d): world (x, y) -> GL (x, -z); elevation = GL y.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

(function () {
  'use strict';

  var TAU = Math.PI * 2, DEG = Math.PI / 180;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function wrap(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
  function smooth01(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  var T = {
    velFollow: 0.72,     // share of the camera yaw that follows the velocity direction (rest = body heading)
    velFrom: 4, velTo: 12, // m/s: velocity following fades in over this band (low speed = body heading)
    wYaw: 3.4,           // rad/s natural frequency of the yaw spring (critically damped)
    wDist: 2.6,          // distance spring
    wFov: 2.2,           // fov spring
    wTarget: 6.0,        // look-at offset spring
    maxYawRate: 2.4,     // rad/s: camera yaw rate limit (no whip)
    dist: 6.4, distFar: 10.5, distSpeed: 0.035, distAngle: 1.4,
    height: 2.15, heightFar: 3.6, heightAngle: 0.35,
    lookAhead: 3.2, lookUp: 0.95,
    fovBase: 62, fovSpeed: 12, fovAngle: 7, fovMax: 84, fovFrom: 8, fovTo: 55,
    shakeAmp: 0.045, shakeFreq: 1.6, traumaDecay: 1.6
  };

  /** Critically damped spring step (semi-implicit, sub-stepped: stable for any frame dt). */
  function spring(s, target, w, dt, maxRate) {
    var n = Math.max(1, Math.ceil(dt / 0.01)), h = dt / n;
    for (var i = 0; i < n; i++) {
      var a = w * w * (target - s.x) - 2 * w * s.v;
      s.v += a * h;
      if (maxRate) s.v = clamp(s.v, -maxRate, maxRate);
      s.x += s.v * h;
    }
    return s.x;
  }
  function mk(x) { return { x: x || 0, v: 0 }; }
  /** Smooth band-limited noise in [-1, 1] (sum of incommensurate sines: no frame-to-frame jitter). */
  function noise(t, seed) { return (Math.sin(t * 1.0 + seed) * 0.5 + Math.sin(t * 2.17 + seed * 1.7) * 0.3 + Math.sin(t * 3.73 + seed * 2.3) * 0.2); }

  function create(opts) {
    opts = opts || {};
    var far = !!opts.far;
    var S;
    function reset() { S = { init: false, yaw: mk(0), dist: mk(T.dist), fov: mk(T.fovBase), tx: mk(0), ty: mk(0), t: 0, trauma: 0, fx: null, last: null }; }
    reset();

    function update(ctx) {
      if (!ctx || !ctx.pose || ctx.lookBack) { S.init = false; return false; }
      var mode = ctx.mode || 'chase';
      if (mode !== 'chase' && mode !== 'chase-far') { S.init = false; return false; }
      var farM = far || mode === 'chase-far';
      var dt = clamp(num(ctx.dt, 1 / 60), 0, 0.1);
      var p = ctx.pose, pl = ctx.player || {};
      var x = num(p.x, 0), y = num(p.y, 0), h = num(p.heading, 0), elev = num(p.elev, 0);
      var vx = num(pl.vx, NaN), vy = num(pl.vy, NaN);
      var speed = Math.abs(num(pl.speed, isFinite(vx) ? Math.hypot(vx, vy) : 0));
      var vDir = isFinite(vx) && Math.hypot(vx, vy) > 0.5 ? Math.atan2(vy, vx) : h;
      var slip = wrap(vDir - h);
      if (Math.abs(slip) > 100 * DEG) slip = 0;                    // reversing / spun: follow the body
      var fx = S.fx || {};
      var angle = num(fx.angle_deg, Math.abs(slip) / DEG);
      var slipK = clamp(num(fx.slip, smooth01(6, 34, angle)), 0, 1);
      var follow = T.velFollow * smooth01(T.velFrom, T.velTo, speed);
      var yawT = h + slip * follow;
      if (!S.init) {
        S.yaw.x = yawT; S.yaw.v = 0; S.init = true;
        S.dist.x = farM ? T.distFar : T.dist; S.dist.v = 0; S.fov.x = T.fovBase; S.fov.v = 0; S.tx.x = 0; S.ty.x = 0;
      }
      // unwrap the target next to the spring state, then spring (critically damped + rate limited)
      var yT = S.yaw.x + wrap(yawT - S.yaw.x);
      if (Math.abs(yT - S.yaw.x) > 2.4) { S.yaw.x = yT; S.yaw.v = 0; }   // respawn / teleport
      var yaw = spring(S.yaw, yT, T.wYaw, dt, T.maxYawRate);
      // distance: grows with speed and angle (more of the slide in frame)
      var dims = ctx.dims || {};
      var len = num(dims.length, 4.5);
      var dT = (farM ? T.distFar : T.dist) + (len - 4.5) * 0.8 + speed * T.distSpeed + slipK * T.distAngle;
      var d = spring(S.dist, dT, T.wDist, dt);
      // keep the camera inside the walls (renderer-provided)
      var cy = Math.cos(yaw), sy = Math.sin(yaw);
      if (typeof ctx.safeFraction === 'function') {
        try { var f = num(ctx.safeFraction(x, y, x - cy * d, y - sy * d, 0.45), 1); if (f < 1) { d = Math.max(len * 0.6, d * clamp(f, 0, 1)); S.dist.x = Math.min(S.dist.x, d); } } catch (e) { /* ignore */ }
      }
      var hgt = (farM ? T.heightFar : T.height) + num(dims.height, 1.3) * 0.3 + slipK * T.heightAngle;
      var ex = x - cy * d, ey = y - sy * d, ez = elev + hgt;
      if (typeof ctx.groundY === 'function') { try { ez = Math.max(ez, num(ctx.groundY(ex, -ey), -1e9) + 0.6); } catch (e) { /* ignore */ } }
      // look-at: ahead along the travel direction, offset springed (no snap when the slide flicks over)
      var la = T.lookAhead + speed * 0.02;
      var ox = Math.cos(vDir) * la * smooth01(2, 8, speed) + Math.cos(h) * la * (1 - smooth01(2, 8, speed));
      var oy = Math.sin(vDir) * la * smooth01(2, 8, speed) + Math.sin(h) * la * (1 - smooth01(2, 8, speed));
      var tx = x + spring(S.tx, ox, T.wTarget, dt), ty = y + spring(S.ty, oy, T.wTarget, dt);
      var tz = elev + T.lookUp + num(dims.height, 1.3) * 0.12;
      // fov: speed + angle widen ("flow")
      var fovT = T.fovBase + T.fovSpeed * smooth01(T.fovFrom, T.fovTo, speed) + T.fovAngle * slipK * smooth01(6, 20, speed);
      var fov = clamp(spring(S.fov, Math.min(T.fovMax, fovT), T.wFov, dt), 30, T.fovMax);
      // shake: subtle, smooth; slip x speed + trauma
      S.t += dt;
      S.trauma = Math.max(0, S.trauma - dt * T.traumaDecay);
      var amp = T.shakeAmp * (slipK * smooth01(8, 30, speed) * 0.8 + smooth01(40, 70, speed) * 0.3) + S.trauma * S.trauma * 0.35;
      var ft = S.t * T.shakeFreq * TAU * 0.5;
      var rx = -sy, ry = cy;                                       // camera right (world)
      var n1 = noise(ft, 1.3), n2 = noise(ft * 1.13, 4.1);
      ex += rx * n1 * amp; ey += ry * n1 * amp; ez += n2 * amp * 0.7;
      tz += n2 * amp * 0.3;
      var out = { eye: [ex, ez, -ey], target: [tx, tz, -ty], up: [0, 1, 0], fovDeg: fov };
      S.last = { yaw: yaw, yawT: yawT, slip: slip, dist: d, fov: fov, amp: amp, speed: speed };
      return out;
    }

    var api = {
      update: update,
      controller: function (ctx) { return update(ctx); },
      setFx: function (fx) { S.fx = fx || null; },
      kick: function (k) { S.trauma = clamp(Math.max(S.trauma, num(k, 0.5)), 0, 1); },
      reset: reset,
      debug: function () { return S.last ? Object.assign({ trauma: S.trauma }, S.last) : null; },
      T: T
    };
    return api;
  }

  CB.race.drift.camera = { create: create, TUNING: T, _internal: { spring: spring, noise: noise, wrap: wrap } };
})();
if (typeof module !== 'undefined') module.exports = CB.race.drift.camera;

/* ==========================================================================
   Redline — js/race/gl/arcade-fx.js
   CB.arcade.fx : world + screen effects for the Arcade gameplay layer, drawn as a perspective-projected Canvas-2D
   overlay on top of the WebGL view (no shader / mesh changes to CB.race.renderer3d, so nothing here can break the
   3D renderer; everything is feature-detected and degrades to "no FX").

     var fx = CB.arcade.fx.create({ track, quality })
       track: gameplay.track()  { pose(s, lat) -> {x, y, heading, z?, pos3?} }   (entity placement in track space)
     fx.attachRenderer(renderer3d)   camera FOV kick + shake (chained setCameraController) and the car hop offset
     fx.draw(ctx, snap, state, W, H, dt, view?)   ctx in CSS px; state = gameplay.state()
     fx.events(list)                 gameplay events -> particles (box sparkle, EMP ring, bonk stars, landing sparks)
     fx.project(x, y, elev) -> {x, y, d, k} | null   (k = px per metre at that depth)
     fx.destroy()

   World entities: rotating "?" item crates, chevron boost pads, glowing boost rings, spinning coins, nitro canisters,
   oil puddles, homing rockets with smoke trails. Cars: nitro / boost exhaust flames (blue nitro, orange turbo/pad,
   purple ultra), powerslide sparks by tier, shield bubble, ghost shimmer, slipstream wind. Screen: speed lines,
   boost vignette. Sim -> GL axes as renderer3d: (x, y, elev) -> (x, elev, -y).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};

(function () {
  'use strict';

  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  var TIER_RGB = ['255,255,255', '58,168,255', '255,154,42', '196,91,255'];
  var FLAME = {
    nitro: ['120,220,255', '40,110,255'], mega: ['150,235,255', '40,90,255'], start: ['255,236,140', '255,120,30'],
    turbo: ['255,226,120', '255,110,20'], pad: ['255,226,120', '255,110,20'], ring: ['255,226,120', '255,110,20'],
    slip: ['220,240,255', '140,190,255'], drift1: ['170,220,255', '58,140,255'], drift2: ['255,220,140', '255,130,30'],
    drift3: ['235,180,255', '160,60,255'], trick: ['255,236,140', '255,120,30']
  };

  function create(opts) {
    opts = opts || {};
    var S = {
      track: opts.track || null, renderer: null, cam: null, W: 1, H: 1, t: 0, parts: [], rings: [], bolts: [], trails: {},
      kick: 0, shake: 0, speedLines: 0, posCache: {}, elev: null, prevCtl: null, ctlSet: false, quality: opts.quality || 'auto', maxParts: 360
    };

    /* ---------------- camera + projection ---------------- */
    function camFrame() {
      var R = S.renderer, c = null;
      if (R && typeof R.getCameraState === 'function') { try { c = R.getCameraState(); } catch (e) { c = null; } }
      if (!c || !c.eye || c.mode === 'map') { S.cam = null; return; }
      var f = norm(sub(c.target, c.eye)), r = norm(cross(f, c.up || [0, 1, 0])), u = cross(r, f);
      var fy = (S.H / 2) / Math.tan(num(c.fov, 60) * Math.PI / 360);
      S.cam = { eye: c.eye, f: f, r: r, u: u, fy: fy, near: Math.max(0.25, num(c.near, 0.3)), interior: c.mode === 'cockpit' || c.mode === 'hood' || c.mode === 'bumper' };
    }
    function projectGL(p) {
      var C = S.cam; if (!C) return null;
      var d = sub(p, C.eye), z = dot(d, C.f);
      if (z < C.near) return null;
      var k = C.fy / z;
      return { x: S.W / 2 + dot(d, C.r) * k, y: S.H / 2 - dot(d, C.u) * k, d: z, k: k };
    }
    function project(x, y, elev) { return projectGL([x, num(elev, 0), -y]); }

    /* ---------------- elevation + poses ---------------- */
    function roadY(x, y, s) {
      if (!S.elev) return 0;
      try { return num(S.elev({ x: x, y: y, s: s, lapS: s }), 0); } catch (e) { return 0; }
    }
    function entPose(e) {
      var key = e.id + ':' + Math.round(e.s * 4) + ':' + Math.round(e.lat * 4);
      var c = S.posCache[key];
      if (c) return c;
      var T = S.track, p = T && typeof T.pose === 'function' ? T.pose(e.s, e.lat) : null;
      if (!p) return null;
      c = { x: p.x, y: p.y, h: num(p.heading, 0), z: isNum(p.z) ? p.z : roadY(p.x, p.y, e.s), pos3: p.pos3 || null };
      if (e.type !== 'rocket') S.posCache[key] = c;
      return c;
    }
    /** the renderer's per-car entry (interpolated pose, elevation, models, car.pose() state) */
    function rEntry(c) {
      var R = S.renderer;
      if (!R || typeof R._debug !== 'function') return null;
      try { var D = R._debug(); return D && D.S && D.S.cars ? D.S.cars[c.id] || null : null; } catch (er) { return null; }
    }
    function carPose(c) {
      // prefer the renderer's interpolated pose (smooth at any frame rate) + its road elevation
      var e = rEntry(c);
      if (e && e.pose) return { x: e.pose.x, y: e.pose.y, h: e.pose.heading, z: num(e.elev, 0) };
      return { x: c.x, y: c.y, h: c.heading, z: num(c.arcadeHop, 0) };
    }
    /** world point from a car-local offset (fwd, left, up) */
    function local(P, fwd, left, up) {
      var c = Math.cos(P.h), s = Math.sin(P.h);
      return [P.x + c * fwd - s * left, P.z + up, -(P.y + s * fwd + c * left)];
    }
    function localE(P, fwd, left, up) {
      var c = Math.cos(P.h), s = Math.sin(P.h);
      return [P.x + c * fwd - s * left, P.z + up, -(P.y + s * fwd + c * left)];
    }

    /* ---------------- renderer hooks: camera kick + hop ---------------- */
    function attachRenderer(R) {
      S.renderer = R || null;
      if (!R) return;
      var D = null;
      try { D = typeof R._debug === 'function' ? R._debug() : null; } catch (e) { D = null; }
      var W = D && D.S && D.S.world;
      if (W) {
        var orig = typeof W.roadY === 'function' ? W.roadY : null;
        S.elev = orig;
        if (!W._arcadeHop) {
          W.roadY = function (car) { return (orig ? num(orig(car), 0) : 0) + (car && isNum(car.arcadeHop) ? car.arcadeHop : 0); };
          W._arcadeHop = true;
        }
      }
      if (typeof R.setCameraController === 'function' && !S.ctlSet) {
        S.prevCtl = D && D.S && typeof D.S.camCtl === 'function' ? D.S.camCtl : null;
        S.ctlSet = true;
        R.setCameraController(function (ctx) {
          var out = null;
          if (S.prevCtl) { try { out = S.prevCtl(ctx); } catch (e) { out = null; } }
          var eye = out && out.eye ? out.eye.slice() : ctx.eye.slice();
          var fov = out && isNum(out.fovDeg) ? out.fovDeg : ctx.fovDeg;
          var tgt = null;
          if (ctx.mode === 'chase' || ctx.mode === 'chase-far') tgt = chaseFix(ctx, eye, out && out.target ? out.target.slice() : ctx.target.slice());
          if (S.kick < 0.003 && S.shake < 0.003) {
            if (!tgt) return out || false;
            var o0 = out ? Object.assign({}, out) : {};
            o0.eye = eye; o0.target = tgt;
            return o0;
          }
          var mode = ctx.mode, interior = mode === 'cockpit' || mode === 'hood' || mode === 'bumper';
          fov += S.kick * (interior ? 9 : 13);
          var a = S.shake * (interior ? 0.035 : 0.07), t = S.t;
          eye[0] += Math.sin(t * 61.3) * a; eye[1] += Math.sin(t * 47.9 + 1.3) * a * 0.7; eye[2] += Math.sin(t * 53.1 + 2.1) * a;
          var o = out ? Object.assign({}, out) : {};
          o.eye = eye; o.fovDeg = fov;
          if (tgt) o.target = tgt;
          return o;
        });
      }
    }
    /** Chase-cam comfort (visual only, renderer3d controller ctx): (1) during a cartoon spin-out the camera keeps the
        travel direction instead of whirling with the car, blending back afterwards; (2) a car about to pass through
        the lens lifts the camera over it. Edits eye in place; returns the new target, or null when nothing changed. */
    function chaseFix(ctx, eye, target) {
      var snap = ctx.snap, pl = ctx.player, P = ctx.pose, dt = clamp(num(ctx.dt, 0.016), 0, 0.1);
      if (!snap || !pl || !P) return null;
      var C = S.ccam || (S.ccam = { w: 0, lift: 0, yaw: null });
      var ar = snap.arcade, A = pl.arcade || (ar && ar.karts && ar.karts[pl.id]) || null;
      var spinning = !!(A && (A.spin > 0 || A.hop > 0.05));
      var px = P.x, py = P.y, changed = false;
      // camera yaw the renderer chose (eye -> car, sim axes) and the travel direction
      var ry = Math.atan2(py + eye[2], px - eye[0]);
      var vx = num(pl.vx, 0), vy = num(pl.vy, 0), sp = Math.hypot(vx, vy);
      if (C.yaw === null || !spinning && C.w < 0.01) C.yaw = ry;
      if (sp > 4) C.yaw = C.yaw + wrapA(Math.atan2(vy, vx) - C.yaw) * (1 - Math.exp(-dt * 6));
      C.w += ((spinning ? 1 : 0) - C.w) * (1 - Math.exp(-dt * (spinning ? 12 : 1.6)));
      if (C.w > 0.002) {
        var dyaw = wrapA(C.yaw - ry) * C.w;
        var ex = eye[0] - px, ez = eye[2] + py, cd = Math.cos(-dyaw), sd = Math.sin(-dyaw);   // GL z = -sim y: rotate by -dyaw
        var nx = ex * cd - ez * sd, nz = ex * sd + ez * cd;
        if (typeof ctx.safeFraction === 'function') {
          var f = 1;
          try { f = num(ctx.safeFraction(px, py, px + nx, py - nz), 1); } catch (e) { f = 1; }
          f = clamp(f, 0.4, 1); nx *= f; nz *= f;
        }
        eye[0] = px + nx; eye[2] = -py + nz;
        // aim along the held direction (lerped with the renderer's aim, which follows the spinning nose)
        var th = Math.hypot(target[0] - px, target[2] + py), yy = ry + dyaw + (ctx.lookBack ? Math.PI : 0);
        var ax = px + Math.cos(yy) * th, az = -(py + Math.sin(yy) * th);
        target[0] += (ax - target[0]) * C.w; target[2] += (az - target[2]) * C.w;
        changed = true;
      }
      // near-lens protection: lift over an opponent whose body would cut the near plane
      var need = 0;
      for (var i = 0; snap.cars && i < snap.cars.length; i++) {
        var c = snap.cars[i];
        if (c === pl || c.id === pl.id) continue;
        var Q = carPose(c), e = rEntry(c), m = e && e.models ? e.models.high || e.models.low : null, d = (m && m.dims) || {};
        var dx = eye[0] - Q.x, dy = -eye[2] - Q.y;
        if (dx * dx + dy * dy > 64) continue;
        var ch = Math.cos(Q.h), sh = Math.sin(Q.h), lf = dx * ch + dy * sh, ll = -dx * sh + dy * ch;
        var hl = num(d.length, num(c.length_m, 4.5)) / 2, hw = num(d.width, num(c.width_m, 1.9)) / 2;
        var out = Math.max(Math.abs(lf) - hl, Math.abs(ll) - hw, 0);
        var top = Q.z + num(d.height, 1.35) + 0.6;
        if (out < 1.6 && eye[1] < top) need = Math.max(need, (top - eye[1]) * (1 - out / 1.6));
      }
      C.lift += (need - C.lift) * (1 - Math.exp(-dt * (need > C.lift ? 18 : 2.5)));
      if (C.lift > 0.005) { eye[1] += C.lift; target[1] += C.lift * 0.35; changed = true; }
      return changed ? target : null;
    }
    function wrapA(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

    /* ---------------- particles ---------------- */
    function spawn(p) {
      if (S.parts.length >= S.maxParts) S.parts.shift();
      S.parts.push(p);
    }
    function burst(pos3, n, rgb, speed, life, size, grav, vel) {
      var bv = vel || [0, 0, 0];   // inherit the car's velocity (else a 60 m/s car leaves the sparkle behind, into the camera)
      for (var i = 0; i < n; i++) {
        var a = Math.random() * TAU, el = Math.random() * 0.9 + 0.1, v = speed * (0.4 + Math.random() * 0.8);
        spawn({ p: pos3.slice(), v: [bv[0] + Math.cos(a) * v * (1 - el * 0.5), bv[1] + el * v, bv[2] + Math.sin(a) * v * (1 - el * 0.5)], life: life * (0.6 + Math.random() * 0.6), age: 0, rgb: rgb, size: size, g: grav == null ? 9 : grav, star: n < 14 });
      }
    }
    function stepParts(dt) {
      for (var i = S.parts.length - 1; i >= 0; i--) {
        var q = S.parts[i];
        q.age += dt;
        if (q.age >= q.life) { S.parts.splice(i, 1); continue; }
        q.v[1] -= q.g * dt;
        q.p[0] += q.v[0] * dt; q.p[1] += q.v[1] * dt; q.p[2] += q.v[2] * dt;
        if (q.p[1] < q.floor) { q.p[1] = q.floor; q.v[1] *= -0.35; }
      }
    }
    function drawParts(ctx) {
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < S.parts.length; i++) {
        var q = S.parts[i], sp = projectGL(q.p);
        if (!sp) continue;
        var a = 1 - q.age / q.life, r = Math.max(1, q.size * sp.k * (0.5 + a * 0.5));
        if (r > 60 || sp.d < 1.5) continue;
        if (r > 10) { a *= 10 / r; r = 10; }
        ctx.fillStyle = 'rgba(' + q.rgb + ',' + a.toFixed(3) + ')';
        if (q.streak) {
          var sp2 = projectGL([q.p[0] - q.v[0] * 0.03, q.p[1] - q.v[1] * 0.03, q.p[2] - q.v[2] * 0.03]);
          if (sp2) { ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = Math.max(1, r * 0.6); ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(sp2.x, sp2.y); ctx.stroke(); continue; }
        }
        ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    /* ---------------- world entities ---------------- */
    function drawBox(ctx, e, P) {
      var t = S.t, bob = Math.sin(t * 2.2 + e.s) * 0.15, size = 0.95, yaw = t * 1.4 + e.s * 0.1, tilt = 0.35;   // ~1.9 m crate, Mario-Kart big
      var c0 = [P.x, P.z + 1.55 + bob, -P.y];
      var cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
      function v(x, y, z) {   // rotate around X (tilt) then Y (yaw)
        var y1 = y * ct - z * st, z1 = y * st + z * ct;
        return [c0[0] + x * cy + z1 * sy, c0[1] + y1, c0[2] - x * sy + z1 * cy];
      }
      var V = [v(-size, -size, -size), v(size, -size, -size), v(size, size, -size), v(-size, size, -size),
               v(-size, -size, size), v(size, -size, size), v(size, size, size), v(-size, size, size)];
      var Pp = V.map(projectGL);
      if (Pp.some(function (p) { return !p; })) return;
      var F = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
      var faces = [];
      F.forEach(function (f, fi) {
        var a = Pp[f[0]], b = Pp[f[1]], c = Pp[f[2]];
        var area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (area > 0) return;   // back face (screen y down)
        var dz = (Pp[f[0]].d + Pp[f[1]].d + Pp[f[2]].d + Pp[f[3]].d) / 4;
        faces.push({ f: f, d: dz, i: fi });
      });
      faces.sort(function (a, b) { return b.d - a.d; });
      var hue = (t * 60 + e.s * 3) % 360;
      // glow
      var cp = projectGL(c0);
      if (cp) {
        var gr = cp.k * 1.6, g = ctx.createRadialGradient(cp.x, cp.y, 0, cp.x, cp.y, gr);
        g.addColorStop(0, 'hsla(' + hue + ',100%,70%,.45)'); g.addColorStop(1, 'hsla(' + hue + ',100%,60%,0)');
        ctx.fillStyle = g; ctx.fillRect(cp.x - gr, cp.y - gr, gr * 2, gr * 2);
      }
      faces.forEach(function (fc) {
        var q = fc.f.map(function (k) { return Pp[k]; });
        ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); for (var i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath();
        var gg = ctx.createLinearGradient(q[0].x, q[0].y, q[2].x, q[2].y);
        gg.addColorStop(0, 'hsla(' + ((hue + fc.i * 40) % 360) + ',95%,62%,.62)');
        gg.addColorStop(1, 'hsla(' + ((hue + 140 + fc.i * 40) % 360) + ',95%,58%,.62)');
        ctx.fillStyle = gg; ctx.fill();
        ctx.lineWidth = Math.max(1, 0.06 * q[0].k); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke();
        // "?" on the face, drawn in the face's own affine frame
        var ox = (q[0].x + q[2].x) / 2, oy = (q[0].y + q[2].y) / 2;
        ctx.save();
        ctx.translate(ox, oy);
        var ax = (q[1].x - q[0].x) / 2, ay = (q[1].y - q[0].y) / 2, bx = (q[3].x - q[0].x) / 2, by = (q[3].y - q[0].y) / 2;
        ctx.transform(ax, ay, -bx, -by, 0, 0);   // front faces wind consistently: flip v so the glyph reads upright
        ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.font = '900 1.3px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('?', 0, 0.1);
        ctx.restore();
      });
    }
    function groundQuad(ctx, P, fwd, left, len, wid, fill, stroke) {
      var pts = [localE(P, fwd - len / 2, left - wid / 2, 0.04), localE(P, fwd + len / 2, left - wid / 2, 0.04), localE(P, fwd + len / 2, left + wid / 2, 0.04), localE(P, fwd - len / 2, left + wid / 2, 0.04)].map(projectGL);
      if (pts.some(function (p) { return !p; })) return false;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (var i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
      return true;
    }
    function drawPad(ctx, e, P) {
      var len = num(e.len, 7), wid = num(e.w, 3.4);
      if (!groundQuad(ctx, P, 0, 0, len, wid, 'rgba(255,120,20,.42)', 'rgba(255,220,120,.9)')) return;
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 3; i++) {
        var ph = ((S.t * 1.8 + i / 3) % 1), f0 = -len / 2 + ph * len;
        var a = projectGL(localE(P, f0 - 0.6, -wid * 0.42, 0.05)), b = projectGL(localE(P, f0 + 0.6, 0, 0.05)), c = projectGL(localE(P, f0 - 0.6, wid * 0.42, 0.05));
        if (!a || !b || !c) continue;
        ctx.strokeStyle = 'rgba(255,240,170,' + (0.9 * Math.sin(ph * Math.PI)).toFixed(3) + ')';
        ctx.lineWidth = Math.max(2, 0.35 * b.k); ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    function drawRing(ctx, e, P) {
      var r = num(e.r, 2.8), segs = 28, pts = [];
      for (var i = 0; i <= segs; i++) {
        var a = i / segs * TAU;
        pts.push(projectGL(localE(P, 0, Math.cos(a) * r, r + 0.3 + Math.sin(a) * r)));
      }
      if (pts.some(function (p) { return !p; })) return;
      ctx.globalCompositeOperation = 'lighter';
      for (var pass = 0; pass < 2; pass++) {
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.strokeStyle = pass ? 'rgba(255,250,210,.95)' : 'rgba(255,150,40,.45)';
        ctx.lineWidth = Math.max(2, (pass ? 0.18 : 0.6) * pts[0].k);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    function drawCoin(ctx, e, P) {
      var c = projectGL([P.x, P.z + 0.95 + Math.sin(S.t * 3 + e.s) * 0.08, -P.y]);
      if (!c) return;
      var r = 0.55 * c.k, sq = Math.abs(Math.cos(S.t * 4 + e.s * 0.3));
      if (r < 0.6) return;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, Math.max(0.8, r * sq), r, 0, 0, TAU);
      ctx.fillStyle = '#ffcc33'; ctx.fill(); ctx.lineWidth = Math.max(1, r * 0.18); ctx.strokeStyle = '#b07a00'; ctx.stroke();
      if (sq > 0.5) { ctx.fillStyle = '#fff3a8'; ctx.beginPath(); ctx.ellipse(c.x - r * 0.15 * sq, c.y - r * 0.2, r * 0.18 * sq, r * 0.32, 0, 0, TAU); ctx.fill(); }
    }
    function drawCan(ctx, e, P) {
      var b = projectGL([P.x, P.z + 0.15, -P.y]), t = projectGL([P.x, P.z + 1.25 + Math.sin(S.t * 2.5 + e.s) * 0.08, -P.y]);
      if (!b || !t) return;
      var w = 0.32 * b.k;
      var g = ctx.createRadialGradient(t.x, (t.y + b.y) / 2, 0, t.x, (t.y + b.y) / 2, w * 4);
      g.addColorStop(0, 'rgba(80,170,255,.5)'); g.addColorStop(1, 'rgba(80,170,255,0)');
      ctx.fillStyle = g; ctx.fillRect(t.x - w * 4, (t.y + b.y) / 2 - w * 4, w * 8, w * 8);
      ctx.fillStyle = '#2f7bff'; ctx.strokeStyle = '#cfe6ff'; ctx.lineWidth = Math.max(1, w * 0.15);
      ctx.beginPath(); ctx.rect(t.x - w, t.y + w * 0.6, w * 2, Math.max(2, b.y - t.y - w * 0.6)); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#d6dbe6'; ctx.fillRect(t.x - w * 0.35, t.y, w * 0.7, w * 0.7);
      if (w > 4) { ctx.fillStyle = '#fff'; ctx.font = '900 ' + Math.round(w * 1.2) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', t.x, (t.y + b.y) / 2 + w * 0.3); }
    }
    function drawOil(ctx, e, P) {
      var age = num(e.age, 1), grow = clamp(age / 0.35, 0.2, 1), r = 1.9 * grow, pts = [];
      for (var i = 0; i < 18; i++) {
        var a = i / 18 * TAU, wob = 1 + 0.12 * Math.sin(a * 3 + e.s);
        pts.push(projectGL(localE(P, Math.cos(a) * r * wob * 1.2, Math.sin(a) * r * wob, 0.03)));
      }
      if (pts.some(function (p) { return !p; })) return;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath();
      var cx = 0, cy = 0; pts.forEach(function (p) { cx += p.x; cy += p.y; }); cx /= pts.length; cy /= pts.length;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(4, Math.abs(pts[0].x - cx) * 1.3));
      var h = (S.t * 40) % 360;
      g.addColorStop(0, 'rgba(20,16,32,.92)'); g.addColorStop(0.6, 'hsla(' + h + ',70%,35%,.75)'); g.addColorStop(1, 'hsla(' + ((h + 120) % 360) + ',80%,45%,.55)');
      ctx.fillStyle = g; ctx.fill();
    }
    function drawRocket(ctx, e, P) {
      var trail = S.trails[e.id] || (S.trails[e.id] = []);
      var head = [P.x, P.z + 0.7, -P.y];
      trail.push({ p: head, t: S.t });
      while (trail.length && S.t - trail[0].t > 0.6) trail.shift();
      for (var i = 0; i < trail.length; i++) {
        var q = projectGL(trail[i].p); if (!q) continue;
        var a = (S.t - trail[i].t) / 0.6;
        var rr = Math.min(40, Math.max(1, (0.12 + a * 0.3) * q.k));
        ctx.fillStyle = 'rgba(225,225,235,' + (0.32 * (1 - a) * (q.d < 8 ? q.d / 8 : 1)).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(q.x, q.y, rr, 0, TAU); ctx.fill();
      }
      var hp = projectGL(head); if (!hp) return;
      var dir = e.dir || 1;
      var tail = projectGL(localE({ x: P.x, y: P.y, z: P.z, h: P.h }, -0.9 * dir, 0, 0.7));
      if (tail) {
        ctx.strokeStyle = '#ff3b4e'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(3, 0.45 * hp.k);
        ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(hp.x, hp.y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,200,80,.9)'; ctx.beginPath(); ctx.arc(tail.x, tail.y, Math.max(2, 0.3 * hp.k * (0.8 + Math.random() * 0.4)), 0, TAU); ctx.fill();
      }
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hp.x, hp.y, Math.max(1.5, 0.16 * hp.k), 0, TAU); ctx.fill();
    }

    /* ---------------- car effects ---------------- */
    /** world exhaust tips {p, back} of a car as the renderer drew it this frame: the model's anchors.exhaust (lowpoly /
        car-mesh, honouring def.exhaust overrides) through the posed body matrix (interpolated pose + suspension pitch /
        roll from car.pose(), + road elevation / hop), so the flames stay glued to the pipes at any speed */
    function exhaustTips(c, P) {
      var e = rEntry(c), m = e && e.models ? e.models[e.lod] || e.models.high || e.models.low : null;
      var ex = m && m.anchors && m.anchors.exhaust;
      if ((!ex || !ex.length) && e && e.models && e.models.high && e.models.high.anchors) ex = e.models.high.anchors.exhaust;   // low LOD carries no anchors
      var B = e && e.poseState && e.poseState.bodyMatrix, elev = e ? num(e.elev, P.z) : P.z;
      if (B && !(Math.abs(B[12] - P.x) < 3 && Math.abs(B[14] + P.y) < 3 && Math.abs(B[5]) > 0.8)) B = null;   // stale / foreign frame
      var ch = Math.cos(P.h), sh = Math.sin(P.h);
      var back = B ? [-B[0], -B[1], -B[2]] : [-ch, 0, sh], out = [];
      function put(x, y, z) {   // car-local (x fwd, y up, z right)
        var w = B ? [B[0] * x + B[4] * y + B[8] * z + B[12], B[1] * x + B[5] * y + B[9] * z + B[13] + elev, B[2] * x + B[6] * y + B[10] * z + B[14]]
          : local(P, x, -z, y);
        out.push({ p: w, back: back });
      }
      if (ex && ex.length) { for (var i = 0; i < ex.length && i < 4; i++) if (ex[i]) put(num(ex[i][0], 0), num(ex[i][1], 0.3), num(ex[i][2], 0)); }
      else if (!ex || !(e && e.models && e.models.high)) {   // no anchors known (fallback car / low LOD only): two tips at the rear bumper
        var d = (m && m.dims) || {}, L = num(d.length, num(c.length_m, 4.5)) / 2, Wd = num(d.width, num(c.width_m, 1.9)) / 2;
        put(-L * 0.98, 0.3, Wd * 0.42); put(-L * 0.98, 0.3, -Wd * 0.42);
      }
      return out;
    }
    function drawFlames(ctx, c, P, kind, A) {
      var col = FLAME[kind] || FLAME.nitro, tips = exhaustTips(c, P);
      if (!tips.length) return;
      var len = (kind === 'nitro' || kind === 'mega' ? 1.5 : 1.0) * (0.8 + Math.random() * 0.4) * (tips.length > 2 ? 0.8 : 1);
      var rad = tips.length > 2 ? 0.1 : 0.13;
      ctx.globalCompositeOperation = 'lighter';
      for (var s = 0; s < tips.length; s++) {
        var T = tips[s], bk = T.back;
        var base = projectGL([T.p[0] + bk[0] * 0.03, T.p[1] + bk[1] * 0.03, T.p[2] + bk[2] * 0.03]);
        var tip = projectGL([T.p[0] + bk[0] * len, T.p[1] + bk[1] * len + 0.04, T.p[2] + bk[2] * len]);
        if (!base || !tip) continue;
        var r = Math.max(1.5, rad * base.k);
        var dx = tip.x - base.x, dy = tip.y - base.y, dl = Math.hypot(dx, dy) || 1, nx = -dy / dl * r, ny = dx / dl * r;
        var g = ctx.createLinearGradient(base.x, base.y, tip.x, tip.y);
        g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(0.25, 'rgba(' + col[0] + ',.9)'); g.addColorStop(1, 'rgba(' + col[1] + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(base.x + nx, base.y + ny); ctx.quadraticCurveTo(base.x + dx * 0.5 + nx * 1.4, base.y + dy * 0.5 + ny * 1.4, tip.x, tip.y);
        ctx.quadraticCurveTo(base.x + dx * 0.5 - nx * 1.4, base.y + dy * 0.5 - ny * 1.4, base.x - nx, base.y - ny); ctx.closePath(); ctx.fill();
        var gl = ctx.createRadialGradient(base.x, base.y, 0, base.x, base.y, r * 2.6);
        gl.addColorStop(0, 'rgba(' + col[0] + ',.6)'); gl.addColorStop(1, 'rgba(' + col[1] + ',0)');
        ctx.fillStyle = gl; ctx.fillRect(base.x - r * 2.6, base.y - r * 2.6, r * 5.2, r * 5.2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    function driftSparks(c, P, A, dt) {
      var tier = A.drift.tier, rgb = TIER_RGB[tier] || TIER_RGB[0], L = num(c.length_m, 4.5) / 2, Wd = num(c.width_m, 1.9) / 2;
      var n = tier ? 3 : 1;
      for (var s = -1; s <= 1; s += 2) {
        for (var i = 0; i < n; i++) {
          if (Math.random() > dt * 60) continue;
          var p = local(P, -L * 0.7, s * Wd * 0.9, 0.05), ch = Math.cos(P.h), sh = Math.sin(P.h);
          var v = 3 + Math.random() * 4;
          spawn({ p: p, v: [-ch * v + (Math.random() - 0.5) * 3, 1 + Math.random() * 2.5, sh * v + (Math.random() - 0.5) * 3], life: 0.25 + Math.random() * 0.2, age: 0, rgb: rgb, size: tier ? 0.07 : 0.04, g: 9, floor: P.z, streak: true });
        }
      }
    }
    function drawBubble(ctx, P, rgb, alpha, wobble) {
      var c = projectGL([P.x, P.z + 0.75, -P.y]);
      if (!c) return;
      var r = 2.7 * c.k * (1 + Math.sin(S.t * 6) * 0.02 * wobble);
      if (r > 2000) return;
      var g = ctx.createRadialGradient(c.x - r * 0.3, c.y - r * 0.35, r * 0.1, c.x, c.y, r);
      g.addColorStop(0, 'rgba(255,255,255,' + (alpha * 0.35).toFixed(3) + ')'); g.addColorStop(0.7, 'rgba(' + rgb + ',' + (alpha * 0.12).toFixed(3) + ')'); g.addColorStop(1, 'rgba(' + rgb + ',' + (alpha * 0.55).toFixed(3) + ')');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(' + rgb + ',' + (alpha * 0.8).toFixed(3) + ')'; ctx.lineWidth = Math.max(1, r * 0.03); ctx.stroke();
    }

    /** screen-space boxes of every car body (8 projected corners), for masking entities behind them */
    function carMasks(snap) {
      var out = [];
      if (!snap || !snap.cars) return out;
      for (var i = 0; i < snap.cars.length; i++) {
        var c = snap.cars[i], P = carPose(c), L = num(c.length_m, 4.5) / 2 * 0.92, Wd = num(c.width_m, 1.9) / 2 * 0.9;
        var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, dmin = 1e9, ok = true;
        for (var k = 0; k < 8 && ok; k++) {
          var q = projectGL(local(P, k & 1 ? L : -L, k & 2 ? Wd : -Wd, k & 4 ? 1.15 : 0.05));
          if (!q) { ok = false; break; }
          if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; if (q.d < dmin) dmin = q.d;
        }
        if (!ok || x1 < 0 || y1 < 0 || x0 > S.W || y0 > S.H || dmin > 220) continue;
        var sx = (x1 - x0) * 0.06, sy = (y1 - y0) * 0.08;   // trim the box toward the real silhouette
        out.push({ d: dmin, x0: x0 + sx, y0: y0 + sy, x1: x1 - sx, y1: y1 });
      }
      return out;
    }

    /* ---------------- events -> particles ---------------- */
    function events(list, snap, state) {
      (list || []).forEach(function (e) {
        var car = null, P = null;
        if (e.carId && snap && snap.cars) for (var i = 0; i < snap.cars.length; i++) if (snap.cars[i].id === e.carId) { car = snap.cars[i]; break; }
        if (car) P = carPose(car);
        var base = P ? [P.x, P.z + 1.0, -P.y] : null;
        var cv = car ? [num(car.vx, 0) * 0.92, 0, -num(car.vy, 0) * 0.92] : null;
        var burstC = function (pos, n, rgb, sp, life, size, g) { burst(pos, n, rgb, sp, life, size, g, cv); };
        switch (e.type) {
          case 'itemBox': if (base) burstC(base, 22, Math.random() < 0.5 ? '255,240,160' : '160,220,255', 5, 0.6, 0.09, 4); break;
          case 'coin': if (base) burstC(base, 8, '255,214,70', 3, 0.4, 0.07, 6); break;
          case 'canister': if (base) burstC(base, 16, '110,190,255', 4, 0.5, 0.09, 3); break;
          case 'hit':
            if (base) burstC(base, e.kind === 'rocket' ? 12 : 8, e.kind === 'rocket' ? '255,230,90' : '200,200,255', 6, 0.7, 0.16, 7);
            if (car && car.isPlayer) S.shake = Math.max(S.shake, 1);
            break;
          case 'explode': if (base) { burstC(base, 30, '255,150,50', 9, 0.6, 0.12, 6); burstC(base, 10, '255,255,255', 4, 0.4, 0.2, 2); } break;
          case 'blocked': if (base) burstC(base, 18, '120,255,190', 5, 0.5, 0.1, 2); break;
          case 'emp': if (P) S.rings.push({ p: [P.x, P.z + 0.3, -P.y], t: 0, r: num(e.radius, 22), rgb: '80,220,255' }); break;
          case 'lightning':
            (state && state.karts ? Object.keys(state.karts) : []).forEach(function (id) {
              var k = state.karts[id], cc = null;
              if (!k || k.slow <= 0 || id === e.carId) return;
              for (var j = 0; j < snap.cars.length; j++) if (snap.cars[j].id === id) cc = snap.cars[j];
              if (cc) S.bolts.push({ id: id, t: 0, seed: Math.random() * 100 });
            });
            break;
          case 'landing': if (base) burstC([base[0], base[1] - 0.9, base[2]], e.big ? 26 : 14, '255,200,90', 6, 0.45, 0.06, 9); if (car && car.isPlayer) S.shake = Math.max(S.shake, e.big ? 0.8 : 0.45); break;
          case 'boost': if (car && car.isPlayer) { S.kick = Math.max(S.kick, e.kind === 'mega' || e.kind === 'start' ? 1 : 0.7); S.shake = Math.max(S.shake, 0.35); } break;
          case 'nitroStart': if (car && car.isPlayer) { S.kick = Math.max(S.kick, 1); S.shake = Math.max(S.shake, 0.5); } break;
          default: break;
        }
      });
    }

    /* ---------------- frame ---------------- */
    function draw(ctx, snap, st, W, H, dt) {
      S.W = W; S.H = H; dt = clamp(num(dt, 0.016), 0, 0.1); S.t += dt;
      if (!st) return;
      camFrame();
      var me = st.player, meCar = null, i;
      if (snap && snap.cars) for (i = 0; i < snap.cars.length; i++) if (snap.cars[i].isPlayer) meCar = snap.cars[i];
      // camera feel targets
      var boosting = me && (me.nitroOn || me.boost);
      S.kick += ((boosting ? (me.nitroOn ? 1 : 0.6) : 0) - S.kick) * clamp(dt * (boosting ? 5 : 2.2), 0, 1);
      S.shake = Math.max(boosting ? 0.25 : 0, S.shake - dt * 1.6);
      S.speedLines += ((boosting ? 1 : (me && me.slip > 0.3 ? 0.35 : 0)) - S.speedLines) * clamp(dt * 6, 0, 1);
      ctx.save();
      if (S.cam) {
        // entities, far to near (skipped when the 3D renderer draws the arcade world itself, e.g. the stunt renderer)
        var own3d = !!(S.renderer && S.renderer.drawsArcadeWorld);
        var list = [];
        (own3d ? [] : st.entities || []).forEach(function (e) {
          if (!e.active && e.type !== 'rocket') return;
          var P = entPose(e); if (!P) return;
          var c = projectGL([P.x, P.z + 1, -P.y]); if (!c || c.d > 260) return;
          // interior cameras: the dashboard / bonnet would be painted over by near ground decals (no depth buffer)
          if (S.cam.interior && c.d < (e.type === 'box' || e.type === 'ring' || e.type === 'rocket' ? 4 : 11)) return;
          list.push({ e: e, P: P, d: c.d });
        });
        list.sort(function (a, b) { return b.d - a.d; });
        var masks = carMasks(snap);
        S.stats = { listed: list.length, nearest: list.length ? Math.round(list[list.length - 1].d) : null, masks: masks.length };
        list.forEach(function (o) {
          var e = o.e;
          // the overlay has no depth buffer: cut out the silhouettes (screen boxes) of cars nearer to the camera
          var cut = null;
          if (masks.length) {
            var cc = projectGL([o.P.x, o.P.z + 1, -o.P.y]), rad = cc ? cc.k * 4 : 0;
            for (var mi = 0; cc && mi < masks.length; mi++) {
              var m = masks[mi];
              if (m.d < o.d - 0.5 && cc.x + rad > m.x0 && cc.x - rad < m.x1 && cc.y + rad > m.y0 && cc.y - rad < m.y1) (cut = cut || []).push(m);
            }
          }
          if (cut) {
            ctx.save(); ctx.beginPath(); ctx.rect(0, 0, S.W, S.H);
            cut.forEach(function (m) { ctx.rect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0); });
            ctx.clip('evenodd');
          }
          if (e.type === 'box') drawBox(ctx, e, o.P);
          else if (e.type === 'pad') drawPad(ctx, e, o.P);
          else if (e.type === 'ring') drawRing(ctx, e, o.P);
          else if (e.type === 'coin') drawCoin(ctx, e, o.P);
          else if (e.type === 'can') drawCan(ctx, e, o.P);
          else if (e.type === 'oil') drawOil(ctx, e, o.P);
          else if (e.type === 'rocket') drawRocket(ctx, e, o.P);
          if (cut) ctx.restore();
        });
        Object.keys(S.trails).forEach(function (id) { if (!(st.entities || []).some(function (e) { return e.id === id; })) delete S.trails[id]; });
        // cars
        if (snap && snap.cars) {
          for (i = 0; i < snap.cars.length; i++) {
            var c = snap.cars[i], A = c.arcade || (st.karts && st.karts[c.id]);
            if (!A) continue;
            var P = carPose(c), cp = projectGL([P.x, P.z + 0.6, -P.y]);
            if (!cp || cp.d > 200) continue;
            var kind = A.nitroOn ? 'nitro' : A.boost ? A.boost.kind : null;
            if (kind && !own3d) drawFlames(ctx, c, P, kind, A);
            if (A.drift) driftSparks(c, P, A, dt);
            if (A.shield > 0) drawBubble(ctx, P, '98,240,181', A.shield < 1.5 ? 0.5 + 0.5 * Math.sin(S.t * 20) : 1, 1);
            if (A.ghost > 0) drawBubble(ctx, P, '185,168,255', 0.55 + 0.25 * Math.sin(S.t * 9), 2);
            if (A.magnet > 0 && Math.random() < dt * 30) spawn({ p: [P.x + (Math.random() - 0.5) * 3, P.z + 0.6 + Math.random(), -P.y + (Math.random() - 0.5) * 3], v: [0, 0.4, 0], life: 0.35, age: 0, rgb: '255,90,100', size: 0.06, g: 0, floor: -1e9 });
            if (A.slow > 0 && Math.random() < dt * 25) spawn({ p: [P.x, P.z + 1.4, -P.y], v: [(Math.random() - 0.5) * 2, 1.5, (Math.random() - 0.5) * 2], life: 0.5, age: 0, rgb: '255,240,120', size: 0.08, g: 0, floor: -1e9 });
          }
        }
        stepParts(dt); drawParts(ctx);
        // EMP rings
        for (i = S.rings.length - 1; i >= 0; i--) {
          var R = S.rings[i]; R.t += dt;
          if (R.t > 0.7) { S.rings.splice(i, 1); continue; }
          var rad = R.r * Math.min(1, R.t / 0.45), pts = [];
          for (var k = 0; k <= 32; k++) { var a = k / 32 * TAU; pts.push(projectGL([R.p[0] + Math.cos(a) * rad, R.p[1], R.p[2] + Math.sin(a) * rad])); }
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = 'rgba(' + R.rgb + ',' + (1 - R.t / 0.7).toFixed(3) + ')'; ctx.lineWidth = 4;
          ctx.beginPath(); var started = false;
          pts.forEach(function (p) { if (!p) { started = false; return; } if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); });
          ctx.stroke(); ctx.globalCompositeOperation = 'source-over';
        }
        // lightning bolts from the sky onto the struck cars
        for (i = S.bolts.length - 1; i >= 0; i--) {
          var B = S.bolts[i]; B.t += dt;
          if (B.t > 0.45) { S.bolts.splice(i, 1); continue; }
          var bc = null; for (k = 0; k < snap.cars.length; k++) if (snap.cars[k].id === B.id) bc = snap.cars[k];
          if (!bc) continue;
          var BP = carPose(bc), top = projectGL([BP.x, BP.z + 30, -BP.y]), bot = projectGL([BP.x, BP.z + 1, -BP.y]);
          if (!top || !bot) continue;
          ctx.strokeStyle = 'rgba(255,250,200,' + (1 - B.t / 0.45).toFixed(3) + ')'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(top.x, top.y);
          for (k = 1; k <= 7; k++) { var f = k / 7; ctx.lineTo(top.x + (bot.x - top.x) * f + (k < 7 ? Math.sin(B.seed + k * 7.3) * 18 : 0), top.y + (bot.y - top.y) * f); }
          ctx.stroke();
        }
      } else stepParts(dt);
      // screen space: speed lines + boost vignette
      if (S.speedLines > 0.02) {
        var n = 26, cx = W / 2, cy = H * 0.48, col = me && me.nitroOn ? '170,225,255' : '255,255,255';
        ctx.strokeStyle = 'rgba(' + col + ',' + (0.28 * S.speedLines).toFixed(3) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (i = 0; i < n; i++) {
          var ang = (i / n) * TAU + Math.sin(S.t * 3 + i * 12.9) * 0.08, ph2 = (S.t * 2.6 + i * 0.37) % 1;
          var r0 = Math.max(W, H) * (0.32 + ph2 * 0.5), r1 = r0 + Math.max(W, H) * (0.08 + 0.1 * S.speedLines);
          ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0 * 0.75); ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1 * 0.75);
        }
        ctx.stroke();
        if (me && me.nitroOn) {
          var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
          vg.addColorStop(0, 'rgba(40,120,255,0)'); vg.addColorStop(1, 'rgba(40,120,255,' + (0.28 * S.speedLines).toFixed(3) + ')');
          ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
        }
      }
      ctx.restore();
    }

    return {
      attachRenderer: attachRenderer,
      setTrack: function (t) { S.track = t; S.posCache = {}; },
      draw: function (ctx, snap, st, W, H, dt) { try { draw(ctx, snap, st, W, H, dt); } catch (e) { if (!S.err && typeof console !== 'undefined') { S.err = 1; console.warn('[arcade.fx]', e); } } },
      events: events,
      project: function (x, y, e) { return project(x, y, e); },
      cameraFeel: function () { return { kick: S.kick, shake: S.shake }; },
      destroy: function () {
        S.parts = []; S.rings = []; S.trails = {};
        if (S.renderer && S.ctlSet && typeof S.renderer.setCameraController === 'function') { try { S.renderer.setCameraController(S.prevCtl); } catch (e) { /* ignore */ } }
        S.ctlSet = false; S.renderer = null;
      },
      _state: S
    };
  }

  CB.arcade.fx = { create: create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.arcade.fx;

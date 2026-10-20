/* ==========================================================================
   Redline — js/race/gl/derby-renderer.js
   CB.derby.renderer : WebGL renderer for Demolition Derby (docs/DERBY-SPEC.md §9).

     isSupported() -> bool
     create(canvas, session, opts {quality 'low'|'medium'|'high'|'ultra', camera, autoQuality}) ->
       { render(snap, alpha?), setCamera(m), cycleCamera(), getCamera(), cameraModes(), cameraLabel(), setFollow(id|null),
         getFollow(), setLookBack(b), shake(amount), resize(), setQuality(q), getQuality(), stats(), destroy(),
         worldToScreen(x, y, z) -> {x, y, visible, scale}, getCameraState(), reset(), is3D: true, kind: 'derby' }
     createPreview(canvas, {build, color, accessories, number, dents?}) -> { update(opts), destroy(), ok }
   `canvas` (create) is the HUD 2D canvas: an own GL canvas is inserted right before it (same box, pointer-events none),
   the 2D canvas is made transparent, sized to CSS px × min(dpr, 2) and cleared every frame (HUD draws after render()).
   createPreview renders straight into the canvas it is given (a dedicated element) with its own small loop.

   Cars: CB.gl.car models (one per car, unique cache key), per-car vertex deformation from snap car.dents (CPU copies
   of the body positions captured while the model is built, re-uploaded only when car.dentSeq changes), scorch / char
   tint, lost wheels hidden + body tilt, broken lights, smoke (white -> black), fire, accessory meshes
   (CB.gl.derbyParts) incl. the animated hammer, flame cones, magnet beams, shield bubbles, nitro flames, wrecking
   ball + chain, oil / caltrop entities, debris (panels, wheels, chunks), sparks, explosions.
   Cameras: 'chase' (default), 'far', 'hood', 'overhead'. Pure helpers in `_` load in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
  var MODES = ['chase', 'far', 'hood', 'overhead'];
  var LABELS = { chase: 'Chase', far: 'Chase (far)', hood: 'Hood', overhead: 'Overhead' };
  var QUALITY = {
    low: { dpr: 1, scale: 0.75, shadow: 0, post: false, particles: 420, aiLod: 'low', far: 900, shake: false, debris: 16 },
    medium: { dpr: 1.25, scale: 1, shadow: 1024, post: true, particles: 1100, aiLod: 'high', far: 1200, shake: true, debris: 44 },
    high: { dpr: 1.5, scale: 1, shadow: 2048, post: true, particles: 2000, aiLod: 'high', far: 1500, shake: true, debris: 80 },
    ultra: { dpr: 2, scale: 1, shadow: 2048, post: true, particles: 2800, aiLod: 'high', far: 1800, shake: true, debris: 100 }
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
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function wrap(a) { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; }
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
  function W(x, y, z) { return [x, z, -y]; }

  /* ================================================================== pure helpers (Node-testable) */
  function hash01(i) { var h = Math.imul(i + 0x9e37, 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; }
  /**
   * Dent a position array (car-local GL: X fwd, Y up, Z right). base, out: Float32Array (xyz). dents: snapshot
   * car.dents ({x, y, z, nx, ny, depth, r} in the car-local SIM frame, n = inward push). Returns per-vertex damage
   * weights (Float32Array, 0..1) for scorch tinting. opts {maxDisp 0.5, crumple 0.35, floor 0.04}.
   */
  function applyDents(base, out, dents, opts) {
    opts = opts || {};
    var n = base.length / 3, maxD = num(opts.maxDisp, 0.5), crumple = num(opts.crumple, 0.35), floorY = num(opts.floor, 0.04);
    var dS = num(opts.depthScale, 1), rS = num(opts.radiusScale, 1), maxDepth = num(opts.maxDepth, 0.6);
    var wts = opts.weights && opts.weights.length >= n ? opts.weights : new Float32Array(n);
    for (var i = 0; i < base.length; i++) out[i] = base[i];
    for (var w0 = 0; w0 < n; w0++) wts[w0] = 0;
    if (!dents || !dents.length) return wts;
    for (var k = 0; k < dents.length; k++) {
      var d = dents[k], cx = num(d.x, 0), cy = num(d.z, 0.5), cz = -num(d.y, 0);
      var dx = num(d.nx, 0), dz = -num(d.ny, 0), dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      var r = Math.max(0.1, num(d.r, 0.5) * rS), r2 = r * r, depth = clamp(num(d.depth, 0.05) * dS, 0, maxDepth);
      if (d.scrape) depth = 0;   // paint-only marks (scrapes)
      for (var v = 0; v < n; v++) {
        var o = v * 3, px = base[o] - cx, py = base[o + 1] - cy, pz = base[o + 2] - cz;
        // elongate the influence vertically a little (a hit crumples the whole panel height)
        var q = px * px + py * py * 0.6 + pz * pz;
        if (q >= r2) continue;
        var t = 1 - q / r2, wgt = t * t;
        // jitter keyed on the (quantised) POSITION so duplicated seam vertices move together (no cracks); two octaves
        // so the dent reads as creased sheet metal rather than a smooth dimple
        var j = (hash01(Math.round(base[o] * 9) * 73856093 ^ Math.round(base[o + 1] * 9) * 19349663 ^ Math.round(base[o + 2] * 9) * 83492791 ^ k * 131) - 0.5) * 2;
        if (crumple > 0.5) j = j * 0.65 + (hash01(Math.round(base[o] * 23) * 73856093 ^ Math.round(base[o + 1] * 23) * 19349663 ^ Math.round(base[o + 2] * 23) * 83492791 ^ k * 977) - 0.5) * 0.7;
        var amt = depth * wgt * (1 + j * crumple);
        out[o] += dx * amt; out[o + 2] += dz * amt;
        out[o + 1] += -Math.abs(j) * crumple * 0.35 * depth * wgt;   // panels sag
        wts[v] = Math.min(1, wts[v] + wgt * (d.scrape ? 0.45 : clamp(depth * 4, 0.2, 1)));
      }
    }
    for (var m = 0; m < n; m++) {
      var b = m * 3, ex = out[b] - base[b], ey = out[b + 1] - base[b + 1], ez = out[b + 2] - base[b + 2], l = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (l > maxD) { var s = maxD / l; out[b] = base[b] + ex * s; out[b + 1] = base[b + 1] + ey * s; out[b + 2] = base[b + 2] + ez * s; }
      if (out[b + 1] < floorY && base[b + 1] >= floorY) out[b + 1] = floorY;
    }
    return wts;
  }
  /* ------------------------------------------------------------------ dramatic damage (pure) */
  /** car dims (GL car-local) for the crumple / part masks */
  function damageDims(d) {
    d = d || {};
    var L = num(d.length, num(d.L, 4.5)), Wd = num(d.width, num(d.W, 1.9)), H = num(d.roof, num(d.H, num(d.height, 1.35)));
    return { L: L, W: Wd, H: H, hl: L / 2, hw: Wd / 2, belt: num(d.belt, H * 0.72), fA: num(d.frontAxle, num(d.fA, L * 0.3)), rA: num(d.rearAxle, num(d.rA, -L * 0.3)),
      wr: num(d.wheelRadius, num(d.wr, 0.34)), track: num(d.track, Wd - 0.3) };
  }
  var PARTS = ['bumperF', 'bumperR', 'hood', 'trunk', 'doorL', 'doorR'];
  /** is GL car-local (x, y, z) inside the region of a detachable part (+Z = right, so the LEFT door is z < 0) */
  function inPart(name, x, y, z, D) {
    var az = Math.abs(z), belt = D.belt;
    switch (name) {
      case 'bumperF': return x > D.hl - 0.32 && y < belt * 0.66 && y > 0.08;
      case 'bumperR': return x < -D.hl + 0.32 && y < belt * 0.66 && y > 0.08;
      case 'hood': return x > D.fA - 0.95 && x < D.hl - 0.12 && y > belt * 0.82 && y < belt + 0.28 && az < D.hw * 0.86;
      case 'trunk': return x < D.rA - 0.1 && x > -D.hl + 0.12 && y > belt * 0.82 && y < belt + 0.3 && az < D.hw * 0.86;
      case 'doorL': case 'doorR': {
        if (name === 'doorL' ? z > -D.hw * 0.55 : z < D.hw * 0.55) return false;
        var dc = (D.fA + D.rA) / 2 + 0.25;
        return Math.abs(x - dc) < Math.min(0.78, (D.fA - D.rA) * 0.3) && y > 0.28 && y < belt * 1.04;
      }
      default: return false;
    }
  }
  /** door hinge (front edge of the door), z of the outer skin */
  function doorHinge(name, D) { var dc = (D.fA + D.rA) / 2 + 0.25, half = Math.min(0.78, (D.fA - D.rA) * 0.3); return { x: dc + half, z: (name === 'doorL' ? -1 : 1) * D.hw * 0.9 }; }
  /**
   * Whole-car damage shape for one mesh. base/out Float32Array xyz (GL car-local), st:
   *   { dims (damageDims), dents, zones {front, rear, left, right}, parts {bumperF..doorR: detached}, roof 0..1 (rollover crush),
   *     hang {doorL, doorR, bumperF, bumperR: 0..1 hanging amount}, flap 0..1 (phase), kind 'body'|'glass'|'light'|'wheels',
   *     lights {fl, fr, rl, rr: broken}, lost [4] (merged-wheel masks, sim order FL FR RL RR), quality 'low'..'ultra' }
   * Returns {wts (dent weights), mask (Uint8Array: 1 = inside a detached part, 2 = hanging, 4 = crumple zone)}.
   */
  function deformCar(base, out, st, scratch) {
    st = st || {};
    var D = st.dims || damageDims(null), n = base.length / 3, i;
    scratch = scratch || {};
    var tmp = scratch.tmp && scratch.tmp.length === base.length ? scratch.tmp : (scratch.tmp = new Float32Array(base.length));
    var mask = scratch.mask && scratch.mask.length === n ? scratch.mask : (scratch.mask = new Uint8Array(n));
    var Z = st.zones || {}, zf = clamp01(num(Z.front, 0)), zr = clamp01(num(Z.rear, 0)), zl = clamp01(num(Z.left, 0)), zrt = clamp01(num(Z.right, 0));
    var P = st.parts || {}, HG = st.hang || {}, kind = st.kind || 'body', roof = clamp01(num(st.roof, 0));
    var lowQ = st.quality === 'low';
    // crumple lengths: how far the nose / tail is pushed in at full damage
    var cf = zf * Math.min(0.95, D.hl - D.fA + 0.55) * 0.85, cr = zr * Math.min(0.95, -D.rA - D.hl * 0 + (D.hl + D.rA) + 0.55) * 0.85;
    var x0f = D.fA - 0.35, x0r = D.rA + 0.35;
    for (i = 0; i < n; i++) {
      var o = i * 3, x = base[o], y = base[o + 1], z = base[o + 2];
      var nx = x, ny = y, nz = z, m = 0;
      var hq = hash01(Math.round(x * 11) * 73856093 ^ Math.round(y * 11) * 19349663 ^ Math.round(z * 11) * 83492791) - 0.5;
      // ---- front crumple: accordion toward the cabin, the bonnet buckles up, wings bulge
      if (cf > 0.001 && x > x0f) {
        var t = clamp01((x - x0f) / Math.max(0.3, D.hl - x0f));
        nx -= cf * Math.pow(t, 1.1);
        var acc = Math.sin(t * 9.5 + z * 3.1) * 0.06 * zf * t;
        ny += acc + hq * 0.07 * zf * t;
        if (y > D.belt * 0.8 && t > 0.15 && t < 0.92) ny += Math.sin(PI * (t - 0.15) / 0.77) * 0.2 * zf;   // buckled bonnet
        nz *= 1 + 0.07 * zf * Math.sin(t * PI) + hq * 0.05 * zf;
        if (y < D.belt * 0.55) ny -= 0.08 * zf * t;   // the nose sags onto the ground
        m |= 4;
      }
      // ---- rear crumple
      if (cr > 0.001 && x < x0r) {
        var tr = clamp01((x0r - x) / Math.max(0.3, D.hl + x0r));
        nx += cr * Math.pow(tr, 1.1);
        ny += Math.sin(tr * 9.5 - z * 3.1) * 0.06 * zr * tr + hq * 0.07 * zr * tr;
        if (y > D.belt * 0.8 && tr > 0.15 && tr < 0.92) ny += Math.sin(PI * (tr - 0.15) / 0.77) * 0.16 * zr;
        nz *= 1 + 0.07 * zr * Math.sin(tr * PI) + hq * 0.05 * zr;
        m |= 4;
      }
      // ---- side cave-in (sim left = GL z < 0)
      var zs = z < 0 ? zl : zrt;
      if (zs > 0.001) {
        var s = clamp01((Math.abs(z) - D.hw * 0.2) / (D.hw * 0.8));
        var wx = clamp01(1 - Math.pow(Math.abs(x) / (D.hl * 0.92), 4));
        var wy = y < D.belt * 1.1 ? 1 : clamp01(1 - (y - D.belt * 1.1) / 0.4) * 0.6 + 0.4;
        var push = zs * 0.36 * s * wx * wy * (1 + hq * 0.6 + Math.sin(x * 6.3) * 0.25);
        nz -= (z < 0 ? -1 : 1) * push;
        ny -= zs * 0.04 * s * wx;
        if (push > 0.02) m |= 4;
      }
      // ---- rollover: the roof bends down and over
      if (roof > 0.001 && y > D.belt) {
        var k = clamp01((y - D.belt) / Math.max(0.2, D.H - D.belt));
        ny -= roof * k * (D.H - D.belt) * 0.62 * (1 + hq * 0.3);
        nz += roof * k * 0.16 * (st.roofSide || 1);
        nx += roof * k * Math.sin(x * 2.1) * 0.05;
      }
      tmp[o] = nx; tmp[o + 1] = ny; tmp[o + 2] = nz;
      mask[i] = m;
    }
    // ---- dents on top of the crumple (deeper, wider, creased)
    var wts = applyDents(tmp, out, st.dents || [], { weights: scratch.wts && scratch.wts.length === n ? scratch.wts : (scratch.wts = new Float32Array(n)),
      maxDisp: lowQ ? 0.6 : 0.85, depthScale: 1.85, radiusScale: 1.35, maxDepth: 0.62, crumple: lowQ ? 0.5 : 0.95, floor: 0.04 });
    // ---- detached / hanging parts (evaluated on the undamaged positions so the regions stay stable)
    if (kind === 'body' || kind === 'glass') {
      for (var pi = 0; pi < PARTS.length; pi++) {
        var name = PARTS[pi], gone = !!P[name], hang = clamp01(num(HG[name], 0));
        if (!gone && hang <= 0.01) continue;
        var hinge = name.indexOf('door') === 0 ? doorHinge(name, D) : null;
        for (i = 0; i < n; i++) {
          var b = i * 3;
          if (!inPart(name, base[b], base[b + 1], base[b + 2], D)) continue;
          if (gone) {
            // the panel is gone: pull the skin in to the inner structure (reads as a dark hole)
            if (name === 'hood' || name === 'trunk') out[b + 1] -= 0.14;
            else if (name === 'bumperF') out[b] -= 0.26;
            else if (name === 'bumperR') out[b] += 0.26;
            else out[b + 2] -= (name === 'doorL' ? -1 : 1) * 0.16;
            mask[i] |= 1;
          } else {
            var ph = num(st.flap, 0);
            if (hinge) {
              // door ajar about its front hinge, swinging with the flap phase
              var ang = hang * (0.55 + 0.3 * Math.sin(ph * TAU)), dxh = out[b] - hinge.x, side = name === 'doorL' ? -1 : 1;
              out[b] = hinge.x + dxh * Math.cos(ang);
              out[b + 2] += side * Math.abs(dxh) * Math.sin(ang);
            } else if (name === 'bumperF' || name === 'bumperR') {
              // one end drops and drags on the ground
              var zt = clamp01((base[b + 2] + D.hw) / (2 * D.hw));
              out[b + 1] -= hang * (0.05 + 0.3 * zt) * (0.85 + 0.15 * Math.sin(ph * TAU));
              out[b] += (name === 'bumperF' ? 1 : -1) * hang * 0.1 * zt;
            } else {
              out[b + 1] += hang * 0.12 * clamp01((Math.abs(base[b]) - D.hl * 0.4) / (D.hl * 0.6)) * (0.8 + 0.2 * Math.sin(ph * TAU));   // bonnet popped
            }
            mask[i] |= 2;
          }
        }
      }
    }
    // ---- broken lamps collapse into the body (only that side goes dark); lost merged wheels vanish
    if (kind === 'light' && st.lights) {
      var LB = st.lights;
      for (i = 0; i < n; i++) {
        var c3 = i * 3, front = base[c3] > 0, left = base[c3 + 2] < 0;
        var br = front ? (left ? LB.fl : LB.fr) : (left ? LB.rl : LB.rr);
        if (br) { out[c3] = base[c3] * 0.6; out[c3 + 1] = Math.min(base[c3 + 1], D.belt * 0.6); out[c3 + 2] = base[c3 + 2] * 0.6; mask[i] |= 1; }
      }
    }
    if (kind === 'wheels' && st.lost) {
      for (i = 0; i < n; i++) {
        var w3 = i * 3, cor = (base[w3] > 0 ? 0 : 2) + (base[w3 + 2] > 0 ? 1 : 0);
        if (st.lost[cor]) { out[w3] = base[w3] > 0 ? D.fA : D.rA; out[w3 + 1] = D.wr; out[w3 + 2] = (base[w3 + 2] > 0 ? 1 : -1) * D.track * 0.4; mask[i] |= 1; }
      }
    }
    return { wts: wts, mask: mask };
  }
  /**
   * Damage colours: scraped bare metal around dents, creased dark folds in the centre, rust / soot in crumple zones,
   * dark interiors where panels came off, cracked milky glass. cBase/cOut (cs 3|4), wts + mask from deformCar.
   * st {kind, glassCrack 0..1, soot 0..1}
   */
  var METAL = [0.36, 0.37, 0.39], CREASE = [0.07, 0.065, 0.06], HOLE = [0.022, 0.02, 0.02], RUST = [0.2, 0.09, 0.04], MILK = [0.56, 0.6, 0.62];
  function paintDamage(cBase, cOut, cs, wts, mask, st, base) {
    st = st || {};
    var n = wts.length, kind = st.kind || 'body', gc = clamp01(num(st.glassCrack, 0)), soot = clamp01(num(st.soot, 0));
    for (var v = 0; v < n; v++) {
      var o = v * cs, w = wts[v], m = mask ? mask[v] : 0;
      var r = cBase[o], g = cBase[o + 1], b = cBase[o + 2];
      var hq = base ? hash01(Math.round(base[v * 3] * 17) * 73856093 ^ Math.round(base[v * 3 + 1] * 17) * 19349663 ^ Math.round(base[v * 3 + 2] * 17) * 83492791) : 0.5;
      if (kind === 'glass') {
        // cracks spread from the hits: some vertices go milky white (crack webs), the rest greys out
        var k = clamp01(gc * 0.7 + w * 1.2);
        var crack = hq < k * 0.55 ? 1 : 0;
        var t = clamp01(k * 0.55 + crack * 0.5);
        r += (MILK[0] - r) * t; g += (MILK[1] - g) * t; b += (MILK[2] - b) * t;
        if (m & 1) { r = HOLE[0]; g = HOLE[1]; b = HOLE[2]; }
      } else {
        if (w > 0.02) {
          // ring of scraped paint -> bare metal; the centre of a deep dent is a dark crease
          var ring = clamp01(w * 2.2) * (0.55 + hq * 0.45), core = clamp01((w - 0.55) * 2.4);
          r += (METAL[0] - r) * ring; g += (METAL[1] - g) * ring; b += (METAL[2] - b) * ring;
          r += (CREASE[0] - r) * core * 0.8; g += (CREASE[1] - g) * core * 0.8; b += (CREASE[2] - b) * core * 0.8;
        }
        if (m & 4) { var rs = 0.22 * (hq > 0.6 ? 1 : 0.4); r += (RUST[0] - r) * rs; g += (RUST[1] - g) * rs; b += (RUST[2] - b) * rs; }
        if (soot > 0) { var sk = soot * (0.6 + 0.4 * hq); r *= 1 - sk * 0.85; g *= 1 - sk * 0.86; b *= 1 - sk * 0.87; }
        if (m & 1) { r = HOLE[0]; g = HOLE[1]; b = HOLE[2]; }
      }
      cOut[o] = r; cOut[o + 1] = g; cOut[o + 2] = b;
      if (cs > 3) cOut[o + 3] = cBase[o + 3];
    }
    return cOut;
  }
  /** body sink / tilt from punctured + lost wheels (sim order FL FR RL RR) */
  function wheelSink(lost, punct) {
    var t = { pitch: 0, roll: 0, drop: 0 };
    for (var i = 0; i < 4; i++) {
      var amt = lost && lost[i] ? 0.27 : punct && punct[i] ? 0.085 : 0;
      if (!amt) continue;
      var front = i < 2, left = i % 2 === 0;
      t.pitch += (front ? -1 : 1) * amt * 0.32; t.roll += (left ? -1 : 1) * amt * 0.62; t.drop -= amt * 0.3;
    }
    return t;
  }
  /** pull the chase camera in front of anything solid between the car and the eye. sd(x, z) -> signed distance
      (> 0 free), blocked(x, y, z) -> bool. Returns the fraction 0..1 of the target->eye segment that is free. */
  function camClear(target, eye, blocked, steps) {
    steps = steps || 14;
    var free = 1;
    for (var i = 1; i <= steps; i++) {
      var t = i / steps, p = [target[0] + (eye[0] - target[0]) * t, target[1] + (eye[1] - target[1]) * t, target[2] + (eye[2] - target[2]) * t];
      if (blocked(p[0], p[1], p[2])) { free = Math.max(0.18, (i - 1) / steps - 0.04); break; }
    }
    return free;
  }

  /** area-weighted vertex normals from positions + indices (flat when vertices are not shared) */
  function computeNormals(pos, idx, out) {
    out = out && out.length === pos.length ? out : new Float32Array(pos.length);
    for (var z = 0; z < out.length; z++) out[z] = 0;
    var tri = idx ? idx.length : pos.length / 3;
    for (var i = 0; i < tri; i += 3) {
      var a = (idx ? idx[i] : i) * 3, b = (idx ? idx[i + 1] : i + 1) * 3, c = (idx ? idx[i + 2] : i + 2) * 3;
      var e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      var e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      out[a] += nx; out[a + 1] += ny; out[a + 2] += nz; out[b] += nx; out[b + 1] += ny; out[b + 2] += nz; out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
    }
    for (var k = 0; k < out.length; k += 3) { var l = Math.hypot(out[k], out[k + 1], out[k + 2]) || 1; out[k] /= l; out[k + 1] /= l; out[k + 2] /= l; }
    return out;
  }
  /** keep each new normal on the same side as the original one (car meshes mix windings) */
  function orientLike(nNew, nBase) {
    for (var i = 0; i < nNew.length; i += 3) if (nNew[i] * nBase[i] + nNew[i + 1] * nBase[i + 1] + nNew[i + 2] * nBase[i + 2] < 0) { nNew[i] = -nNew[i]; nNew[i + 1] = -nNew[i + 1]; nNew[i + 2] = -nNew[i + 2]; }
    return nNew;
  }
  /** hammer boom angle (rad from upright, toward the swing side) for the swing phase 0..1 */
  function hammerAngle(sw) {
    if (!(sw > 0)) return 0.62;
    if (sw < 0.2) return lerp(0.62, -0.45, sw / 0.2);
    if (sw < 0.36) return lerp(-0.45, 1.95, (sw - 0.2) / 0.16);
    if (sw < 0.55) return 1.95;
    return lerp(1.95, 0.62, (sw - 0.55) / 0.45);
  }
  /** GL frame of a snapshot car: pos, fwd, up, right (pitch + = nose up, roll + = left side up, lost-wheel tilt) */
  function carFrame(c, tilt) {
    var h = num(c.heading, 0), f = [Math.cos(h), 0, -Math.sin(h)], u = [0, 1, 0], r = cross(f, u);
    var pitch = num(c.pitch, 0) + (tilt ? tilt.pitch : 0), roll = num(c.roll, 0) + (tilt ? tilt.roll : 0);
    if (pitch) { f = rotAxis(f, r, pitch); u = rotAxis(u, r, pitch); }
    if (roll) { u = rotAxis(u, f, roll); r = cross(f, u); }
    return { pos: [num(c.x, 0), num(c.z, 0) + (tilt ? tilt.drop : 0), -num(c.y, 0)], fwd: norm(f), up: norm(u), right: norm(r) };
  }
  /** body tilt from lost wheels (sim order FL FR RL RR) */
  function wheelTilt(lost) {
    var t = { pitch: 0, roll: 0, drop: 0 };
    if (!lost) return t;
    var L = [0.11, 0.11, 0.09, 0.09];
    for (var i = 0; i < 4; i++) {
      if (!lost[i]) continue;
      var front = i < 2, left = i % 2 === 0;
      t.pitch += front ? -0.06 : 0.06; t.roll += left ? -L[i] : L[i]; t.drop -= 0.08;
    }
    return t;
  }
  function wheelCorner(w) { return (w.front ? 0 : 2) + (num(w.z, 0) > 0 ? 1 : 0); }

  function isSupported() {
    var G = CB.gl;
    if (!G || typeof G.createContext !== 'function' || typeof G.drawList !== 'function' || !G.derbyArena || !G.derbyParts) return false;
    return typeof G.isSupported === 'function' ? !!G.isSupported() : true;
  }

  /* ================================================================== lighting (shared by renderer + preview) */
  function makeLighting(fx) {
    var cache = {};
    return function (tod) {
      if (cache[tod]) return cache[tod];
      var L = null;
      try { if (fx && fx.getLighting) L = fx.getLighting(tod, 'dry'); else if (CB.gl.effects && CB.gl.effects.getLighting) L = CB.gl.effects.getLighting(tod, 'dry'); } catch (e) { L = null; }
      var base = tod === 'night' ? { sunDir: [0.3, 0.62, 0.42], sunColor: [0.3, 0.32, 0.45], ambientSky: [0.16, 0.16, 0.26], ambientGround: [0.06, 0.05, 0.08], fogColor: [0.03, 0.03, 0.07], fogDensity: 0.0016, envTop: [0.01, 0.01, 0.04], envHorizon: [0.1, 0.06, 0.16], envBottom: [0.02, 0.02, 0.03], exposure: 1.2 }
        : tod === 'dusk' ? { sunDir: [0.82, 0.22, -0.55], sunColor: [1.5, 0.82, 0.48], ambientSky: [0.36, 0.32, 0.46], ambientGround: [0.18, 0.13, 0.1], fogColor: [0.66, 0.46, 0.42], fogDensity: 0.0012, envTop: [0.18, 0.22, 0.44], envHorizon: [0.98, 0.58, 0.36], envBottom: [0.16, 0.12, 0.12], exposure: 1.0 }
          : { sunDir: [-0.42, 0.78, -0.46], sunColor: [1.35, 1.27, 1.12], ambientSky: [0.5, 0.58, 0.7], ambientGround: [0.26, 0.24, 0.19], fogColor: [0.72, 0.8, 0.9], fogDensity: 0.0008, envTop: [0.3, 0.5, 0.84], envHorizon: [0.8, 0.86, 0.93], envBottom: [0.26, 0.25, 0.22], exposure: 0.95 };
      if (L && L.sunDir) {
        base.sunDir = L.sunDir.slice(); if (L.sunColor) base.sunColor = L.sunColor.slice();
        if (L.ambientSky) base.ambientSky = L.ambientSky.slice(); if (L.ambientGround) base.ambientGround = L.ambientGround.slice();
        if (L.fogColor) base.fogColor = L.fogColor.slice(); if (L.skyZenith) base.envTop = L.skyZenith.slice(); if (L.skyHorizon) base.envHorizon = L.skyHorizon.slice();
        if (L.skyGround) base.envBottom = L.skyGround.slice();
        if (tod === 'night') { base.ambientSky = mul(base.ambientSky, 2.2); base.sunColor = mul(base.sunColor, 1.8); }
      }
      if (base.sunDir[1] < 0.2) base.sunDir[1] = 0.2;
      base.sunDir = norm(base.sunDir);
      var lin = function (c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; };
      base.fogColor = lin(base.fogColor); base.envTop = lin(base.envTop); base.envHorizon = lin(base.envHorizon); base.envBottom = lin(base.envBottom);
      base.fogDensity *= 0.6;
      cache[tod] = base;
      return base;
    };
  }

  /* ================================================================== car model with captured CPU geometry */
  var IDENT16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function buildCarModel(ctx, build, opts) {
    var G = CB.gl, orig = G.createMesh, model = null;
    if (!CB.gl.car || typeof CB.gl.car.build !== 'function' || !build) return null;
    G.createMesh = function (c, geo, o) {
      var m = orig.call(G, c, geo, Object.assign({}, o || {}, { dynamic: true }));
      try { m._geo = geo; } catch (e) { /* ignore */ }
      return m;
    };
    try { model = CB.gl.car.build(ctx, build, opts); } catch (e) { model = null; }
    finally { G.createMesh = orig; }
    if (!model || !model.parts) return null;
    // deformable parts: everything attached to the body
    model._deform = [];
    model._dd = damageDims(model.dims);
    model.parts.forEach(function (p) {
      var g = p.mesh && p.mesh._geo;
      var merged = p.attach === 'car' && /wheels/.test(p.kind || '');
      if (!g || !g.positions || (p.attach && p.attach !== 'body' && !merged)) return;
      var pos = g.positions instanceof Float32Array ? g.positions : new Float32Array(g.positions);
      var nrm = g.normals && g.normals.length === pos.length ? (g.normals instanceof Float32Array ? g.normals : new Float32Array(g.normals)) : null;
      var cs = g.colors && g.colors.length ? (num(g.colorSize, 0) || Math.round(g.colors.length / (pos.length / 3))) : 0;
      model._deform.push({
        part: p, mesh: p.mesh, base: new Float32Array(pos), cur: new Float32Array(pos), nBase: nrm ? new Float32Array(nrm) : null, nCur: new Float32Array(pos.length),
        idx: g.indices || null, cBase: cs ? new Float32Array(g.colors) : null, cCur: cs ? new Float32Array(g.colors) : null, cs: cs, wts: new Float32Array(pos.length / 3),
        glass: /glass/.test(p.kind || ''), light: /^light/.test(p.kind || ''), wheels: merged, scratch: {}
      });
    });
    model._seq = 0;
    return model;
  }
  /** (re)deform a model from the damage state (deformCar st) or a plain dent list */
  function deformModel(model, st) {
    if (!model || !model._deform) return;
    if (Array.isArray(st)) st = { dents: st };
    st = st || {};
    model._deform.forEach(function (d) {
      var kind = d.glass ? 'glass' : d.light ? 'light' : d.wheels ? 'wheels' : 'body';
      if (kind === 'wheels' && !(st.lost && (st.lost[0] || st.lost[1] || st.lost[2] || st.lost[3])) && !d.dirty) return;
      var s2 = {}; for (var k in st) s2[k] = st[k];
      s2.kind = kind; s2.dims = model._dd;
      if (kind === 'wheels') s2.dents = null;
      var r = deformCar(d.base, d.cur, s2, d.scratch);
      d.dirty = kind === 'wheels';
      var n = d.nBase ? orientLike(computeNormals(d.cur, d.idx, d.nCur), d.nBase) : computeNormals(d.cur, d.idx, d.nCur);
      var upd = { positions: d.cur, normals: n };
      if (d.cCur && kind !== 'light' && kind !== 'wheels') {
        paintDamage(d.cBase, d.cCur, d.cs, r.wts, r.mask, { kind: kind, glassCrack: st.glassCrack, soot: st.soot }, d.base);
        upd.colors = d.cCur; upd.colorSize = d.cs;
      }
      try { d.mesh.update(upd); } catch (e) { /* ignore */ }
    });
  }
  /** deform a plain list of captured meshes (accessories) with the body's damage (no part masks) */
  function deformParts(list, dims, st) {
    var s2 = { dims: dims, dents: st.dents, zones: st.zones, roof: st.roof, roofSide: st.roofSide, kind: 'acc', quality: st.quality };
    list.forEach(function (d) {
      var r = deformCar(d.base, d.cur, s2, d.scratch);
      var n = d.nBase ? orientLike(computeNormals(d.cur, d.idx, d.nCur), d.nBase) : computeNormals(d.cur, d.idx, d.nCur);
      var upd = { positions: d.cur, normals: n };
      if (d.cCur) { paintDamage(d.cBase, d.cCur, d.cs, r.wts, r.mask, { kind: 'body', soot: st.soot }, d.base); upd.colors = d.cCur; upd.colorSize = d.cs; }
      try { d.mesh.update(upd); } catch (e) { /* ignore */ }
    });
  }
  /** damage-state key: re-deform only when something visible changed */
  function damageKey(st) {
    var Z = st.zones || {}, q = function (v) { return Math.round(num(v, 0) * 20); };
    var P = st.parts || {}, pb = 0;
    PARTS.forEach(function (k, i) { if (P[k]) pb |= 1 << i; });
    var H = st.hang || {}, L = st.lights || {}, lo = st.lost || [];
    return [st.dentSeq, q(Z.front), q(Z.rear), q(Z.left), q(Z.right), pb, q(st.roof), q(H.doorL), q(H.doorR), q(H.bumperF), q(H.bumperR), q(H.hood),
      (L.fl ? 1 : 0) + (L.fr ? 2 : 0) + (L.rl ? 4 : 0) + (L.rr ? 8 : 0), (lo[0] ? 1 : 0) + (lo[1] ? 2 : 0) + (lo[2] ? 4 : 0) + (lo[3] ? 8 : 0),
      Math.round(num(st.flap, 0) * 6), q(st.glassCrack), q(st.soot), st.scrapeN || 0].join(',');
  }

  /* ================================================================== create */
  function create(canvas, source, opts) {
    opts = opts || {};
    var G = CB.gl, M4 = G.mat4, DP = G.derbyParts;
    var arena = (source && source.arena) || (source && source.cfg && CB.derby.arenas && CB.derby.arenas.get(source.cfg.arenaId)) || (source && source.boundary ? source : null);
    if (!arena && CB.derby.arenas) arena = CB.derby.arenas.get(CB.derby.arenas.DEFAULT);
    if (!arena) throw new Error('derby renderer: needs a session or arena');
    var R = {
      quality: QUALITY[opts.quality] ? opts.quality : 'high', mode: MODES.indexOf(opts.camera) >= 0 ? opts.camera : 'chase', lookBack: false, follow: null,
      cars: {}, frame: 0, lastT: 0, time: 0, stats: { fps: 0, ms: 0, draws: 0, tris: 0 }, shakeA: 0, fov: 64, fovKick: 0, rig: { init: false }, ema: 16, slowT: 0, lastSnapT: -1
    };
    var Q = QUALITY[R.quality];
    /* ---- DOM ---- */
    var doc = canvas.ownerDocument || document;
    var glc = doc.createElement('canvas');
    glc.className = 'derby-gl-canvas';
    glc.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block;';
    var parent = canvas.parentNode;
    if (parent) {
      parent.insertBefore(glc, canvas);
      var cs0 = doc.defaultView && doc.defaultView.getComputedStyle ? doc.defaultView.getComputedStyle(parent) : null;
      if (cs0 && cs0.position === 'static') parent.style.position = 'relative';
    }
    function placeGL() { glc.style.left = canvas.offsetLeft + 'px'; glc.style.top = canvas.offsetTop + 'px'; glc.style.width = canvas.clientWidth + 'px'; glc.style.height = canvas.clientHeight + 'px'; }
    var prevBg = canvas.style.background;
    canvas.style.background = 'transparent';
    var ctx = G.createContext(glc, { antialias: !Q.post, alpha: false });
    if (!ctx) throw new Error('derby renderer: WebGL unavailable');
    var gl = ctx.gl;
    var world = G.derbyArena.build(ctx, arena, { quality: R.quality });
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
    var tod = arena.timeOfDay || 'day';
    try { if (CB.gl.effects && typeof CB.gl.effects.create === 'function') fx = CB.gl.effects.create(ctx, { quality: R.quality, timeOfDay: tod, weather: 'dry', autoEmit: false, linearOutput: !!post }); } catch (e) { fx = null; }
    var lighting = makeLighting(fx);

    /* ---- shared meshes ---- */
    var SH = {
      ball: G.createMesh(ctx, DP.ballGeometry()), link: G.createMesh(ctx, DP.chainLinkGeometry()), bubble: G.createMesh(ctx, DP.bubbleGeometry()),
      cube: G.createMesh(ctx, DP.cubeGeometry()), panel: G.createMesh(ctx, DP.debrisGeometry('panel')), chunk: G.createMesh(ctx, DP.debrisGeometry('chunk')),
      wheel: G.createMesh(ctx, DP.debrisGeometry('wheel')), caltrops: G.createMesh(ctx, DP.caltropGeometry()),
      hood: G.createMesh(ctx, DP.debrisGeometry('hood')), door: G.createMesh(ctx, DP.debrisGeometry('door')), bumper: G.createMesh(ctx, DP.debrisGeometry('bumper')),
      disc: (function () { var g = new DP.Geo(); g.disc([0, 0, 0], 1, 20, [1, 1, 1, 1], 5); return G.createMesh(ctx, g.out()); })(),
      ring: (function () {
        // flat annulus (shockwave): inner 0.82, outer 1.0
        var g = new DP.Geo(), N = 40;
        for (var k = 0; k < N; k++) {
          var a0 = k / N * TAU, a1 = (k + 1) / N * TAU;
          var o0 = [Math.cos(a0), 0, Math.sin(a0)], o1 = [Math.cos(a1), 0, Math.sin(a1)];
          g.quad(mul(o0, 0.82), mul(o1, 0.82), o1, o0, [1, 1, 1, 1], [0, 1, 0]);
        }
        return G.createMesh(ctx, g.out());
      })()
    };
    var MAT = {
      ball: { color: [1, 1, 1, 1], roughness: 0.35, metallic: 0.8 },
      link: { color: [1, 1, 1, 1], roughness: 0.4, metallic: 0.8 },
      shield: { color: [0.25, 0.75, 1.6, 0.28], unlit: true, transparent: true, additive: true, depthWrite: false, castShadow: false, doubleSided: true },
      beam: { color: [1.2, 2.6, 4, 1], unlit: true, additive: true, transparent: true, depthWrite: false, castShadow: false },
      flash: { color: [5, 3.4, 1.6, 1], unlit: true, additive: true, transparent: true, depthWrite: false, castShadow: false },
      oil: { color: [0.012, 0.012, 0.02, 0.92], roughness: 0.04, metallic: 0.2, clearcoat: 1, transparent: true, castShadow: false, polygonOffset: [-1, -4] },
      caltrops: { color: [1, 1, 1, 1], roughness: 0.35, metallic: 0.7 },
      plate: { color: [1, 1, 1, 1], roughness: 0.55, metallic: 0.4 },
      wheel: { color: [1, 1, 1, 1], roughness: 0.8 },
      chunk: { color: [0.25, 0.24, 0.23, 1], roughness: 0.7 },
      charred: { color: [0.05, 0.045, 0.04, 1], roughness: 0.95, metallic: 0.1, doubleSided: true }
    };

    /* ---- cars ---- */
    function defaultBuild() { try { return CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null; } catch (e) { return null; } }
    function fallbackModel(c) {
      var g = new DP.Geo(), rgb = hexRgb(c.color, [0.8, 0.1, 0.1]), col = [rgb[0], rgb[1], rgb[2], 1];
      var L = num(c.spec && c.spec.length, 4.4) / 2, Wd = num(c.spec && c.spec.width, 1.9) / 2;
      g.aabb([0, 0.6, 0], L, 0.3, Wd, col); g.aabb([-0.2, 1.05, 0], L * 0.5, 0.22, Wd * 0.85, [0.1, 0.11, 0.13, 1]);
      var wg = new DP.Geo();
      [[L * 0.62, Wd], [L * 0.62, -Wd], [-L * 0.62, Wd], [-L * 0.62, -Wd]].forEach(function (w) { wg.cyl([w[0], 0.34, w[1] - 0.13], [w[0], 0.34, w[1] + 0.13], 0.34, 0.34, 10, [0.04, 0.04, 0.045, 1], true); });
      return { _fallback: true, dims: { length: L * 2, width: Wd * 2, height: 1.3, roof: 1.27, wheelRadius: 0.34 }, hoodCam: [0.6, 1.25, 0],
        parts: [{ mesh: G.createMesh(ctx, g.out()), material: { color: [1, 1, 1, 1], roughness: 0.35, clearcoat: 0.8 }, local: IDENT16, kind: 'body' },
          { mesh: G.createMesh(ctx, wg.out()), material: { color: [1, 1, 1, 1], roughness: 0.8 }, local: IDENT16, kind: 'wheels', attach: 'car' }] };
    }
    function carEntry(c) {
      var e = R.cars[c.id];
      if (!e) {
        e = R.cars[c.id] = { id: c.id, model: null, pst: {}, items: [], M: M4.create(), prev: null, prevT: -1, view: {}, seq: -1, acc: null, accKey: '', mats: null, lastParts: {},
          lastLost: [false, false, false, false], smokeAcc: 0, fireAcc: 0, flameAcc: 0, outT: 0 };
      }
      return e;
    }
    function ensureModel(e, c) {
      if (e.model) return e.model;
      var b = c.build || defaultBuild();
      var lod = c.isPlayer || c.id === R.follow ? 'high' : Q.aiLod;
      var m = buildCarModel(ctx, b, { number: num(c.number, 0) + 40 * (c.isPlayer ? 1 : 0), color: c.color, accent: c.accent, lod: lod, id: 'derby-' + c.id, name: c.name, isPlayer: !!c.isPlayer });
      if (!m) m = fallbackModel(c);
      e.model = m;
      // per-car material clones (char / health tint without touching the shared cache)
      e.mats = {};
      m.parts.forEach(function (p, i) {
        if (/^light/.test(p.kind || '')) return;
        var mm = {}; for (var k in p.material) mm[k] = p.material[k];
        var bc = p.material.baseColor || p.material.uBaseColor || p.material.color || [1, 1, 1, 1];
        mm._base = bc.slice(); mm.baseColor = mm.uBaseColor = mm.color = bc.slice();
        e.mats[i] = mm;
      });
      var dims = DP.dimsOf(m);
      e.dims = dims;
      return m;
    }
    function ensureAcc(e, c) {
      var ids = (c.acc || []).map(function (a) { return a.id; }).sort();
      var key = ids.join(',');
      if (e.accKey === key && e.acc) return e.acc;
      if (e.acc) try { e.acc.destroy(); } catch (er) { /* ignore */ }
      // capture CPU geometry so armour / bars / blades dent, scrape and char with the body
      var orig = G.createMesh, caps = [];
      G.createMesh = function (cx, geo, o) { var m = orig.call(G, cx, geo, Object.assign({}, o || {}, { dynamic: true })); caps.push({ m: m, g: geo }); return m; };
      try { e.acc = DP.build(ctx, ids, e.model); } finally { G.createMesh = orig; }
      e.accKey = key; e.dkey = null;
      e.accDeform = [];
      if (e.acc && R.quality !== 'low') {
        e.acc.items.forEach(function (it) {
          if (/glow/.test(it.kind || '')) return;
          var cp = null; for (var q = 0; q < caps.length; q++) if (caps[q].m === it.mesh) cp = caps[q];
          if (!cp || !cp.g || !cp.g.positions) return;
          var pos = new Float32Array(cp.g.positions), nb = cp.g.normals && cp.g.normals.length === pos.length ? new Float32Array(cp.g.normals) : null;
          var cs = cp.g.colors && cp.g.colors.length ? Math.round(cp.g.colors.length / (pos.length / 3)) : 0;
          e.accDeform.push({ mesh: it.mesh, base: pos, cur: new Float32Array(pos), nBase: nb, nCur: new Float32Array(pos.length), idx: cp.g.indices || null,
            cBase: cs ? new Float32Array(cp.g.colors) : null, cCur: cs ? new Float32Array(cp.g.colors) : null, cs: cs, scratch: {} });
        });
      }
      return e.acc;
    }
    /** everything the deformation needs from the snapshot car + renderer-side memory (rollovers, scrapes, glass) */
    function damageState(e, c, dt, dcam, isFocus) {
      var Z = c.zones || {}, P = c.parts || {}, lowQ = R.quality === 'low';
      // rollovers bend the roof (accumulates per flip)
      var rolled = !!c.flipped || Math.abs(num(c.roll, 0)) > 1.5;
      if (rolled && !e.wasRolled) { e.roof = Math.min(1, num(e.roof, 0) + 0.55); e.roofSide = num(c.roll, 0) >= 0 ? -1 : 1; }
      e.wasRolled = rolled;
      // fire exposure scorches the paint
      var fire = Math.max(num(c.onFire, 0), num(c.engine && c.engine.fire, 0));
      e.soot = Math.min(1, num(e.soot, 0) + fire * dt * 0.09);
      var hang = {};
      function hz(v, a, b) { return clamp01((num(v, 0) - a) / (b - a)); }
      if (!P.doorL) hang.doorL = hz(Z.left, 0.35, 0.7);
      if (!P.doorR) hang.doorR = hz(Z.right, 0.35, 0.7);
      if (!P.bumperF) hang.bumperF = hz(Z.front, 0.3, 0.55);
      if (!P.bumperR) hang.bumperR = hz(Z.rear, 0.3, 0.55);
      if (!P.hood) hang.hood = hz(Z.front, 0.5, 0.82);
      if (!P.trunk) hang.trunk = hz(Z.rear, 0.55, 0.85);
      var anyHang = hang.doorL || hang.doorR || hang.bumperF || hang.bumperR || hang.hood || hang.trunk;
      var flap = 0;
      if (anyHang && !lowQ && !c.out && (isFocus || dcam < 22)) {
        e.flapPh = num(e.flapPh, 0) + dt * (0.9 + Math.min(2.2, Math.abs(num(c.speed, 0)) * 0.12) + num(e.jolt, 0) * 2);
        flap = e.flapPh % 1;
      }
      e.jolt = Math.max(0, num(e.jolt, 0) - dt * 2);
      var dents = c.dents || [];
      if (e.scrapes && e.scrapes.length) dents = dents.concat(e.scrapes);
      var hp = clamp01(num(c.health, 1));
      return {
        dentSeq: num(c.dentSeq, 0), dents: dents, zones: Z, parts: P, hang: hang, flap: flap, roof: num(e.roof, 0), roofSide: num(e.roofSide, 1),
        lights: { fl: !!P.lightFL || c.out, fr: !!P.lightFR || c.out, rl: !!P.lightRL || c.out, rr: !!P.lightRR || c.out },
        lost: c.wheelLost || null, glassCrack: clamp01((1 - hp) * 0.9 + num(e.glass, 0)), soot: c.out ? 0.9 : num(e.soot, 0),
        scrapeN: e.scrapes ? e.scrapes.length : 0, quality: R.quality
      };
    }
    function addScrape(e, c, wx, wy, wz) {
      if (!e || !c) return;
      if (e.lastScrape != null && R.time - e.lastScrape < 0.35) return;
      e.lastScrape = R.time;
      var h = num(c.heading, 0), co = Math.cos(h), s = Math.sin(h), dx = wx - c.x, dy = wy - c.y;
      var lx = dx * co + dy * s, ly = -dx * s + dy * co, L = num(c.spec && c.spec.length, 4.4) / 2, Wd = num(c.spec && c.spec.width, 1.9) / 2;
      e.scrapes = e.scrapes || [];
      e.scrapes.push({ x: clamp(lx, -L, L), y: clamp(ly, -Wd, Wd), z: clamp(num(wz, 0.6) - num(c.z, 0), 0.25, 1.1), nx: 0, ny: 0, depth: 0, r: 0.75, scrape: true });
      if (e.scrapes.length > (R.quality === 'low' ? 6 : 18)) e.scrapes.shift();
    }
    function tintCar(e, c) {
      var dark = c.out ? 0.28 : 1 - 0.32 * clamp01(1 - num(c.health, 1)) - (c.onFire > 0.3 ? 0.15 : 0);
      if (e._dark === dark) return;
      e._dark = dark;
      Object.keys(e.mats).forEach(function (k) {
        var mm = e.mats[k], b = mm._base, ch = c.out ? [0.07, 0.06, 0.055] : [b[0], b[1], b[2]];
        var t = c.out ? 0.75 : 0;
        var col = [lerp(b[0], ch[0], t) * dark, lerp(b[1], ch[1], t) * dark, lerp(b[2], ch[2], t) * dark, b[3] == null ? 1 : b[3]];
        mm.baseColor = mm.uBaseColor = mm.color = col;
        if (c.out) { mm.clearcoat = 0; mm.roughness = 0.9; mm.metallic = 0.1; }
      });
    }

    function frameMatrix(o, fr) {
      var f = fr.fwd, u = fr.up, r = fr.right, p = fr.pos;
      o[0] = f[0]; o[1] = f[1]; o[2] = f[2]; o[3] = 0; o[4] = u[0]; o[5] = u[1]; o[6] = u[2]; o[7] = 0;
      o[8] = r[0]; o[9] = r[1]; o[10] = r[2]; o[11] = 0; o[12] = p[0]; o[13] = p[1]; o[14] = p[2]; o[15] = 1;
      return o;
    }
    function xform(M, p) { return [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]]; }
    var tmpM = M4.create(), tmpM2 = M4.create(), bodyW = M4.create();
    function pivotRot(out, pv, ang) {
      // T(pv) * Rx(ang): rotation about the car's forward (+X) axis
      var c = Math.cos(ang), s = Math.sin(ang);
      out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 0; out[5] = c; out[6] = s; out[7] = 0;
      out[8] = 0; out[9] = -s; out[10] = c; out[11] = 0; out[12] = pv[0]; out[13] = pv[1]; out[14] = pv[2]; out[15] = 1;
      return out;
    }
    function poseCar(e, c, fr, dt, out) {
      var model = e.model, P = CB.gl.car && CB.gl.car.pose, items = null;
      var cv = e.view;
      cv.x = 0; cv.y = 0; cv.heading = 0; cv.speed = Math.abs(num(c.speed, 0)); cv.steerAngle = num(c.steer, 0); cv.brake = c.brake; cv.throttle = c.throttle;
      cv.gear = num(c.vSigned, 0) < -0.5 ? -1 : 1; cv.headlights = R.tod !== 'day' && !c.out; cv.lightsOn = cv.headlights; cv.wheelspin = 0; cv.skidding = 0; cv.surface = 'asphalt';
      if (P && !model._fallback) { try { items = P(model, cv, c.airborne ? 0 : dt, e.pst); } catch (err) { items = null; } }
      if (!items) {
        items = e.fbItems || (e.fbItems = model.parts.map(function (p) { var m = M4.create(); M4.copy(m, p.local || IDENT16); return { mesh: p.mesh, material: p.material, model: m, kind: p.kind, part: p, castShadow: true }; }));
      }
      // broken lights: kill the emissive of the broken side(s)
      var pm = e.pst && e.pst.mats, parts = c.parts || {};
      if (pm) {
        var hb = (parts.lightFL ? 1 : 0) + (parts.lightFR ? 1 : 0), tb = (parts.lightRL ? 1 : 0) + (parts.lightRR ? 1 : 0);
        Object.keys(pm).forEach(function (k) {
          var em = pm[k].emissive; if (!em) return;
          // one broken lamp collapses into the body (deformCar 'light'), so only BOTH broken kill the emissive;
          // at night the lamps are toned down so they do not bloom into big white blobs
          var f = /head|drl/.test(k) ? (hb === 2 ? 0 : 1) : /tail|brake|rev/.test(k) ? (tb === 2 ? 0 : 1) : 1;
          if (R.tod !== 'day') f *= /head|drl/.test(k) ? 0.5 : 0.7;
          if (c.out) f = 0;
          if (f < 1) { em[0] *= f; em[1] *= f; em[2] *= f; }
        });
      }
      frameMatrix(e.M, fr);
      var B = e.pst && e.pst.bodyMatrix ? e.pst.bodyMatrix : IDENT16;
      M4.multiply(bodyW, e.M, B);
      out.length = 0;
      var Wl = e.items, lost = c.wheelLost || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i], p = it.part;
        if (p && p.wheel && (p.attach === 'wheel' || p.attach === 'caliper') && lost[wheelCorner(p.wheel)]) continue;
        var w = Wl[i] || (Wl[i] = { model: M4.create() });
        var pi = model.parts.indexOf(p);
        w.mesh = it.mesh; w.material = e.mats && e.mats[pi] && !/^light/.test(it.kind || '') ? e.mats[pi] : it.material; w.kind = it.kind; w.castShadow = it.castShadow !== false;
        w.transparent = it.transparent || (it.material && it.material.transparent);
        M4.multiply(w.model, e.M, it.model);
        out.push(w);
      }
      // accessories
      var A = ensureAcc(e, c);
      if (A) {
        e.accItems = e.accItems || [];
        for (var a = 0; a < A.items.length; a++) {
          var ai = e.accItems[a] || (e.accItems[a] = { model: M4.create() });
          ai.mesh = A.items[a].mesh; ai.material = A.items[a].material; ai.kind = A.items[a].kind; ai.castShadow = A.items[a].castShadow;
          M4.copy(ai.model, bodyW);
          out.push(ai);
        }
        if (A.hammer) {
          var hs = null; (c.acc || []).forEach(function (x) { if (x.id === 'hammer') hs = x; });
          var ang = hammerAngle(hs ? num(hs.swing, 0) : 0), side = hs ? num(hs.side, 1) : 1;
          var hi = e.hamItem || (e.hamItem = { model: M4.create() });
          hi.mesh = A.hammer.mesh; hi.material = A.hammer.material; hi.kind = 'derby-hammer'; hi.castShadow = true;
          pivotRot(tmpM, A.hammer.pivot, -side * ang);
          M4.multiply(hi.model, bodyW, tmpM);
          out.push(hi);
          e.hammerHead = xform(hi.model, [0, 1.85, 0]);
          e.hammerSwing = hs ? num(hs.swing, 0) : 0;
        }
      }
      return out;
    }
    function anchorWorld(e, local) { return xform(bodyW_for(e), local); }
    function bodyW_for(e) { var B = e.pst && e.pst.bodyMatrix ? e.pst.bodyMatrix : IDENT16; M4.multiply(tmpM2, e.M, B); return tmpM2; }

    /* ---- particles (CPU) ---- */
    var PS = [], PMAX = Q.particles;
    var rnd = Math.random;
    function spawn(p) { if (PS.length >= PMAX) PS.splice(0, Math.max(1, PS.length - PMAX + 1)); PS.push(p); }
    function sparks(pos, n, vel, col, speed) {
      var lowQ = R.quality === 'low';
      n = Math.min(n, lowQ ? 16 : R.quality === 'medium' ? 48 : 80);
      for (var i = 0; i < n; i++) {
        var a = rnd() * TAU, b = 0.3 + rnd() * 0.9, sp = num(speed, 7) * (0.6 + rnd() * 0.8);
        var v = add(mul(vel || [0, 0, 0], 0.45), [Math.cos(a) * sp * b, 1.2 + rnd() * sp * 0.7, Math.sin(a) * sp * b]);
        var life = 0.25 + rnd() * 0.45, sz = 0.045 + rnd() * 0.045, c0 = col || (rnd() < 0.25 ? [5, 4.2, 2.4, 1] : [4.2, 2.0, 0.5, 1]);
        spawn({ p: pos.slice(), v: v, life: life, age: 0, size: sz, col: c0, add: true, g: 1 });
        // streak: two trailing points riding the same velocity a few ms behind read as a hot line
        if (!lowQ) for (var k = 1; k <= 2; k++) spawn({ p: madd(pos, v, -0.012 * k), v: v.slice(), life: life * (1 - k * 0.12), age: 0, size: sz * (1 - k * 0.25), col: [c0[0] * 0.7, c0[1] * 0.6, c0[2] * 0.5, 0.9], add: true, g: 1 });
      }
    }
    /** glass glitter: tumbling blue-white specks that bounce and settle */
    function shards(pos, n, vel) {
      if (R.quality === 'low') return;
      for (var i = 0; i < n; i++) {
        var a = rnd() * TAU, sp = 2 + rnd() * 5;
        spawn({ p: madd(pos, [rnd() - 0.5, rnd() * 0.4, rnd() - 0.5], 0.8), v: add(mul(vel || [0, 0, 0], 0.5), [Math.cos(a) * sp, 1 + rnd() * 3.5, Math.sin(a) * sp]), life: 0.9 + rnd() * 1.3, age: 0,
          size: 0.035 + rnd() * 0.04, col: rnd() < 0.5 ? [2.2, 2.5, 2.8, 1] : [0.9, 1.1, 1.3, 1], add: true, g: 1, glint: true });
      }
    }
    function puff(pos, n, col, size, up, life) {
      for (var i = 0; i < n; i++) {
        var a = rnd() * TAU;
        spawn({ p: madd(pos, [Math.cos(a), 0, Math.sin(a)], rnd() * 0.5), v: [Math.cos(a) * 0.8, num(up, 1.6) * (0.6 + rnd() * 0.7), Math.sin(a) * 0.8], life: num(life, 1.6) * (0.7 + rnd() * 0.6), age: 0, size: size * (0.7 + rnd() * 0.6), grow: size * 1.4, col: col, add: false, g: -0.05, soft: 0.8 });
      }
    }
    function flame(pos, vel, size, life, col) { spawn({ p: pos.slice(), v: vel, life: life, age: 0, size: size, grow: size * 1.6, col: col || [2.6, 1.0, 0.22, 0.85], add: true, g: -0.35 }); }
    function stepParticles(dt) {
      for (var i = PS.length - 1; i >= 0; i--) {
        var p = PS[i];
        p.age += dt;
        if (p.age >= p.life) { PS.splice(i, 1); continue; }
        p.v[1] -= 9.8 * p.g * dt;
        p.p[0] += p.v[0] * dt; p.p[1] += p.v[1] * dt; p.p[2] += p.v[2] * dt;
        if (p.add && p.g > 0 && p.p[1] < 0.02) { p.p[1] = 0.02; p.v[1] *= -0.3; p.v[0] *= 0.6; p.v[2] *= 0.6; }
        if (!p.add) { p.v[0] *= 1 - 0.8 * dt; p.v[2] *= 1 - 0.8 * dt; }
      }
      if (!particles) return;
      var n = Math.min(PS.length, particles.max);
      for (var k = 0; k < n; k++) {
        var q = PS[k], t = q.age / q.life, a = q.col[3] * (q.add ? (1 - t) : (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85));
        if (q.glint) a *= 0.45 + 0.55 * Math.abs(Math.sin(q.age * 31 + k));
        particles.set(k, q.p[0], q.p[1], q.p[2], q.col[0] * a, q.col[1] * a, q.col[2] * a, a, Math.max(0.02, q.size + num(q.grow, 0) * q.age), 0, q.add ? 0.2 : num(q.soft, 0.7), q.add);
      }
      particles.upload(n);
    }

    /* ---- debris (cosmetic rigid bits that stay in the arena: panels, doors, bonnets, bumpers, wheels, chunks) ---- */
    var DEB = [];
    function debris(kind, pos, vel, mat, scale) {
      var cap = Q.debris;
      if (DEB.length >= cap) {
        // drop a small chunk first, else the oldest piece
        var ci = -1; for (var q = 0; q < DEB.length; q++) if (DEB[q].kind === 'chunk') { ci = q; break; }
        DEB.splice(ci >= 0 ? ci : 0, 1);
      }
      var d = { kind: kind, p: pos.slice(), v: vel.slice(), rot: [rnd() * TAU, rnd() * TAU, rnd() * TAU], rv: [(rnd() - 0.5) * 14, (rnd() - 0.5) * 10, (rnd() - 0.5) * 14],
        life: kind === 'chunk' ? 7 + rnd() * 5 : Infinity, age: 0, mat: mat, s: scale || 1, item: { model: M4.create() }, sleep: false };
      if (kind !== 'chunk' && kind !== 'wheel') d.rot = [rnd() * 0.6, rnd() * TAU, rnd() * 0.6];
      DEB.push(d);
      return d;
    }
    function groundAt(x, z) { var AR = CB.derby.arenas; try { return AR ? AR.heightAt(arena, x, -z).z : 0; } catch (e) { return 0; } }
    var DEB_H = { wheel: 0.34, hood: 0.04, door: 0.07, bumper: 0.12, panel: 0.06, chunk: 0.07 };
    function stepDebris(dt, out) {
      var cars = R.debCars || [];
      for (var i = DEB.length - 1; i >= 0; i--) {
        var d = DEB[i];
        d.age += dt;
        if (d.age > d.life) { DEB.splice(i, 1); continue; }
        // cars plough through resting debris and fling it
        for (var c = 0; c < cars.length; c++) {
          var cc = cars[c], dx = d.p[0] - cc.p[0], dz = d.p[2] - cc.p[2];
          if (dx * dx + dz * dz > 5.5 || Math.abs(d.p[1] - cc.p[1]) > 1.6 || cc.sp < 2.5) continue;
          var dl = Math.hypot(dx, dz) || 1;
          d.v = [cc.v[0] * 1.15 + dx / dl * 2.5, 1.2 + cc.sp * 0.12 + rnd(), cc.v[2] * 1.15 + dz / dl * 2.5];
          d.rv = [(rnd() - 0.5) * 12, (rnd() - 0.5) * 8, (rnd() - 0.5) * 12]; d.sleep = false;
          if (d.kind !== 'chunk' && rnd() < 0.3) sparks(d.p, 4, d.v, null, 3);
        }
        if (!d.sleep) {
          d.v[1] -= 9.8 * dt;
          d.p[0] += d.v[0] * dt; d.p[1] += d.v[1] * dt; d.p[2] += d.v[2] * dt;
          var gy = groundAt(d.p[0], d.p[2]) + num(DEB_H[d.kind], 0.06) * d.s;
          if (CB.derby.arenas) {
            var bd = CB.derby.arenas.sdBoundary(arena, d.p[0], -d.p[2]);
            if (bd.d < 0) {
              if (bd.open) gy = -44.6;
              else if (d.p[1] < num(arena.wall && arena.wall.height, 1.2) + 0.3) {
                // bounce off the wall back into the arena
                var vn = d.v[0] * bd.nx + -d.v[2] * bd.ny;
                if (vn < 0) { d.v[0] -= 1.5 * vn * bd.nx; d.v[2] += 1.5 * vn * bd.ny; }
                d.p[0] += bd.nx * -bd.d; d.p[2] -= bd.ny * -bd.d;
              }
            }
          }
          if (d.p[1] < gy) {
            d.p[1] = gy; d.v[1] = Math.abs(d.v[1]) * (d.kind === 'wheel' ? 0.35 : 0.22);
            var fr = d.kind === 'wheel' && d.roll ? 0.985 : 0.62;
            d.v[0] *= fr; d.v[2] *= fr;
            if (d.kind === 'wheel' && d.roll) { d.rv[2] *= 0.985; if (Math.hypot(d.v[0], d.v[2]) < 1.2) { d.roll = false; d.rot[0] = PI / 2; } }
            else {
              d.rv[0] *= 0.5; d.rv[1] *= 0.6; d.rv[2] *= 0.5;
              // flat pieces settle flat
              if (d.kind === 'door') { var tgx = d.rot[0] >= 0 ? PI / 2 : -PI / 2; d.rot[0] += (tgx - d.rot[0]) * 0.35; d.rot[2] *= 0.8; }
              else if (d.kind !== 'chunk' && d.kind !== 'wheel') { d.rot[0] *= 0.8; d.rot[2] *= 0.8; }
              else if (d.kind === 'wheel') { d.rot[0] += (PI / 2 - d.rot[0]) * 0.3; }
            }
            if (Math.abs(d.v[1]) < 0.4 && Math.hypot(d.v[0], d.v[2]) < 0.25 && Math.abs(d.rv[1]) < 0.4) { d.sleep = true; d.v = [0, 0, 0]; }
          }
          for (var k = 0; k < 3; k++) d.rot[k] += d.rv[k] * dt;
          if (d.p[1] < -60) { DEB.splice(i, 1); continue; }
        }
        var m = d.item.model, sc = d.s;
        // Euler (y, x, z) rotation; wheels: axle = local Z
        var cy = Math.cos(d.rot[1]), sy = Math.sin(d.rot[1]), cx = Math.cos(d.rot[0]), sx = Math.sin(d.rot[0]), cz = Math.cos(d.rot[2]), sz = Math.sin(d.rot[2]);
        var r00 = cy * cz + sy * sx * sz, r01 = -cy * sz + sy * sx * cz, r02 = sy * cx;
        var r10 = cx * sz, r11 = cx * cz, r12 = -sx;
        var r20 = -sy * cz + cy * sx * sz, r21 = sy * sz + cy * sx * cz, r22 = cy * cx;
        m[0] = r00 * sc; m[1] = r10 * sc; m[2] = r20 * sc; m[3] = 0; m[4] = r01 * sc; m[5] = r11 * sc; m[6] = r21 * sc; m[7] = 0;
        m[8] = r02 * sc * (d.flipZ ? -1 : 1); m[9] = r12 * sc * (d.flipZ ? -1 : 1); m[10] = r22 * sc * (d.flipZ ? -1 : 1); m[11] = 0; m[12] = d.p[0]; m[13] = d.p[1]; m[14] = d.p[2]; m[15] = 1;
        var it = d.item; it.mesh = SH[d.kind] || SH.chunk; it.material = d.mat || MAT.chunk; it.castShadow = d.kind !== 'chunk' && R.quality !== 'low'; it.kind = 'derby-debris';
        it.doubleSided = d.kind === 'hood' || d.kind === 'door';
        out.push(it);
      }
    }

    /* ---- dynamic items pool ---- */
    var dynItems = [], dynPool = [];
    function dyn(mesh, mat) {
      var it = dynPool[dynItems.length] || (dynPool[dynItems.length] = { model: M4.create() });
      it.mesh = mesh; it.material = mat; it.castShadow = false; it.transparent = !!mat.transparent; it.kind = 'derby-dyn';
      dynItems.push(it);
      return it;
    }
    function setTRS(m, pos, ax, ay, az, sx, sy, sz) {
      m[0] = ax[0] * sx; m[1] = ax[1] * sx; m[2] = ax[2] * sx; m[3] = 0; m[4] = ay[0] * sy; m[5] = ay[1] * sy; m[6] = ay[2] * sy; m[7] = 0;
      m[8] = az[0] * sz; m[9] = az[1] * sz; m[10] = az[2] * sz; m[11] = 0; m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
    }
    /** a box stretched from p0 to p1 (unit cube mesh) */
    function segment(mesh, mat, p0, p1, t) {
      var d = sub(p1, p0), l = Math.sqrt(dot(d, d)) || 1e-4, ax = mul(d, 1 / l);
      var h = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], az = norm(cross(ax, h)), ay = cross(az, ax);
      var it = dyn(mesh, mat);
      setTRS(it.model, mul(add(p0, p1), 0.5), ax, ay, az, l, t, t);
      return it;
    }
    function chainSeg(p0, p1, odd) {
      var d = sub(p1, p0), l = Math.sqrt(dot(d, d)) || 1e-4, ax = mul(d, 1 / l);
      var h = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], az = norm(cross(ax, h)), ay = cross(az, ax);
      if (odd) { var t = ay; ay = az; az = mul(t, -1); }
      var it = dyn(SH.link, MAT.link); it.castShadow = true;
      setTRS(it.model, p0, ax, ay, az, l, 1, 1);
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
      if (glc.width !== w || glc.height !== h) { if (typeof ctx.resize === 'function') ctx.resize(cw, ch, dpr); else { glc.width = w; glc.height = h; } }
      return { w: glc.width, h: glc.height, cw: cw, ch: ch };
    }

    /* ---- camera ---- */
    var cam = { view: M4.create(), proj: M4.create(), viewProj: M4.create(), position: [0, 0, 0] };
    function setCam(eye, target, up, fovDeg, aspect) {
      M4.lookAt(cam.view, eye, target, up);
      M4.perspective(cam.proj, fovDeg * DEG, aspect, 0.2, Q.far);
      M4.multiply(cam.viewProj, cam.proj, cam.view);
      cam.position[0] = eye[0]; cam.position[1] = eye[1]; cam.position[2] = eye[2];
      cam.eye = cam.position; cam.target = target; cam.up = up; cam.fovDeg = fovDeg; cam.aspect = aspect;
      cam.viewMatrix = cam.view; cam.projMatrix = cam.proj; cam.uView = cam.view; cam.uProj = cam.proj; cam.uCamPos = cam.position;
      cam.forward = norm(sub(target, eye)); cam.near = 0.2; cam.far = Q.far;
      return cam;
    }
    /** is the GL point inside something solid (obstacles up to their height, arena walls, the ground) */
    function camBlocked(x, y, z) {
      var AR = CB.derby.arenas; if (!AR) return false;
      var sx = x, sy = -z, obs = arena.obstacles || [];
      for (var i = 0; i < obs.length; i++) {
        var o = obs[i];
        if (Math.abs(sx - o.x) > o.br + 0.6 || Math.abs(sy - o.y) > o.br + 0.6) continue;
        if (y > num(o.h, 2) + 0.4) continue;
        if (AR.sdObstacle(o, sx, sy).d < 0.45) return true;
      }
      var bd = AR.sdBoundary(arena, sx, sy);
      if (bd.d < -0.3 && !bd.open && y < num(arena.wall && arena.wall.height, 1.2) + 2.5) return true;
      return y < groundAt(x, z) + 0.25;
    }
    /** spring for directional kicks */
    function stepKick(dt) {
      var k = 90, d = 11;
      for (var i = 0; i < 3; i++) { R.kv[i] += (-k * R.ko[i] - d * R.kv[i]) * dt; R.ko[i] += R.kv[i] * dt; }
    }
    /** replay / cinematic camera: a low orbit or side shot around a crash point */
    function cineCam(cn, byId, dt, aspect) {
      cn.t += dt;
      var tc = cn.targetId && byId[cn.targetId], focusP = cn.focus ? W(cn.focus[0], cn.focus[1], num(cn.focus[2], 0)) : null;
      var fp = tc ? [num(tc.x, 0), num(tc.z, 0) + 0.8, -num(tc.y, 0)] : focusP || [0, 1, 0];
      if (tc && focusP) fp = lerp3(fp, focusP, 0.35);
      if (!cn.base) cn.base = num(cn.angle, R.rig.yaw != null ? R.rig.yaw + PI * 0.6 : 0);
      var ang = cn.base + (cn.orbit !== false ? cn.t * 0.55 : 0), rad = num(cn.dist, 8.5) - Math.min(2, cn.t * 0.6), ht = num(cn.height, 1.6);
      var eye = [fp[0] + Math.cos(ang) * rad, fp[1] + ht, fp[2] - Math.sin(ang) * rad];
      var tpos = tc ? [num(tc.x, 0), -num(tc.y, 0)] : null;
      var blk = function (x, y, z) {
        if (camBlocked(x, y, z)) return true;
        var dc = R.debCars || [];
        for (var i = 0; i < dc.length; i++) {
          var cp = dc[i].p;
          if (tpos && Math.abs(cp[0] - tpos[0]) < 0.5 && Math.abs(cp[2] - tpos[1]) < 0.5) continue;
          if (y < cp[1] + 2.4 && Math.hypot(x - cp[0], z - cp[2]) < 3.0) return true;
        }
        return false;
      };
      // blocked low shot: try other angles first, then climb over the pile-up instead of diving into the target
      var clr = camClear(fp, eye, blk, 16);
      if (clr < 0.75) {
        for (var tA = 1; tA <= 5 && clr < 0.75; tA++) {
          var a2 = ang + tA * 1.05, e2 = [fp[0] + Math.cos(a2) * rad, fp[1] + ht, fp[2] - Math.sin(a2) * rad], c2 = camClear(fp, e2, blk, 16);
          if (c2 > clr) { clr = c2; eye = e2; if (c2 >= 0.75) cn.base += tA * 1.05; }
        }
      }
      if (clr < 0.75) { eye[1] = fp[1] + ht + 4.5; clr = Math.max(clr, camClear(fp, eye, blk, 16)); }
      if (clr < 1) eye = lerp3(fp, eye, Math.max(0.55, clr));
      var gy = groundAt(eye[0], eye[2]); if (eye[1] < gy + 0.6) eye[1] = gy + 0.6;
      if (cn.dur && cn.t > cn.dur) R.cine = null;
      var sh = R.shakeA > 0.001 && Q.shake ? [Math.sin(R.time * 53) * R.shakeA * 0.12, Math.sin(R.time * 61) * R.shakeA * 0.1, 0] : [0, 0, 0];
      return setCam(add(eye, sh), fp, [0, 1, 0], num(cn.fov, 50), aspect);
    }
    function camera(c, fr, e, dt, aspect) {
      var rig = R.rig, pos = [num(c.x, 0), num(c.z, 0), -num(c.y, 0)];
      stepKick(dt);
      if (R.cine) return cineCam(R.cine, R.byId || {}, dt, aspect);
      var hd = num(c.heading, 0);
      if (!rig.init) { rig.yaw = hd; rig.pos = pos.slice(); rig.init = true; rig.lift = 0; }
      // the camera yaw follows the car's HEADING (never its velocity), so reversing does not swing the camera round
      var rate = R.mode === 'far' ? 3 : 4.2;
      rig.yaw += wrap(hd - rig.yaw) * (1 - Math.exp(-rate * dt));
      rig.pos = lerp3(rig.pos, pos, 1 - Math.exp(-14 * dt));
      var cy = Math.cos(rig.yaw), sy = Math.sin(rig.yaw), fwd = [cy, 0, -sy];
      var spd = Math.abs(num(c.speed, 0));
      var shk = Q.shake && R.shakeA > 0.001 ? R.shakeA : 0;
      var sh = shk ? [Math.sin(R.time * 53) * shk * 0.22, Math.sin(R.time * 61 + 1) * shk * 0.16, Math.sin(R.time * 47 + 2) * shk * 0.22] : [0, 0, 0];
      R.shakeA = Math.max(0, R.shakeA - dt * 2.2);
      R.fovKick = Math.max(0, R.fovKick - dt * 18);
      var fovT = 62 + clamp01((spd - 10) / 30) * 8 + (c.boosting ? 7 : 0);
      R.fov += (fovT - R.fov) * (1 - Math.exp(-dt * 4));
      var fov = R.fov + R.fovKick;
      var back = R.lookBack ? -1 : 1, up = [0, 1, 0], eye, tgt;
      if (R.mode === 'chase' || R.mode === 'far') {
        var far = R.mode === 'far';
        var dist = far ? 13.5 : 7.6, ht = far ? 6.2 : 2.9;
        eye = add(add(rig.pos, mul(fwd, -dist * back)), [0, ht, 0]);
        tgt = add(add(rig.pos, [0, 1.0, 0]), mul(fwd, 4 * back));
        if (c.out) { eye[1] += 2; }
        // never inside a pillar / statue / wall: march from the car to the eye, pull in in front of the first solid
        var piv = add(rig.pos, [0, 1.3, 0]), fr0 = camClear(piv, eye, camBlocked, 16);
        rig.clear = rig.clear == null ? fr0 : (fr0 < rig.clear ? fr0 : rig.clear + (fr0 - rig.clear) * (1 - Math.exp(-3 * dt)));
        if (rig.clear < 0.999) { eye = lerp3(piv, eye, rig.clear); eye[1] += (1 - rig.clear) * 1.6; }
        var ey = groundAt(eye[0], eye[2]);
        if (eye[1] < ey + 1.2) eye[1] = ey + 1.2;
        // directional jolt (kick) springs back
        eye = add(eye, R.ko); tgt = add(tgt, mul(R.ko, 0.35));
        return setCam(add(eye, sh), tgt, up, fov, aspect);
      }
      if (R.mode === 'hood') {
        var hc = (e.model && e.model.hoodCam) || [0.6, 1.25, 0];
        eye = xform(e.M, [hc[0], hc[1] + 0.05, hc[2]]);
        var dir = R.lookBack ? mul(fr.fwd, -1) : fr.fwd;
        return setCam(add(eye, mul(sh, 0.4)), add(eye, mul(dir, 10)), fr.up[1] > 0.3 ? fr.up : up, fov + 4, aspect);
      }
      // overhead: high and behind, looking down at the action
      eye = add(rig.pos, [-cy * 14, 34, sy * 14]);
      return setCam(add(eye, mul(sh, 1.5)), add(rig.pos, [0, 0.5, 0]), up, 52, aspect);
    }

    function toScreen(p) {
      var vp = cam.viewProj, x = p[0], y = p[1], z = p[2];
      var cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (!(cw > 0.05)) return { x: 0, y: 0, visible: false, scale: 0 };
      var Wd = canvas.clientWidth || 1, H = canvas.clientHeight || 1;
      return { x: (cx / cw * 0.5 + 0.5) * Wd, y: (0.5 - cy / cw * 0.5) * H, visible: Math.abs(cx / cw) < 1.2 && Math.abs(cy / cw) < 1.2, scale: H * 0.5 * cam.proj[5] / cw, depth: cw };
    }

    /* ---- events -> FX ---- */
    function carColorMat(e, c) {
      if (!e.debMat) { var rgb = hexRgb(c.color, [0.6, 0.1, 0.1]); e.debMat = { color: [rgb[0], rgb[1], rgb[2], 1], roughness: 0.4, clearcoat: 0.5, metallic: 0.2, doubleSided: true }; }
      return e.debMat;
    }
    function handleEvents(snap, byId, poses, focus) {
      (snap.events || []).forEach(function (ev) {
        var c = byId[ev.carId], e = c ? R.cars[c.id] : null;
        var p = ev.x != null ? W(ev.x, ev.y, num(ev.z, c ? c.z + 0.6 : 0.6)) : (c ? add(poses[c.id].pos, [0, 0.8, 0]) : null);
        if (!p) return;
        var involved = c && (c.id === focus || ev.otherId === focus);
        var en = num(ev.energy, 0);
        var vel = c ? [num(c.vx, 0), 0, -num(c.vy, 0)] : [0, 0, 0];
        switch (ev.type) {
          case 'impact': case 'wall': {
            var k = clamp(en / 25000, 0.2, 3.2);
            sparks(p, Math.round(14 + k * 22), vel, null, 6 + k * 3);
            puff(p, Math.round(2 + k * 3), arena.surface && arena.surface.kind === 'ice' ? [0.9, 0.95, 1, 0.5] : [0.5, 0.45, 0.4, 0.45], 0.8, 1.2, 1.3);
            if (ev.big || k > 1.2) {
              for (var b = 0; b < (R.quality === 'low' ? 1 : 4); b++) debris('chunk', p, [vel[0] * 0.3 + (rnd() - 0.5) * 7, 3 + rnd() * 4, vel[2] * 0.3 + (rnd() - 0.5) * 7], e && rnd() < 0.6 ? carColorMat(e, c) : MAT.chunk, 0.5 + rnd() * 0.7);
              shards(p, Math.round(10 + k * 6), vel);
            }
            // glass cracks + panels jolt on the cars involved
            [c, ev.otherId ? byId[ev.otherId] : null].forEach(function (cx, ii) {
              if (!cx) return; var ex = carEntry(cx);
              ex.glass = Math.min(0.8, num(ex.glass, 0) + (ev.big ? 0.18 : 0.05) * (ii === 1 ? 1 : 0.6)); ex.jolt = 1;
              if (ev.type === 'impact') addScrape(ex, cx, num(ev.x, cx.x), num(ev.y, cx.y), num(ev.z, cx.z + 0.6));
            });
            if (ev.type === 'wall' && c) addScrape(e, c, num(ev.x, c.x), num(ev.y, c.y), num(ev.z, c.z + 0.6));
            if (involved) {
              R.shakeA = Math.min(2, R.shakeA + clamp(en / 40000, 0.15, 1.5));
              if (ev.big) R.fovKick = Math.min(12, R.fovKick + 7);
              // directional jolt: the victim is shoved along the hit normal, the attacker bounces back a little
              if (ev.nx != null) api.kick(focus === ev.otherId ? ev.nx : -ev.nx, focus === ev.otherId ? ev.ny : -ev.ny, clamp(en / 60000, 0.1, 1.2) * (focus === ev.otherId ? 1 : 0.5));
            }
            if (ev.crusher) sparks(p, 30, [0, -2, 0], [4, 2.5, 0.8, 1], 9);
            break;
          }
          case 'scrape':
            sparks(p, ev.saws ? 18 : 10, vel, ev.saws ? [4, 3, 1.4, 1] : null, 5);
            if (c) addScrape(e, c, num(ev.x, c.x), num(ev.y, c.y), num(ev.z, c.z + 0.5));
            if (ev.otherId && byId[ev.otherId]) addScrape(carEntry(byId[ev.otherId]), byId[ev.otherId], num(ev.x, c ? c.x : 0), num(ev.y, c ? c.y : 0), num(ev.z, 0.6));
            break;
          case 'light': shards(p, 10, vel); sparks(p, 6, vel, [3, 3, 3, 1], 3); break;
          case 'hammer':
            if (!ev.miss) { var hp = e && e.hammerHead ? e.hammerHead : p; sparks(hp, 30, [0, 0, 0], [5, 3, 1, 1], 9); R.flashes.push({ p: hp, t: 0, s: 1.6 }); if (involved) { R.shakeA = Math.min(1.6, R.shakeA + 0.8); R.fovKick = 8; } }
            break;
          case 'launch': puff(p, 10, [0.55, 0.5, 0.45, 0.5], 1.0, 2, 1.4); sparks(p, 16, vel, null, 6); if (involved) R.shakeA = Math.min(1.6, R.shakeA + 0.6); break;
          case 'land': puff(p, Math.round(clamp(en, 4, 12)), [0.55, 0.5, 0.45, 0.45], 0.9, 1, 1.2); if (involved) R.shakeA = Math.min(1.6, R.shakeA + 0.3); break;
          case 'explode': {
            var lowX = R.quality === 'low';
            for (var f = 0; f < (lowX ? 18 : 60); f++) flame(madd(p, [rnd() - 0.5, rnd() * 0.6, rnd() - 0.5], 1.4), [(rnd() - 0.5) * 11, 2 + rnd() * 9, (rnd() - 0.5) * 11], 0.8 + rnd() * 1.0, 0.5 + rnd() * 0.6, rnd() < 0.25 ? [3.2, 1.6, 0.45, 0.85] : rnd() < 0.5 ? [2.6, 0.8, 0.12, 0.85] : [1.6, 0.35, 0.05, 0.9]);
            puff(p, lowX ? 8 : 22, [0.05, 0.045, 0.045, 0.9], 2.0, 3.4, 4.2);
            sparks(p, 70, [0, 3, 0], null, 15);
            shards(p, 30, [0, 2, 0]);
            for (var d2 = 0; d2 < (lowX ? 3 : 8); d2++) debris('chunk', p, [(rnd() - 0.5) * 16, 6 + rnd() * 9, (rnd() - 0.5) * 16], e && rnd() < 0.5 ? carColorMat(e, c) : MAT.charred, 0.7 + rnd() * 0.9);
            if (c && e) { debris('hood', add(p, [0, 0.6, 0]), [(rnd() - 0.5) * 6, 9 + rnd() * 5, (rnd() - 0.5) * 6], MAT.charred, num(e.dims && e.dims.W, 1.9) / 1.9); }
            R.flashes.push({ p: p, t: 0, s: 3.2 });
            R.rings.push({ p: [p[0], groundAt(p[0], p[2]) + 0.08, p[2]], t: 0, dur: 0.75, r: 13, mat: { color: [3.2, 1.6, 0.5, 1], unlit: true, additive: true, transparent: true, depthWrite: false, castShadow: false, doubleSided: true } });
            if (e) e.boomT = 0;
            var fd = byId[focus];
            if (involved || (c && fd && Math.hypot(c.x - fd.x, c.y - fd.y) < 28)) { R.shakeA = Math.min(2.2, R.shakeA + 1.5); R.fovKick = 12; if (fd && c) api.kick(fd.x - c.x, fd.y - c.y, 1.2); }
            break;
          }
          case 'part-off':
            if (c && e && e.model) {
              var fr = poses[c.id], part = ev.part || '', DD = e.model._dd || damageDims(e.dims);
              var lp = part === 'hood' ? [DD.fA - 0.35, DD.belt + 0.08, 0] : part === 'trunk' ? [DD.rA + 0.2, DD.belt + 0.08, 0] : part === 'bumperF' ? [DD.hl - 0.12, 0.42, 0]
                : part === 'bumperR' ? [-DD.hl + 0.12, 0.42, 0] : part === 'doorL' ? [(DD.fA + DD.rA) / 2 + 0.25, 0.68, -DD.hw] : part === 'doorR' ? [(DD.fA + DD.rA) / 2 + 0.25, 0.68, DD.hw] : [0, 0.8, 0];
              var at = xform(e.M, lp);
              var kindD = part === 'hood' || part === 'trunk' ? 'hood' : part.indexOf('door') === 0 ? 'door' : part.indexOf('bumper') === 0 ? 'bumper' : 'panel';
              var out = part === 'doorL' ? mul(fr.right, -1) : part === 'doorR' ? fr.right : part === 'bumperF' || part === 'hood' ? fr.fwd : part === 'bumperR' || part === 'trunk' ? mul(fr.fwd, -1) : fr.up;
              var vv = add(mul(vel, 0.65), add(mul(out, 3 + rnd() * 3), [0, (kindD === 'hood' ? 6 : 3) + rnd() * 3, 0]));
              var dd = debris(kindD, at, vv, carColorMat(e, c), num(DD.W, 1.9) / 1.9);
              if (dd && part === 'doorR') dd.flipZ = true;
              sparks(at, 24, vel, null, 6);
              shards(at, kindD === 'door' ? 16 : 6, vel);
              e.jolt = 1;
            }
            break;
          case 'wheel-off':
            if (c) {
              var fr2 = poses[c.id], wi = num(ev.wheel, 0), wl = num(c.spec && c.spec.length, 4.4) * 0.3 * (wi < 2 ? 1 : -1), wz = (wi % 2 === 0 ? -1 : 1) * num(c.spec && c.spec.width, 1.9) * 0.48;
              var wpos = add(add(fr2.pos, mul(fr2.fwd, wl)), add(mul(fr2.right, wz), [0, 0.35, 0]));
              var wd = debris('wheel', wpos, add(mul(vel, 0.9), add(mul(fr2.right, wz * 3.5), [0, 3, 0])), MAT.wheel, 1);
              if (wd) { wd.roll = true; wd.rv = [0, (rnd() - 0.5) * 2, -(Math.hypot(vel[0], vel[2]) + 4) / 0.34]; wd.rot[1] = num(c.heading, 0); }
              sparks(wpos, 40, vel, null, 8);
              if (e) e.jolt = 1;
            }
            break;
          case 'puncture': puff(p, 3, [0.8, 0.8, 0.8, 0.35], 0.4, 0.8, 0.6); break;
          case 'fire': for (var fi = 0; fi < 8; fi++) flame(madd(p, [rnd() - 0.5, 0, rnd() - 0.5], 0.8), [0, 2 + rnd() * 2, 0], 0.5, 0.5, null); break;
          case 'oil': if (!ev.slip) puff(p, 4, [0.05, 0.05, 0.06, 0.6], 0.5, 0.4, 0.8); break;
          case 'shield': if (c) R.flashes.push({ p: add(poses[c.id].pos, [0, 0.8, 0]), t: 0, s: 2.2, col: 'cyan' }); break;
          case 'repair': for (var rp = 0; rp < 24; rp++) spawn({ p: madd(p, [rnd() - 0.5, rnd(), rnd() - 0.5], 2), v: [0, 1.5 + rnd(), 0], life: 0.9, age: 0, size: 0.12, col: [0.6, 3, 1.2, 1], add: true, g: 0 }); break;
          case 'unflip': case 'respawn': puff(p, 6, [0.6, 0.58, 0.55, 0.4], 0.8, 1, 1); break;
          case 'eliminated': if (involved) R.shakeA = Math.min(2, R.shakeA + 0.6); break;
          default: break;
        }
      });
    }

    /* ---- night lights ---- */
    function arenaLights(focusPos) {
      var out = [], D = world.dyn;
      if (R.tod === 'day') return out;
      D.spots.forEach(function (s, i) {
        var t = R.time * 0.35 + s.phase, b = arena.bounds;
        var tx = Math.cos(t * 1.3 + i) * (b.maxX * 0.6), ty = Math.sin(t * 0.9 + i * 2) * (b.maxY * 0.6);
        var tp = [tx, 0, -ty];
        out.push({ pos: s.pos, dir: norm(sub(tp, s.pos)), color: [6.5, 6.1, 5.3], range: 110, cosInner: 0.985, cosOuter: 0.965, type: 1, d: 0 });
      });
      D.lamps.forEach(function (l) {
        var d = Math.hypot(l.pos[0] - focusPos[0], l.pos[2] - focusPos[2]);
        if (l.post) out.push({ pos: l.pos, dir: [0, -1, 0], color: [3.2, 2.6, 1.9], range: 22, cosInner: 0.7, cosOuter: 0.4, type: 1, d: d });
        else out.push({ pos: l.pos, dir: norm(sub([l.pos[0] * 0.2, 0, l.pos[2] * 0.2], l.pos)), color: arena.surface && arena.surface.kind === 'ice' ? [2.6, 2.6, 2.7] : [5, 4.8, 4.4], range: 120, cosInner: 0.9, cosOuter: 0.72, type: 1, d: d });
      });
      out.sort(function (a, b) { return a.d - b.d; });
      return out.slice(0, 5);
    }

    /* ---- frame ---- */
    R.flashes = []; R.rings = []; R.ko = [0, 0, 0]; R.kv = [0, 0, 0]; R.cine = null;
    var carLists = [], casters = [], main = [];
    function render(snap, alpha) {
      if (!snap || !snap.cars || ctx.lost) return;
      var t0 = now(), dt = R.lastT ? clamp((t0 - R.lastT) / 1000, 0, 0.1) : 1 / 60;
      R.lastT = t0; R.time += dt; R.frame++;
      R.tod = snap.timeOfDay || arena.timeOfDay || 'day';
      // restart detection: time went backwards -> reset dents + debris
      if (snap.t < R.lastSnapT - 0.5) api.reset();
      R.lastSnapT = snap.t;
      var size = ensureSize(), Lt = lighting(R.tod);
      var byId = {}, i;
      for (i = 0; i < snap.cars.length; i++) byId[snap.cars[i].id] = snap.cars[i];
      R.byId = byId;
      var focusId = R.follow && byId[R.follow] ? R.follow : (snap.playerId && byId[snap.playerId] ? snap.playerId : snap.cars[0].id);
      var focus = byId[focusId];
      R.focusId = focusId;
      // interpolated frames
      var poses = {}, a = clamp01(num(alpha, num(snap.alpha, 1)));
      for (i = 0; i < snap.cars.length; i++) {
        var c = snap.cars[i], e = carEntry(c);
        var cur = { x: c.x, y: c.y, z: c.z, heading: c.heading, pitch: c.pitch, roll: c.roll };
        var v = cur;
        if (e.prev && e.prevT !== snap.t && Math.hypot(cur.x - e.prev.x, cur.y - e.prev.y) < 6) {
          v = { x: lerp(e.prev.x, cur.x, a), y: lerp(e.prev.y, cur.y, a), z: lerp(e.prev.z, cur.z, a), heading: e.prev.heading + wrap(cur.heading - e.prev.heading) * a, pitch: lerp(e.prev.pitch, cur.pitch, a), roll: lerp(e.prev.roll, cur.roll, a) };
        }
        if (e.prevT !== snap.t) { e.prev = cur; e.prevT = snap.t; }
        var tilt = wheelSink(c.wheelLost, c.punct), spd0 = Math.abs(num(c.speed, 0));
        if (c.punct && spd0 > 2 && !c.out) { var np = 0; for (var pw = 0; pw < 4; pw++) if (c.punct[pw] && !(c.wheelLost && c.wheelLost[pw])) np++; if (np) tilt.roll += np * 0.014 * Math.sin(R.time * (5 + spd0 * 0.9)); }
        poses[c.id] = carFrame(v, tilt);
        e.fr = poses[c.id];
        e.vpos = v;
      }
      handleEvents(snap, byId, poses, focusId);
      // camera
      var fe = carEntry(focus);
      ensureModel(fe, focus);
      frameMatrix(fe.M, poses[focusId]);
      var aspect = size.cw / Math.max(1, size.ch);
      camera(Object.assign({}, focus, fe.vpos), poses[focusId], fe, dt, aspect);
      main.length = 0; casters.length = 0; dynItems.length = 0;
      var deformMs = 0, deformN = 0;
      var ppos = poses[focusId].pos;
      // cars
      for (i = 0; i < snap.cars.length; i++) {
        var cc = snap.cars[i], ce = carEntry(cc), fr = poses[cc.id];
        var dcam = Math.hypot(fr.pos[0] - cam.position[0], fr.pos[1] - cam.position[1], fr.pos[2] - cam.position[2]);
        ensureModel(ce, cc);
        ensureAcc(ce, cc);
        if (ce.model._deform) {
          var dst = damageState(ce, cc, dt, dcam, cc.id === focusId), dk = damageKey(dst);
          if (dk !== ce.dkey) {
            var td0 = now();
            deformModel(ce.model, dst);
            if (ce.accDeform && ce.accDeform.length) deformParts(ce.accDeform, ce.model._dd, dst);
            ce.dkey = dk; deformMs += now() - td0; deformN++;
          }
        }
        tintCar(ce, cc);
        if (R.mode === 'hood' && cc.id === focusId) { poseCar(ce, cc, fr, dt, carLists[i] || (carLists[i] = [])); }
        else {
          var list = carLists[i] || (carLists[i] = []);
          poseCar(ce, cc, fr, dt, list);
          for (var q = 0; q < list.length; q++) { main.push(list[q]); if (list[q].castShadow && dcam < 70) casters.push(list[q]); }
        }
        carFx(cc, ce, fr, dt, dcam, byId, poses);
      }
      // arena + dynamic world bits
      for (i = 0; i < world.items.length; i++) { main.push(world.items[i]); if (world.items[i].castShadow) casters.push(world.items[i]); }
      worldDynamic(snap, byId, poses, dt);
      if (typeof world.dynamicItems === 'function') {
        try { var wd = world.dynamicItems(snap, snap.t || R.time, cam); if (wd) for (i = 0; i < wd.length; i++) { main.push(wd[i]); if (wd[i].castShadow) casters.push(wd[i]); } } catch (e7) { /* optional */ }
      }
      var dc = R.debCars || (R.debCars = []); dc.length = 0;
      for (i = 0; i < snap.cars.length; i++) { var sc = snap.cars[i]; if (sc.out) continue; var sp = poses[sc.id].pos; dc.push({ p: sp, v: [num(sc.vx, 0), 0, -num(sc.vy, 0)], sp: Math.abs(num(sc.speed, 0)) }); }
      stepDebris(dt, main);
      for (i = 0; i < dynItems.length; i++) { main.push(dynItems[i]); if (dynItems[i].castShadow) casters.push(dynItems[i]); }
      stepParticles(dt);
      var env = {
        sunDir: Lt.sunDir, sunColor: Lt.sunColor, ambientSky: Lt.ambientSky, ambientGround: Lt.ambientGround, fogColor: Lt.fogColor, fogDensity: Lt.fogDensity,
        envTop: Lt.envTop, envHorizon: Lt.envHorizon, envBottom: Lt.envBottom, exposure: Lt.exposure, time: R.time, timeOfDay: R.tod, weather: 'dry'
      };
      if (R.tod !== 'day') {
        var lights = arenaLights(ppos);
        // headlights of the nearest cars with working lights
        var near = snap.cars.filter(function (x) { return !x.out && !(x.parts && x.parts.lightFL && x.parts.lightFR); }).sort(function (A, B) { return Math.hypot(A.x - focus.x, A.y - focus.y) - Math.hypot(B.x - focus.x, B.y - focus.y); });
        for (i = 0; i < near.length && lights.length < 8; i++) {
          var lf = poses[near[i].id];
          lights.push({ pos: add(add(lf.pos, mul(lf.fwd, 2.4)), mul(lf.up, 0.7)), dir: norm(madd(lf.fwd, lf.up, -0.12)), color: [1.15, 1.08, 0.95], range: 26, cosInner: 0.94, cosOuter: 0.82, type: 1 });
          if (i >= 2) break;
        }
        // fire glow (burning cars / braziers) when room is left
        if (lights.length < 8 && world.dyn.fires.length) { var fp = world.dyn.fires[0]; lights.push({ pos: add(fp.pos, [0, 0.8, 0]), color: [4, 1.8, 0.5], range: 16, type: 0 }); }
        env.lights = lights.slice(0, 8);
      }
      if (shadow) { try { if (shadow.render(casters, { center: ppos, sunDir: Lt.sunDir, radius: 60 })) env.shadow = shadow; } catch (e2) { shadow = null; } }
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
          post.end({ bloom: true, bloomStrength: R.tod === 'night' ? 0.5 : 0.55, threshold: env.linearOutput ? (R.tod === 'night' ? 1.35 : 1.1) : (R.tod === 'night' ? 0.9 : 0.82), vignette: 0.32,
            speedBlur: focus.boosting ? 0.35 : 0, exposure: Lt.exposure, saturation: 1.1, contrast: 1.06, time: R.time });
        } catch (e6) { post = null; }
      }
      overlay2D(snap, focus);
      var ms = now() - t0;
      R.ema += (dt * 1000 - R.ema) * 0.05;
      R.stats.deformMs = deformMs; R.stats.deforms = deformN; R.stats.maxMs = Math.max(ms, num(R.stats.maxMs, 0) * 0.995); R.stats.maxDeformMs = Math.max(deformMs, num(R.stats.maxDeformMs, 0) * 0.995);
      R.stats.ms = ms; R.stats.fps = R.ema > 0 ? 1000 / R.ema : 0; R.stats.particles = PS.length; R.stats.tris = world.stats.triangles; R.stats.debris = DEB.length;
      if (opts.autoQuality !== false && R.frame > 150) {
        if (R.ema > 26) R.slowT += dt; else R.slowT = Math.max(0, R.slowT - dt);
        if (R.slowT > 3) { R.slowT = 0; var qi = ['low', 'medium', 'high', 'ultra'].indexOf(R.quality); if (qi > 0) api.setQuality(['low', 'medium', 'high', 'ultra'][qi - 1]); }
      }
    }

    /** per-car particles + accessory FX */
    function carFx(c, e, fr, dt, dcam, byId, poses) {
      var M = e.M, L = num(c.spec && c.spec.length, 4.4), H = e.dims ? e.dims.H : 1.3;
      var far = dcam > 90, lowQ = R.quality === 'low';
      var vel = [num(c.vx, 0), 0, -num(c.vy, 0)];
      // engine smoke white -> black
      var eng = c.engine || {}, smoke = Math.max(num(eng.smoke, 0), c.out ? 0.8 : 0);
      var rear = c.spec && (c.spec.enginePos === 'mid' || c.spec.enginePos === 'rear');
      var bay = xform(M, [rear ? -L * 0.3 : L * 0.3, H * 0.72, 0]);
      if (smoke > 0.05 && !far) {
        e.smokeAcc += dt * (4 + smoke * (lowQ ? 6 : 14));
        var bl = clamp01(num(eng.black, 0) + (c.out ? 0.6 : 0));
        while (e.smokeAcc > 1) {
          e.smokeAcc -= 1;
          var g = lerp(0.85, 0.06, bl);
          spawn({ p: madd(bay, [rnd() - 0.5, 0, rnd() - 0.5], 0.3), v: add(mul(vel, 0.25), [(rnd() - 0.5) * 0.6, 1.2 + smoke * 1.5 + rnd(), (rnd() - 0.5) * 0.6]), life: 1.4 + smoke * 1.6, age: 0, size: 0.35 + smoke * 0.4, grow: 0.9 + smoke, col: [g, g * 0.98, g * 0.96, 0.35 + 0.35 * smoke], add: false, g: -0.03, soft: 0.85 });
        }
      }
      // fire (body fire / engine fire / wreck)
      if (c.out) e.outT = num(e.outT, 0) + dt; else e.outT = 0;
      // wrecks: a big blaze that settles into a smouldering burnt-out shell
      var wreckFire = c.out && c.elimReason !== 'fell' ? clamp(1.1 - e.outT * 0.09, 0.18, 1) : 0;
      if (c.out && smoke < 0.9) smoke = 0.9;
      var fire = Math.max(num(c.onFire, 0), num(eng.fire, 0), wreckFire);
      if (fire > 0.05 && !far) {
        e.fireAcc += dt * (lowQ ? 12 : 40) * fire;
        while (e.fireAcc > 1) {
          e.fireAcc -= 1;
          var engineFire = num(eng.fire, 0) > num(c.onFire, 0);
          var lp = engineFire ? [rear ? -L * 0.3 : L * 0.3, H * 0.6, (rnd() - 0.5) * 0.8] : [(rnd() - 0.5) * L * 0.8, H * (0.4 + rnd() * 0.5), (rnd() - 0.5) * 1.4];
          flame(xform(M, lp), add(mul(vel, 0.6), [(rnd() - 0.5) * 0.8, 1.8 + rnd() * 2.4, (rnd() - 0.5) * 0.8]), 0.18 + fire * 0.2 + rnd() * 0.1, 0.3 + rnd() * 0.35, rnd() < 0.35 ? [2.4, 0.75, 0.15, 0.8] : [1.9, 0.9, 0.25, 0.7]);
        }
      }
      if (c.acc && c.acc.length) {
        var A = e.acc, anc = (A && A.anchors) || {}, BW = bodyW_for(e);
        c.acc.forEach(function (st) {
          if (st.id === 'flamethrower' && st.active && anc.flame && !far) {
            var tip = xform(BW, anc.flame), dir = norm(madd(fr.fwd, fr.up, -0.06));
            var n = lowQ ? 3 : 6;
            for (var k = 0; k < n; k++) {
              var sp = 15 + rnd() * 8, jx = (rnd() - 0.5) * 0.35, jy = (rnd() - 0.5) * 0.2;
              var d = norm(add(add(dir, mul(fr.right, jx)), mul(fr.up, jy)));
              flame(madd(tip, d, rnd() * 0.4 + (R.mode === 'hood' && c.id === R.focusId ? 1.6 : 0)), add(mul(d, sp), mul(vel, 0.9)), 0.16 + rnd() * 0.12, 0.42 + rnd() * 0.18, rnd() < 0.3 ? [2.4, 1.3, 0.4, 0.8] : [2.0, 0.65, 0.12, 0.75]);
            }
            if (!lowQ && rnd() < 0.4) spawn({ p: madd(tip, dir, 8), v: add(mul(dir, 4), [0, 1.5, 0]), life: 1.2, age: 0, size: 0.6, grow: 1.2, col: [0.12, 0.1, 0.09, 0.4], add: false, g: -0.05 });
          }
          if (st.id === 'magnet' && st.targetId && byId[st.targetId] && anc.magnet) {
            var m0 = xform(BW, anc.magnet), tf = poses[st.targetId], m1 = add(tf.pos, [0, 0.9, 0]);
            var segs = 7, prev = m0;
            for (var s = 1; s <= segs; s++) {
              var tt = s / segs, pnt = lerp3(m0, m1, tt);
              if (s < segs) pnt = add(pnt, [(rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.7]);
              segment(SH.cube, MAT.beam, prev, pnt, 0.07);
              prev = pnt;
            }
            if (rnd() < 0.5) sparks(m1, 2, [0, 0, 0], [1.5, 3, 5, 1], 3);
          }
          if (st.id === 'nitro' && st.active && !far) {
            var tips = anc.nitro && anc.nitro.length ? anc.nitro : [[-L / 2, 0.35, -0.35], [-L / 2, 0.35, 0.35]];
            tips.forEach(function (tp) { var w = xform(BW, tp); for (var q = 0; q < 2; q++) flame(w, add(mul(fr.fwd, -7 - rnd() * 3), mul(vel, 0.95)), 0.22, 0.09 + rnd() * 0.05, [0.7, 1.5, 4.5, 1]); });
          }
        });
      }
      // ram boost: fat blue/orange exhaust jets + a hot glow on the nose
      var ram = c.ram;
      if (ram && ram.active && !far) {
        var dmR = e.dims || { L: 4.4, W: 1.9, H: 1.3 };
        [-0.35, 0.35].forEach(function (zz) {
          var ex = xform(M, [-dmR.L / 2 - 0.05, 0.42, zz]);
          for (var q = 0; q < (lowQ ? 1 : 3); q++) flame(madd(ex, fr.fwd, -rnd() * 0.6), add(mul(fr.fwd, -10 - rnd() * 6), mul(vel, 0.94)), 0.12 + rnd() * 0.07, 0.07 + rnd() * 0.05, rnd() < 0.55 ? [0.45, 1.0, 3.2, 0.9] : [2.6, 1.0, 0.25, 0.9]);
        });
        var gl0 = dyn(SH.bubble, MAT.ramGlow || (MAT.ramGlow = { color: [1.2, 0.55, 0.18, 0.22], unlit: true, transparent: true, additive: true, depthWrite: false, castShadow: false }));
        var pr = 1 + Math.sin(R.time * 30) * 0.06;
        setTRS(gl0.model, xform(M, [dmR.L * 0.48, dmR.H * 0.4, 0]), fr.fwd, fr.up, fr.right, 0.9 * pr, dmR.H * 0.45 * pr, dmR.W * 0.62 * pr);
        if (!lowQ && rnd() < 0.5) sparks(xform(M, [dmR.L * 0.5, 0.3, (rnd() - 0.5) * dmR.W]), 2, vel, [1.5, 2.5, 5, 1], 3);
      } else if (ram && num(ram.charge, 0) > 0.98 && !far && !lowQ && rnd() < 0.15) {
        var dmC = e.dims || { L: 4.4 };
        spawn({ p: xform(M, [-dmC.L / 2, 0.42, (rnd() - 0.5) * 0.7]), v: add(mul(fr.fwd, -1.5), [0, 0.5, 0]), life: 0.2, age: 0, size: 0.05, col: [0.5, 1.1, 3, 0.8], add: true, g: 0 });
      }
      // shield bubble
      if (num(c.shield, 0) > 0 || c.invuln) {
        var it = dyn(SH.bubble, MAT.shield), pulse = 1 + Math.sin(R.time * 9) * 0.03;
        var dm = e.dims || { L: 4.4, W: 1.9, H: 1.3 };
        setTRS(it.model, add(fr.pos, mul(fr.up, dm.H * 0.45)), fr.fwd, fr.up, fr.right, dm.L * 0.62 * pulse, dm.H * 0.78 * pulse, dm.W * 0.78 * pulse);
        if (c.invuln && !(num(c.shield, 0) > 0)) it.material = MAT.shieldGhost || (MAT.shieldGhost = Object.assign({}, MAT.shield, { color: [0.6, 0.6, 0.6, 0.12] }));
      }
      // hammer impact window: a bright head flash
      if (e.hammerHead && e.hammerSwing > 0.3 && e.hammerSwing < 0.42) { var hf = dyn(SH.cube, MAT.flash); setTRS(hf.model, e.hammerHead, [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.9, 0.9, 0.9); }
    }

    function worldDynamic(snap, byId, poses, dt) {
      var D = world.dyn, t = snap.t || R.time;
      // crushers
      D.crushers.forEach(function (cr) {
        var cl = CB.derby.arenas ? CB.derby.arenas.crusherClosed(cr.h, t) : 0;
        var y = lerp(cr.top - 0.6, 1.0, cl);
        var it = dyn(world.meshes.crusherPlate, MAT.plate); it.castShadow = true;
        var c = Math.cos(cr.rot), s = Math.sin(cr.rot);
        setTRS(it.model, [cr.pos[0], y, cr.pos[2]], [c, 0, -s], [0, 1, 0], [s, 0, c], cr.hw, 1, cr.hh);
        if (cl > 0.95 && rnd() < 0.3) puff([cr.pos[0] + (rnd() - 0.5) * cr.hw * 2, 0.4, cr.pos[2] + (rnd() - 0.5) * cr.hh * 2], 1, [0.5, 0.45, 0.4, 0.4], 0.6, 1, 1);
      });
      // braziers / torches
      var fN = R.quality === 'low' ? 1 : 3;
      D.fires.forEach(function (f) { for (var k = 0; k < fN; k++) flame(madd(f.pos, [rnd() - 0.5, 0, rnd() - 0.5], f.size * 0.4), [(rnd() - 0.5) * 0.4, 1.6 + rnd() * 1.6, (rnd() - 0.5) * 0.4], 0.3 * f.size + rnd() * 0.2, 0.4 + rnd() * 0.3, null); if (rnd() < 0.1) spawn({ p: add(f.pos, [0, 1.2, 0]), v: [0, 1.6, 0], life: 2, age: 0, size: 0.4, grow: 0.8, col: [0.1, 0.09, 0.08, 0.3], add: false, g: -0.02 }); });
      if (R.quality !== 'low') D.torches.forEach(function (f) { if (rnd() < 0.6) flame(madd(f.pos, [rnd() - 0.5, 0, rnd() - 0.5], 0.08), [0, 1.2 + rnd(), 0], 0.16, 0.3, null); });
      // entities: oil, caltrops, wrecking balls
      (snap.entities || []).forEach(function (en) {
        if (en.type === 'oil') {
          var it = dyn(SH.disc, MAT.oil), r = num(en.r, 3.5) * clamp01(num(en.life, 10) / 1.5 + 0.3) * 0.85;
          setTRS(it.model, W(en.x, en.y, num(en.z, 0) + 0.02), [1, 0, 0], [0, 1, 0], [0, 0, 1], r, 1, r * 0.82);
        } else if (en.type === 'caltrops') {
          var it2 = dyn(SH.caltrops, MAT.caltrops), sc = num(en.r, 3.2) / 3.2, h = num(en.heading, 0);
          setTRS(it2.model, W(en.x, en.y, num(en.z, 0)), [Math.cos(h), 0, -Math.sin(h)], [0, 1, 0], [Math.sin(h), 0, Math.cos(h)], sc, 1, sc);
        } else if (en.type === 'ball') {
          var owner = byId[en.owner], oe = owner ? R.cars[owner.id] : null;
          var bp = W(en.x, en.y, num(en.z, 0.45));
          var bi = dyn(SH.ball, MAT.ball); bi.castShadow = true;
          setTRS(bi.model, bp, [1, 0, 0], [0, 1, 0], [0, 0, 1], 1, 1, 1);
          var ap = oe && oe.acc && oe.acc.anchors && oe.acc.anchors.hitch ? xform(bodyW_for(oe), oe.acc.anchors.hitch) : W(num(en.ax, en.x), num(en.ay, en.y), (owner ? owner.z : 0) + 0.55);
          var top = add(bp, [0, 0.5, 0]), dist = Math.sqrt(dot(sub(top, ap), sub(top, ap)));
          var sag = Math.max(0, 4.5 - dist) * 0.45 + 0.05, nL = R.quality === 'low' ? 8 : 16, prev = ap;
          for (var k = 1; k <= nL; k++) {
            var tt = k / nL, p = lerp3(ap, top, tt);
            p[1] -= sag * 4 * tt * (1 - tt);
            if (p[1] < 0.06) p[1] = 0.06;
            chainSeg(prev, p, k % 2); prev = p;
          }
        }
      });
      // explosion shockwave rings
      for (var r2 = R.rings.length - 1; r2 >= 0; r2--) {
        var rg = R.rings[r2]; rg.t += dt;
        if (rg.t > rg.dur) { R.rings.splice(r2, 1); continue; }
        var u = rg.t / rg.dur, rr = rg.r * (1 - Math.pow(1 - u, 2.4)), fa = (1 - u) * (1 - u);
        rg.mat.color[0] = 3.2 * fa; rg.mat.color[1] = 1.6 * fa; rg.mat.color[2] = 0.5 * fa; rg.mat.color[3] = fa;
        var ri = dyn(SH.ring, rg.mat);
        setTRS(ri.model, rg.p, [1, 0, 0], [0, 1, 0], [0, 0, 1], rr, 1, rr);
      }
      // flashes (hammer hits, explosions, shields)
      for (var f2 = R.flashes.length - 1; f2 >= 0; f2--) {
        var fl = R.flashes[f2]; fl.t += dt;
        if (fl.t > 0.18) { R.flashes.splice(f2, 1); continue; }
        var k2 = 1 - fl.t / 0.18, s2 = fl.s * (0.6 + fl.t * 4);
        var it3 = dyn(SH.bubble, fl.col === 'cyan' ? MAT.shield : (MAT.flashBall || (MAT.flashBall = { color: [3, 1.8, 0.7, 0.5], unlit: true, additive: true, transparent: true, depthWrite: false, castShadow: false })));
        setTRS(it3.model, fl.p, [1, 0, 0], [0, 1, 0], [0, 0, 1], s2 * k2 + 0.1, s2 * k2 + 0.1, s2 * k2 + 0.1);
      }
    }

    function overlay2D(snap, focus) {
      var c2 = canvas.getContext && canvas.getContext('2d');
      if (!c2) return;
      c2.save(); c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, canvas.width, canvas.height); c2.restore();
      void snap; void focus;
    }

    var api = {
      is3D: true, kind: 'derby',
      render: render,
      reset: function () {
        R.rig.init = false; PS.length = 0; DEB.length = 0; R.flashes.length = 0;
        R.rings.length = 0; R.cine = null;
        Object.keys(R.cars).forEach(function (k) { var e = R.cars[k]; e.prev = null; if (e.model && e.model._deform && e.dkey) { deformModel(e.model, {}); } e.seq = -1; e.dkey = null; e._dark = null; e.roof = 0; e.soot = 0; e.glass = 0; e.scrapes = []; e.wasRolled = false; e.outT = 0; });
      },
      setCamera: function (m) { if (m === 'chase-far') m = 'far'; if (m === 'tv' || m === 'heli') m = 'overhead'; if (m === 'cockpit' || m === 'bumper') m = 'hood'; if (MODES.indexOf(m) >= 0) { R.mode = m; R.rig.init = false; } return R.mode; },
      cycleCamera: function () { R.mode = MODES[(MODES.indexOf(R.mode) + 1) % MODES.length]; R.rig.init = false; return R.mode; },
      getCamera: function () { return R.mode; },
      cameraLabel: function () { return LABELS[R.mode]; },
      cameraModes: function () { return MODES.slice(); },
      setFollow: function (id) { if (id !== R.follow) { R.follow = id || null; R.rig.init = false; } return R.follow; },
      getFollow: function () { return R.follow; },
      setLookBack: function (b) { R.lookBack = !!b; },
      shake: function (amt) { if (Q.shake) R.shakeA = Math.min(2.2, R.shakeA + num(amt, 0.5)); },
      /** directional jolt in SIM ground coords (dirX, dirY) — the camera is shoved that way and springs back */
      kick: function (dx, dy, amt) {
        var l = Math.hypot(num(dx, 0), num(dy, 0)); if (!(l > 1e-6)) return;
        var a = clamp(num(amt, 0.5), 0, 2) * (Q.shake ? 1 : 0.4) * 9;
        R.kv[0] += dx / l * a; R.kv[2] += -dy / l * a; R.kv[1] += a * 0.25;
      },
      /** replay camera: {targetId?, focus [x, y, z] sim?, orbit (default true), dur s?, dist, height, fov, angle}; null ends */
      setCinematic: function (o) { R.cine = o ? Object.assign({}, o, { t: 0, base: null }) : null; if (!o) R.rig.init = false; return !!R.cine; },
      getCinematic: function () { return R.cine ? Object.assign({}, R.cine) : null; },
      resize: function () { ensureSize(); },
      getQuality: function () { return R.quality; },
      setQuality: function (q) {
        if (!QUALITY[q] || q === R.quality) return R.quality;
        R.quality = q; setupQuality(); PMAX = Q.particles;
        try { world.destroy(); } catch (e) { /* ignore */ }
        world = G.derbyArena.build(ctx, arena, { quality: q });
        return q;
      },
      setAutoQuality: function (b) { opts.autoQuality = !!b; },
      stats: function () { return Object.assign({ quality: R.quality, camera: R.mode, frame: R.frame, cars: Object.keys(R.cars).length, follow: R.follow }, R.stats); },
      getCameraState: function () { return { eye: cam.position.slice(), target: (cam.target || cam.position).slice(), up: (cam.up || [0, 1, 0]).slice(), fov: cam.fovDeg || 64, fovDeg: cam.fovDeg || 64, mode: R.mode, aspect: cam.aspect }; },
      worldToScreen: function (x, y, z) { return toScreen([x, num(z, 0), -y]); },
      toScreen: function (x, y, z) { return toScreen([x, num(z, 0), -y]); },
      camera: function () { return cam; },
      destroy: function () {
        try { world.destroy(); } catch (e) { /* ignore */ }
        Object.keys(SH).forEach(function (k) { try { SH[k].destroy(); } catch (e) { /* ignore */ } });
        Object.keys(R.cars).forEach(function (k) { var e = R.cars[k]; if (e.acc) try { e.acc.destroy(); } catch (er) { /* ignore */ } });
        if (shadow) try { shadow.destroy(); } catch (e) { /* ignore */ }
        if (post) try { post.destroy(); } catch (e) { /* ignore */ }
        if (particles) try { particles.destroy(); } catch (e) { /* ignore */ }
        if (CB.gl.car && CB.gl.car.cache && CB.gl.car.cache.clear) try { CB.gl.car.cache.clear(ctx); } catch (e) { /* ignore */ }
        if (ctx && ctx.destroy) try { ctx.destroy(); } catch (e) { /* ignore */ }
        if (glc.parentNode) glc.parentNode.removeChild(glc);
        canvas.style.background = prevBg || '';
      },
      _world: function () { return world; }, _ctx: function () { return ctx; }, _R: R
    };
    return api;
  }

  /* ================================================================== setup-garage preview (turntable) */
  function createPreview(canvas, o) {
    o = o || {};
    var G = CB.gl, M4 = G && G.mat4, DP = G && G.derbyParts;
    var stub = { ok: false, update: function () {}, destroy: function () {}, setPaused: function () {} };
    if (!canvas || !G || !G.createContext || !DP || !CB.gl.car) return stub;
    var ctx = null;
    try { ctx = G.createContext(canvas, { antialias: true, alpha: true }); } catch (e) { ctx = null; }
    if (!ctx) return stub;
    var gl = ctx.gl, S = { build: o.build || null, color: o.color, accessories: (o.accessories || []).slice(), number: num(o.number, 7), model: null, acc: null, pst: {}, angle: 0.7, raf: 0, dead: false, paused: false, last: 0, key: '', drag: null };
    var light = makeLighting(null)('day');
    var shadow = null; try { shadow = G.createShadowMap(ctx, 1024); if (shadow && shadow.ok === false) shadow = null; } catch (e) { shadow = null; }
    var g0 = new DP.Geo();
    g0.disc([0, 0, 0], 4.2, 48, [0.16, 0.16, 0.18, 1]);
    g0.disc([0, 0.003, 0], 3.6, 48, [0.22, 0.22, 0.25, 1]);
    var floor = { mesh: G.createMesh(ctx, g0.out()), material: { color: [1, 1, 1, 1], roughness: 0.4, clearcoat: 0.5, castShadow: false }, model: M4.create(), kind: 'floor' };
    var cam = { view: M4.create(), proj: M4.create(), viewProj: M4.create(), position: [0, 0, 0] };
    var items = [], M = M4.create(), bodyW = M4.create();
    function rebuild() {
      var key = JSON.stringify([S.build && S.build.meta, S.build && S.build.body, S.color, S.number]);
      if (key !== S.key || !S.model) {
        if (S.model && S.model.destroy) try { S.model.destroy(); } catch (e) { /* ignore */ }
        try { if (CB.gl.car.cache && CB.gl.car.cache.clear) CB.gl.car.cache.clear(ctx); } catch (e) { /* ignore */ }
        S.model = buildCarModel(ctx, S.build || (CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null), { number: S.number, color: S.color, lod: 'high', id: 'derby-preview', isPlayer: true });
        S.pst = {}; S.key = key;
        if (S.model && o.dents) deformModel(S.model, o.dents);
        S.accKey = null;
      }
      var ak = S.accessories.slice().sort().join(',');
      if (ak !== S.accKey && S.model) { if (S.acc) try { S.acc.destroy(); } catch (e) { /* ignore */ } S.acc = DP.build(ctx, S.accessories, S.model); S.accKey = ak; }
    }
    function size() {
      var dpr = Math.min(2, num(typeof window !== 'undefined' && window.devicePixelRatio, 1));
      var cw = Math.max(1, canvas.clientWidth || 300), ch = Math.max(1, canvas.clientHeight || 200);
      if (typeof ctx.resize === 'function') ctx.resize(cw, ch, dpr); else { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
      return { w: canvas.width, h: canvas.height, aspect: cw / ch };
    }
    function frame(t) {
      if (S.dead) return;
      S.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(frame) : 0;
      if (S.paused || ctx.lost) return;
      var dt = S.last ? clamp((t - S.last) / 1000, 0, 0.1) : 0.016; S.last = t;
      if (!S.drag) S.angle += dt * 0.35;
      rebuild();
      if (!S.model) return;
      var sz = size();
      var dm = DP.dimsOf(S.model), R0 = Math.max(5.2, dm.L * 1.25);
      var eye = [Math.cos(S.angle) * R0, 1.9 + dm.H * 0.4, Math.sin(S.angle) * R0];
      M4.lookAt(cam.view, eye, [0, dm.H * 0.45, 0], [0, 1, 0]);
      M4.perspective(cam.proj, 38 * DEG, sz.aspect, 0.1, 100);
      M4.multiply(cam.viewProj, cam.proj, cam.view);
      cam.position = eye; cam.eye = eye; cam.viewMatrix = cam.view; cam.projMatrix = cam.proj; cam.uView = cam.view; cam.uProj = cam.proj; cam.uCamPos = eye;
      items.length = 0;
      var cv = { x: 0, y: 0, heading: 0, speed: 0, steerAngle: Math.sin(t / 1400) * 0.25, brake: 0, throttle: 0, gear: 1, headlights: true, lightsOn: true, surface: 'asphalt' };
      var its = null; try { its = CB.gl.car.pose(S.model, cv, dt, S.pst); } catch (e) { its = null; }
      M4.identity(M);
      if (its) its.forEach(function (it) { items.push({ mesh: it.mesh, material: it.material, model: it.model, kind: it.kind, castShadow: true, transparent: it.transparent }); });
      var B = S.pst.bodyMatrix || IDENT16;
      M4.multiply(bodyW, M, B);
      if (S.acc) {
        S.acc.items.forEach(function (it) { items.push({ mesh: it.mesh, material: it.material, model: bodyW, kind: it.kind, castShadow: true }); });
        if (S.acc.hammer) {
          var hm = M4.create(), c = Math.cos(-0.62), s = Math.sin(-0.62), pv = S.acc.hammer.pivot;
          var R2 = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, pv[0], pv[1], pv[2], 1];
          M4.multiply(hm, bodyW, R2);
          items.push({ mesh: S.acc.hammer.mesh, material: S.acc.hammer.material, model: hm, kind: 'hammer', castShadow: true });
        }
        if (S.acc.anchors && S.acc.anchors.hitch && !S.ballMesh) S.ballMesh = G.createMesh(ctx, DP.ballGeometry());
        if (S.acc.anchors && S.acc.anchors.hitch) {
          var bm = M4.create(); bm[12] = S.acc.anchors.hitch[0] - 1.6; bm[13] = 0.45; bm[14] = 0;
          items.push({ mesh: S.ballMesh, material: { color: [1, 1, 1, 1], roughness: 0.35, metallic: 0.8 }, model: bm, kind: 'ball', castShadow: true });
        }
      }
      var casters = items.slice();
      items.push(floor);
      var env = { sunDir: norm([-0.4, 0.85, 0.35]), sunColor: [2.2, 2.1, 1.95], ambientSky: [0.55, 0.58, 0.66], ambientGround: [0.2, 0.2, 0.22], fogColor: [0.05, 0.05, 0.06], fogDensity: 0, envTop: light.envTop, envHorizon: light.envHorizon, envBottom: light.envBottom, exposure: 1.0, time: t / 1000 };
      if (shadow) { try { if (shadow.render(casters, { center: [0, 0, 0], sunDir: env.sunDir, radius: 6 })) env.shadow = shadow; } catch (e) { shadow = null; } }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, sz.w, sz.h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      try { G.drawList(ctx, items, cam, env); } catch (e) { /* ignore */ }
    }
    // drag to rotate
    function down(e) { S.drag = { x: e.clientX, a: S.angle }; }
    function move(e) { if (S.drag) S.angle = S.drag.a + (e.clientX - S.drag.x) * 0.012; }
    function up() { S.drag = null; }
    try { canvas.addEventListener('pointerdown', down); window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); } catch (e) { /* ignore */ }
    S.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(frame) : 0;
    return {
      ok: true,
      update: function (p) {
        p = p || {};
        if (p.build !== undefined) S.build = p.build;
        if (p.color !== undefined) S.color = p.color;
        if (p.number !== undefined) S.number = p.number;
        if (p.accessories) S.accessories = p.accessories.slice();
        if (p.dents && S.model) deformModel(S.model, p.dents);
      },
      setPaused: function (b) { S.paused = !!b; },
      renderOnce: function () { frame(now()); },
      destroy: function () {
        S.dead = true;
        if (S.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.raf);
        try { canvas.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); } catch (e) { /* ignore */ }
        if (S.acc) try { S.acc.destroy(); } catch (e) { /* ignore */ }
        try { if (CB.gl.car.cache && CB.gl.car.cache.clear) CB.gl.car.cache.clear(ctx); } catch (e) { /* ignore */ }
        if (shadow) try { shadow.destroy(); } catch (e) { /* ignore */ }
        try { floor.mesh.destroy(); } catch (e) { /* ignore */ }
        try { var ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) { /* ignore */ }
        if (ctx && ctx.destroy) try { ctx.destroy(); } catch (e) { /* ignore */ }
      }
    };
  }

  CB.derby.renderer = {
    isSupported: isSupported, create: create, createPreview: createPreview, MODES: MODES, LABELS: LABELS, QUALITY: QUALITY,
    _: { applyDents: applyDents, computeNormals: computeNormals, orientLike: orientLike, hammerAngle: hammerAngle, carFrame: carFrame, wheelTilt: wheelTilt, wheelCorner: wheelCorner, hash01: hash01,
      damageDims: damageDims, inPart: inPart, deformCar: deformCar, paintDamage: paintDamage, wheelSink: wheelSink, camClear: camClear, damageKey: damageKey, PARTS: PARTS }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.renderer;
})();

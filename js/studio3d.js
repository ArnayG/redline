/* ==========================================================================
   FORGE Atelier — js/studio3d.js
   CB.studio3d : the Atelier studio as a live WebGL turntable of the SAME low-poly car the game drives
   (docs/LOWPOLY-SPEC.md "Studio"). CB.render (js/render.js) hands its viewer over to this module when WebGL is
   available and keeps the SVG renderer as fallback and for thumbnails / snapshots / the spec sheet.

   API
     CB.studio3d.isSupported()                 WebGL + CB.gl + CB.lowpoly present (false in Node)
     CB.studio3d.mount(container, opts)        -> <canvas> | null. opts: {view, xray, spin, onFail(reason)}
                                               (onFail: the GPU context died for good -> caller falls back)
     CB.studio3d.update(build, metrics, spec?) re-target the car (coalesced to one rebuild per frame; geometry
                                               changes cross-fade, a model swap also eases the framing).
                                               spec = CB.render.resolve(build, metrics) (x-ray figures)
     CB.studio3d.setView(v)                    'side' | 'front' | 'rear' | 'top' (eased camera move)
     CB.studio3d.getView()
     CB.studio3d.isOrbiting()                  camera is off the preset view (turntable / drag); changes fire
                                               window 'cb:studio-orbit' {orbit, view} (+ opts.onOrbit)
     CB.studio3d.setXray(bool) / isXray()      translucent body + drivetrain / battery / CG blocks + labels
     CB.studio3d.setSpin(bool) / isSpinning()  spinning wheels (+ a rolling floor grid)
     CB.studio3d.resetCamera()                 back to the current view, default zoom, auto-rotate resumes
     CB.studio3d.setCamera({yaw, pitch, distK, hold}) exact angles (deg; same convention as lowpoly-preview.html)
     CB.studio3d.isMounted(container?)
     CB.studio3d.destroy()                     cancel the loop, drop observers / listeners / GPU resources
     CB.studio3d.stats()                       debug: {frames, builds, running, visible, triangles, view, ...}
     CB.studio3d._                             pure helpers (Node tests): VIEWS, viewAngles, shortestYaw,
                                               fitDistance, xrayLayout, featureEdges, geomSig, buildKey,
                                               parseCssColor, wheelLocal, xrPal

   Look & behaviour
     * transparent canvas over the #viewer CSS studio backdrop (theme + x-ray blueprint gradients come from
       css/styles.css); the 2D perspective grid is replaced by a 3D floor grid + light pool, a soft contact
       shadow (footprint + tyre patches) and a faded floor reflection (mirrored car, erased with distance).
     * studio rig that follows the camera: key light (sun) upper-left, cool rim light behind, faint fill.
     * slow auto-rotate (paused while interacting, resumes after a few idle seconds), drag to orbit (inertia),
       wheel / pinch to zoom, double-click to reset, view buttons snap with eased moves.
     * every geometry change cross-fades from a snapshot of the previous frame (copyTexImage2D), so paint,
       wheels, aero, ride height, model swaps and the x-ray toggle all morph smoothly.
     * idles cool: renders on demand; auto-rotate alone runs at ~30 fps; stops entirely when the Atelier is
       hidden, the tab is in the background or the viewer is scrolled off screen; reduced motion = no
       auto-rotate / tweens / fades; low-power GPU preference; DPR capped.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

(function () {
  'use strict';

  var HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  var PI = Math.PI, DEG = PI / 180;
  function num(v, d) { if (typeof v === 'string' && v.trim() !== '') v = Number(v); return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function nowMs() { return HAS_DOM && window.performance && performance.now ? performance.now() : Date.now(); }

  /* ======================================================================
     Pure helpers
     ====================================================================== */
  // camera yaw (deg) around +y: 0 = camera on +x (front), -90 = camera on -z (left side, nose to the left like
  // the SVG side view), 180 = rear. pitch in degrees above the horizon.
  var VIEWS = { side: { yaw: -90, pitch: 7 }, front: { yaw: 0, pitch: 7 }, rear: { yaw: 180, pitch: 7 }, top: { yaw: -90, pitch: 88 } };
  var VIEW_IDS = ['side', 'front', 'rear', 'top'];
  function viewAngles(v) { var a = VIEWS[v] || VIEWS.side; return { yaw: a.yaw, pitch: a.pitch }; }
  /** signed shortest angular delta (deg) from a to b, in (-180, 180] */
  function shortestYaw(a, b) { var d = ((b - a) % 360 + 540) % 360 - 180; return d === -180 ? 180 : d; }

  /**
   * Camera distance (m) that frames a car of dims {length, width, height} in a viewport of the given aspect
   * (width / height of the free stage region) with vertical FOV fovy (rad) at pitch (deg). Uses yaw-independent
   * extents so the auto-rotate never "breathes".
   */
  function fitDistance(dims, aspect, fovy, pitchDeg) {
    var L = num(dims && dims.length, 4.5), W = num(dims && dims.width, 1.9), H = num(dims && dims.height, 1.4);
    var p = clamp(num(pitchDeg, 8), 0, 90) * DEG, diag = Math.sqrt(L * L + W * W);
    var t = Math.tan(clamp(num(fovy, 0.5), 0.1, 2) / 2), asp = clamp(num(aspect, 2), 0.3, 8);
    var hHalf = diag * 0.5 * 1.02;
    var vHalf = (H * Math.cos(p) + (W + diag) * 0.5 * Math.sin(p)) * 0.5 * 1.12;
    return Math.max(hHalf / (t * asp), vHalf / t) + W * 0.55 * Math.cos(p) + H * 0.3 * Math.sin(p);
  }

  /** cheap deterministic signature of a CB.lowpoly.build result (identical geometry + colours -> same sig) */
  function geomSig(r) {
    if (!r || !r.parts) return '';
    var h = 2166136261, parts = r.parts;
    function mix(v) { h ^= Math.round(v * 4096) | 0; h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619) | 0; }
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], P = p.positions || [], C = p.colors || [];
      mix(P.length); mix(C.length); mix(i);
      var step = Math.max(1, Math.floor(P.length / 61));
      for (var k = 0; k < P.length; k += step) mix(P[k]);
      var cs = Math.max(1, Math.floor(C.length / 29));
      for (k = 0; k < C.length; k += cs) mix(C[k] * 8);
      var W = p.wheel;
      if (W) { mix(W.x); mix(W.y); mix(W.z); mix(W.r); mix(W.inset || 0); mix(W.camber || 0); }
      var M = p.material;
      if (M) { mix(num(M.metallic, 0)); mix(num(M.roughness, 0)); mix(num(M.clearcoat, 0)); }
    }
    return (h >>> 0).toString(36) + ':' + parts.length;
  }
  function buildKey(build) {
    if (!build || typeof build !== 'object') return '';
    var o = {}, k;
    for (k in build) if (Object.prototype.hasOwnProperty.call(build, k) && k !== 'meta') o[k] = build[k];
    try { return JSON.stringify(o); } catch (e) { return String(Math.random()); }
  }

  /** parse '#rgb' / '#rrggbb' / 'rgb()' / 'rgba()' -> [r, g, b, a] in 0..1 (sRGB) or null */
  function parseCssColor(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    var m;
    if (s[0] === '#') {
      var x = s.slice(1);
      if (x.length === 3 || x.length === 4) x = x.split('').map(function (c) { return c + c; }).join('');
      if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(x)) return null;
      return [parseInt(x.slice(0, 2), 16) / 255, parseInt(x.slice(2, 4), 16) / 255, parseInt(x.slice(4, 6), 16) / 255, x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1];
    }
    if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(function (v) { return /%$/.test(v) ? parseFloat(v) * 2.55 : parseFloat(v); });
      if (p.length < 3 || p.slice(0, 3).some(function (v) { return !isFinite(v); })) return null;
      var a = p.length > 3 ? (/%/.test(m[1].split(/[\s,\/]+/).filter(Boolean)[3]) ? p[3] / 255 : p[3]) : 1;
      return [clamp(p[0] / 255, 0, 1), clamp(p[1] / 255, 0, 1), clamp(p[2] / 255, 0, 1), clamp(num(a, 1), 0, 1)];
    }
    if (s === 'transparent') return [0, 0, 0, 0];
    return null;
  }
  function hexLin(hex) { var c = parseCssColor(hex) || [0.5, 0.5, 0.5, 1]; return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2), 1]; }

  /** x-ray palette (same hues as CB.render's x-ray, js/render.js xrPal) */
  function xrPal(theme) {
    var light = theme === 'light';
    return {
      line: light ? '#1f6fb2' : '#5cc8ff', soft: light ? '#3b84c4' : '#9fe0ff', eng: light ? '#c26a10' : '#ffb35c', bat: light ? '#0e9a6c' : '#3ee6a8',
      mot: light ? '#7b4cc4' : '#c48bff', fuel: light ? '#a88400' : '#ffd166', hot: light ? '#d0432a' : '#ff6b4a', text: light ? '#123a5c' : '#d9f1ff',
      bg: light ? 'rgba(255,255,255,.82)' : 'rgba(7,18,28,.78)', cg: '#ffffff'
    };
  }
  function motorSplit(d) {
    var m = clamp(Math.round(num(d.motors, 2)), 1, 4);
    if (d.drive === 'fwd') return { f: m, r: 0 };
    if (d.drive === 'rwd') return { f: 0, r: m };
    return { f: m >= 4 ? 2 : 1, r: m >= 4 ? 2 : m - 1 || 1 };
  }
  function turbosOf(d) {
    var a = d.aspiration;
    return { turbos: a === 'turbo' || a === 'electric-turbo' || a === 'twincharged' ? 1 : a === 'twin-turbo' ? 2 : a === 'quad-turbo' ? 4 : 0, blower: a === 'supercharged' || a === 'twincharged' };
  }
  function diffLabel(id) { return ({ open: 'OPEN', 'lsd-viscous': 'VLSD', 'lsd-clutch': 'LSD', 'lsd-torsen': 'TORSEN', 'e-diff': 'E-DIFF', locking: 'LOCKER', none: '' })[id] || String(id || '').toUpperCase(); }

  /**
   * Pure x-ray layout in car-local metres (CB.lowpoly frame: +x forward, y up, z right, origin = centre of the
   * overall length on the ground). dims = CB.lowpoly.build(...).dims, spec = CB.render.resolve(build, metrics).
   * -> { blocks:[{shape:'box'|'rod'|'cylZ'|'cylY'|'sphere', c?, s?, p0?, p1?, r?, tone}], labels:[{text, p, tone}],
   *      cg:[x,y,z] }. tone is a key of xrPal().
   */
  function xrayLayout(dims, spec) {
    var D = dims || {}, n = (spec && spec.n) || {}, d = (spec && spec.d) || {};
    var L = num(D.length, 4.5), Wd = num(D.width, 1.85), Hh = num(D.height, 1.35);
    var FA = num(D.frontAxle, L * 0.28), RA = num(D.rearAxle, -L * 0.25), wb = Math.max(1.2, FA - RA);
    var rF = num(D.wheelRadiusFront, num(D.wheelRadius, 0.33)), rR = num(D.wheelRadiusRear, num(D.wheelRadius, 0.33));
    var ride = clamp(num(D.rideHeight, 0.13), 0.03, 0.4), track = num(D.track, Wd - 0.25);
    var belt = clamp(num(D.belt, Hh * 0.7), ride + 0.3, Hh), deck = clamp(num(D.deck, belt), ride + 0.25, Hh);
    var blocks = [], labels = [];
    var y0 = ride + 0.1;
    function box(c, s, tone) { blocks.push({ shape: 'box', c: c, s: s, tone: tone }); }
    function rod(p0, p1, r, tone) { blocks.push({ shape: 'rod', p0: p0, p1: p1, r: r, tone: tone }); }
    function lab(text, p, tone) { if (text) labels.push({ text: String(text), p: p, tone: tone }); }
    var engType = d.engType || 'ice', position = d.position || 'front', drive = d.drive || 'rwd';
    var engF = 0, engR = 0, gbF = 0, gbR = 0, top = 0;
    if (engType !== 'ev') {
      var len = clamp(num(n.engLen, 600) / 1000 * (drive === 'fwd' && d.config === 'inline' && position === 'front' ? 0.62 : 1), 0.3, 1.2);
      var eh = d.config === 'flat' ? 0.42 : d.config === 'rotary' ? 0.38 : d.config === 'inline' ? 0.6 : 0.56;
      var limit = position === 'front' ? belt * 0.96 - 0.05 : position === 'mid' ? belt - 0.08 : deck - 0.06;
      eh = clamp(Math.min(eh, limit - y0), 0.18, 0.62);
      var ew = Math.min(track * 0.6, d.config === 'inline' ? 0.5 : d.config === 'rotary' ? 0.5 : d.config === 'flat' ? 0.82 : d.config === 'w' ? 0.8 : 0.72);
      if (position === 'mid') { engR = RA + rR * 0.2 + 0.16; engF = engR + len; }
      else if (position === 'rear') { engF = RA + len * 0.15; engR = engF - len; }
      else { engF = FA + len * 0.18; engR = engF - len; }
      var ecx = (engF + engR) / 2;
      top = y0 + eh;
      box([ecx, y0 + eh * 0.42, 0], [len, eh * 0.84, ew * 0.72], 'eng');
      // cylinder heads / pots
      var rows = d.config === 'inline' ? 1 : d.config === 'w' ? 2 : d.config === 'rotary' ? 0 : 2;
      var cyl = clamp(Math.round(num(d.cyl, 8)), 1, 16);
      if (rows) {
        var per = Math.ceil(cyl / rows), pr = clamp(len / (per + 0.6) * 0.32, 0.025, 0.06);
        for (var rr = 0; rr < rows; rr++) {
          for (var k = 0; k < per; k++) {
            var cx = engR + len * (k + 0.5 + (rr ? 0.15 : 0)) / (per + 0.2);
            if (d.config === 'flat') {
              var zs = rr ? 1 : -1;
              blocks.push({ shape: 'cylZ', c: [cx, y0 + eh * 0.45, zs * (ew * 0.36 + 0.06)], r: pr, h: 0.12, tone: 'eng' });
            } else {
              var zc = rows === 2 ? (rr ? 1 : -1) * ew * 0.24 : 0;
              blocks.push({ shape: 'cylY', c: [cx, y0 + eh * 0.84 + 0.05, zc], r: pr, h: 0.1, tone: 'eng' });
            }
          }
        }
      } else {
        for (var ro = 0; ro < Math.max(1, num(d.rotors, 2)); ro++) blocks.push({ shape: 'cylZ', c: [lerp(engR, engF, (ro + 0.5) / Math.max(1, num(d.rotors, 2))), y0 + eh * 0.45, 0], r: eh * 0.36, h: ew * 0.74, tone: 'eng' });
      }
      var tb = turbosOf(d);
      for (var ti = 0; ti < tb.turbos; ti++) blocks.push({ shape: 'sphere', c: [position === 'front' ? engR + 0.12 + ti * 0.05 : engF - 0.12 - ti * 0.05, y0 + eh * 0.45, (ti % 2 ? -1 : 1) * (ew * 0.36 + 0.09)], r: 0.075, tone: 'hot' });
      if (tb.blower) box([ecx, top + 0.04, 0], [len * 0.55, 0.1, ew * 0.4], 'hot');
      lab(String(d.layout || '') + ' ' + num(n.disp, 0).toFixed(1) + ' L ' + String(d.aspiration || '').toUpperCase() + (n.hp ? ' · ' + Math.round(n.hp) + ' HP' : ''), [ecx, top + 0.14, 0], 'eng');
      // gearbox
      if (position === 'front') { gbF = drive === 'fwd' ? engR + 0.04 : engR; gbR = gbF - (drive === 'fwd' ? 0.26 : 0.52); }
      else if (position === 'mid') { gbF = engR; gbR = Math.min(engR - 0.38, RA - 0.22); }
      else { gbR = engF; gbF = Math.max(engF + 0.42, RA + 0.38); }
      var gh = d.trans === 'cvt' || d.trans === 'single-speed' ? 0.24 : 0.3;
      box([(gbF + gbR) / 2, y0 + 0.02 + gh / 2, 0], [Math.abs(gbF - gbR), gh, 0.34], 'soft');
      lab((num(d.gears, 0) > 1 ? d.gears + '-SPD ' : '') + String(d.trans || '').toUpperCase(), [(gbF + gbR) / 2, y0 + gh + 0.1, 0], 'soft');
      // hybrid motor + pack
      if (engType === 'hybrid') {
        blocks.push({ shape: 'cylZ', c: [position === 'front' ? engR : engF, y0 + 0.2, 0], r: 0.13, h: 0.3, tone: 'mot' });
        var hx = RA + rR + 0.32;
        box([hx, ride + 0.14, 0], [0.52, 0.18, track * 0.55], 'bat');
        lab(num(n.kwh, 0).toFixed(1) + ' kWh', [hx, ride + 0.3, 0], 'bat');
      }
      // exhaust
      if (d.tipStyle !== 'none') {
        var ex0 = [position === 'front' ? engR + 0.15 : ecx, y0 + eh * 0.3, 0.22], exU = [Math.min(ex0[0], RA + rR + 0.5) - 0.1, ride + 0.07, 0.3];
        var exT = [-L / 2 + 0.12, ride + 0.12, 0.42];
        if (position !== 'front') exU = [ecx - 0.2, ride + 0.1, 0.3];
        rod(ex0, exU, 0.028, 'hot'); rod(exU, exT, 0.028, 'hot');
        box([-L / 2 + 0.45, ride + 0.12, 0.3], [0.36, 0.12, 0.3], 'hot');
      }
      // fuel tank
      var tw = clamp(num(n.tank, 60) * 9 / 1000, 0.38, 0.9), tx = position === 'mid' ? FA - rF - 0.12 - tw / 2 : RA + rR + 0.06 + tw / 2;
      if (engType === 'hybrid' && position !== 'mid') tx = Math.max(tx, RA + rR + 0.6 + tw / 2);
      box([tx, ride + 0.16, 0], [tw, 0.2, Math.min(0.75, track * 0.5)], 'fuel');
      lab(Math.round(num(n.tank, 0)) + ' L ' + String(d.fuel || '').toUpperCase(), [tx, ride + 0.34, 0], 'fuel');
    } else {
      // EV: floor battery modules + motors at the axles
      var bx0 = FA - rF * 0.85, bx1 = RA + rR * 0.85, bth = clamp(0.09 + num(n.kwh, 80) * 0.00055, 0.1, 0.21);
      var mods = clamp(Math.round(num(n.kwh, 80) / 7), 4, 30), mw = (bx0 - bx1) / mods;
      for (var mi = 0; mi < mods; mi++) box([bx0 - mw * (mi + 0.5), ride + 0.03 + bth / 2, 0], [mw - 0.012, bth, track * 0.78], 'bat');
      lab(Math.round(num(n.kwh, 0)) + ' kWh ' + String(d.chem || '').toUpperCase() + ' · ' + Math.round(num(d.voltage, 0)) + ' V', [(bx0 + bx1) / 2, ride + bth + 0.16, 0], 'bat');
      var ms = motorSplit(d);
      [[FA, rF, ms.f], [RA, rR, ms.r]].forEach(function (a) {
        for (var q = 0; q < a[2]; q++) blocks.push({ shape: 'cylZ', c: [a[0] + (a[0] > 0 ? -0.08 : 0.08), a[1] + 0.02, a[2] > 1 ? (q ? 0.19 : -0.19) : 0], r: 0.13, h: a[2] > 1 ? 0.3 : 0.38, tone: 'mot' });
        if (a[2]) lab(a[2] + ' × ' + Math.round(num(n.motorKw, 0)) + ' kW', [a[0], a[1] + 0.26, 0], 'mot');
      });
      gbF = FA; gbR = RA; engR = FA; engF = FA;
    }
    // driveshafts, half-shafts, diffs
    var shY = ride + 0.15;
    if (engType !== 'ev') {
      if (position === 'front' && drive !== 'fwd') rod([gbR, shY + 0.04, 0], [RA, rR, 0], 0.03, 'line');
      if (drive === 'awd' && position === 'front') rod([gbF - 0.06, shY, 0.1], [FA, rF, 0], 0.03, 'line');
      if (drive === 'awd' && position !== 'front') rod([Math.max(gbF, engF), shY, 0], [FA, rF, 0], 0.03, 'line');
      if (drive === 'awd') box([position === 'front' ? gbR : engF + 0.05, shY, 0], [0.14, 0.1, 0.16], 'line');
    }
    var fDriven = drive !== 'rwd', rDriven = drive !== 'fwd';
    [[FA, rF, fDriven, d.frontDiff, 'front'], [RA, rR, rDriven, d.rearDiff, 'rear']].forEach(function (a) {
      var tz = track / 2 - 0.12;
      if (a[2]) {
        rod([a[0], a[1], -tz], [a[0], a[1], tz], 0.022, 'line');
        blocks.push({ shape: 'sphere', c: [a[0], a[1], 0], r: 0.09, tone: 'line' });
        if (engType !== 'ev' && a[3]) lab(diffLabel(a[3]) + (d.tv ? ' + TV' : ''), [a[0], a[1] - 0.17, 0], 'line');
      }
    });
    // radiator, 12 V battery
    var radH = clamp((d.cooling === 'race' ? 0.42 : d.cooling === 'uprated' ? 0.36 : 0.3), 0.15, Math.max(0.15, belt * 0.85 - ride - 0.1));
    box([L / 2 - 0.32, ride + 0.08 + radH / 2, 0], [0.05, radH, Math.min(0.75, track * 0.55)], 'line');
    var b12 = position === 'front' && engType !== 'ev' ? [FA - rF * 0.3 - 0.12, Math.min(belt * 0.8, ride + 0.42), track * 0.3] : [-L / 2 + 0.6, ride + 0.3, -track * 0.28];
    box(b12, [0.24, 0.17, 0.17], d.battery12 === 'lithium' ? 'bat' : 'soft');
    // centre of gravity + weight split
    var wf = clamp(num(n.wf, 50), 15, 85) / 100, cgx = FA - wb * (1 - wf), cgy = clamp(num(n.cgH, 500) / 1000, 0.15, Hh * 0.9);
    var cg = [cgx, cgy, 0];
    blocks.push({ shape: 'sphere', c: cg, r: 0.075, tone: 'cg' });
    rod([cgx, 0.004, 0], [cgx, cgy - 0.07, 0], 0.006, 'line');
    blocks.push({ shape: 'cylY', c: [cgx, 0.004, 0], r: 0.16, h: 0.004, tone: 'line' });
    lab('CG ' + Math.round(num(n.cgH, cgy * 1000)) + ' mm', [cgx, cgy + 0.17, 0], 'text');
    var mass = num(n.mass, 0);
    lab('F ' + (wf * 100).toFixed(1) + '%' + (mass ? '  ' + Math.round(mass * wf) + ' kg' : ''), [FA, 0.02, 0], 'text');
    lab('R ' + (100 - wf * 100).toFixed(1) + '%' + (mass ? '  ' + Math.round(mass * (1 - wf)) + ' kg' : ''), [RA, 0.02, 0], 'text');
    return { blocks: blocks, labels: labels, cg: cg };
  }

  /**
   * Feature edges of a triangle mesh (flat-shaded, unwelded): edges between faces whose normals differ by
   * more than acos(cosT), plus open boundary edges. -> Float32Array of line-segment endpoints (xyz xyz ...).
   */
  function featureEdges(P, I, cosT) {
    if (!P || !P.length) return new Float32Array(0);
    var nv = P.length / 3, idx = I && I.length ? I : null, nt = idx ? idx.length / 3 : nv / 3;
    cosT = num(cosT, Math.cos(28 * DEG));
    var map = Object.create(null), list = [];
    function vk(i) { return Math.round(P[i * 3] * 5000) + ',' + Math.round(P[i * 3 + 1] * 5000) + ',' + Math.round(P[i * 3 + 2] * 5000); }
    for (var t = 0; t < nt; t++) {
      var a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      var ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
      var wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
      var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(l > 1e-12)) continue;
      nx /= l; ny /= l; nz /= l;
      var ks = [vk(a), vk(b), vk(c)], vs = [a, b, c];
      for (var e = 0; e < 3; e++) {
        var k0 = ks[e], k1 = ks[(e + 1) % 3];
        if (k0 === k1) continue;
        var key = k0 < k1 ? k0 + '|' + k1 : k1 + '|' + k0, rec = map[key];
        if (!rec) { rec = map[key] = { i: vs[e], j: vs[(e + 1) % 3], n: [nx, ny, nz], c: 1, sharp: false }; list.push(rec); }
        else { rec.c++; if (rec.n[0] * nx + rec.n[1] * ny + rec.n[2] * nz < cosT) rec.sharp = true; }
      }
    }
    var out = [];
    for (var q = 0; q < list.length; q++) {
      var r = list[q];
      if (r.c === 1 || r.sharp) out.push(P[r.i * 3], P[r.i * 3 + 1], P[r.i * 3 + 2], P[r.j * 3], P[r.j * 3 + 1], P[r.j * 3 + 2]);
    }
    return new Float32Array(out);
  }

  /** local wheel frame T(px,py,pz) * Rx(camber) * Rz(spin) (same convention as CB.gl.car, no steer) */
  function wheelLocal(o, px, py, pz, camber, spin) {
    var cx = Math.cos(camber), sx = Math.sin(camber), cz = Math.cos(spin), sz = Math.sin(spin);
    o[0] = cz; o[1] = sz * cx; o[2] = sz * sx; o[3] = 0;
    o[4] = -sz; o[5] = cz * cx; o[6] = cz * sx; o[7] = 0;
    o[8] = 0; o[9] = -sx; o[10] = cx; o[11] = 0;
    o[12] = px; o[13] = py; o[14] = pz; o[15] = 1;
    return o;
  }

  /** true when the camera has left the chosen preset view (turntable / drag / inertia / setCamera); a tween
      heading back to a view counts as on-view so the view button lights up the moment it is pressed. */
  function isOrbiting(cam, view, tweening) {
    if (tweening || !cam) return false;
    var a = viewAngles(view);
    return Math.abs(shortestYaw(num(cam.yaw, a.yaw), a.yaw)) > 3 || Math.abs(num(cam.pitch, a.pitch) - a.pitch) > 3;
  }

  var _ = {
    isOrbiting: isOrbiting,
    VIEWS: VIEWS, VIEW_IDS: VIEW_IDS, viewAngles: viewAngles, shortestYaw: shortestYaw, fitDistance: fitDistance, geomSig: geomSig,
    buildKey: buildKey, parseCssColor: parseCssColor, xrPal: xrPal, xrayLayout: xrayLayout, featureEdges: featureEdges, wheelLocal: wheelLocal,
    easeInOut: easeInOut, motorSplit: motorSplit, stageDpr: function (cw, ch, dev) { return stageDpr(cw, ch, dev); }
  };

  /* ======================================================================
     Live controller (browser only)
     ====================================================================== */
  var G = null, M4 = null;
  var FOV_FREE = 27 * DEG;           // vertical FOV of the free stage region (long lens = product-shot look)
  var AUTO_SPEED = 7;                // deg / s
  var IDLE_RESUME = 6000;            // ms of no interaction before the turntable resumes
  var PX_BUDGET = 3.2e6;             // drawing-buffer pixels (2x of a 1265 x 632 stage)
  var SPIN_MAX = 15.7;               // rad / s (~2.5 rev/s, like the SVG viewer)
  var st = null;
  var supportCache = null;

  function isSupported() {
    if (!HAS_DOM) return false;
    if (!CB.gl || typeof CB.gl.createContext !== 'function' || !CB.gl.mat4 || typeof CB.gl.drawList !== 'function') return false;
    if (!CB.lowpoly || typeof CB.lowpoly.build !== 'function') return false;
    if (supportCache !== null) return supportCache;
    supportCache = typeof CB.gl.isSupported === 'function' ? !!CB.gl.isSupported() : true;
    return supportCache;
  }

  var CSS = [
    '.cb-s3d-host{touch-action:pan-y}',
    '.cb-s3d-canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;cursor:grab;touch-action:pan-y;outline:none;-webkit-tap-highlight-color:transparent;transition:opacity .2s}',
    '.cb-s3d-canvas.is-drag{cursor:grabbing}',
    '.cb-s3d .viewer-env{opacity:0 !important}',
    '.cb-s3d-labels{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;opacity:0;transition:opacity .35s ease}',
    '.cb-s3d-labels.is-on{opacity:1}',
    '.cb-s3d-lab{position:absolute;left:0;top:0;white-space:nowrap;font:600 9.5px/1.25 var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);letter-spacing:.05em;padding:2px 6px;border-radius:4px;' +
      'border:1px solid currentColor;will-change:transform}',
    '.cb-s3d-hint{position:absolute;right:16px;top:12px;font:600 9.5px/1 var(--mono,ui-monospace,Menlo,monospace);letter-spacing:.2em;text-transform:uppercase;color:var(--text-faint,#777);' +
      'pointer-events:none;opacity:0;transition:opacity .6s ease;z-index:3}',
    '.cb-s3d-hint.is-on{opacity:.75}',
    '@media (hover:none){.cb-s3d-hint .k-mouse{display:none}}',
    '@media (hover:hover){.cb-s3d-hint .k-touch{display:none}}',
    '@media (prefers-reduced-motion:reduce){.cb-s3d-labels,.cb-s3d-hint,.cb-s3d-canvas{transition:none}}',
    '@media print{.cb-s3d-hint{display:none}}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('cb-s3d-style')) return;
    var s = document.createElement('style');
    s.id = 'cb-s3d-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------------- shaders (GLSL ES 1.0 dialect, CB.gl.preprocess makes them WebGL2-ready) */
  var FLOOR_VS = [
    'attribute vec3 aPos;',
    'uniform mat4 uViewProj;',
    'varying vec3 vW;',
    'void main() { vW = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); }'
  ].join('\n');
  var FLOOR_FS = [
    'varying vec3 vW;',
    'uniform float uMode;',          // 0 = reflection erase (WebGL fallback path), 1 = floor (reflection + pool + grid + contact shadow)
    'uniform vec4 uFoot;',           // half length, half width, centre x, reflection strength
    'uniform vec4 uWheel[4];',       // x, z, radius x, radius z
    'uniform vec4 uShadow;',         // rgb, strength
    'uniform vec4 uGrid;',           // rgb (sRGB), alpha
    'uniform vec4 uPool;',           // rgb, alpha
    'uniform vec2 uGridOff;',
    'uniform vec4 uEye;',            // camera position xyz, 1 = blurred reflection textures bound
    'uniform vec2 uInvRes;',         // 1 / drawing buffer size
    'uniform sampler2D uRefl;',      // mirrored car, half res
    'uniform sampler2D uReflBlur;',  // same, blurred (quarter res)
    'float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }',
    'void main() {',
    '  vec2 p = vW.xz - vec2(uFoot.z, 0.0);',
    '  float d = sdBox(p, uFoot.xy, 0.35);',
    '  if (uMode < 0.5) {',
    '    float keep = uFoot.w * (1.0 - smoothstep(-0.9, 1.1, d));',
    '    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0 - keep);',
    '    return;',
    '  }',
    // contact shadow: a wide soft penumbra, a tight occlusion core under the sills and a dark patch under every tyre
    '  float s = 0.3 * (1.0 - smoothstep(-0.5, 1.7, d)) + 0.45 * (1.0 - smoothstep(-0.5, 0.16, d)) + 0.22 * (1.0 - smoothstep(-0.25, 0.02, d));',
    '  for (int i = 0; i < 4; i++) {',
    '    vec2 q = (vW.xz - uWheel[i].xy) / max(uWheel[i].zw, vec2(0.01));',
    '    float l = length(q);',
    '    s += 0.35 * (1.0 - smoothstep(0.2, 1.05, l)) + 0.55 * (1.0 - smoothstep(0.05, 0.42, length(q * vec2(1.35, 1.0))));',
    '  }',
    '  s = clamp(s * uShadow.w, 0.0, 0.94);',
    '  float r = length(vW.xz * vec2(0.62, 1.0));',
    '  float pool = uPool.a * (1.0 - smoothstep(0.0, 5.2, r));',
    '  vec2 g = vW.xz + uGridOff;',
    '  vec2 gd = abs(fract(g - 0.5) - 0.5);',
    '#ifdef HAS_DERIVATIVES',
    '  vec2 fw = max(fwidth(g), vec2(1e-4));',
    '  vec2 lw = 1.0 - smoothstep(fw * 0.5, fw * 1.5, gd);',
    '  float fade = 1.0 - smoothstep(0.05, 0.22, max(fw.x, fw.y));',
    '#else',
    '  vec2 lw = 1.0 - smoothstep(0.006, 0.02, gd);',
    '  float fade = 1.0;',
    '#endif',
    '  float grid = uGrid.a * max(lw.x, lw.y) * fade * (1.0 - smoothstep(1.4, 6.2, r));',
    '  vec3 col = vec3(0.0); float a = 0.0;',
    '  if (uEye.w > 0.5) {',
    // glossy floor: depth of the reflected point below the floor ~ distance still to travel to the car footprint times the
    // view ray's slope; reflections are crisp at the tyres and sills and blur + fade towards the mirrored roof
    '    float hz = max(d, 0.0) * uEye.y / max(length(vW.xz - uEye.xz), 0.25);',
    '    vec2 suv = gl_FragCoord.xy * uInvRes;',
    '    vec4 rs = texture2D(uRefl, suv), rb = texture2D(uReflBlur, suv);',
    '    vec4 rf = mix(rb, rs, (1.0 - smoothstep(0.02, 0.32, hz)) * 0.75);',
    '    float rk = uFoot.w * (1.0 - smoothstep(0.0, 1.6, hz)) * (1.0 - smoothstep(4.0, 9.0, r));',
    '    col = rf.rgb * rk; a = rf.a * rk;',
    '  }',
    '  col = col * (1.0 - pool) + uPool.rgb * pool; a = a * (1.0 - pool) + pool;',
    '  col = col * (1.0 - grid) + uGrid.rgb * grid; a = a * (1.0 - grid) + grid;',
    // the shadow darkens the floor; over the reflection it only half applies (the mirrored sills / tyres are already dark)
    '  vec3 base = col; float ba = a;',
    '  col = col * (1.0 - s) + uShadow.rgb * s;',
    '  a = a * (1.0 - s) + s;',
    '  col = mix(col, base * (1.0 - s * 0.5) + uShadow.rgb * s * 0.5 * (1.0 - ba), ba * 0.6);',
    '  a = mix(a, ba * (1.0 - s * 0.5) + s * 0.5 * (1.0 - ba) + s * 0.5, ba * 0.6);',
    '  gl_FragColor = vec4(col, a);',
    '}'
  ].join('\n');
  // 9-tap Gaussian in 5 bilinear fetches (separable: run once along x, once along y)
  var BLUR_FS = [
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uDir;',
    'void main() {',
    '  vec4 c = texture2D(uTex, vUv) * 0.2270270270;',
    '  c += (texture2D(uTex, vUv + uDir * 1.3846153846) + texture2D(uTex, vUv - uDir * 1.3846153846)) * 0.3162162162;',
    '  c += (texture2D(uTex, vUv + uDir * 3.2307692308) + texture2D(uTex, vUv - uDir * 3.2307692308)) * 0.0702702703;',
    '  gl_FragColor = c;',
    '}'
  ].join('\n');
  var COPY_VS = [
    'attribute vec3 aPos;',
    'varying vec2 vUv;',
    'void main() { vUv = aPos.xy * 0.5 + 0.5; gl_Position = vec4(aPos.xy, 0.0, 1.0); }'
  ].join('\n');
  var COPY_FS = [
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform float uAlpha;',
    'void main() { gl_FragColor = texture2D(uTex, vUv) * uAlpha; }'
  ].join('\n');

  /* ---------------- theme */
  function readTheme() {
    var root = document.documentElement, theme = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    var cs = null;
    try { cs = window.getComputedStyle(root); } catch (e) { cs = null; }
    function v(name, fb) { var c = cs ? parseCssColor(cs.getPropertyValue(name)) : null; return c || parseCssColor(fb); }
    var light = theme === 'light';
    var grid = v('--studio-grid', light ? 'rgba(30,24,12,.075)' : 'rgba(255,255,255,.06)');
    var spot = v('--studio-spot', light ? 'rgba(255,255,255,.95)' : 'rgba(201,165,107,.13)');
    return {
      theme: theme, pal: xrPal(theme),
      grid: [grid[0], grid[1], grid[2], Math.min(0.24, grid[3] * 0.85)],
      pool: [spot[0], spot[1], spot[2], Math.min(0.6, spot[3] * (light ? 0.35 : 0.9))],
      shadow: light ? [0.2, 0.16, 0.08, 0.62] : [0, 0, 0, 0.95],
      refl: light ? 0.26 : 0.42,
      env: light ? {
        ambientSky: [0.5, 0.52, 0.56], ambientGround: [0.24, 0.23, 0.2], envTop: [0.45, 0.5, 0.6], envHorizon: [0.72, 0.72, 0.7], envBottom: [0.3, 0.29, 0.26],
        sun: [1.35, 1.3, 1.18], rim: [1.4, 1.5, 1.7], fill: [0.35, 0.35, 0.37], exposure: 0.92,
        studio: [0.8, 0.95, 0.22, 0]
      } : {
        ambientSky: [0.4, 0.44, 0.52], ambientGround: [0.17, 0.16, 0.14], envTop: [0.34, 0.4, 0.52], envHorizon: [0.42, 0.43, 0.46], envBottom: [0.05, 0.05, 0.055],
        sun: [1.3, 1.24, 1.12], rim: [1.7, 1.8, 2.1], fill: [0.35, 0.37, 0.42], exposure: 0.92,
        // softbox studio reflections (gl-core studioEnv): strength, room brightness, floor bounce
        studio: [1, 0.4, 0.05, 0]
      }
    };
  }

  /* ---------------- mount / destroy */
  function mount(container, opts) {
    if (!HAS_DOM || !container) return null;
    if (st && st.host === container && container.contains(st.canvas)) return st.canvas;
    if (st) destroy();
    if (!isSupported()) return null;
    G = CB.gl; M4 = G.mat4;
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'cb-s3d-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3D studio view of the car');
    var ctx = null;
    try { ctx = G.createContext(canvas, { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power', preserveDrawingBuffer: false }); }
    catch (e) { ctx = null; }
    if (!ctx) return null;
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e2) { reduce = false; }
    var t = nowMs(), v0 = VIEW_IDS.indexOf(opts.view) >= 0 ? opts.view : 'side', a0 = viewAngles(v0);
    st = {
      host: container, canvas: canvas, ctx: ctx, gl: ctx.gl, opts: opts, reduce: reduce, dead: false,
      view: v0, cam: { yaw: a0.yaw, pitch: a0.pitch, distK: 1 }, tween: null,
      auto: { on: !reduce, resumeAt: t + 2200, speed: 0 }, drag: null, pointers: {}, pinch: null, inertia: 0,
      car: null, dimsShown: null, dimsFrom: null, dimsTo: null, dimsT0: 0,
      pendingBuild: null, pendingMetrics: null, pendingSpec: null, lastBuild: null, lastMetrics: null, spec: null, key: '',
      xray: !!opts.xray, xr: null, xrKey: '', spin: { on: !!opts.spin, speed: 0, angle: 0, travel: 0 },
      fade: null, snapTex: null, raf: 0, last: 0, lastDraw: 0, dirty: true, visible: true, shownCache: true,
      frames: 0, builds: 0, theme: readTheme(), pad: { t: 30, b: 58 }, timers: [], listeners: [], ro: null, io: null, mo: null,
      lostAt: 0, hintShown: false
    };
    injectCss();
    container.classList.add('cb-s3d-host');
    var viewerEl = container.closest ? container.closest('#viewer') : null;
    st.viewerEl = viewerEl || container.parentElement || container;
    st.viewerEl.classList.add('cb-s3d');
    container.appendChild(canvas);
    st.labelsEl = document.createElement('div');
    st.labelsEl.className = 'cb-s3d-labels';
    st.labelsEl.setAttribute('aria-hidden', 'true');
    container.appendChild(st.labelsEl);
    st.hintEl = document.createElement('div');
    st.hintEl.className = 'cb-s3d-hint';
    st.hintEl.setAttribute('aria-hidden', 'true');
    st.hintEl.innerHTML = '<span class="k-mouse">Drag · Scroll · Double-click</span><span class="k-touch">Swipe · Pinch · Double-tap</span>';
    container.appendChild(st.hintEl);
    try { initGPU(); }
    catch (e3) { try { console.warn('[studio3d] GPU init failed', e3); } catch (e4) { /* ignore */ } destroy(); return null; }
    bindEvents();
    measure();
    scheduleResume();
    // first build: the state the app will push next anyway (avoids an empty first frame)
    if (CB.state && typeof CB.state.get === 'function') {
      try { var b = CB.state.get(); if (b) st.pendingBuild = b; } catch (e5) { /* ignore */ }
    }
    st.hintTimer = setTimeout(function () { if (st && st.hintEl && !st.hintShown) { st.hintEl.classList.add('is-on'); st.hintTimer = setTimeout(function () { if (st && st.hintEl) st.hintEl.classList.remove('is-on'); }, 5200); } }, 1400);
    wake();
    return canvas;
  }

  function initGPU() {
    var ctx = st.ctx;
    st.progFloor = G.createProgram(ctx, FLOOR_VS, FLOOR_FS, { name: 'studio-floor' });
    st.progCopy = G.createProgram(ctx, COPY_VS, COPY_FS, { name: 'studio-copy' });
    try { st.progBlur = G.createProgram(ctx, COPY_VS, BLUR_FS, { name: 'studio-blur' }); } catch (e) { st.progBlur = null; }
    st.rt = null; st.rtFailed = !st.progBlur || typeof G.createRenderTarget !== 'function';
    var S = 40;
    st.floorMesh = G.createMesh(ctx, { positions: new Float32Array([-S, 0, -S, S, 0, -S, S, 0, S, -S, 0, S]), indices: new Uint16Array([0, 2, 1, 0, 3, 2]) }, { computeNormals: false });
    st.triMesh = G.createMesh(ctx, { positions: new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]) }, { computeNormals: false });
    st.snapTex = null;
  }
  function dropGPU(lost) {
    if (!st) return;
    if (st.car) destroyEntry(st.car, lost);
    st.car = null;
    if (st.xr) destroyXr(st.xr, lost);
    st.xr = null; st.xrKey = '';
    if (!lost) {
      try { if (st.floorMesh) st.floorMesh.destroy(); if (st.triMesh) st.triMesh.destroy(); } catch (e) { /* ignore */ }
      try { if (st.snapTex) st.gl.deleteTexture(st.snapTex); } catch (e2) { /* ignore */ }
    }
    if (st.rt && !lost) { ['a', 'b', 'c'].forEach(function (k) { try { st.rt[k].destroy(); } catch (e5) { /* ignore */ } }); }
    st.rt = null;
    if (st.probe && !lost) { try { st.probe.destroy(); } catch (e3) { /* ignore */ } }
    st.probe = null; st.probeKey = ''; st.probeFailed = false;
    st.floorMesh = st.triMesh = st.snapTex = null; st.fade = null;
  }

  function destroy() {
    if (!st) return;
    if (st.orbit) syncOrbit(false);
    var s = st;
    s.dead = true;
    if (s.raf) { try { window.cancelAnimationFrame(s.raf); } catch (e) { /* ignore */ } }
    s.raf = 0;
    clearTimeout(s.hintTimer); clearTimeout(s.resumeTimer); clearTimeout(s.lostTimer);
    s.listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) { /* ignore */ } });
    s.listeners = [];
    try { if (s.ro) s.ro.disconnect(); } catch (e1) { /* ignore */ }
    try { if (s.io) s.io.disconnect(); } catch (e2) { /* ignore */ }
    try { if (s.mo) s.mo.disconnect(); } catch (e3) { /* ignore */ }
    try { dropGPU(!!(s.ctx && s.ctx.isLost && s.ctx.isLost())); } catch (e4) { /* ignore */ }
    try { s.ctx.destroy(); } catch (e5) { /* ignore */ }
    [s.canvas, s.labelsEl, s.hintEl].forEach(function (el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    try { s.host.classList.remove('cb-s3d-host'); } catch (e6) { /* ignore */ }
    try { if (s.viewerEl) s.viewerEl.classList.remove('cb-s3d'); } catch (e7) { /* ignore */ }
    st = null;
  }

  /* ---------------- events */
  function on(el, ev, fn, o) { el.addEventListener(ev, fn, o || false); st.listeners.push([el, ev, fn, o || false]); }
  function interacted(t) {
    st.auto.resumeAt = t + IDLE_RESUME;
    st.auto.speed = 0;
    if (st.hintEl && !st.hintShown) { st.hintShown = true; st.hintEl.classList.remove('is-on'); }
    scheduleResume();
  }
  function scheduleResume() {
    clearTimeout(st.resumeTimer);
    if (!st.auto.on) return;
    var wait = st.auto.resumeAt - nowMs();
    if (wait > 0 && isFinite(wait)) st.resumeTimer = setTimeout(function () { if (st) wake(); }, wait + 20);
  }
  function bindEvents() {
    var cv = st.canvas;
    on(cv, 'pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      st.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(st.pointers);
      try { cv.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      var t = nowMs();
      st.tween = null; st.inertia = 0;
      if (ids.length >= 2) {
        var a = st.pointers[ids[0]], b = st.pointers[ids[1]];
        st.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: st.cam.distK };
        st.drag = null;
      } else {
        st.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: t, vx: 0, type: e.pointerType };
        cv.classList.add('is-drag');
      }
      st.auto.resumeAt = Infinity; st.auto.speed = 0;
      interacted(t); st.auto.resumeAt = Infinity;
      wake();
    });
    on(cv, 'pointermove', function (e) {
      var p = st.pointers[e.pointerId];
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (st.pinch) {
        var ids = Object.keys(st.pointers);
        if (ids.length >= 2) {
          var a = st.pointers[ids[0]], b = st.pointers[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          st.cam.distK = clamp(st.pinch.k * st.pinch.d / d, 0.55, 2.2);
          st.dirty = true; wake();
        }
        return;
      }
      var dr = st.drag;
      if (!dr || dr.id !== e.pointerId) return;
      var t = nowMs(), dx = e.clientX - dr.x, dy = e.clientY - dr.y, dts = Math.max(1, t - dr.t);
      st.cam.yaw += dx * 0.36;
      st.cam.pitch = clamp(st.cam.pitch + dy * 0.28, 2, 88);
      dr.vx = lerp(dr.vx, dx * 0.36 / dts * 1000, 0.5);
      dr.x = e.clientX; dr.y = e.clientY; dr.t = t;
      st.dirty = true; wake();
    });
    function up(e) {
      if (!st.pointers[e.pointerId]) return;
      delete st.pointers[e.pointerId];
      try { cv.releasePointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      var t = nowMs();
      if (st.drag && st.drag.id === e.pointerId) {
        if (t - st.drag.t < 90 && !st.reduce) st.inertia = clamp(st.drag.vx, -400, 400);
        st.drag = null;
      }
      if (Object.keys(st.pointers).length < 2) st.pinch = null;
      cv.classList.remove('is-drag');
      interacted(t);
      wake();
    }
    on(cv, 'pointerup', up);
    on(cv, 'pointercancel', up);
    on(cv, 'wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      st.cam.distK = clamp(st.cam.distK * Math.exp(clamp(dy, -200, 200) * 0.0016), 0.55, 2.2);
      if (st.tween) st.tween.to.distK = st.cam.distK;
      interacted(nowMs());
      st.dirty = true; wake();
    }, { passive: false });
    on(cv, 'dblclick', function (e) { e.preventDefault(); resetCamera(); });
    on(cv, 'contextmenu', function (e) { if (st.drag) e.preventDefault(); });
    try {
      var mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && mq.addEventListener) on(mq, 'change', function () { st.reduce = !!mq.matches; st.auto.on = !st.reduce; st.auto.speed = 0; if (st.reduce) { st.tween = null; st.fade = null; st.inertia = 0; } st.dirty = true; wake(); });
    } catch (eM) { /* ignore */ }
    on(document, 'visibilitychange', function () { if (!document.hidden) { st.last = 0; wake(); } });
    on(window, 'resize', function () { measure(); st.dirty = true; wake(); });
    on(window, 'cb:route', function () { setTimeout(function () { if (st) { measure(); st.dirty = true; wake(); } }, 0); });
    if (typeof window.ResizeObserver === 'function') {
      try { st.ro = new window.ResizeObserver(function () { if (!st) return; measure(); st.dirty = true; wake(); }); st.ro.observe(st.host); } catch (e1) { st.ro = null; }
    }
    if (typeof window.IntersectionObserver === 'function') {
      try {
        st.io = new window.IntersectionObserver(function (ents) {
          if (!st) return;
          var e = ents[ents.length - 1];
          st.visible = !!(e && e.isIntersecting);
          if (st.visible) { st.last = 0; st.dirty = true; wake(); }
        });
        st.io.observe(st.canvas);
      } catch (e2) { st.io = null; }
    }
    if (typeof window.MutationObserver === 'function') {
      try {
        st.mo = new window.MutationObserver(function () { if (!st) return; st.theme = readTheme(); st.xrKey = ''; st.dirty = true; wake(); });
        st.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
      } catch (e3) { st.mo = null; }
    }
    st.ctx.onLost(function () {
      if (!st) return;
      st.lostAt = nowMs();
      if (st.raf) { window.cancelAnimationFrame(st.raf); st.raf = 0; }
      clearTimeout(st.lostTimer);
      st.lostTimer = setTimeout(function () {
        if (st && st.ctx.isLost()) { var f = st.opts.onFail; if (typeof f === 'function') f('context-lost'); else destroy(); }
      }, 3000);
    });
    st.ctx.onRestored(function () {
      if (!st) return;
      clearTimeout(st.lostTimer);
      st.lostAt = 0;
      try { dropGPU(true); initGPU(); }
      catch (e) { var f = st.opts.onFail; if (typeof f === 'function') f('restore-failed'); return; }
      st.key = ''; st.pendingBuild = st.pendingBuild || st.lastBuild; st.pendingMetrics = st.pendingMetrics || st.lastMetrics;
      st.dirty = true; wake();
    });
  }
  function measure() {
    if (!st) return;
    try {
      var cs = window.getComputedStyle(st.host);
      st.pad = { t: Math.max(0, num(parseFloat(cs.paddingTop), 30)), b: Math.max(0, num(parseFloat(cs.paddingBottom), 58)) };
    } catch (e) { /* keep */ }
    st.shownCache = isShownSlow();
  }
  function isShownSlow() {
    if (!st) return false;
    var c = st.canvas;
    return !!(c.isConnected !== false && c.clientWidth > 8 && c.clientHeight > 8 && c.getClientRects().length);
  }
  function isShown() {
    if (!st || st.dead || document.hidden || st.visible === false) return false;
    if (st.ctx.isLost && st.ctx.isLost()) return false;
    return isShownSlow();
  }

  /* ---------------- public controls */
  function update(build, metrics, spec) {
    if (!st || !build) return;
    st.pendingBuild = build;
    st.pendingMetrics = metrics || null;
    st.pendingSpec = spec || null;
    wake();
  }
  function tweenTo(yaw, pitch, distK, ms) {
    var c = st.cam;
    if (st.reduce || !ms) { c.yaw = yaw; c.pitch = pitch; c.distK = distK; st.tween = null; st.dirty = true; return; }
    st.tween = { from: { yaw: c.yaw, pitch: c.pitch, distK: c.distK }, to: { yaw: c.yaw + shortestYaw(c.yaw, yaw), pitch: pitch, distK: distK }, t0: nowMs(), dur: ms };
  }
  function setView(v) {
    if (VIEW_IDS.indexOf(v) < 0) v = 'side';
    if (!st) return v;
    st.view = v;
    var a = viewAngles(v), c = st.cam;
    var ang = Math.abs(shortestYaw(c.yaw, a.yaw)) + Math.abs(a.pitch - c.pitch);
    tweenTo(a.yaw, a.pitch, 1, clamp(420 + ang * 3.2, 450, 1100));
    st.inertia = 0;
    st.orbit = null; syncOrbit(isOrbiting(c, v, !!st.tween));
    interacted(nowMs());
    st.auto.resumeAt = nowMs() + 4500; scheduleResume();   // hold the chosen view a moment, then turn again
    st.dirty = true; wake();
    return v;
  }
  function resetCamera() {
    if (!st) return;
    var a = viewAngles(st.view);
    tweenTo(a.yaw, a.pitch, 1, 700);
    st.inertia = 0;
    st.auto.resumeAt = nowMs() + 1400; st.auto.speed = 0;
    scheduleResume();
    st.dirty = true; wake();
  }
  /** jump the camera to exact angles (deg) / zoom; holds there like a view snap. {yaw, pitch, distK, hold(ms)} */
  function setCamera(o) {
    if (!st || !o) return null;
    var c = st.cam;
    st.tween = null; st.inertia = 0;
    if (isFinite(o.yaw)) c.yaw = +o.yaw;
    if (isFinite(o.pitch)) c.pitch = clamp(+o.pitch, 2, 88);
    if (isFinite(o.distK)) c.distK = clamp(+o.distK, 0.55, 2.2);
    interacted(nowMs());
    st.auto.resumeAt = nowMs() + (isFinite(o.hold) ? +o.hold : IDLE_RESUME); scheduleResume();
    st.dirty = true; wake();
    return { yaw: c.yaw, pitch: c.pitch, distK: c.distK };
  }
  function setXray(onf) {
    var v = typeof onf === 'boolean' ? onf : !(st && st.xray);
    if (!st) return v;
    if (v !== st.xray) { st.xrayFlip = true; st.xray = v; wake(); }
    return v;
  }
  function setSpin(onf) {
    var v = typeof onf === 'boolean' ? onf : !(st && st.spin.on);
    if (!st) return v;
    st.spin.on = v;
    if (st.reduce) st.spin.speed = v ? SPIN_MAX : 0;
    wake();
    return v;
  }

  /* ---------------- loop */
  function wake() {
    if (!st || st.dead || st.raf) return;
    if (st.ctx.isLost && st.ctx.isLost()) return;
    st.raf = window.requestAnimationFrame(frame);
  }
  function autoActive(t) { return st.auto.on && !st.drag && !st.pinch && !st.tween && t >= st.auto.resumeAt && Math.abs(st.inertia) < 1; }
  function busy(t) {
    return !!(st.drag || st.pinch || st.tween || Math.abs(st.inertia) > 0.5 || st.fade || st.dimsTo || st.spin.on || st.spin.speed > 0 || st.pendingBuild || st.xrayFlip);
  }
  function frame(t) {
    st.raf = 0;
    if (!st || st.dead) return;
    if (!isShown()) { st.last = 0; return; }   // paused: woken again by visibility / IO / resize / route / updates
    var animating = busy(t), auto = autoActive(t);
    // the turntable on its own runs at ~30 fps (idle cool); interaction, morphs and spin get the full rate
    if (!animating && auto && !st.dirty && t - st.lastDraw < 31) { st.raf = window.requestAnimationFrame(frame); return; }
    var dt = st.last ? Math.min(0.1, (t - st.last) / 1000) : 1 / 60;
    st.last = t;
    try {
      step(dt, t);
      render(t);
    } catch (e) {
      try { console.warn('[studio3d] frame failed', e); } catch (e2) { /* ignore */ }
      var f = st && st.opts.onFail;
      if (st && !st.failedOnce) { st.failedOnce = true; if (typeof f === 'function') { f('frame-error'); return; } }
      return;
    }
    if (!st) return;
    st.lastDraw = t; st.frames++; st.dirty = false;
    if (busy(t) || autoActive(t)) st.raf = window.requestAnimationFrame(frame);
    else st.last = 0;
  }

  function step(dt, t) {
    var c = st.cam;
    // camera tween
    if (st.tween) {
      var tw = st.tween, k = clamp((t - tw.t0) / tw.dur, 0, 1), e = easeInOut(k);
      c.yaw = lerp(tw.from.yaw, tw.to.yaw, e); c.pitch = lerp(tw.from.pitch, tw.to.pitch, e); c.distK = lerp(tw.from.distK, tw.to.distK, e);
      if (k >= 1) st.tween = null;
    }
    // drag inertia
    if (Math.abs(st.inertia) > 0.5 && !st.drag) { c.yaw += st.inertia * dt; st.inertia *= Math.exp(-dt * 4.5); if (Math.abs(st.inertia) <= 0.5) { st.inertia = 0; interacted(t); } }
    // turntable
    if (autoActive(t)) { st.auto.speed = Math.min(AUTO_SPEED, st.auto.speed + AUTO_SPEED * dt / 1.6); c.yaw += st.auto.speed * dt; }
    else st.auto.speed = 0;
    c.yaw = ((c.yaw + 180) % 360 + 360) % 360 - 180;
    if (st.tween) { /* keep tween targets in the same branch */ }
    // wheel spin
    var sp = st.spin, target = sp.on ? SPIN_MAX : 0;
    if (st.reduce) sp.speed = target;
    else sp.speed += (target - sp.speed) * Math.min(1, dt / (sp.on ? 0.42 : 0.65));
    if (!sp.on && sp.speed < 0.05) sp.speed = 0;
    sp.angle = (sp.angle - sp.speed * dt) % (PI * 2);
    var rw = st.car ? num(st.car.r.dims.wheelRadius, 0.33) : 0.33;
    sp.travel = (sp.travel + sp.speed * rw * dt) % 1;
    // framing morph between two cars
    if (st.dimsTo) {
      var kd = clamp((t - st.dimsT0) / 650, 0, 1), ed = easeInOut(kd), A = st.dimsFrom, B = st.dimsTo;
      st.dimsShown = { length: lerp(A.length, B.length, ed), width: lerp(A.width, B.width, ed), height: lerp(A.height, B.height, ed) };
      if (kd >= 1) { st.dimsShown = B; st.dimsTo = null; }
    }
    if (st.fade && t - st.fade.t0 >= st.fade.dur) st.fade = null;
    syncOrbit(isOrbiting(c, st.view, !!st.tween));
  }
  /** Tell the page when the camera leaves / returns to the preset view so the "Side" etc. label is honest. */
  function syncOrbit(orbit) {
    if (!st || st.orbit === orbit) return;
    st.orbit = orbit;
    var detail = { orbit: orbit, view: st.view };
    var f = st.opts && st.opts.onOrbit;
    if (typeof f === 'function') { try { f(detail); } catch (e) { /* ignore */ } }
    try { if (typeof window.CustomEvent === 'function') window.dispatchEvent(new window.CustomEvent('cb:studio-orbit', { detail: detail })); } catch (e2) { /* ignore */ }
  }

  /* ---------------- car entries */
  function lightMaterial(p) {
    var src = p.material || {}, m = {}, k;
    for (k in src) m[k] = src[k];
    var e = null;
    if (p.kind === 'light-brake') e = [0.55, 0.012, 0.008];
    else if (p.lightKey === 'light-drl' || /drl/.test(src.name || '')) e = [2.3, 2.4, 2.5];
    else if (p.kind === 'light-head') e = [0.32, 0.32, 0.3];
    else if (p.kind === 'light-rev') e = [0.05, 0.05, 0.05];
    if (e) { m.emissive = e; m.uEmissive = e; }
    return m;
  }
  function makeEntry(r) {
    var ctx = st.ctx, items = [], refl = [];
    for (var i = 0; i < r.parts.length; i++) {
      var p = r.parts[i];
      if (!p.positions || !p.positions.length) continue;
      var mesh = G.createMesh(ctx, { positions: p.positions, normals: p.normals, colors: p.colors, colorSize: 4, uvs: p.uvs, indices: p.indices });
      var mat = /^light-/.test(p.kind) ? lightMaterial(p) : p.material;
      var it = { mesh: mesh, material: mat, model: M4.create(), part: p, castShadow: false };
      items.push(it);
      refl.push({ mesh: mesh, material: mat, model: M4.create(), part: p, castShadow: false });
    }
    var tris = 0;
    r.parts.forEach(function (p) { tris += num(p.triangles, 0); });
    return { r: r, items: items, refl: refl, sig: geomSig(r), ghost: null, tris: tris };
  }
  function destroyEntry(en, lost) {
    if (!en) return;
    if (!lost) {
      en.items.forEach(function (it) { try { it.mesh.destroy(); } catch (e) { /* ignore */ } });
      if (en.ghost) en.ghost.forEach(function (it) { if (it.own) { try { it.mesh.destroy(); } catch (e) { /* ignore */ } } });
    }
    en.items = []; en.refl = []; en.ghost = null;
  }
  function wheelsOf(r) {
    var w = [];
    r.parts.forEach(function (p) { if (p.attach === 'wheel' && p.wheel && /^tire-|^tyre-/.test(p.kind)) w.push(p.wheel); });
    if (!w.length) r.parts.forEach(function (p) { if (p.attach === 'wheel' && p.wheel && w.indexOf(p.wheel) < 0 && !w.some(function (q) { return q.id === p.wheel.id; })) w.push(p.wheel); });
    return w.slice(0, 4);
  }
  function poseEntry(en) {
    var ang = st.spin.angle;
    for (var i = 0; i < en.items.length; i++) {
      var it = en.items[i], p = it.part, W = p.wheel, m = it.model;
      if ((p.attach === 'wheel' || p.attach === 'caliper') && W) {
        var side = W.side || (W.z < 0 ? -1 : 1);
        wheelLocal(m, W.x, W.y, W.z - side * (W.inset || 0), W.camber || 0, p.attach === 'wheel' ? ang : 0);
      } else M4.identity(m);
      var rm = en.refl[i].model;
      for (var k = 0; k < 16; k++) rm[k] = m[k];
      rm[1] = -m[1]; rm[5] = -m[5]; rm[9] = -m[9]; rm[13] = -m[13];
    }
    if (en.ghost) for (var g = 0; g < en.ghost.length; g++) { var gi = en.ghost[g]; if (gi.src) M4.copy(gi.model, gi.src.model); }
  }

  /* ---------------- x-ray */
  function ghostFor(en) {
    if (en.ghost) return en.ghost;
    var ctx = st.ctx, out = [];
    en.items.forEach(function (it) {
      var p = it.part, kind = p.kind || '';
      if (/^caliper/.test(kind)) { out.push({ mesh: it.mesh, material: it.material, model: M4.create(), src: it, role: 'solid' }); return; }
      var n = p.positions.length / 3, white = new Float32Array(n * 4);
      for (var q = 0; q < white.length; q++) white[q] = 1;
      var gm = G.createMesh(ctx, { positions: p.positions, normals: p.normals, colors: white, colorSize: 4, indices: p.indices });
      out.push({ mesh: gm, own: true, material: null, model: M4.create(), src: it, role: /^glass/.test(kind) ? 'glass' : /^(wheel|tire|tyre)-/.test(kind) ? 'wheel' : 'ghost' });
      var E = featureEdges(p.positions, p.indices, Math.cos(26 * DEG));
      if (E.length) {
        var ec = new Float32Array(E.length / 3 * 4);
        for (q = 0; q < ec.length; q++) ec[q] = 1;
        var em = G.createMesh(ctx, { positions: E, colors: ec, colorSize: 4, mode: 'lines' }, { computeNormals: false });
        out.push({ mesh: em, own: true, material: null, model: M4.create(), src: it, role: 'edge' });
      }
    });
    en.ghost = out;
    return out;
  }
  function xrMaterials(pal) {
    var line = hexLin(pal.line);
    var light = st.theme.theme === 'light';
    return {
      ghost: { name: 'xr-ghost', baseColor: [line[0], line[1], line[2], light ? 0.08 : 0.05], transparent: true, depthWrite: false, roughness: 0.9, metallic: 0, clearcoat: 0, emissive: [line[0] * 0.02, line[1] * 0.02, line[2] * 0.02], envIntensity: 0.08 },
      glass: { name: 'xr-glass', baseColor: [line[0], line[1], line[2], light ? 0.1 : 0.07], transparent: true, depthWrite: false, roughness: 0.6, metallic: 0, clearcoat: 0, emissive: [0, 0, 0], envIntensity: 0.15 },
      wheel: { name: 'xr-wheel', baseColor: [line[0], line[1], line[2], light ? 0.12 : 0.08], transparent: true, depthWrite: false, roughness: 0.9, metallic: 0, emissive: [0, 0, 0], envIntensity: 0.1 },
      edge: { name: 'xr-edge', unlit: true, baseColor: [line[0], line[1], line[2], light ? 0.55 : 0.4], transparent: true, depthWrite: false },
      blocks: { name: 'xr-blocks', baseColor: [1, 1, 1, 1], roughness: 0.45, metallic: 0.1, clearcoat: 0.4, emissive: [0, 0, 0] }
    };
  }
  function blockGeo(b, pal) {
    var g = G.geometry, geo = null, m = M4.create(), col = hexLin(pal[b.tone] || pal.line);
    if (b.shape === 'box') { geo = g.box(b.s[0], b.s[1], b.s[2]); m[12] = b.c[0]; m[13] = b.c[1]; m[14] = b.c[2]; }
    else if (b.shape === 'sphere') { geo = g.sphere(b.r, 14, 10); m[12] = b.c[0]; m[13] = b.c[1]; m[14] = b.c[2]; }
    else if (b.shape === 'cylY') { geo = g.cylinder(b.r, b.r, b.h, 16); m[12] = b.c[0]; m[13] = b.c[1]; m[14] = b.c[2]; }
    else if (b.shape === 'cylZ') {
      geo = g.cylinder(b.r, b.r, b.h, 16);
      // rotate +y -> +z (Rx(90deg))
      m[5] = 0; m[6] = 1; m[9] = -1; m[10] = 0; m[12] = b.c[0]; m[13] = b.c[1]; m[14] = b.c[2];
    } else if (b.shape === 'rod') {
      var dx = b.p1[0] - b.p0[0], dy = b.p1[1] - b.p0[1], dz = b.p1[2] - b.p0[2], L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(L > 1e-4)) return null;
      geo = g.cylinder(b.r, b.r, L, 10);
      var Y = [dx / L, dy / L, dz / L], tmp = Math.abs(Y[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
      var X = [Y[1] * tmp[2] - Y[2] * tmp[1], Y[2] * tmp[0] - Y[0] * tmp[2], Y[0] * tmp[1] - Y[1] * tmp[0]], xl = Math.hypot(X[0], X[1], X[2]);
      X = [X[0] / xl, X[1] / xl, X[2] / xl];
      var Z = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
      m[0] = X[0]; m[1] = X[1]; m[2] = X[2]; m[4] = Y[0]; m[5] = Y[1]; m[6] = Y[2]; m[8] = Z[0]; m[9] = Z[1]; m[10] = Z[2];
      m[12] = (b.p0[0] + b.p1[0]) / 2; m[13] = (b.p0[1] + b.p1[1]) / 2; m[14] = (b.p0[2] + b.p1[2]) / 2;
    }
    if (!geo) return null;
    return { geometry: geo, transform: m, color: col };
  }
  function destroyXr(x, lost) {
    if (!x) return;
    if (!lost) [x.mesh, x.glow].forEach(function (mm) { if (mm) { try { mm.destroy(); } catch (e) { /* ignore */ } } });
    x.mesh = x.glow = null;
  }
  function ensureXr() {
    var en = st.car;
    if (!en) return null;
    var spec = st.spec || {};
    var key;
    try { key = JSON.stringify([spec.n, spec.d, en.sig, st.theme.theme]); } catch (e) { key = String(nowMs()); }
    if (st.xr && st.xrKey === key) return st.xr;
    destroyXr(st.xr);
    var pal = st.theme.pal, lay = xrayLayout(en.r.dims, spec), list = [];
    lay.blocks.forEach(function (b) { var q = blockGeo(b, pal); if (q) list.push(q); });
    var merged = list.length ? G.geometry.merge(list) : null;
    var x = { layout: lay, mats: xrMaterials(pal), mesh: merged ? G.createMesh(st.ctx, merged) : null, glow: null };
    x.items = x.mesh ? [{ mesh: x.mesh, material: x.mats.blocks, model: M4.create() }] : [];
    // labels
    var host = st.labelsEl;
    host.innerHTML = '';
    x.labels = lay.labels.map(function (l) {
      var el = document.createElement('div');
      el.className = 'cb-s3d-lab';
      el.textContent = l.text;
      el.style.color = pal[l.tone] || pal.text;
      el.style.background = pal.bg;
      host.appendChild(el);
      return { el: el, p: l.p, w: 0, h: 0 };
    });
    st.xr = x; st.xrKey = key;
    return x;
  }

  /* ---------------- build pipeline (one per frame at most) */
  function applyPending(t) {
    if (!st.pendingBuild && !st.xrayFlip) return false;
    var changed = false, swapModel = false, newEntry = null;
    if (st.pendingBuild) {
      var b = st.pendingBuild, m = st.pendingMetrics, sp = st.pendingSpec;
      st.pendingBuild = null; st.pendingMetrics = null; st.pendingSpec = null;
      st.lastBuild = b; st.lastMetrics = m;
      if (!sp && CB.render && typeof CB.render.resolve === 'function') { try { sp = CB.render.resolve(b, m); } catch (e) { sp = null; } }
      st.spec = sp || st.spec;
      var key = buildKey(b);
      if (key !== st.key || !st.car) {
        st.key = key;
        var r = null;
        try { r = CB.lowpoly.build(b, { lod: 'high' }); } catch (e2) { r = null; try { console.warn('[studio3d] lowpoly.build failed', e2); } catch (e3) { /* ignore */ } }
        st.builds++;
        if (r && r.parts && r.parts.length) {
          var sig = geomSig(r);
          if (!st.car || sig !== st.car.sig) {
            newEntry = makeEntry(r);
            swapModel = !st.car || (st.car.r.model && r.model && st.car.r.model.id !== r.model.id);
            changed = true;
          }
        }
      }
    }
    var flip = !!st.xrayFlip;
    st.xrayFlip = false;
    if (!changed && !flip) return false;
    // cross-fade: snapshot exactly what is on screen now, then swap
    var canFade = !st.reduce && st.car && st.lastDraw > 0;
    if (canFade) { try { render(t, true); snapshot(); } catch (e4) { canFade = false; } }
    if (newEntry) {
      var old = st.car;
      st.car = newEntry;
      var nd = newEntry.r.dims;
      var to = { length: nd.length, width: nd.width, height: nd.height };
      if (old && swapModel && !st.reduce) { st.dimsFrom = st.dimsShown || to; st.dimsTo = to; st.dimsT0 = t; }
      else { st.dimsShown = to; st.dimsTo = null; }
      if (old) destroyEntry(old);
      var mdl = newEntry.r.model || {}, dd = newEntry.r.dims || {};
      st.canvas.setAttribute('aria-label', '3D studio view: ' + ((mdl.make || dd.make || '') + ' ' + (mdl.name || dd.modelName || '')).trim() + ' (drag to orbit)');
    }
    if (canFade) st.fade = { t0: t, dur: swapModel ? 560 : flip ? 420 : 300 };
    return true;
  }
  function snapshot() {
    var gl = st.gl, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (!st.snapTex) st.snapTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.snapTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, w, h, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    st.snapW = w; st.snapH = h;
  }

  /* ---------------- camera + lights */
  function cameraFor(w, h) {
    var c = st.cam, dpr = st.ctx.dpr || 1;
    var padT = st.pad.t * dpr, padB = st.pad.b * dpr;
    if (h - padT - padB < h * 0.45) { var k = (h * 0.55) / Math.max(1, padT + padB); padT *= k; padB *= k; }
    var hf = Math.max(1, h - padT - padB), aspF = w / hf;
    var dims = st.dimsShown || { length: 4.5, width: 1.9, height: 1.4 };
    var R = fitDistance(dims, aspF, FOV_FREE, c.pitch) * c.distK;
    var tanFull = Math.tan(FOV_FREE / 2) * h / hf;
    var y = c.yaw * DEG, p = c.pitch * DEG;
    var tgt = [0, dims.height * (c.pitch > 60 ? 0.3 : 0.44), 0];
    var eye = [tgt[0] + Math.cos(y) * Math.cos(p) * R, tgt[1] + Math.sin(p) * R, tgt[2] + Math.sin(y) * Math.cos(p) * R];
    if (eye[1] < 0.15) eye[1] = 0.15;
    var view = M4.create(), proj = M4.create(), vp = M4.create();
    M4.lookAt(view, eye, tgt, [0, 1, 0]);
    M4.perspective(proj, 2 * Math.atan(tanFull), w / h, Math.max(0.05, R * 0.05), R * 6 + 40);
    var cyTop = padT + hf / 2, ndcY = 1 - 2 * cyTop / h;
    proj[9] = -ndcY;
    M4.multiply(vp, proj, view);
    return { view: view, proj: proj, viewProj: vp, position: eye, R: R };
  }
  function envFor(mirror) {
    var T = st.theme.env, y = st.cam.yaw * DEG;
    var ka = y + 62 * DEG, ke = 58 * DEG;
    var sun = [Math.cos(ke) * Math.cos(ka), Math.sin(ke), Math.cos(ke) * Math.sin(ka)];
    var ra = y + PI - 75 * DEG, rp = [Math.cos(ra) * 6, 1.25, Math.sin(ra) * 6];
    var fa = y - 70 * DEG, fp = [Math.cos(fa) * 7, 1.1, Math.sin(fa) * 7];
    if (mirror) { sun[1] = -sun[1]; rp[1] = -rp[1]; fp[1] = -fp[1]; }
    return {
      sunDir: sun, sunColor: T.sun,
      ambientSky: mirror ? T.ambientGround : T.ambientSky, ambientGround: mirror ? T.ambientSky : T.ambientGround,
      envTop: T.envTop, envHorizon: T.envHorizon, envBottom: T.envBottom, fogDensity: 0, exposure: T.exposure,
      studio: T.studio, envMap: studioProbe(sun, T),
      lights: [
        { pos: rp, color: T.rim, range: 22, type: 0 },
        { pos: fp, color: T.fill, range: 22, type: 0 }
      ]
    };
  }

  /** One studio reflection probe (WebGL2) shared by the car and its floor reflection, re-baked only when the key
      light has turned by a few degrees or the theme changed. (Letting drawList auto-bake would alternate between the
      mirrored and the normal pass's lighting and leave a random one on screen when the loop idles.) undefined =
      no probe (WebGL1 / bake failed): gl-core then evaluates the same studio environment per pixel. */
  function studioProbe(sun, T) {
    if (!st.ctx.isWebGL2 || st.probeFailed || typeof G.createEnvMap !== 'function') return undefined;
    var key = Math.round(Math.atan2(sun[2], sun[0]) / DEG / 3) + '|' + st.theme.theme;
    if (st.probe && st.probeKey === key && st.probe.valid) return st.probe;
    try {
      if (!st.probe) st.probe = G.createEnvMap(st.ctx, null, { size: 128 });
      var base = sun[1] < 0 ? [sun[0], -sun[1], sun[2]] : sun;
      if (!st.probe || !st.probe.update({ sunDir: base, sunColor: T.sun, envTop: T.envTop, envHorizon: T.envHorizon, envBottom: T.envBottom, studio: T.studio })) { st.probeFailed = true; return undefined; }
      st.probeKey = key;
    } catch (e) { st.probeFailed = true; return undefined; }
    return st.probe;
  }

  /* ---------------- render */
  function useProg(prog) { st.gl.useProgram(prog.program); return prog.u; }
  function drawFloor(cam, mode, R) {
    var gl = st.gl, en = st.car, u = useProg(st.progFloor), d = en.r.dims, T = st.theme;
    gl.uniformMatrix4fv(u.uViewProj, false, cam.viewProj);
    gl.uniform1f(u.uMode, mode);
    var cx = (num(d.frontAxle, 1.3) + num(d.rearAxle, -1.2)) / 2 * 0.25;
    gl.uniform4f(u.uFoot, d.length * 0.46, d.width * 0.43, cx, T.refl);
    var W = en.wheels || (en.wheels = wheelsOf(en.r)), arr = new Float32Array(16);
    for (var i = 0; i < 4; i++) {
      var w = W[i];
      if (w) { arr[i * 4] = w.x; arr[i * 4 + 1] = w.z - (w.side || (w.z < 0 ? -1 : 1)) * (w.inset || 0); arr[i * 4 + 2] = w.r * 0.85; arr[i * 4 + 3] = Math.max(0.12, w.width * 0.9); }
      else { arr[i * 4] = 999; arr[i * 4 + 1] = 999; arr[i * 4 + 2] = 0.1; arr[i * 4 + 3] = 0.1; }
    }
    if (u.uWheel) gl.uniform4fv(u.uWheel, arr);
    else if (u['uWheel[0]']) gl.uniform4fv(u['uWheel[0]'], arr);
    var xr = st.xray, sh = T.shadow, photo = st.photo;
    gl.uniform4f(u.uShadow, sh[0], sh[1], sh[2], sh[3] * (xr ? 0.45 : 1));
    gl.uniform4f(u.uGrid, T.grid[0], T.grid[1], T.grid[2], xr || (photo && !st.spin.on) ? 0 : T.grid[3]);
    gl.uniform4f(u.uPool, T.pool[0], T.pool[1], T.pool[2], xr ? T.pool[3] * 0.4 : T.pool[3]);
    gl.uniform2f(u.uGridOff, st.spin.travel, 0);
    var ey = cam.position;
    if (u.uEye) gl.uniform4f(u.uEye, ey[0], Math.max(0.05, ey[1]), ey[2], R && mode > 0.5 ? 1 : 0);
    if (u.uInvRes) gl.uniform2f(u.uInvRes, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    if (R && mode > 0.5) {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.a.tex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, R.c.tex);
      if (u.uRefl) gl.uniform1i(u.uRefl, 1);
      if (u.uReflBlur) gl.uniform1i(u.uReflBlur, 2);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    if (mode < 0.5) gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    st.floorMesh.bind(); st.floorMesh.drawRaw();
    unbind();
    if (R && mode > 0.5) {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }
  /** half-res mirrored-car target + a quarter-res blur pair; null -> the WebGL1-safe path (mirrored car drawn straight
      onto the canvas and erased with distance) */
  function reflTargets(w, h) {
    if (st.rtFailed) return null;
    var hw = Math.max(2, Math.round(w / 2)), hh = Math.max(2, Math.round(h / 2)), qw = Math.max(2, Math.round(w / 4)), qh = Math.max(2, Math.round(h / 4));
    try {
      if (!st.rt) st.rt = { a: G.createRenderTarget(st.ctx, hw, hh, { depth: true }), b: G.createRenderTarget(st.ctx, qw, qh, { depth: false }), c: G.createRenderTarget(st.ctx, qw, qh, { depth: false }) };
      st.rt.a.resize(hw, hh); st.rt.b.resize(qw, qh); st.rt.c.resize(qw, qh);
      if (!st.rt.a.ok || !st.rt.b.ok || !st.rt.c.ok) throw new Error('reflection target incomplete');
    } catch (e) {
      st.rtFailed = true;
      if (st.rt) ['a', 'b', 'c'].forEach(function (k) { try { if (st.rt[k]) st.rt[k].destroy(); } catch (e2) { /* ignore */ } });
      st.rt = null;
      return null;
    }
    return st.rt;
  }
  function blurPass(src, dst, dx, dy) {
    var gl = st.gl, u = useProg(st.progBlur);
    dst.bind();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, dx / src.w, dy / src.h);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    st.triMesh.bind(); st.triMesh.drawRaw();
    unbind();
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  /** the mirrored car into the half-res target, then a two-level separable blur into the quarter-res pair */
  function renderReflection(cam, w, h) {
    var R = reflTargets(w, h);
    if (!R) return null;
    var gl = st.gl;
    R.a.bind();
    gl.clearColor(0, 0, 0, 0); gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    G.drawList(st.ctx, st.car.refl, cam, envFor(true));
    blurPass(R.a, R.b, 1, 0); blurPass(R.b, R.c, 0, 1);
    blurPass(R.c, R.b, 2.2, 0); blurPass(R.b, R.c, 0, 2.2);
    R.a.unbind();
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    return R;
  }
  function unbind() { var ctx = st.ctx; if (ctx.ext && ctx.ext.vao && ctx.bindVAO) ctx.bindVAO(null); }
  function drawSnapshot(alpha) {
    var gl = st.gl;
    if (!st.snapTex || alpha <= 0.002) return;
    var u = useProg(st.progCopy);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.snapTex);
    gl.uniform1i(u.uTex, 0); gl.uniform1f(u.uAlpha, alpha);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    st.triMesh.bind(); st.triMesh.drawRaw();
    unbind();
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }
  /** drawing-buffer scale: at least 2x (supersampled on 1x screens: MSAA + a 2:1 downscale by the compositor kills
      the stair-stepping on the faceted silhouettes), within a pixel budget so big viewports stay cheap */
  function stageDpr(cw, ch, dev) {
    var dpr = clamp(Math.max(2, num(dev, 1)), 1, 2), px = Math.max(1, cw * ch);
    if (px * dpr * dpr > PX_BUDGET) dpr = Math.max(Math.min(1, num(dev, 1)), Math.sqrt(PX_BUDGET / px));
    return dpr;
  }
  function resize() {
    var c = st.canvas, cw = c.clientWidth, ch = c.clientHeight;
    st.ctx.resize(cw, ch, stageDpr(cw, ch, window.devicePixelRatio || 1) * (st.photoScale || 1));
  }
  /** render one frame. snapOnly = the "before" frame of a cross-fade (no state changes). */
  function render(t, snapOnly) {
    if (!snapOnly) applyPending(t);
    resize();
    var gl = st.gl, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    var en = st.car;
    var cam = null;
    if (en) {
      cam = cameraFor(w, h);
      poseEntry(en);
      var xr = st.xray, R = null;
      if (!xr && st.theme.refl > 0) {
        R = renderReflection(cam, w, h);
        if (!R) {
          gl.viewport(0, 0, w, h);
          G.drawList(st.ctx, en.refl, cam, envFor(true));
          drawFloor(cam, 0, null);
        }
      }
      drawFloor(cam, 1, R);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      var env = envFor(false);
      if (xr) {
        var x = ensureXr(), gh = ghostFor(en), mats = x ? x.mats : xrMaterials(st.theme.pal), list = x ? x.items.slice() : [];
        poseEntry(en);
        for (var i = 0; i < gh.length; i++) {
          var gi = gh[i];
          gi.material = gi.role === 'solid' ? gi.src.material : mats[gi.role] || mats.ghost;
          list.push(gi);
        }
        G.drawList(st.ctx, list, cam, env);
      } else G.drawList(st.ctx, en.items, cam, env);
    }
    if (st.fade && !snapOnly) {
      var k = clamp((t - st.fade.t0) / st.fade.dur, 0, 1);
      if (st.snapW === w && st.snapH === h) drawSnapshot(1 - easeOut(k));
    } else if (st.fade && snapOnly && st.snapW === w && st.snapH === h) {
      drawSnapshot(1 - easeOut(clamp((t - st.fade.t0) / st.fade.dur, 0, 1)));
    }
    if (!snapOnly) placeLabels(cam, w, h);
  }
  function placeLabels(cam, w, h) {
    var el = st.labelsEl, on = !!(st.xray && st.xr && cam);
    if (el.classList.contains('is-on') !== on) el.classList.toggle('is-on', on);
    if (!on) return;
    var vp = cam.viewProj, cw = st.canvas.clientWidth, ch = st.canvas.clientHeight;
    st.xr.labels.forEach(function (l) {
      var p = l.p, x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
      var ww = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (!(ww > 0.01)) { l.el.style.display = 'none'; return; }
      var sx = (x / ww * 0.5 + 0.5) * cw, sy = (1 - (y / ww * 0.5 + 0.5)) * ch;
      l.el.style.display = '';
      l.el.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px) translate(-50%,-100%)';
    });
  }

  function stats() {
    if (!st) return { mounted: false };
    var en = st.car;
    return {
      mounted: true, frames: st.frames, builds: st.builds, running: !!st.raf, visible: isShown(), view: st.view, xray: st.xray, spin: st.spin.on,
      triangles: en ? en.tris : 0, model: en && en.r.model ? en.r.model.id : null, auto: autoActive(nowMs()), cam: { yaw: st.cam.yaw, pitch: st.cam.pitch, distK: st.cam.distK },
      orbit: !!st.orbit, resumeIn: Math.round(st.auto.resumeAt - nowMs()), autoOn: st.auto.on, fading: !!st.fade, webgl2: !!st.ctx.isWebGL2, dpr: st.ctx.dpr, reduceMotion: st.reduce
    };
  }

  /**
   * Debug frame-time probe: renders n frames back to back (camera orbiting, wheels spinning) and waits for the GPU
   * after each one (a 1-pixel readPixels), so the figures are CPU + GPU per frame. -> {frames, avgMs, p50, p95, w, h, dpr}
   */
  function bench(n) {
    if (!st || !st.car) return null;
    n = clamp(Math.round(num(n, 60)), 1, 600);
    var gl = st.gl, px = new Uint8Array(4), times = [], t = nowMs(), yaw0 = st.cam.yaw, spin0 = st.spin.speed;
    st.spin.speed = SPIN_MAX;
    for (var i = 0; i < n; i++) {
      var t0 = nowMs();
      st.cam.yaw = yaw0 + i * 3;
      st.spin.angle -= 0.2;
      render(t + i * 16);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(nowMs() - t0);
    }
    st.cam.yaw = yaw0; st.spin.speed = spin0; st.dirty = true; wake();
    var sorted = times.slice().sort(function (a, b) { return a - b; }), sum = 0;
    times.forEach(function (v) { sum += v; });
    return { frames: n, avgMs: +(sum / n).toFixed(2), p50: +sorted[n >> 1].toFixed(2), p95: +sorted[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(2), w: gl.drawingBufferWidth, h: gl.drawingBufferHeight, dpr: st.ctx.dpr };
  }

  /**
   * One still frame of a build as an image (the menu hero): renders the studio car once on a throw-away offscreen
   * canvas and returns a PNG data URL (null when WebGL / the low-poly kit is unavailable). Synchronous; the live
   * Atelier turntable (if mounted) is parked for the duration and untouched. opts {width, height (CSS px), yaw,
   * pitch, distK}; the device pixel ratio is the studio's (capped at 2).
   */
  function still(build, opts) {
    if (!HAS_DOM || !build || !isSupported() || !document.body) return null;
    opts = opts || {};
    var w = Math.max(64, Math.round(num(opts.width, 720))), hgt = Math.max(48, Math.round(num(opts.height, 300)));
    var saved = st, url = null, box = document.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + w + 'px;height:' + hgt + 'px;padding:0;opacity:0;pointer-events:none;contain:strict';
    document.body.appendChild(box);
    st = null;
    try {
      if (mount(box, { view: 'side' }) && st) {
        if (st.raf) { try { window.cancelAnimationFrame(st.raf); } catch (e0) { /* ignore */ } st.raf = 0; }
        st.reduce = true; st.auto.on = false;
        var c = st.cam, a = viewAngles('side');
        c.yaw = isFinite(opts.yaw) ? +opts.yaw : a.yaw + 28; c.pitch = isFinite(opts.pitch) ? +opts.pitch : 9; c.distK = isFinite(opts.distK) ? +opts.distK : 1.08;
        st.pendingBuild = build; st.pendingMetrics = null; st.pendingSpec = null;
        var t = nowMs();
        applyPending(t);
        if (st.car) {
          st.dimsShown = st.dimsShown || { length: st.car.r.dims.length, width: st.car.r.dims.width, height: st.car.r.dims.height };
          step(0, t);
          render(t, true);
          url = st.canvas.toDataURL('image/png');
        }
      }
    } catch (e) { url = null; try { console.warn('[studio3d] still failed', e); } catch (e2) { /* ignore */ } }
    try { if (st) destroy(); } catch (e3) { /* ignore */ }
    st = saved;
    if (box.parentNode) box.parentNode.removeChild(box);
    return url && url.length > 2000 ? url : null;
  }

  CB.studio3d = {
    version: '1.0.0',
    still: still,
    isSupported: isSupported,
    mount: mount,
    update: update,
    setView: setView,
    getView: function () { return st ? st.view : 'side'; },
    /** true while the turntable / user orbit has moved the camera off the chosen preset view */
    isOrbiting: function () { return !!(st && st.orbit); },
    setXray: setXray, toggleXray: setXray, isXray: function () { return !!(st && st.xray); },
    setSpin: setSpin, toggleSpin: setSpin, isSpinning: function () { return !!(st && st.spin.on); },
    resetCamera: resetCamera, setCamera: setCamera,
    isMounted: function (container) { return !!(st && (!container || st.host === container) && st.host.contains(st.canvas)); },
    destroy: destroy,
    stats: stats,
    bench: bench,
    _: _
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.studio3d;

/* ==========================================================================
   FORGE — js/platform/device.js
   CB.device : device class detection, the automatic graphics quality tier, and small mobile / iOS helpers.
   Loads right after js/util.js (no dependencies); every other module may feature-detect it.

     CB.device.info()                 cached probe {mobile, ios, android, tablet, touch, coarse, dpr, cores, memory,
                                      gpu, software, saveData, screenW, screenH, standalone, fullscreen}
     CB.device.classify(info)         PURE -> {tier 'low'|'medium'|'high', mobile, reasons[]}
     CB.device.autoTier()             the tier 'Auto' graphics starts at on this device (classify() lowered by a
                                      previously learned tier, see learn()). Desktop: 'high' (= unchanged) unless
                                      the GPU is a software rasteriser or the machine is tiny.
     CB.device.resolveQuality(q)      'auto' -> autoTier(); 'low'|'medium'|'high'|'ultra' pass through
     CB.device.learn(tier, detected)  remember the tier the frame-time governor settled on (localStorage, guarded)
     CB.device.createStartupGovernor(opts)  PURE frame-time governor for the first seconds of driving:
                                      g.sample(ms) -> null | {action:'down', to:tier, medianMs} | {action:'ok', medianMs}
     CB.device.stepDown(tier, n)      PURE 'high' -> 'medium' -> 'low'
     CB.device.isStandalone()         launched from the home screen (iOS navigator.standalone / display-mode)
     CB.device.canFullscreen()        Fullscreen API usable (false on iPhone Safari)
     CB.device.storage                get/set/remove that never throw (private mode / blocked storage / quota)
     CB.device.standaloneHint()       one-time 'Add to Home Screen' tip on iPhone when a race / drift route opens
     CB.device.unlockAudio()          resume every suspended / iOS-'interrupted' AudioContext (called on gestures)

   Side effects in a browser (all guarded): wraps window.AudioContext / webkitAudioContext so every context created
   by the game is registered and resumed on the next touchend / pointerup / click / keydown (iOS only unlocks Web
   Audio inside those gestures and re-suspends it after calls / Siri / backgrounding); tags <html> with
   cb-touch / cb-mobile / cb-ios / cb-standalone classes for CSS.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

CB.device = (function () {
  'use strict';

  var TIERS = ['low', 'medium', 'high'];
  var ALL = ['low', 'medium', 'high', 'ultra'];
  var LS_KEY = 'forge.gfx.auto.v1';
  var hasWin = typeof window !== 'undefined' && typeof document !== 'undefined';

  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function tierIdx(t) { return TIERS.indexOf(t === 'ultra' ? 'high' : t); }

  /* ------------------------------------------------------------ storage (never throws) */
  var mem = {};
  var storage = {
    get: function (k) {
      try { var ls = hasWin && window.localStorage; if (ls) { var v = ls.getItem(k); if (v != null) return v; } } catch (e) { /* blocked */ }
      return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
    },
    set: function (k, v) {
      mem[k] = String(v);
      try { var ls = hasWin && window.localStorage; if (ls) ls.setItem(k, String(v)); return true; } catch (e) { return false; }
    },
    remove: function (k) {
      delete mem[k];
      try { var ls = hasWin && window.localStorage; if (ls) ls.removeItem(k); } catch (e) { /* ignore */ }
    }
  };

  /* ------------------------------------------------------------ GPU string (pure) */
  /** Rough GPU class from the unmasked renderer string: 0 software, 1 weak, 2 mid, 3 strong, -1 unknown. */
  function gpuClass(gpu) {
    var g = str(gpu).toLowerCase();
    if (!g) return -1;
    if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) return 0;
    var m;
    if ((m = g.match(/adreno[^0-9]*(\d{3})/))) {
      var a = +m[1];
      return a >= 730 ? 3 : a >= 640 ? 2 : 1;           // Adreno 6xx low/mid -> weak, 640+/7xx mid, 730+ strong
    }
    if (/immortalis|xclipse/.test(g)) return 3;
    if ((m = g.match(/mali-g(\d+)/))) {
      var mg = +m[1];
      // Mali-G7x (G71..G78) / G610..G720 mid; G5x/G3x weak; G710+/G715/G720 strong-ish
      return mg >= 710 ? 3 : mg >= 610 || (mg >= 72 && mg < 100) ? 2 : 1;
    }
    if (/mali|powervr|videocore|vivante|tegra 3|tegra 4/.test(g)) return 1;
    if (/apple (m\d|a1[4-9])/.test(g)) return 3;
    if (/apple gpu|apple/.test(g)) return 2;              // iOS Safari masks the model: "Apple GPU"
    return 3;                                             // desktop GPUs (NVIDIA / AMD / Intel / Apple M*)
  }

  /* ------------------------------------------------------------ classification (pure) */
  /**
   * info: {ua, platform, maxTouchPoints, coarse, dpr, cores, memory (GB), gpu, screenW, screenH, saveData}
   * Desktop keeps 'high' (the shipped default) unless clearly incapable; phones start 'low' or 'medium'.
   */
  function classify(info) {
    var I = info || {}, ua = str(I.ua), reasons = [];
    var ipad = /iPad/.test(ua) || (/Macintosh|MacIntel/.test(ua + ' ' + str(I.platform)) && num(I.maxTouchPoints, 0) > 1);
    var ios = /iPhone|iPod/.test(ua) || ipad;
    var android = /Android/.test(ua);
    var shortSide = Math.min(num(I.screenW, 0), num(I.screenH, 0)), longSide = Math.max(num(I.screenW, 0), num(I.screenH, 0));
    var phoneUA = /iPhone|iPod|Mobile|Android.*Mobile|Windows Phone|IEMobile|Opera Mini/.test(ua);
    var tablet = ipad || (android && !/Mobile/.test(ua));
    var mobile = !!(ios || android || phoneUA || (I.coarse && shortSide > 0 && shortSide < 600));
    var cores = num(I.cores, 0), memory = num(I.memory, 0), dpr = num(I.dpr, 1), gc = gpuClass(I.gpu);
    var tier;
    if (!mobile) {
      tier = 'high';
      if (gc === 0) { tier = 'low'; reasons.push('software GPU'); }
      else if (cores > 0 && cores <= 2 && memory > 0 && memory <= 4) { tier = 'medium'; reasons.push('2 cores / ' + memory + ' GB'); }
      else if (memory > 0 && memory < 4 && cores > 0 && cores <= 4) { tier = 'medium'; reasons.push('low memory'); }
      else reasons.push('desktop');
    } else {
      reasons.push(tablet ? 'tablet' : 'phone');
      // start at 'low' (no shadows / post, 1x pixels) and earn 'medium'
      var strong = false;
      if (gc === 0) reasons.push('software GPU');
      else if (ios) {
        // iOS masks the GPU ("Apple GPU") and caps hardwareConcurrency, so use the screen: iPhone 12 and later have a
        // >= 844 pt long side (390x844, 393x852, 428x926, 430x932...); iPads have >= 1024
        strong = ipad ? longSide >= 1024 : longSide >= 844;
        if (/apple (a1[5-9]|m\d)/i.test(str(I.gpu))) strong = true;
        reasons.push(strong ? 'recent iOS device' : 'older iOS device');
      } else {
        strong = gc >= 2 && (memory === 0 || memory >= 4) && (cores === 0 || cores >= 6);
        if (gc >= 3 && memory >= 6) strong = true;
        reasons.push('gpu class ' + gc + (memory ? ' / ' + memory + ' GB' : '') + (cores ? ' / ' + cores + ' cores' : ''));
      }
      if (memory > 0 && memory <= 3) { strong = false; reasons.push('<= 3 GB'); }
      tier = strong ? 'medium' : 'low';
      if (tablet && strong && gc >= 3 && memory >= 8) tier = 'high';
    }
    if (I.saveData && tierIdx(tier) > 0) { tier = TIERS[tierIdx(tier) - 1]; reasons.push('data saver'); }
    return { tier: tier, mobile: mobile, ios: ios, android: android, tablet: tablet, gpuClass: gc, dpr: dpr, reasons: reasons };
  }

  function stepDown(t, n) {
    var i = tierIdx(t);
    if (i < 0) i = 2;
    return TIERS[Math.max(0, i - Math.max(1, n | 0))];
  }
  function minTier(a, b) {
    var ia = tierIdx(a), ib = tierIdx(b);
    if (ia < 0) return b; if (ib < 0) return a;
    return TIERS[Math.min(ia, ib)];
  }

  /* ------------------------------------------------------------ startup frame-time governor (pure) */
  /**
   * Watches the first seconds of driving (after a warm-up for shader compiles / uploads) and picks a lower tier
   * at once when the median frame interval is clearly too long. Complements renderer3d's own continuous governor,
   * which ignores > 250 ms intervals and steps down one level per ~2-5 s — far too slow on a 5-10 fps phone.
   *   opts: {warmupFrames 20, warmupMs 600, windowMs 2500, minFrames 12, targetMs 33.4 (30 fps), slackMs 6}
   *   sample(ms) -> null while measuring; then once: {action:'ok'|'down', medianMs, to?}
   * median <= target+slack (rAF capped at 30 Hz in iOS Low Power Mode is fine) -> ok; else drop one tier per
   * doubling over budget: <= 2x budget -> 1 step, more -> 2 steps.
   */
  function createStartupGovernor(opts) {
    var o = opts || {};
    var warmF = num(o.warmupFrames, 20), warmMs = num(o.warmupMs, 600), win = num(o.windowMs, 2500), minF = num(o.minFrames, 12);
    var target = num(o.targetMs, 1000 / 30), slack = num(o.slackMs, 6);
    var g = { done: false, frames: 0, warmT: 0, t: 0, xs: [], result: null };
    g.sample = function (ms) {
      if (g.done || !(ms > 0)) return null;
      if (ms > 2000) return null;                  // tab switch / breakpoint / alert
      g.frames++;
      if (g.frames <= warmF || g.warmT < warmMs) { g.warmT += Math.min(ms, 100); return null; }
      g.xs.push(Math.min(ms, 1000)); g.t += ms;
      if (g.t < win || g.xs.length < minF) {
        // hopeless (each frame > 250 ms): decide as soon as there are a few samples instead of waiting 12 frames
        if (!(g.xs.length >= 4 && g.t >= win)) return null;
      }
      g.done = true;
      var s = g.xs.slice().sort(function (a, b) { return a - b; }), med = s[s.length >> 1];
      var budget = target + slack;
      if (med <= budget) g.result = { action: 'ok', medianMs: med };
      else g.result = { action: 'down', medianMs: med, steps: med > budget * 2 ? 2 : 1 };
      return g.result;
    };
    g.reset = function () { g.done = false; g.frames = 0; g.warmT = 0; g.t = 0; g.xs = []; g.result = null; };
    return g;
  }

  /* ------------------------------------------------------------ browser probe */
  var cachedInfo = null;
  function probeGpu() {
    if (!hasWin) return '';
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: false }) || c.getContext('experimental-webgl');
      if (!gl) return '';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      var r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) { try { lose.loseContext(); } catch (e0) { /* ignore */ } }   // free the probe context right away
      return str(r);
    } catch (e) { return ''; }
  }
  function mq(q) { try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch (e) { return false; } }
  function info() {
    if (cachedInfo) return cachedInfo;
    if (!hasWin) return (cachedInfo = { ua: '', mobile: false, dpr: 1, cores: 0, memory: 0, gpu: '', touch: false, coarse: false });
    var nav = window.navigator || {}, scr = window.screen || {};
    var I = {
      ua: str(nav.userAgent), platform: str(nav.platform), maxTouchPoints: num(nav.maxTouchPoints, 0),
      coarse: mq('(pointer: coarse)'), touch: num(nav.maxTouchPoints, 0) > 0 || 'ontouchstart' in window,
      dpr: num(window.devicePixelRatio, 1), cores: num(nav.hardwareConcurrency, 0), memory: num(nav.deviceMemory, 0),
      screenW: num(scr.width, 0), screenH: num(scr.height, 0),
      saveData: !!(nav.connection && nav.connection.saveData), gpu: ''
    };
    I.gpu = probeGpu();
    var c = classify(I);
    I.mobile = c.mobile; I.ios = c.ios; I.android = c.android; I.tablet = c.tablet; I.software = c.gpuClass === 0;
    I.tier = c.tier; I.reasons = c.reasons;
    I.standalone = isStandalone(); I.fullscreen = canFullscreen();
    cachedInfo = I;
    return I;
  }
  function isStandalone() {
    if (!hasWin) return false;
    try { if (window.navigator.standalone === true) return true; } catch (e) { /* ignore */ }
    return mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)');
  }
  function canFullscreen() {
    if (!hasWin) return false;
    var d = document, el = d.documentElement;
    return !!((d.fullscreenEnabled || d.webkitFullscreenEnabled) && (el.requestFullscreen || el.webkitRequestFullscreen));
  }

  /* ------------------------------------------------------------ auto tier + learning */
  function learned() {
    try { var o = JSON.parse(storage.get(LS_KEY) || 'null'); return o && tierIdx(o.tier) >= 0 ? o : null; } catch (e) { return null; }
  }
  function autoTier() {
    var I = info(), t = I.tier || 'high', L = learned();
    if (L && L.detected === t) t = minTier(t, L.tier);   // a learned downgrade only counts for the same detection
    return t;
  }
  function resolveQuality(q) {
    if (q === 'auto' || !q) return autoTier();
    return ALL.indexOf(q) >= 0 ? q : autoTier();
  }
  /** Remember the tier the governors settled on for 'Auto' (or forget it when it matches the detection again). */
  function learn(tier, detected) {
    if (tierIdx(tier) < 0) return;
    var d = detected || info().tier;
    if (tier === d) storage.remove(LS_KEY);
    else storage.set(LS_KEY, JSON.stringify({ tier: tier, detected: d, at: Date.now() }));
  }

  /* ------------------------------------------------------------ audio unlock (iOS) */
  var contexts = [];
  function unlockAudio() {
    for (var i = contexts.length - 1; i >= 0; i--) {
      var c = contexts[i];
      if (!c || c.state === 'closed') { contexts.splice(i, 1); continue; }
      if (c.state === 'suspended' || c.state === 'interrupted') {
        try { var p = c.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ }
      }
      if (!c.__cbPrimed) {
        // iOS: playing one silent buffer inside the gesture is what actually unlocks the output on older WebKit
        try {
          var b = c.createBuffer(1, 1, 22050), s = c.createBufferSource();
          s.buffer = b; s.connect(c.destination); if (s.start) s.start(0); else if (s.noteOn) s.noteOn(0);
          c.__cbPrimed = true;
        } catch (e2) { /* ignore */ }
      }
    }
  }
  function wrapAudio() {
    if (!hasWin) return;
    ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
      var Orig = window[name];
      if (typeof Orig !== 'function' || Orig.__cbWrapped) return;
      try {
        var Wrapped = function (o) {
          var c = arguments.length ? new Orig(o) : new Orig();
          contexts.push(c);
          return c;
        };
        Wrapped.prototype = Orig.prototype;
        Wrapped.__cbWrapped = true;
        Object.defineProperty(Wrapped, 'name', { value: name });
        window[name] = Wrapped;
      } catch (e) { /* leave the native constructor */ }
    });
    var onG = function () { if (contexts.length) unlockAudio(); };
    ['touchend', 'pointerup', 'click', 'keydown'].forEach(function (ev) {
      try { window.addEventListener(ev, onG, { capture: true, passive: true }); } catch (e) { /* ignore */ }
    });
    try {
      document.addEventListener('visibilitychange', function () { if (!document.hidden) onG(); });
      window.addEventListener('pageshow', onG);
    } catch (e3) { /* ignore */ }
  }

  function tagHtml() {
    if (!hasWin) return;
    try {
      var I = info(), cl = document.documentElement.classList;
      if (I.touch) cl.add('cb-touch');
      if (I.mobile) cl.add('cb-mobile');
      if (I.ios) cl.add('cb-ios');
      if (I.standalone) cl.add('cb-standalone');
      if (!I.fullscreen) cl.add('cb-no-fullscreen');
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ iPhone 'Add to Home Screen' hint */
  var HINT_KEY = 'forge.hint.standalone.v1';
  /** PURE: should the standalone hint show? (iOS, no Fullscreen API, not already standalone, not dismissed, driving route) */
  function wantsStandaloneHint(I, hash, seen) {
    return !!(I && I.ios && !I.standalone && !I.fullscreen && !seen && /^#\/(race|drift)(\/|\?|$)/.test(String(hash || '')));
  }
  function standaloneHint(force) {
    if (!hasWin) return false;
    var I = info();
    if (!force && !wantsStandaloneHint(I, location.hash, storage.get(HINT_KEY))) return false;
    if (document.getElementById('cb-standalone-hint')) return false;
    storage.set(HINT_KEY, '1');
    var el = document.createElement('div');
    el.id = 'cb-standalone-hint'; el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom));z-index:2147482000;' +
      'display:flex;align-items:center;gap:10px;max-width:min(520px,calc(100vw - 24px));padding:8px 8px 8px 14px;border-radius:14px;' +
      'background:rgba(16,17,20,.94);border:1px solid rgba(255,255,255,.14);color:#e9e6df;font:500 13px/1.35 system-ui,-apple-system,sans-serif;' +
      'box-shadow:0 12px 30px rgba(0,0,0,.5);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)';
    el.innerHTML = '<span>Play full screen: tap <b>Share</b> \u2192 <b>Add to Home Screen</b>, then open the game from your home screen.</span>' +
      '<button type="button" aria-label="Dismiss" style="flex:none;min-width:40px;min-height:40px;border:0;border-radius:10px;background:rgba(255,255,255,.08);color:inherit;font:600 18px system-ui;cursor:pointer">\u00d7</button>';
    var close = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    el.querySelector('button').addEventListener('click', close);
    setTimeout(close, 12000);
    document.body.appendChild(el);
    return true;
  }
  function watchRoutes() {
    var check = function () { setTimeout(function () { try { standaloneHint(false); } catch (e) { /* ignore */ } }, 1500); };
    try { window.addEventListener('hashchange', check); document.addEventListener('DOMContentLoaded', check); } catch (e) { /* ignore */ }
  }

  if (hasWin) { wrapAudio(); tagHtml(); watchRoutes(); }

  return {
    info: info, classify: classify, autoTier: autoTier, resolveQuality: resolveQuality, learn: learn, learned: learned,
    createStartupGovernor: createStartupGovernor, stepDown: stepDown, minTier: minTier, gpuClass: gpuClass,
    isStandalone: isStandalone, canFullscreen: canFullscreen, wantsStandaloneHint: wantsStandaloneHint, standaloneHint: standaloneHint, storage: storage, unlockAudio: unlockAudio,
    TIERS: TIERS.slice(), _contexts: contexts, _reset: function () { cachedInfo = null; mem = {}; }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CB.device;

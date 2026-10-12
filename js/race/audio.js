/* FORGE Atelier — Race Mode: procedural audio (CB.race.audio)
 *
 * Contract (docs/RACE-SPEC.md "Inter-module contracts"):
 *   CB.race.audio.create() -> { start(), update(snap), setMuted(bool), destroy() }
 *   - handles snap.events itself
 *   - never throws when AudioContext is unavailable (Node, locked-down browsers)
 *   - only starts producing sound after start() is called from a user gesture
 *
 * Extras on the instance: setVolume(0..1), getVolume(), isMuted(), toggleMute(), isAvailable(), isRunning(),
 *   suspend(), resume(), setChannelLevel('engine'|'tires'|'ambience'|'sfx'|'ai'|'ui', 0..1), debug().
 * Pure helpers on the module (usable from Node tests): profileFromBuild(build), firingFrequency(rpm, cylinders),
 *   attenuation(distance_m), spatialize(listener, source), harmonicTable(profile), shaperCurve(amount, n).
 *
 * Everything is synthesised at runtime (no samples): oscillators with per-layout harmonic tables, amplitude-modulated
 * noise for combustion pulses / diesel clatter / rumble strips, filtered noise for tyres, wind, rain, gravel,
 * scheduled one-shots for crackles, pops, blow-off valves, impacts, scrapes, countdown beeps and UI chimes.
 *
 * Signal graph:
 *   [player engine] ─┐
 *   [player tyres]  ─┤
 *   [ambience]      ─┼─> liveBus (ducked when paused) ─┐
 *   [AI voices x3]  ─┘                                 ├─> mixBus ─> compressor ─> masterGain ─> destination
 *   [one-shot sfx]  ──> sfxBus ────────────────────────┤
 *   [ui beeps]      ──> uiBus  ────────────────────────┘
 */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

CB.race.audio = (function () {
  'use strict';

  // ---------------------------------------------------------------------------------------------------------------
  // Small math helpers (local; CB.util may not exist yet)
  // ---------------------------------------------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function smoothstep(e0, e1, x) { var t = clamp01((x - e0) / ((e1 - e0) || 1)); return t * t * (3 - 2 * t); }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Catalog fallbacks (CB.data may be missing / incomplete while the configurator is built concurrently)
  // ---------------------------------------------------------------------------------------------------------------
  var LAYOUTS = {
    'I3':       { cylinders: 3,  uneven: 0.38, smooth: 0.45, odd: 1.25, rasp: 0.55, character: 'thrum' },
    'I4':       { cylinders: 4,  uneven: 0.08, smooth: 0.55, odd: 0.90, rasp: 0.50, character: 'buzz' },
    'I5':       { cylinders: 5,  uneven: 0.32, smooth: 0.65, odd: 1.30, rasp: 0.60, character: 'warble' },
    'I6':       { cylinders: 6,  uneven: 0.04, smooth: 0.95, odd: 0.80, rasp: 0.40, character: 'silk' },
    'V6':       { cylinders: 6,  uneven: 0.16, smooth: 0.70, odd: 1.05, rasp: 0.55, character: 'growl' },
    'V8':       { cylinders: 8,  uneven: 0.48, smooth: 0.75, odd: 1.10, rasp: 0.60, character: 'burble' },
    'V10':      { cylinders: 10, uneven: 0.18, smooth: 0.80, odd: 1.20, rasp: 0.70, character: 'shriek' },
    'V12':      { cylinders: 12, uneven: 0.03, smooth: 1.00, odd: 0.95, rasp: 0.55, character: 'scream' },
    'W16':      { cylinders: 16, uneven: 0.10, smooth: 0.95, odd: 0.85, rasp: 0.45, character: 'roar' },
    'flat-4':   { cylinders: 4,  uneven: 0.58, smooth: 0.50, odd: 1.15, rasp: 0.60, character: 'boxer' },
    'flat-6':   { cylinders: 6,  uneven: 0.12, smooth: 0.85, odd: 1.10, rasp: 0.65, character: 'wail' },
    'rotary-2': { cylinders: 4,  uneven: 0.10, smooth: 0.60, odd: 1.60, rasp: 0.90, character: 'brap', rotary: true }
  };
  var ASPIRATIONS = {
    'na':             { turbo: 0, turbos: 0, supercharger: 0, lag: 0,    boost: 0 },
    'turbo':          { turbo: 1, turbos: 1, supercharger: 0, lag: 0.60, boost: 1.0 },
    'twin-turbo':     { turbo: 1, turbos: 2, supercharger: 0, lag: 0.45, boost: 1.2 },
    'quad-turbo':     { turbo: 1, turbos: 4, supercharger: 0, lag: 0.35, boost: 1.5 },
    'supercharged':   { turbo: 0, turbos: 0, supercharger: 1, lag: 0.02, boost: 0.8 },
    'twincharged':    { turbo: 1, turbos: 1, supercharger: 1, lag: 0.20, boost: 1.4 },
    'electric-turbo': { turbo: 1, turbos: 1, supercharger: 0, lag: 0.08, boost: 1.3, eturbo: true }
  };
  var EXHAUST_DB = { 'stock': 78, 'sport': 86, 'titanium': 90, 'valvetronic': 92, 'straight-pipe': 101 };

  function findById(list, id) {
    if (!list || !id) return null;
    if (Array.isArray(list)) { for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i]; return null; }
    if (typeof list === 'object') return list[id] || null;
    return null;
  }
  function catalog() { return (CB && CB.data) || {}; }

  // ---------------------------------------------------------------------------------------------------------------
  // Sound profile derived from a Build (pure; Node-safe)
  // ---------------------------------------------------------------------------------------------------------------
  function profileFromBuild(build) {
    build = build || {};
    var eng = build.engine || {};
    var trans = build.transmission || {};
    var data = catalog();
    var type = eng.type === 'ev' || eng.type === 'hybrid' ? eng.type : 'ice';
    var layoutId = LAYOUTS[eng.layout] ? eng.layout : (findById(data.engineLayouts, eng.layout) ? eng.layout : 'V8');
    var lay = LAYOUTS[layoutId] || LAYOUTS.V8;
    var cat = findById(data.engineLayouts, layoutId) || {};
    var cylinders = num(cat.cylinders, lay.cylinders);
    if (lay.rotary) cylinders = Math.max(2, num(cat.cylinders, 2)) * 2; // each rotor ≈ 2 "cylinders" of firing events
    var smooth = num(cat.smoothness, lay.smooth);
    var sp = cat.soundProfile;
    var asp = ASPIRATIONS[eng.aspiration] || ASPIRATIONS.na;
    var aspCat = findById(data.aspirations, eng.aspiration) || {};
    var exCat = findById(data.exhausts, eng.exhaust) || {};
    var exDb = num(exCat.loudness_db, EXHAUST_DB[eng.exhaust] != null ? EXHAUST_DB[eng.exhaust] : 82);
    var loud = clamp01((exDb - 74) / 28);
    var diesel = eng.fuel === 'diesel';
    var redline = clamp(num(eng.redline_rpm, diesel ? 4800 : 7000), 3500, 12000);
    var boost = asp.turbo || asp.supercharger ? clamp(num(eng.boost_bar, asp.boost), 0.2, 3) : 0;
    var disp = clamp(num(eng.displacement_l, 3), 0.6, 9);
    var motors = clamp(Math.round(num(eng.motors, 1)), 1, 4);
    var straightCut = trans.type === 'sequential' || trans.type === 'manual' && /race|dog/i.test(String(trans.variant || ''));
    var seed = hashStr(JSON.stringify([type, layoutId, eng.aspiration, eng.exhaust, disp, eng.fuel, motors]));
    var p = {
      type: type,
      ev: type === 'ev',
      hybrid: type === 'hybrid',
      layout: layoutId,
      character: lay.character,
      rotary: !!lay.rotary,
      cylinders: cylinders,
      smooth: clamp01(smooth),
      uneven: clamp01(num(sp && sp.uneven, lay.uneven)),
      oddBias: num(sp && sp.odd, lay.odd),
      rasp: clamp01(num(sp && sp.rasp, lay.rasp) * (0.6 + loud * 0.7)),
      displacement_l: disp,
      // bigger displacement per cylinder -> deeper, heavier pulses
      body: clamp01((disp / Math.max(1, cylinders)) / 0.8),
      redline: redline,
      idle: diesel ? 750 : (lay.rotary ? 1000 : 850),
      diesel: diesel,
      aspiration: eng.aspiration || 'na',
      turbo: !!asp.turbo,
      turbos: asp.turbos || 0,
      eturbo: !!asp.eturbo,
      supercharger: !!asp.supercharger,
      lag: clamp01(num(aspCat.lag, asp.lag)),
      boost: boost,
      exhaust: eng.exhaust || 'stock',
      exhaustDb: exDb,
      loud: loud,
      popsy: clamp01(loud * 1.15 - 0.1 + (lay.rotary ? 0.25 : 0) + (asp.turbo ? 0.1 : 0)),
      motors: motors,
      motorKw: num(eng.motorPower_kw, 200),
      voltage: num(eng.voltage, 400),
      straightCut: !!straightCut,
      transmission: trans.type || 'auto',
      seed: seed,
      harmonics: null
    };
    if (p.ev) { p.redline = 16000; p.idle = 0; p.turbo = p.supercharger = false; p.loud = 0; p.popsy = 0; }
    p.harmonics = sp && Array.isArray(sp.harmonics) ? sp.harmonics.slice(0, 32) : harmonicTable(p);
    return p;
  }

  // Harmonic amplitude table for the engine's main PeriodicWave. Index 0 = DC (unused).
  function harmonicTable(p) {
    var rnd = mulberry32(p.seed || 1);
    var n = 24, amps = [0];
    var roll = 1.05 + p.smooth * 0.75 - p.loud * 0.35 - (p.rotary ? 0.25 : 0);
    for (var k = 1; k < n; k++) {
      var a = Math.pow(k, -roll);
      if (k % 2 === 1 && k > 1) a *= p.oddBias;
      // formant-ish bump (exhaust resonance) around harmonic 3..6
      a *= 1 + 0.6 * p.rasp * Math.exp(-Math.pow((k - 4.5) / 1.8, 2));
      a *= 0.85 + rnd() * 0.3;
      amps.push(a);
    }
    return amps;
  }

  function firingFrequency(rpm, cylinders) {
    return Math.max(0, num(rpm, 0)) / 60 * Math.max(1, num(cylinders, 4)) / 2;
  }

  // Distance attenuation: near-field flat, then inverse-square-ish rolloff, hard cutoff at ~220 m.
  function attenuation(d) {
    d = Math.max(0, num(d, 0));
    var ref = 9;
    var g = 1 / (1 + Math.pow(d / ref, 1.6));
    return d > 220 ? 0 : g * (1 - smoothstep(150, 220, d));
  }

  // Listener-relative mixing parameters. listener/source: {x, y, heading, speed}
  function spatialize(listener, source) {
    var dx = num(source.x, 0) - num(listener.x, 0);
    var dy = num(source.y, 0) - num(listener.y, 0);
    var d = Math.sqrt(dx * dx + dy * dy);
    var h = num(listener.heading, 0);
    var ch = Math.cos(h), sh = Math.sin(h);
    var fwd = dx * ch + dy * sh;
    var left = -dx * sh + dy * ch;
    var pan = d > 0.01 ? clamp(-left / Math.max(d, 4), -1, 1) * 0.9 : 0;
    // Doppler from radial relative velocity (positive = receding)
    var lv = num(listener.speed, 0), sv = num(source.speed, 0);
    var sh2 = num(source.heading, 0);
    var rvx = Math.cos(sh2) * sv - ch * lv;
    var rvy = Math.sin(sh2) * sv - sh * lv;
    var radial = d > 0.5 ? (rvx * dx + rvy * dy) / d : 0;
    var doppler = clamp(343 / (343 + radial), 0.8, 1.25);
    var behind = d > 0.01 ? clamp01(-fwd / d) : 0;
    return { distance: d, gain: attenuation(d), pan: pan, doppler: doppler, behind: behind, forward: fwd, left: left };
  }

  // Soft-clip transfer curve for exhaust rasp. Pure.
  function shaperCurve(amount, n) {
    n = n || 2048;
    var k = Math.max(0.001, amount);
    var c = typeof Float32Array !== 'undefined' ? new Float32Array(n) : new Array(n);
    var norm = (1 + k) / (1 + k); // = 1 at x=1
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      // asymmetric for even-harmonic grit
      var y = (1 + k) * x / (1 + k * Math.abs(x));
      if (x > 0) y *= 0.96;
      c[i] = y / norm;
    }
    return c;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Settings persistence
  // ---------------------------------------------------------------------------------------------------------------
  var LS_KEY = 'forge.race.audio.v1';
  function loadSettings() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveSettings(s) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  function getAudioContextCtor() {
    try {
      var g = typeof window !== 'undefined' ? window : globalThis;
      return g.AudioContext || g.webkitAudioContext || null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Instance
  // ---------------------------------------------------------------------------------------------------------------
  function create(opts) {
    opts = opts || {};
    var saved = loadSettings() || {};
    var settings = {
      muted: typeof opts.muted === 'boolean' ? opts.muted : !!saved.muted,
      volume: clamp01(num(opts.volume, num(saved.volume, 0.8))),
      levels: { engine: 1, tires: 1, ambience: 1, sfx: 1, ai: 1, ui: 1 }
    };
    if (saved.levels) for (var lk in settings.levels) if (typeof saved.levels[lk] === 'number') settings.levels[lk] = clamp01(saved.levels[lk]);

    var Ctor = getAudioContextCtor();
    var ctx = null, destroyed = false, started = false, failed = !Ctor;
    var nodes = null;          // graph root nodes
    var player = null;         // player engine voice
    var tires = null, amb = null;
    var aiVoices = [];
    var noise = null;          // {white, pink, brown} buffers
    var activeOneShots = 0;
    var MAX_ONESHOTS = 40;
    var gestureHooked = false;
    var lastCtxTime = 0;
    var lastSnapT = null, frozenFrames = 0, paused = false;
    var profileCache = {};     // carId -> {key, profile}
    var st = freshState();
    var rnd = Math.random;

    function freshState() {
      return {
        lightsOn: 0, lightsOut: false, phase: null,
        prevGear: null, prevThrottle: 0, throttleHist: [], prevRpm: 0,
        spool: 0, spoolTarget: 0, bovCooldown: 0, popCooldown: 0, limiterPopCooldown: 0,
        shiftDip: 0, limiting: false, impactCooldown: {}, lastFinalLapLap: -1, playerId: null,
        scrapeLevel: 0, scrapeDecay: 0
      };
    }

    // ---- safe AudioParam helpers --------------------------------------------------------------------------------
    function now() { return ctx ? ctx.currentTime : 0; }
    /* Every setTargetAtTime() adds an automation event that Chrome keeps on the param's timeline; issuing ~80 of them
       per frame with unchanged targets makes the timelines (and the cost of each further call) grow during a race.
       So a param is only re-targeted when its target moved noticeably, or after a short refresh interval. */
    function setP(param, v, tc) {
      if (!param || !isFinite(v)) return;
      tc = tc == null ? 0.03 : tc;
      var t = ctx.currentTime, lv = param._cbV, lt = param._cbT;
      if (lv !== undefined && param._cbTc === tc) {
        var d = Math.abs(v - lv), scale = Math.max(Math.abs(v), Math.abs(lv), 1e-3);
        if (d <= 1e-5 || (d / scale < 0.004 && t - lt < 0.25)) return;
        if (t - lt < 0.012 && d / scale < 0.05) return;                  // > 80 Hz retargeting of small moves is inaudible
      }
      param._cbV = v; param._cbT = t; param._cbTc = tc;
      try { param.setTargetAtTime(v, t, tc); } catch (e) { try { param.value = v; } catch (e2) { /* ignore */ } }
    }
    function setNow(param, v) {
      if (!param || !isFinite(v)) return;
      param._cbV = undefined;
      try { param.cancelScheduledValues(ctx.currentTime); param.setValueAtTime(v, ctx.currentTime); } catch (e) { try { param.value = v; } catch (e2) { /* ignore */ } }
    }
    function freq(v) { var ny = ctx ? ctx.sampleRate * 0.45 : 20000; return clamp(num(v, 1), 1, ny); }

    function makePanner(dest) {
      var p = null;
      try {
        if (ctx.createStereoPanner) {
          p = ctx.createStereoPanner();
          p.connect(dest);
          return { node: p, set: function (v, tc) { setP(p.pan, clamp(v, -1, 1), tc); } };
        }
      } catch (e) { /* fallthrough */ }
      try {
        p = ctx.createPanner();
        p.panningModel = 'equalpower';
        p.connect(dest);
        return {
          node: p,
          set: function (v) {
            v = clamp(v, -1, 1);
            try { p.setPosition(v, 0, 1 - Math.abs(v)); } catch (e) { /* ignore */ }
          }
        };
      } catch (e2) {
        var g = ctx.createGain(); g.connect(dest);
        return { node: g, set: function () {} };
      }
    }

    function makeNoiseBuffers() {
      var sr = ctx.sampleRate, len = Math.floor(sr * 2.5);
      var r = mulberry32(0xF0A6E);
      var white = ctx.createBuffer(1, len, sr), pink = ctx.createBuffer(1, len, sr), brown = ctx.createBuffer(1, len, sr);
      var w = white.getChannelData(0), pk = pink.getChannelData(0), br = brown.getChannelData(0);
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
      for (var i = 0; i < len; i++) {
        var x = r() * 2 - 1;
        w[i] = x;
        // Paul Kellet pink filter
        b0 = 0.99886 * b0 + x * 0.0555179; b1 = 0.99332 * b1 + x * 0.0750759; b2 = 0.96900 * b2 + x * 0.1538520;
        b3 = 0.86650 * b3 + x * 0.3104856; b4 = 0.55000 * b4 + x * 0.5329522; b5 = -0.7616 * b5 - x * 0.0168980;
        pk[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11; b6 = x * 0.115926;
        last = (last + 0.02 * x) / 1.02; br[i] = last * 3.5;
      }
      // crossfade loop seam
      var fade = Math.floor(sr * 0.02);
      [w, pk, br].forEach(function (d) {
        for (var j = 0; j < fade; j++) { var t = j / fade; d[j] = d[j] * t + d[len - fade + j] * (1 - t); }
      });
      return { white: white, pink: pink, brown: brown };
    }

    function loopNoise(kind, rate) {
      var s = ctx.createBufferSource();
      s.buffer = noise[kind || 'white'];
      s.loop = true;
      s.loopStart = 0; s.loopEnd = s.buffer.duration - 0.02;
      if (rate) s.playbackRate.value = rate;
      // random offset so layers using the same buffer don't comb-filter
      try { s.start(0, rnd() * (s.buffer.duration - 0.1)); } catch (e) { s.start(0); }
      return s;
    }
    function osc(type, f) {
      var o = ctx.createOscillator();
      if (type && typeof type === 'object') { try { o.setPeriodicWave(type); } catch (e) { o.type = 'sawtooth'; } }
      else o.type = type || 'sine';
      o.frequency.value = freq(f || 50);
      o.start(0);
      return o;
    }
    function gain(v, dest) { var g = ctx.createGain(); g.gain.value = v == null ? 1 : v; if (dest) g.connect(dest); return g; }
    function filter(type, f, q, dest) {
      var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq(f); if (q != null) b.Q.value = q;
      if (dest) b.connect(dest); return b;
    }
    // Amplitude modulator: returns {input, output, setRate, setDepth}; output = input * (1 - depth + depth*lfo)
    function amMod(dest, lfoType) {
      var g = gain(0.5, dest);
      var lfo = osc(lfoType || 'sine', 20);
      var depth = gain(0.5); lfo.connect(depth); depth.connect(g.gain);
      return {
        input: g, lfo: lfo,
        setRate: function (f, tc) { setP(lfo.frequency, freq(f), tc == null ? 0.02 : tc); },
        setDepth: function (d, tc) { d = clamp01(d) * 0.5; setP(g.gain, 1 - d, tc); setP(depth.gain, d, tc); },
        stop: function () { try { lfo.stop(); } catch (e) { /* ignore */ } }
      };
    }
    function stopAll(list) { list.forEach(function (n) { try { n.stop(); } catch (e) { /* ignore */ } try { n.disconnect(); } catch (e2) { /* ignore */ } }); }

    // ---- graph -----------------------------------------------------------------------------------------------------
    function buildGraph() {
      noise = makeNoiseBuffers();
      var master = gain(0);
      master.connect(ctx.destination);
      var comp = ctx.createDynamicsCompressor();
      try {
        comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 5;
        comp.attack.value = 0.004; comp.release.value = 0.22;
      } catch (e) { /* ignore */ }
      comp.connect(master);
      // gentle "air" shelf after compression is skipped; a low shelf adds chassis weight to the whole mix
      var tone = filter('lowshelf', 120, null, comp); tone.gain.value = 2.5;
      var mix = gain(0.9, tone);
      var live = gain(1, mix);
      var sfx = gain(settings.levels.sfx, mix);
      var ui = gain(0.55 * settings.levels.ui, mix);
      var engineBus = gain(settings.levels.engine, live);
      var tireBus = gain(settings.levels.tires, live);
      var ambBus = gain(settings.levels.ambience, live);
      var aiBus = gain(settings.levels.ai, live);
      nodes = { master: master, comp: comp, mix: mix, live: live, sfx: sfx, ui: ui, engine: engineBus, tires: tireBus, amb: ambBus, ai: aiBus };
      tires = buildTires();
      amb = buildAmbience();
      for (var i = 0; i < 3; i++) aiVoices.push(buildAIVoice(i));
      applyMaster(0.05);
    }

    function applyMaster(tc) {
      if (!nodes) return;
      setP(nodes.master.gain, settings.muted ? 0 : settings.volume * settings.volume * 0.9, tc == null ? 0.05 : tc);
    }

    // ---- player engine voice ---------------------------------------------------------------------------------------
    function buildEngineVoice(p) {
      var v = { profile: p, srcs: [], out: gain(0, nodes.engine) };
      // exhaust resonance & rasp chain
      var limiter = gain(1, v.out);
      var limLfo = osc('square', 18);
      var limDepth = gain(0); limLfo.connect(limDepth); limDepth.connect(limiter.gain);
      v.limiter = limiter; v.limLfo = limLfo; v.limDepth = limDepth; v.srcs.push(limLfo);

      var drone = filter('peaking', 90 + (1 - p.body) * 120, 1.4, limiter); drone.gain.value = 3 + p.loud * 6;
      var lp = filter('lowpass', 900, 0.9 + p.loud * 2.5, drone);
      var lp2 = filter('lowpass', 6000, 0.5, lp);
      var shaper = ctx.createWaveShaper();
      shaper.curve = shaperCurve(2 + p.loud * 16 + p.rasp * 6);
      try { shaper.oversample = '2x'; } catch (e) { /* ignore */ }
      shaper.connect(lp2);
      var drive = gain(1, shaper);
      v.lp = lp; v.lp2 = lp2; v.drive = drive; v.drone = drone;

      if (!p.ev) {
        // main firing tone with custom harmonic table
        var wave = null;
        try {
          var real = new Float32Array(p.harmonics.length), imag = new Float32Array(p.harmonics.length);
          for (var i = 1; i < p.harmonics.length; i++) imag[i] = p.harmonics[i];
          wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
        } catch (e) { wave = null; }
        v.fund = osc(wave || 'sawtooth', 40); v.fundG = gain(0.55, drive); v.fund.connect(v.fundG);
        // half-order (uneven firing / cross-plane burble / boxer rumble)
        v.sub = osc('triangle', 20); v.subG = gain(0.2 + p.uneven * 0.6, drive); v.sub.connect(v.subG);
        // second-order harmonic layer, swells with throttle
        v.hi = osc('sawtooth', 80); v.hiG = gain(0.1, drive); v.hi.connect(v.hiG);
        // crankshaft rotation thump
        v.crank = osc('sine', 12); v.crankG = gain(0.15 + p.body * 0.25, limiter); v.crank.connect(v.crankG);
        // slightly detuned twin of the fundamental for bank-to-bank beating (V engines)
        v.det = osc('sawtooth', 40); v.detG = gain(/^V|^W|flat/.test(p.layout) ? 0.18 : 0.06, drive); v.det.connect(v.detG);
        // combustion pulse noise: noise -> bandpass -> AM at firing rate
        var combAM = amMod(drive, 'sawtooth');
        v.combBP = filter('bandpass', 400, 1.1, combAM.input);
        v.combN = loopNoise('white'); v.combG = gain(0.0, v.combBP); v.combN.connect(v.combG);
        v.combAM = combAM; v.srcs.push(combAM.lfo);
        // intake roar (pre-shaper so it doesn't get too dirty, goes to lp2)
        v.intakeBP = filter('bandpass', 700, 0.9, lp2);
        v.intakeN = loopNoise('pink'); v.intakeG = gain(0, v.intakeBP); v.intakeN.connect(v.intakeG);
        // diesel clatter
        if (p.diesel) {
          var clatAM = amMod(limiter, 'square');
          v.clatHP = filter('highpass', 2400, 0.8, clatAM.input);
          v.clatN = loopNoise('white'); v.clatG = gain(0, v.clatHP); v.clatN.connect(v.clatG);
          v.clatAM = clatAM; v.srcs.push(clatAM.lfo, v.clatN);
        }
        v.srcs.push(v.fund, v.sub, v.hi, v.crank, v.det, v.combN, v.intakeN);
        // forced induction
        if (p.turbo) {
          v.turboBP = filter('bandpass', 3000, 8, nodes.engine);
          v.turboA = osc('sine', 3000); v.turboB = osc('triangle', 4500);
          v.turboG = gain(0, v.turboBP); v.turboA.connect(v.turboG);
          v.turboBG = gain(p.turbos > 1 ? 0.5 : 0.2, v.turboG); v.turboB.connect(v.turboBG);
          // rushing air through the compressor
          v.turboN = loopNoise('white'); v.turboNBP = filter('bandpass', 5000, 3, nodes.engine);
          v.turboNG = gain(0, v.turboNBP); v.turboN.connect(v.turboNG);
          v.srcs.push(v.turboA, v.turboB, v.turboN);
        }
        if (p.supercharger) {
          v.scHP = filter('highpass', 600, 0.7, nodes.engine);
          v.scA = osc('sawtooth', 1000); v.scB = osc('sine', 2000);
          v.scG = gain(0, v.scHP); v.scA.connect(v.scG); v.scB.connect(v.scG);
          v.srcs.push(v.scA, v.scB);
        }
      }
      if (p.ev || p.hybrid) {
        // motor whine: stator slot harmonics; multiple motors -> slight detune chorus
        v.evG = gain(0, nodes.engine);
        var evBP = filter('bandpass', 1200, 0.6, v.evG);
        v.evOsc = [];
        for (var m = 0; m < Math.max(1, p.ev ? p.motors : 1); m++) {
          var o1 = osc('sine', 500), o2 = osc('triangle', 750);
          var g1 = gain(0.6 / Math.sqrt(m + 1), evBP), g2 = gain(0.22 / Math.sqrt(m + 1), evBP);
          o1.connect(g1); o2.connect(g2);
          v.evOsc.push({ a: o1, b: o2, detune: 1 + (m - (p.motors - 1) / 2) * 0.006 });
          v.srcs.push(o1, o2);
        }
        // inverter switching tone: stepped square tones (like trains/early EVs), strongest at low speed
        v.invG = gain(0, nodes.engine);
        var invHP = filter('highpass', 500, 0.7, v.invG);
        v.inv = osc('square', 700); v.invGain = gain(0.08, invHP); v.inv.connect(v.invGain);
        v.inv2 = osc('sine', 1400); v.inv2Gain = gain(0.12, invHP); v.inv2.connect(v.inv2Gain);
        // gearbox (single-speed reduction) hum
        v.redG = gain(0, nodes.engine);
        v.red = osc('triangle', 300); v.red.connect(v.redG);
        v.srcs.push(v.inv, v.inv2, v.red);
      }
      if (p.straightCut || p.ev) {
        v.gwG = gain(0, nodes.engine);
        v.gw = osc('sine', 600); v.gw.connect(v.gwG);
        v.srcs.push(v.gw);
      }
      setP(v.out.gain, 1, 0.3);
      return v;
    }

    function destroyEngineVoice(v) {
      if (!v) return;
      try { setP(v.out.gain, 0, 0.05); } catch (e) { /* ignore */ }
      var srcs = v.srcs, out = v.out;
      setTimeout(function () { stopAll(srcs); try { out.disconnect(); } catch (e) { /* ignore */ } }, 300);
    }

    function updateEngineVoice(v, car, dt, snap) {
      var p = v.profile;
      var rpm = clamp(num(car.rpm, p.idle), 0, p.redline * 1.08);
      var redline = num(car.redline, p.redline) || p.redline;
      var rn = clamp01(rpm / redline);
      var thr = clamp01(num(car.throttle, 0));
      var speed = Math.abs(num(car.speed, 0));
      var gear = num(car.gear, 1);
      var tc = 0.025;

      // edge detection --------------------------------------------------------------------------------------
      st.throttleHist.push({ t: now(), v: thr });
      while (st.throttleHist.length && (now() - st.throttleHist[0].t > 0.18 || st.throttleHist.length > 48)) st.throttleHist.shift();
      var maxRecentThr = 0; st.throttleHist.forEach(function (h) { if (h.v > maxRecentThr) maxRecentThr = h.v; });
      var lifted = maxRecentThr - thr > 0.45 && thr < 0.25;
      var shiftedUp = st.prevGear != null && gear > st.prevGear && st.prevGear > 0;
      var shiftedDown = st.prevGear != null && gear < st.prevGear && gear > 0;
      st.prevGear = gear;
      st.bovCooldown -= dt; st.popCooldown -= dt; st.limiterPopCooldown -= dt;
      if (shiftedUp || shiftedDown) st.shiftDip = p.ev ? 0 : 0.09;
      st.shiftDip = Math.max(0, st.shiftDip - dt);
      var dipMul = st.shiftDip > 0 ? 0.35 : 1;
      var limiting = !p.ev && rn >= 0.972 && thr > 0.55;

      if (!p.ev) {
        var ff = firingFrequency(rpm, p.cylinders);
        var wobble = 1 + (Math.sin(now() * 7.3) * 0.004 + Math.sin(now() * 2.1) * 0.003) * (1 - p.smooth * 0.6);
        setP(v.fund.frequency, freq(ff * wobble), tc);
        setP(v.det.frequency, freq(ff * (1.006 + p.uneven * 0.01)), tc);
        setP(v.sub.frequency, freq(ff * 0.5), tc);
        setP(v.hi.frequency, freq(ff * 2.0), tc);
        setP(v.crank.frequency, freq(rpm / 60), tc);
        v.combAM.setRate(ff, tc);
        setP(v.combBP.frequency, freq(ff * (2.5 + p.rasp * 2)), tc);
        setP(v.intakeBP.frequency, freq(300 + ff * 3.2), tc);

        var load = thr;
        var over = thr < 0.08 && rn > 0.35 ? 1 : 0; // overrun
        // harmonic balance shifts with throttle: on-throttle = brighter, rougher
        setP(v.fundG.gain, 0.5 + 0.15 * (1 - load), tc);
        setP(v.hiG.gain, 0.04 + load * (0.18 + p.loud * 0.12) * (0.4 + rn), tc);
        setP(v.subG.gain, (0.12 + p.uneven * 0.7) * (1 - rn * 0.5) * (0.6 + 0.4 * (1 - load)), 0.05);
        setP(v.combG.gain, (0.12 + load * 0.55 + over * 0.25) * (0.4 + p.rasp), tc);
        v.combAM.setDepth(0.55 + p.uneven * 0.35, 0.05);
        setP(v.intakeG.gain, load * rn * (p.turbo ? 0.12 : 0.3), tc);
        setP(v.drive.gain, (0.7 + load * (1.2 + p.loud * 2.2) + rn * 0.6) * dipMul, 0.012);
        var cutoff = 260 + p.loud * 500 + rn * (700 + p.loud * 900) + load * (900 + p.loud * 3200) * (0.3 + rn);
        setP(v.lp.frequency, freq(cutoff), 0.04);
        setP(v.lp2.frequency, freq(2500 + p.loud * 6000 + load * 3000), 0.06);
        // overall level: exhaust loudness + load + rpm
        var level = (0.16 + 0.22 * load + 0.2 * rn) * (0.5 + 0.75 * p.loud) * (0.75 + p.body * 0.35);
        if (over) level *= 0.75;
        if (snap && snap.phase === 'finished' && car.finished) level *= 0.75;
        setP(v.out.gain, level * dipMul, 0.02);
        // rev limiter bounce: chop the signal with a square LFO
        if (limiting) {
          setP(v.limLfo.frequency, 13 + p.cylinders * 0.6 + rnd() * 2, 0.02);
          setP(v.limDepth.gain, 0.42, 0.01); setP(v.limiter.gain, 0.58, 0.01);
          if (st.limiterPopCooldown <= 0 && p.popsy > 0.25 && rnd() < 0.25) { crackle(1 + Math.round(p.popsy * 2), 0.5 * p.popsy, 0, 1); st.limiterPopCooldown = 0.12; }
        } else {
          setP(v.limDepth.gain, 0, 0.015); setP(v.limiter.gain, 1, 0.015);
        }
        if (v.clatG) {
          v.clatAM.setRate(ff, tc); v.clatAM.setDepth(0.95);
          setP(v.clatG.gain, (0.05 + 0.12 * (1 - rn)) * (0.6 + load * 0.6), 0.05);
        }

        // turbo spool / whistle / blow-off ------------------------------------------------------------------
        if (p.turbo) {
          var boostOn = clamp01((rn - (0.18 + p.lag * 0.25)) / 0.45);
          var target = thr * boostOn;
          var tauUp = 0.12 + p.lag * 1.4, tauDown = 0.18;
          var k = 1 - Math.exp(-dt / (target > st.spool ? tauUp : tauDown));
          st.spool += (target - st.spool) * k;
          var sp = st.spool;
          var pitch = (p.eturbo ? 4200 : 2600) + sp * (3800 + p.boost * 900) + rn * 900;
          setP(v.turboA.frequency, freq(pitch), 0.05); setP(v.turboB.frequency, freq(pitch * 1.497), 0.05);
          setP(v.turboBP.frequency, freq(pitch * 1.05), 0.05);
          setP(v.turboG.gain, sp * sp * (0.022 + p.boost * 0.012) * (1 + (p.turbos - 1) * 0.15), 0.04);
          setP(v.turboNBP.frequency, freq(2500 + sp * 4000), 0.05);
          setP(v.turboNG.gain, sp * thr * 0.05, 0.05);
          if (lifted && st.spool > 0.4 && st.bovCooldown <= 0 && !p.eturbo) {
            blowOff(st.spool, p.turbos);
            st.bovCooldown = 0.45; st.spool *= 0.25;
          } else if (shiftedUp && st.spool > 0.5 && st.bovCooldown <= 0 && !p.eturbo) {
            blowOff(st.spool * 0.6, p.turbos); st.bovCooldown = 0.35; st.spool *= 0.55;
          }
        }
        if (p.supercharger) {
          var scf = rpm / 60 * 2.6 * 6; // pulley ratio × rotor lobes
          setP(v.scA.frequency, freq(scf), tc); setP(v.scB.frequency, freq(scf * 2.01), tc);
          setP(v.scG.gain, (0.006 + thr * 0.03) * (0.3 + rn) * (0.6 + p.boost * 0.4), 0.04);
        }

        // gear shift crackle & overrun pops -------------------------------------------------------------------
        if (shiftedUp && rn > 0.45 && maxRecentThr > 0.5) crackle(2 + Math.round(p.popsy * 5), 0.35 + p.popsy * 0.6, 0, 1);
        if (shiftedDown && p.popsy > 0.3) crackle(1 + Math.round(p.popsy * 3), 0.3 + p.popsy * 0.4, 0, 1);
        var falling = rpm < st.prevRpm - 2;
        if (thr < 0.06 && rn > 0.5 && falling && st.popCooldown <= 0 && p.popsy > 0.15) {
          if (rnd() < dt * (1 + p.popsy * 9)) { crackle(1 + Math.round(rnd() * p.popsy * 3), 0.25 + p.popsy * 0.5, 0, 1); st.popCooldown = 0.06 + rnd() * 0.15; }
        }
        if (lifted && rn > 0.6 && p.popsy > 0.35) crackle(2 + Math.round(p.popsy * 3), 0.4 + p.popsy * 0.5, 0, 1);
      }

      // EV / hybrid motor ------------------------------------------------------------------------------------------
      if (v.evG) {
        var mrpm = p.ev ? rpm : speed * 60 / (2 * Math.PI * 0.33) * 9;
        var whine = mrpm / 60 * 8;
        var brk = clamp01(num(car.brake, 0));
        var evLoad = Math.max(thr, brk * 0.6);
        v.evOsc.forEach(function (o) {
          setP(o.a.frequency, freq(80 + whine * o.detune), tc);
          setP(o.b.frequency, freq((80 + whine) * 1.5 * o.detune), tc);
        });
        var evLevel = (p.ev ? 1 : 0.4) * (0.02 + evLoad * 0.09) * smoothstep(0, 6, speed + thr * 4) * (0.7 + p.motorKw / 1000);
        setP(v.evG.gain, evLevel, 0.04);
        // inverter steps up through PWM bands as speed rises
        var band = speed < 4 ? 0 : speed < 10 ? 1 : speed < 18 ? 2 : 3;
        var invF = [620, 780, 940, 1180][band] * (p.voltage >= 800 ? 1.25 : 1);
        setP(v.inv.frequency, freq(invF), 0.01); setP(v.inv2.frequency, freq(invF * 2 + whine * 0.1), 0.02);
        setP(v.invG.gain, (p.ev ? 1 : 0.5) * evLoad * 0.05 * (1 - smoothstep(10, 30, speed)), 0.04);
        setP(v.red.frequency, freq(mrpm / 60 * 3.1), tc);
        setP(v.redG.gain, (p.ev ? 0.03 : 0.01) * smoothstep(2, 20, speed) * (0.4 + evLoad), 0.05);
        if (p.ev) setP(v.out.gain, 1, 0.1);
      }
      if (v.gwG) {
        var gwf = speed * (p.ev ? 38 : 26) * (1 + Math.max(0, 6 - gear) * 0.25);
        setP(v.gw.frequency, freq(120 + gwf), tc);
        setP(v.gwG.gain, (p.ev ? 0.006 : 0.014) * smoothstep(3, 25, speed) * (0.4 + thr), 0.05);
      }

      st.prevThrottle = thr; st.prevRpm = rpm; st.limiting = limiting;
    }

    // ---- tyres -----------------------------------------------------------------------------------------------------
    function buildTires() {
      var t = { srcs: [] };
      // squeal: two resonant bands + slow AM for "chatter"
      var am = amMod(nodes.tires, 'triangle');
      t.am = am; t.srcs.push(am.lfo);
      t.n = loopNoise('white');
      t.bp1 = filter('bandpass', 1100, 9, am.input);
      t.bp2 = filter('bandpass', 2300, 14, am.input);
      t.g1 = gain(0, t.bp1); t.g2 = gain(0, t.bp2);
      t.n.connect(t.g1); t.n.connect(t.g2);
      // tonal component: squeals are surprisingly pitched
      t.tone = osc('sawtooth', 900); t.toneBP = filter('bandpass', 1000, 18, am.input); t.toneG = gain(0, t.toneBP); t.tone.connect(t.toneG);
      // wheelspin chirp/scrub (lower, rougher)
      t.spinBP = filter('bandpass', 600, 2, nodes.tires); t.spinG = gain(0, t.spinBP); t.n.connect(t.spinG);
      // rolling road noise
      t.roll = loopNoise('brown'); t.rollLP = filter('lowpass', 200, 0.7, nodes.tires); t.rollG = gain(0, t.rollLP); t.roll.connect(t.rollG);
      // surfaces: gravel crunch (grass/sand), rumble strip
      var gravAM = amMod(nodes.tires, 'square');
      t.gravAM = gravAM; t.srcs.push(gravAM.lfo);
      t.grav = loopNoise('pink', 0.8); t.gravBP = filter('bandpass', 900, 0.7, gravAM.input); t.gravG = gain(0, t.gravBP); t.grav.connect(t.gravG);
      var kerbAM = amMod(nodes.tires, 'square');
      t.kerbAM = kerbAM; t.srcs.push(kerbAM.lfo);
      t.kerbO = osc('triangle', 70); t.kerbG = gain(0, kerbAM.input); t.kerbO.connect(t.kerbG);
      t.kerbN = loopNoise('brown'); t.kerbNG = gain(0, kerbAM.input); t.kerbN.connect(t.kerbNG);
      // wall scrape (sustained while event stream reports wall contact)
      t.scrN = loopNoise('white', 0.7); t.scrBP = filter('bandpass', 1800, 2.5, nodes.tires); t.scrG = gain(0, t.scrBP); t.scrN.connect(t.scrG);
      t.srcs.push(t.n, t.tone, t.roll, t.grav, t.kerbO, t.kerbN, t.scrN);
      return t;
    }

    function updateTires(car, dt, snap) {
      var t = tires;
      var speed = Math.abs(num(car.speed, 0));
      var skid = clamp01(num(car.skidding, 0));
      var spin = clamp01(num(car.wheelspin, 0));
      var brake = clamp01(num(car.brake, 0));
      var wet = snap && (snap.weather === 'wet' ? 1 : snap.weather === 'damp' ? 0.5 : 0) || 0;
      var surface = car.surface || 'asphalt';
      var onAsphalt = surface === 'asphalt' || surface === 'kerb';
      var sf = smoothstep(1.5, 9, speed);
      var lock = brake > 0.4 && skid > 0.3 && spin < 0.2 ? 1 : 0;
      var sq = onAsphalt ? Math.pow(skid, 1.4) * sf * (1 - wet * 0.75) : 0;
      // add nearby AI squeal (mixed into the same voice, attenuated)
      sq = Math.max(sq, st.aiSquealLevel || 0);
      var pitch = 780 + skid * 520 + speed * 3 + lock * 380 + Math.sin(now() * 3.7) * 40;
      setP(t.bp1.frequency, freq(pitch), 0.05);
      setP(t.bp2.frequency, freq(pitch * 2.05), 0.05);
      setP(t.tone.frequency, freq(pitch * 0.995), 0.05);
      setP(t.toneBP.frequency, freq(pitch), 0.05);
      setP(t.g1.gain, sq * 0.9, 0.04);
      setP(t.g2.gain, sq * 0.45, 0.04);
      setP(t.toneG.gain, sq * 0.06, 0.04);
      t.am.setRate(6 + skid * 14 + rnd() * 3, 0.1); t.am.setDepth(0.25 + 0.3 * (1 - skid));
      var spinLvl = onAsphalt ? spin * smoothstep(0, 3, speed + spin * 3) * (1 - wet * 0.5) : 0;
      setP(t.spinBP.frequency, freq(450 + spin * 500), 0.05);
      setP(t.spinG.gain, spinLvl * 0.5, 0.04);
      // rolling
      setP(t.rollLP.frequency, freq(120 + speed * 6 + wet * 600), 0.1);
      setP(t.rollG.gain, smoothstep(0, 60, speed) * (0.35 + wet * 0.4), 0.1);
      // surfaces
      var off = surface === 'grass' ? 0.6 : surface === 'sand' ? 1 : 0;
      t.gravAM.setRate(8 + speed * 1.3 + rnd() * 6, 0.05); t.gravAM.setDepth(0.6);
      setP(t.gravBP.frequency, freq(surface === 'sand' ? 1400 : 700), 0.1);
      setP(t.gravG.gain, off * smoothstep(0, 20, speed) * 0.9, 0.06);
      var kerb = surface === 'kerb' ? 1 : 0;
      t.kerbAM.setRate(clamp(speed / 0.9, 1, 120), 0.02); t.kerbAM.setDepth(0.95);
      setP(t.kerbO.frequency, freq(55 + speed * 0.8), 0.05);
      setP(t.kerbG.gain, kerb * smoothstep(1, 15, speed) * 0.35, 0.03);
      setP(t.kerbNG.gain, kerb * smoothstep(1, 15, speed) * 0.5, 0.03);
      // scrape decays unless refreshed by wall events
      st.scrapeLevel = Math.max(0, st.scrapeLevel - dt * 3.5);
      setP(t.scrBP.frequency, freq(1200 + speed * 25), 0.05);
      setP(t.scrG.gain, st.scrapeLevel * smoothstep(0, 8, speed) * 0.7, 0.03);
    }

    // ---- ambience: wind, rain ----------------------------------------------------------------------------------------
    function buildAmbience() {
      var a = { srcs: [] };
      a.wind = loopNoise('pink'); a.windLP = filter('lowpass', 400, 0.6, nodes.amb); a.windG = gain(0, a.windLP); a.wind.connect(a.windG);
      a.whis = loopNoise('white'); a.whisBP = filter('bandpass', 2500, 1.5, nodes.amb); a.whisG = gain(0, a.whisBP); a.whis.connect(a.whisG);
      a.gust = osc('sine', 0.17); a.gustDepth = gain(0); a.gust.connect(a.gustDepth); a.gustDepth.connect(a.windG.gain);
      a.rain = loopNoise('white', 0.9); a.rainHP = filter('highpass', 3500, 0.5, nodes.amb); a.rainG = gain(0, a.rainHP); a.rain.connect(a.rainG);
      a.rainLow = loopNoise('pink'); a.rainLP = filter('bandpass', 900, 0.5, nodes.amb); a.rainLowG = gain(0, a.rainLP); a.rainLow.connect(a.rainLowG);
      // distant crowd / circuit bed (very subtle)
      a.bed = loopNoise('brown', 0.5); a.bedBP = filter('bandpass', 350, 0.4, nodes.amb); a.bedG = gain(0, a.bedBP); a.bed.connect(a.bedG);
      a.srcs.push(a.wind, a.whis, a.gust, a.rain, a.rainLow, a.bed);
      return a;
    }

    function updateAmbience(car, snap) {
      var a = amb;
      var speed = Math.abs(num(car ? car.speed : 0, 0));
      var sn = clamp01(speed / 85);
      setP(a.windLP.frequency, freq(250 + speed * 28), 0.15);
      var wg = sn * sn * 0.5;
      setP(a.windG.gain, wg, 0.15);
      setP(a.gustDepth.gain, wg * 0.25, 0.3);
      setP(a.whisBP.frequency, freq(1800 + speed * 25), 0.2);
      setP(a.whisG.gain, smoothstep(35, 90, speed) * 0.05, 0.2);
      var wet = snap.weather === 'wet' ? 1 : snap.weather === 'damp' ? 0.35 : 0;
      setP(a.rainG.gain, wet * 0.05, 0.5);
      setP(a.rainLowG.gain, wet * 0.06 + wet * sn * 0.12, 0.3);
      var crowd = snap.phase === 'grid' || snap.phase === 'countdown' ? 0.05 : snap.phase === 'finished' ? 0.07 : 0.02;
      setP(a.bedG.gain, crowd * (snap.timeOfDay === 'night' ? 0.6 : 1), 0.8);
    }

    // ---- AI engine voices (pool of 3) ------------------------------------------------------------------------------
    function buildAIVoice(i) {
      var v = { idx: i, carId: null, profile: null, srcs: [] };
      v.pan = makePanner(nodes.ai);
      v.shadow = filter('lowpass', 8000, 0.5, v.pan.node);   // head shadow when behind + air absorption
      v.out = gain(0, v.shadow);
      v.lp = filter('lowpass', 1200, 1.2, v.out);
      v.shaper = ctx.createWaveShaper(); v.shaper.curve = shaperCurve(6); v.shaper.connect(v.lp);
      v.a = osc('sawtooth', 50); v.aG = gain(0.5, v.shaper); v.a.connect(v.aG);
      v.b = osc('triangle', 25); v.bG = gain(0.3, v.shaper); v.b.connect(v.bG);
      v.c = osc('square', 100); v.cG = gain(0.08, v.shaper); v.c.connect(v.cG);
      v.srcs.push(v.a, v.b, v.c);
      return v;
    }

    function assignAIVoice(v, car) {
      v.carId = car.id;
      v.profile = profileFor(car);
      var p = v.profile;
      try {
        if (p.ev) { v.a.type = 'sine'; v.b.type = 'sine'; v.c.type = 'triangle'; v.shaper.curve = shaperCurve(1); }
        else { v.a.type = 'sawtooth'; v.b.type = 'triangle'; v.c.type = 'square'; v.shaper.curve = shaperCurve(3 + p.loud * 12); }
      } catch (e) { /* ignore */ }
      setP(v.bG.gain, p.ev ? 0.25 : 0.15 + p.uneven * 0.5, 0.05);
      // fade in from silence to avoid a jump in pitch/level being audible as a click
      setNow(v.out.gain, 0);
    }

    function profileFor(car) {
      var key = car.build ? (car.build.engine ? JSON.stringify(car.build.engine) + (car.build.transmission ? car.build.transmission.type : '') : 'x') : 'none';
      var c = profileCache[car.id];
      if (c && c.key === key) return c.profile;
      var prof = profileFromBuild(car.build || {});
      profileCache[car.id] = { key: key, profile: prof };
      return prof;
    }

    function updateAIVoices(snap, listener) {
      var others = [];
      var sqMax = 0;
      (snap.cars || []).forEach(function (c) {
        if (!c || c.id === listener.id || c.isPlayer) return;
        if (c.dnf && !(num(c.speed, 0) > 1)) return;
        var sp = spatialize(listener, c);
        // nearby AI tyre squeal contributes to tyre voice
        var sq = clamp01(num(c.skidding, 0)) * sp.gain * smoothstep(2, 10, Math.abs(num(c.speed, 0)));
        if (sq > sqMax) sqMax = sq;
        others.push({ car: c, sp: sp });
      });
      st.aiSquealLevel = sqMax * 0.6;
      others.sort(function (a, b) { return a.sp.distance - b.sp.distance; });
      var top = others.slice(0, 3).filter(function (o) { return o.sp.gain > 0.002; });
      var topIds = {}; top.forEach(function (o) { topIds[o.car.id] = o; });
      // free voices whose car left the top 3
      aiVoices.forEach(function (v) { if (v.carId != null && !topIds[v.carId]) { v.carId = null; setP(v.out.gain, 0, 0.08); } });
      // keep stable assignments, give freed voices to new cars
      top.forEach(function (o) {
        var has = aiVoices.some(function (v) { return v.carId === o.car.id; });
        if (!has) {
          var free = null;
          for (var i = 0; i < aiVoices.length; i++) if (aiVoices[i].carId == null) { free = aiVoices[i]; break; }
          if (free) assignAIVoice(free, o.car);
        }
      });
      aiVoices.forEach(function (v) {
        if (v.carId == null) return;
        var o = topIds[v.carId]; if (!o) return;
        var c = o.car, sp = o.sp, p = v.profile;
        var rpm = clamp(num(c.rpm, p.idle), 0, p.redline * 1.08);
        var redline = num(c.redline, p.redline) || p.redline;
        var rn = clamp01(rpm / redline), thr = clamp01(num(c.throttle, 0.5));
        var f;
        if (p.ev) {
          f = (80 + rpm / 60 * 8) * sp.doppler;
          setP(v.a.frequency, freq(f), 0.03); setP(v.b.frequency, freq(f * 1.5), 0.03); setP(v.c.frequency, freq(f * 2.01), 0.03);
          setP(v.lp.frequency, freq(3500), 0.1);
        } else {
          f = firingFrequency(rpm, p.cylinders) * sp.doppler;
          setP(v.a.frequency, freq(f), 0.03); setP(v.b.frequency, freq(f * 0.5), 0.03); setP(v.c.frequency, freq(f * 2), 0.03);
          setP(v.lp.frequency, freq(300 + rn * 1200 + thr * (800 + p.loud * 2000)), 0.05);
        }
        var lvl = (p.ev ? 0.12 : (0.2 + 0.25 * thr + 0.15 * rn) * (0.5 + 0.8 * p.loud)) * sp.gain;
        setP(v.out.gain, lvl * 1.4, 0.05);
        v.pan.set(sp.pan, 0.04);
        // behind -> darker; distance -> air absorption
        setP(v.shadow.frequency, freq(lerp(9000, 2200, sp.behind * 0.8) * lerp(1, 0.45, clamp01(sp.distance / 160))), 0.08);
      });
    }

    // ---- one-shot synthesis ----------------------------------------------------------------------------------------
    function oneShotGuard() { return ctx && nodes && activeOneShots < MAX_ONESHOTS && !destroyed; }
    function track(src, chain, end) {
      activeOneShots++;
      var done = false;
      function finish() {
        if (done) return; done = true; activeOneShots = Math.max(0, activeOneShots - 1);
        chain.forEach(function (n) { try { n.disconnect(); } catch (e) { /* ignore */ } });
      }
      src.onended = finish;
      try { src.stop(end); } catch (e) { /* ignore */ }
      // safety net in case onended never fires (context closed / browser quirks)
      try { setTimeout(finish, Math.max(0, (end - now())) * 1000 + 1500); } catch (e) { /* ignore */ }
    }
    function spatialOut(dest, pan, level) {
      var g = gain(level == null ? 1 : level);
      if (pan && Math.abs(pan) > 0.02) { var pn = makePanner(dest); pn.set(pan, 0.001); try { pn.node.pan && (pn.node.pan.value = clamp(pan, -1, 1)); } catch (e) { /* ignore */ } g.connect(pn.node); return { g: g, extra: [pn.node] }; }
      g.connect(dest); return { g: g, extra: [] };
    }

    // noise burst with an envelope and optionally sweeping filter
    function noiseBurst(o) {
      if (!oneShotGuard()) return;
      var t0 = now() + (o.delay || 0);
      var dur = o.dur || 0.2;
      var src = ctx.createBufferSource(); src.buffer = noise[o.kind || 'white'];
      if (o.rate) src.playbackRate.value = o.rate;
      var f = filter(o.type || 'bandpass', o.freq || 1000, o.Q == null ? 1 : o.Q);
      var out = spatialOut(o.dest || nodes.sfx, o.pan, 1);
      var env = gain(0); f.connect(env); env.connect(out.g); src.connect(f);
      var peak = Math.max(0.0001, o.gain == null ? 0.5 : o.gain);
      var atk = o.attack || 0.004;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + atk);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      if (o.freqEnd) { f.frequency.setValueAtTime(freq(o.freq), t0); f.frequency.exponentialRampToValueAtTime(freq(o.freqEnd), t0 + dur); }
      if (o.am) { // flutter
        var lfo = ctx.createOscillator(); lfo.frequency.value = o.am; var d = gain(peak * 0.6); lfo.connect(d); d.connect(env.gain);
        lfo.start(t0); try { lfo.stop(t0 + dur + 0.05); } catch (e) { /* ignore */ }
        out.extra.push(lfo, d);
      }
      src.start(t0, rnd() * (src.buffer.duration - dur - 0.1 > 0 ? src.buffer.duration - dur - 0.1 : 0));
      track(src, [src, f, env, out.g].concat(out.extra), t0 + dur + 0.05);
    }

    function tone(o) {
      if (!oneShotGuard()) return;
      var t0 = now() + (o.delay || 0);
      var dur = o.dur || 0.15;
      var s = ctx.createOscillator(); s.type = o.type || 'sine';
      s.frequency.setValueAtTime(freq(o.freq), t0);
      if (o.freqEnd) s.frequency.exponentialRampToValueAtTime(freq(o.freqEnd), t0 + dur);
      var out = spatialOut(o.dest || nodes.sfx, o.pan, 1);
      var env = gain(0); s.connect(env);
      var chain = [s, env, out.g].concat(out.extra);
      if (o.lp) { var f = filter('lowpass', o.lp, 0.7); env.connect(f); f.connect(out.g); chain.push(f); } else env.connect(out.g);
      var peak = Math.max(0.0001, o.gain == null ? 0.3 : o.gain);
      var atk = o.attack || 0.005, rel = o.release == null ? dur * 0.6 : o.release;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + atk);
      if (o.hold) env.gain.setValueAtTime(peak, t0 + Math.max(atk, dur - rel));
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      s.start(t0);
      track(s, chain, t0 + dur + 0.05);
    }

    // exhaust crackle: a burst of short pops with random spacing
    function crackle(count, strength, pan, att) {
      if (!ctx) return;
      att = att == null ? 1 : att;
      strength = clamp01(strength) * att;
      if (strength < 0.01) return;
      var t = 0;
      for (var i = 0; i < count; i++) {
        t += 0.012 + rnd() * 0.06;
        var big = rnd() < 0.3;
        noiseBurst({ delay: t, dur: big ? 0.07 : 0.03 + rnd() * 0.02, type: 'bandpass', freq: big ? 500 + rnd() * 500 : 1300 + rnd() * 2200,
          Q: 0.8, gain: strength * (big ? 0.9 : 0.55), attack: 0.001, pan: pan });
        if (big) tone({ delay: t, dur: 0.06, type: 'sine', freq: 140 + rnd() * 60, freqEnd: 50, gain: strength * 0.5, attack: 0.001, pan: pan });
      }
    }

    function blowOff(strength, turbos) {
      strength = clamp01(strength);
      var flutter = turbos >= 2 && rnd() < 0.5;
      noiseBurst({ dur: 0.32 + strength * 0.25, type: 'bandpass', freq: 3800 + strength * 1500, freqEnd: 700, Q: 1.6,
        gain: 0.18 + strength * 0.35, attack: 0.008, am: flutter ? 22 + rnd() * 10 : 0, pan: 0 });
      noiseBurst({ dur: 0.18, type: 'highpass', freq: 6000, Q: 0.7, gain: 0.08 * strength, attack: 0.003 });
    }

    function thud(intensity, pan, att) {
      var g = clamp01(intensity) * att;
      if (g < 0.01) return;
      tone({ dur: 0.25 + g * 0.25, type: 'sine', freq: 95 + rnd() * 30, freqEnd: 38, gain: 0.5 + g * 0.6, attack: 0.002, pan: pan });
      noiseBurst({ dur: 0.18 + g * 0.2, kind: 'brown', type: 'lowpass', freq: 600 + g * 1200, freqEnd: 150, Q: 0.8, gain: 0.6 * g + 0.15, attack: 0.002, pan: pan });
      // body panel clank
      noiseBurst({ delay: 0.005, dur: 0.12, type: 'bandpass', freq: 1800 + rnd() * 1500, Q: 4, gain: 0.25 * g, attack: 0.001, pan: pan });
      if (g > 0.6) noiseBurst({ delay: 0.02, dur: 0.4, type: 'highpass', freq: 4000, Q: 0.5, gain: 0.12 * g, attack: 0.002, pan: pan }); // debris / glass tinkle
    }

    function scrapeHit(intensity, pan, att, isPlayer) {
      var g = clamp01(intensity) * att;
      if (g < 0.01) return;
      if (isPlayer) st.scrapeLevel = Math.min(1, st.scrapeLevel + 0.4 + g * 0.6);
      noiseBurst({ dur: 0.35 + g * 0.4, type: 'bandpass', freq: 2200 + rnd() * 1000, freqEnd: 900, Q: 2.2, gain: 0.25 + g * 0.4, attack: 0.006, am: 30 + rnd() * 25, pan: pan });
      tone({ dur: 0.2, type: 'sine', freq: 70, freqEnd: 40, gain: 0.3 * g, attack: 0.002, pan: pan });
      // sparks sizzle
      for (var i = 0; i < 3 + Math.round(g * 5); i++) {
        noiseBurst({ delay: rnd() * 0.25, dur: 0.02 + rnd() * 0.03, type: 'highpass', freq: 5000 + rnd() * 3000, Q: 0.7, gain: 0.08 + g * 0.1, attack: 0.001, pan: pan });
      }
    }

    // ---- UI / race-control sounds --------------------------------------------------------------------------------
    function beep(f, dur, level) {
      tone({ dest: nodes.ui, type: 'square', freq: f, dur: dur, gain: level || 0.18, attack: 0.004, release: 0.04, hold: true, lp: 3500 });
      tone({ dest: nodes.ui, type: 'sine', freq: f * 2, dur: dur, gain: (level || 0.18) * 0.35, attack: 0.004, release: 0.04, hold: true });
    }
    function chime(notes, level, type) {
      notes.forEach(function (n, i) {
        tone({ dest: nodes.ui, type: type || 'triangle', freq: n, dur: 0.35, gain: level || 0.15, attack: 0.005, delay: i * 0.09 });
        tone({ dest: nodes.ui, type: 'sine', freq: n * 2, dur: 0.25, gain: (level || 0.15) * 0.3, attack: 0.005, delay: i * 0.09 });
      });
    }
    function buzzer() {
      tone({ dest: nodes.ui, type: 'sawtooth', freq: 150, dur: 0.55, gain: 0.16, hold: true, release: 0.06, lp: 1200 });
      tone({ dest: nodes.ui, type: 'square', freq: 155, dur: 0.55, gain: 0.08, hold: true, release: 0.06, lp: 1200 });
    }
    function cheer() {
      noiseBurst({ dest: nodes.ui, kind: 'pink', dur: 2.6, type: 'bandpass', freq: 1200, Q: 0.4, gain: 0.12, attack: 0.5, am: 7 });
      noiseBurst({ dest: nodes.ui, kind: 'pink', dur: 2.2, type: 'bandpass', freq: 2600, Q: 0.6, gain: 0.05, attack: 0.6, delay: 0.2, am: 11 });
    }

    function handleCountdown(snap) {
      var cd = snap.countdown || {};
      var lights = num(cd.lightsOn, 0);
      if (snap.phase !== st.phase) {
        if (snap.phase === 'grid' || (snap.phase === 'countdown' && st.phase !== 'grid')) { st.lightsOn = 0; st.lightsOut = false; }
        st.phase = snap.phase;
      }
      if (lights > st.lightsOn && lights > 0 && !cd.lightsOut) beep(lights >= 5 ? 520 : 440, 0.16, 0.2);
      if (lights < st.lightsOn && !cd.lightsOut && lights === 0) st.lightsOut = false;
      st.lightsOn = lights;
      if (cd.lightsOut && !st.lightsOut) beep(880, 0.55, 0.24);
      st.lightsOut = !!cd.lightsOut;
    }

    function handleEvents(snap, listener) {
      var evs = snap.events || [];
      var pid = listener.id;
      for (var i = 0; i < evs.length && i < 48; i++) {
        var e = evs[i]; if (!e) continue;
        var mine = e.carId != null && e.carId === pid;
        var sp = (typeof e.x === 'number' && typeof e.y === 'number') ? spatialize(listener, e) : { gain: mine ? 1 : 0.5, pan: 0, distance: 0 };
        var att = mine ? 1 : Math.min(1, sp.gain * 1.3);
        var pan = mine ? 0 : sp.pan;
        var inten = clamp01(num(e.intensity, 0.5));
        switch (e.type) {
          case 'collision': {
            var key = 'c' + e.carId + '_' + Math.round(num(e.x, 0) / 3) + '_' + Math.round(num(e.y, 0) / 3);
            if ((st.impactCooldown[key] || 0) > now()) break;
            st.impactCooldown[key] = now() + 0.09;
            thud(inten, pan, mine ? 1 : att);
            if (mine && inten > 0.5) crackle(1, 0.2, 0, 1);
            break;
          }
          case 'wall': {
            var wk = 'w' + e.carId;
            if ((st.impactCooldown[wk] || 0) > now()) { if (mine) st.scrapeLevel = Math.min(1, st.scrapeLevel + 0.15); break; }
            st.impactCooldown[wk] = now() + 0.12;
            if (inten > 0.35) thud(inten * 0.8, pan, att);
            scrapeHit(inten, pan, att, mine);
            break;
          }
          case 'lap': if (mine) chime([660, 880], 0.12); break;
          case 'sector': if (mine) tone({ dest: nodes.ui, type: 'sine', freq: 1320, dur: 0.12, gain: 0.07 }); break;
          case 'fastestLap': if (mine) chime([784, 988, 1175, 1568], 0.13); else if (e.carId != null) tone({ dest: nodes.ui, type: 'triangle', freq: 990, dur: 0.18, gain: 0.05 }); break;
          case 'penalty': if (mine) { buzzer(); } break;
          case 'jumpstart': if (mine || e.carId == null) buzzer(); break;
          case 'trackLimits': if (mine) { tone({ dest: nodes.ui, type: 'square', freq: 520, dur: 0.12, gain: 0.08, lp: 2000 }); tone({ dest: nodes.ui, type: 'square', freq: 390, dur: 0.18, gain: 0.08, lp: 2000, delay: 0.13 }); } break;
          case 'finish':
            if (mine) { chime([523, 659, 784, 1047, 1319], 0.15); cheer(); }
            else tone({ dest: nodes.ui, type: 'triangle', freq: 700, dur: 0.15, gain: 0.03 * Math.max(0.3, att) });
            break;
          default: break;
        }
      }
      // prune cooldown map
      var t = now(), keys = Object.keys(st.impactCooldown);
      if (keys.length > 64) keys.forEach(function (k) { if (st.impactCooldown[k] < t) delete st.impactCooldown[k]; });
    }

    // ---- lifecycle -------------------------------------------------------------------------------------------------
    function hookGesture() {
      if (gestureHooked || typeof window === 'undefined' || !window.addEventListener) return;
      gestureHooked = true;
      window.addEventListener('pointerdown', onGesture, true);
      window.addEventListener('keydown', onGesture, true);
      window.addEventListener('touchstart', onGesture, true);
    }
    function unhookGesture() {
      if (!gestureHooked || typeof window === 'undefined') return;
      gestureHooked = false;
      try {
        window.removeEventListener('pointerdown', onGesture, true);
        window.removeEventListener('keydown', onGesture, true);
        window.removeEventListener('touchstart', onGesture, true);
      } catch (e) { /* ignore */ }
    }
    function onGesture() {
      if (!ctx || destroyed) return;
      if (ctx.state === 'suspended') { try { var pr = ctx.resume(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { /* ignore */ } }
      if (ctx.state === 'running') unhookGesture();
    }
    function onVisibility() {
      if (!ctx || destroyed || typeof document === 'undefined') return;
      try {
        if (document.hidden) { if (ctx.state === 'running') ctx.suspend(); }
        else if (started && ctx.state === 'suspended') { var pr = ctx.resume(); if (pr && pr.catch) pr.catch(function () {}); }
      } catch (e) { /* ignore */ }
    }

    function start() {
      if (destroyed || failed) return false;
      try {
        if (!ctx) {
          try { ctx = new Ctor({ latencyHint: 'interactive' }); } catch (e) { ctx = new Ctor(); }
          buildGraph();
          lastCtxTime = ctx.currentTime;
          if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibility);
        }
        started = true;
        if (ctx.state === 'suspended') {
          var pr = ctx.resume(); if (pr && pr.catch) pr.catch(function () {});
          hookGesture();
        }
        return true;
      } catch (err) {
        failed = true;
        try { if (ctx && ctx.close) ctx.close(); } catch (e) { /* ignore */ }
        ctx = null; nodes = null;
        return false;
      }
    }

    function update(snap) {
      if (!ctx || !nodes || destroyed || !snap) return;
      // A suspended / interrupted context does not advance currentTime and does not consume scheduled automation:
      // updating it every frame would only pile up AudioParam events (and time-based history) without bound.
      if (ctx.state !== 'running') { lastSnapT = snap.t; return; }
      try { updateInner(snap); } catch (err) {
        // Audio must never break the race loop.
        if (typeof console !== 'undefined' && !update._warned) { update._warned = true; try { console.warn('[race.audio] update error', err); } catch (e) { /* ignore */ } }
      }
    }

    function updateInner(snap) {
      var t = ctx.currentTime;
      var dt = clamp(t - lastCtxTime, 0, 0.1) || 1 / 60;
      lastCtxTime = t;

      // pause detection: sim time frozen for a few frames -> duck continuous layers
      if (lastSnapT != null && snap.t === lastSnapT) frozenFrames++; else frozenFrames = 0;
      lastSnapT = snap.t;
      var nowPaused = frozenFrames > 6;
      if (nowPaused !== paused) { paused = nowPaused; setP(nodes.live.gain, paused ? 0 : 1, paused ? 0.06 : 0.15); }

      var cars = snap.cars || [];
      var me = null;
      for (var i = 0; i < cars.length; i++) if (cars[i] && (cars[i].id === snap.playerId || (snap.playerId == null && cars[i].isPlayer))) { me = cars[i]; break; }
      if (!me) for (var j = 0; j < cars.length; j++) if (cars[j] && cars[j].isPlayer) { me = cars[j]; break; }
      if (!me && cars.length) me = cars[0];
      var listener = me ? { id: me.id, x: num(me.x, 0), y: num(me.y, 0), heading: num(me.heading, 0), speed: num(me.speed, 0) } : { id: null, x: 0, y: 0, heading: 0, speed: 0 };

      // session restart: sim time went backwards
      if (st.lastT != null && typeof snap.t === 'number' && snap.t + 0.5 < st.lastT) { var keepPhase = null; st = freshState(); st.phase = keepPhase; }
      st.lastT = snap.t;

      handleCountdown(snap);
      if (!paused) handleEvents(snap, listener);

      if (me) {
        var prof = profileFor(me);
        if (!player || player.profile !== prof) { destroyEngineVoice(player); player = buildEngineVoice(prof); st.prevGear = null; }
        if (!paused) {
          updateEngineVoice(player, me, dt, snap);
          updateTires(me, dt, snap);
        }
      }
      if (!paused) {
        updateAmbience(me, snap);
        updateAIVoices(snap, listener);
      }
    }

    function setMuted(m) {
      settings.muted = !!m;
      saveSettings(settings);
      applyMaster(0.04);
    }
    function setVolume(v) {
      settings.volume = clamp01(num(v, settings.volume));
      saveSettings(settings);
      applyMaster(0.05);
    }
    function setChannelLevel(name, v) {
      if (!(name in settings.levels)) return;
      settings.levels[name] = clamp01(num(v, 1));
      saveSettings(settings);
      if (!nodes) return;
      var map = { engine: nodes.engine, tires: nodes.tires, ambience: nodes.amb, sfx: nodes.sfx, ai: nodes.ai, ui: nodes.ui };
      setP(map[name].gain, settings.levels[name] * (name === 'ui' ? 0.55 : 1), 0.05);
    }
    function suspend() { try { if (ctx && ctx.state === 'running') ctx.suspend(); } catch (e) { /* ignore */ } }
    function resume() { try { if (ctx && ctx.state === 'suspended') { var pr = ctx.resume(); if (pr && pr.catch) pr.catch(function () {}); } } catch (e) { /* ignore */ } }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      unhookGesture();
      try { if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibility); } catch (e) { /* ignore */ }
      if (!ctx) return;
      try { if (nodes) setP(nodes.master.gain, 0, 0.03); } catch (e) { /* ignore */ }
      var c = ctx, lists = [];
      if (player) lists = lists.concat(player.srcs);
      if (tires) lists = lists.concat(tires.srcs);
      if (amb) lists = lists.concat(amb.srcs);
      aiVoices.forEach(function (v) { lists = lists.concat(v.srcs); });
      setTimeout(function () {
        stopAll(lists);
        try { var pr = c.close && c.close(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { /* ignore */ }
      }, 120);
      ctx = null; nodes = null; player = null; tires = null; amb = null; aiVoices = [];
    }

    return {
      start: function () { try { return start(); } catch (e) { return false; } },
      update: update,
      setMuted: function (m) { try { setMuted(m); } catch (e) { /* ignore */ } },
      isMuted: function () { return settings.muted; },
      toggleMute: function () { try { setMuted(!settings.muted); } catch (e) { /* ignore */ } return settings.muted; },
      setVolume: function (v) { try { setVolume(v); } catch (e) { /* ignore */ } },
      getVolume: function () { return settings.volume; },
      setChannelLevel: function (n, v) { try { setChannelLevel(n, v); } catch (e) { /* ignore */ } },
      isAvailable: function () { return !failed && !!Ctor; },
      isRunning: function () { return !!(ctx && ctx.state === 'running'); },
      suspend: suspend,
      resume: resume,
      destroy: function () { try { destroy(); } catch (e) { /* ignore */ } },
      debug: function () {
        return { available: !failed && !!Ctor, state: ctx ? ctx.state : 'none', oneShots: activeOneShots, paused: paused,
          spool: st.spool, limiting: st.limiting, profile: player ? player.profile : null,
          aiVoices: aiVoices.map(function (v) { return v.carId; }) };
      }
    };
  }

  return {
    create: create,
    profileFromBuild: profileFromBuild,
    harmonicTable: harmonicTable,
    firingFrequency: firingFrequency,
    attenuation: attenuation,
    spatialize: spatialize,
    shaperCurve: shaperCurve
  };
})();

if (typeof module !== 'undefined') module.exports = CB.race.audio;

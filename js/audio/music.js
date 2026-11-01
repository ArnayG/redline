/* ==========================================================================
   Redline — js/audio/music.js
   CB.music : the soundtrack. Everything is Web Audio synthesis driven by the generative sequencer in
   js/audio/music-tracks.js (no audio files, no network, all material original).

   Public API
     CB.music.play(context, opts?)  context: 'menu' | 'hub' | 'garage' | 'race' | 'drift' | 'arcade' | 'f1' | 'derby' |
                                    'drag' | 'results' | 'victory' | 'defeat' | a track id.
                                    opts { trackId (circuit / map id: 'sakura-*' picks the Sakura Pass piece), won (results),
                                    intensity 0..1, seed, fade (s), phase (drag: 'idle'|'stage'|'go'), after {context, opts}
                                    (what follows a stinger), restart }. Crossfades from whatever is playing. Before the
                                    first user gesture it only remembers the request (autoplay policy).
     CB.music.stop(opts?)           fade out (opts.fade s, 0 = immediately) and forget the request; nodes are released.
     CB.music.setVolume(v)          music volume 0..1 (persists to the profile's settings.audio.music when present)
     CB.music.setEnabled(on)        the Settings "Music" on/off switch (settings.audio.musicOn)
     CB.music.setIntensity(x)       0..1: layers fade in / out by threshold, the filter opens
     CB.music.duck(amount, opts?)   attenuate by amount 0..1 for opts.reason (default 'user'); duck(0, {reason}) releases.
                                    Reasons multiply: 'engine' (driving), 'pause', ...
     CB.music.cue(source, info)     screen hooks from the mode UIs (race-ui / derby-ui / drag-ui): { screen, mode,
                                    trackId, paused, won } -> picks the context, intensity and ducks
     CB.music.frame(source, data)   per-frame race state (throttled to 5 Hz here): lap / laps / position / nitro /
                                    speed / drag phase / derby survivors -> intensity + engine ducking
     CB.music.state(), .stats()     debug: what is playing, live voices, scheduler CPU time
     CB.music.renderOffline(id, seconds, opts) -> Promise<AudioBuffer>   (OfflineAudioContext; opts.phases for drag)
     CB.music.toWav(audioBuffer) -> ArrayBuffer (16-bit PCM)
     CB.music._                     internals for tests (engine factory, contextFor, effectiveVolume, ...)

   Signal graph (one AudioContext for the page lifetime, created on the first gesture, suspended when idle / hidden):
     voices -> part gate (layer) -> [pump: kick sidechain] -> pan -> deck filter (intensity) -> sweep filter -> deck out ─┐
            \-> part sends ─────────────────────────────────────> deck reverb / delay sends ─> Convolver / Delay ─┤
                                                                                   musicBus -> duck -> volume -> limiter -> out
   Classic script, zero dependencies, loads in Node for tests (no AudioContext is touched until a gesture).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

(function () {
  'use strict';

  var hasWin = typeof window !== 'undefined' && typeof document !== 'undefined';
  function TR() { return CB.musicTracks || (typeof require === 'function' ? safeRequire() : null); }
  function safeRequire() { try { return require('./music-tracks.js'); } catch (e) { return null; } }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function mtof(n) { return 440 * Math.pow(2, (n - 69) / 12); }
  function smooth01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function ctxCtor(g) {
    g = g || (hasWin ? window : globalThis);
    return g.AudioContext || g.webkitAudioContext || null;
  }

  /* ======================================================================
     ENGINE: master chain + shared buffers for one (Offline)AudioContext
     ====================================================================== */
  function createEngine(ctx) {
    var E = { ctx: ctx, decks: [], curves: {}, nodesMade: 0, sr: ctx.sampleRate || 44100 };
    function mk(n) { E.nodesMade++; return n; }
    E.mk = mk;
    // shared noise (2 s white) + crackle (4 s vinyl) buffers
    var sr = E.sr, i;
    E.noise = ctx.createBuffer(1, Math.floor(sr * 2), sr);
    var nd = E.noise.getChannelData(0), seed = 1234567;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    for (i = 0; i < nd.length; i++) nd[i] = rnd() * 2 - 1;
    E.rnd = rnd;
    // master: musicBus -> duck -> vol -> glue/limiter -> destination
    E.bus = mk(ctx.createGain()); E.bus.gain.value = 0.62;
    E.duck = mk(ctx.createGain());
    E.vol = mk(ctx.createGain()); E.vol.gain.value = 0;
    E.lim = mk(ctx.createDynamicsCompressor());
    try { E.lim.threshold.value = -8; E.lim.knee.value = 6; E.lim.ratio.value = 12; E.lim.attack.value = 0.003; E.lim.release.value = 0.2; } catch (e) { /* ignore */ }
    E.bus.connect(E.duck); E.duck.connect(E.vol); E.vol.connect(E.lim); E.lim.connect(ctx.destination);
    // reverb: convolver with a generated stereo impulse (2.6 s, darkening exponential tail, 12 ms pre-delay)
    E.rev = mk(ctx.createConvolver());
    var len = Math.floor(sr * 2.6), ir = ctx.createBuffer(2, len, sr), pre = Math.floor(sr * 0.012);
    for (var ch = 0; ch < 2; ch++) {
      var d = ir.getChannelData(ch), lp = 0;
      for (i = 0; i < len; i++) {
        var x = i < pre ? 0 : (rnd() * 2 - 1) * Math.pow(1 - i / len, 3.4);
        var a = 0.25 + 0.7 * (1 - i / len);            // one-pole lowpass that closes as the tail decays
        lp += (x - lp) * a; d[i] = lp;
      }
    }
    E.rev.buffer = ir;
    E.revIn = mk(ctx.createGain()); E.revOut = mk(ctx.createGain()); E.revOut.gain.value = 0.9;
    var revHp = mk(ctx.createBiquadFilter()); revHp.type = 'highpass'; revHp.frequency.value = 220;
    E.revIn.connect(revHp); revHp.connect(E.rev); E.rev.connect(E.revOut); E.revOut.connect(E.bus);
    // tempo delay with a filtered feedback loop
    E.delIn = mk(ctx.createGain());
    E.delay = mk(ctx.createDelay(2)); E.delay.delayTime.value = 0.36;
    E.fb = mk(ctx.createGain()); E.fb.gain.value = 0.34;
    var dlp = mk(ctx.createBiquadFilter()); dlp.type = 'lowpass'; dlp.frequency.value = 3200;
    var dhp = mk(ctx.createBiquadFilter()); dhp.type = 'highpass'; dhp.frequency.value = 320;
    E.delOut = mk(ctx.createGain()); E.delOut.gain.value = 0.7;
    E.delIn.connect(dhp); dhp.connect(E.delay); E.delay.connect(dlp); dlp.connect(E.fb); E.fb.connect(E.delay);
    dlp.connect(E.delOut); E.delOut.connect(E.bus); E.delOut.connect(E.revIn);
    E.master = [E.bus, E.duck, E.vol, E.lim, E.rev, E.revIn, E.revOut, revHp, E.delIn, E.delay, E.fb, dlp, dhp, E.delOut];
    E.curve = function (amt) {
      var k = Math.round(amt * 20) / 20;
      if (E.curves[k]) return E.curves[k];
      var n = 1024, c = new Float32Array(n), g = 1 + k * 9, nrm = Math.tanh(g);
      for (var j = 0; j < n; j++) { var xx = j / (n - 1) * 2 - 1; c[j] = Math.tanh(xx * g) / nrm; }
      return (E.curves[k] = c);
    };
    E.crackle = function () {
      if (E.crackleBuf) return E.crackleBuf;
      var b = ctx.createBuffer(1, Math.floor(sr * 4), sr), cd = b.getChannelData(0), hiss = 0;
      for (var j = 0; j < cd.length; j++) {
        hiss += ((rnd() * 2 - 1) - hiss) * 0.2;
        cd[j] = hiss * 0.012;
        if (rnd() < 0.00035) { var amp = 0.15 + rnd() * 0.35; for (var q = 0; q < 24 && j + q < cd.length; q++) cd[j + q] += amp * (rnd() * 2 - 1) * (1 - q / 24); }
      }
      return (E.crackleBuf = b);
    };
    E.destroy = function () {
      E.decks.slice().forEach(function (d) { d.kill(); });
      E.master.forEach(function (n) { try { n.disconnect(); } catch (e) { /* ignore */ } });
    };
    return E;
  }

  /* ======================================================================
     DECK: one playing track (its parts, filters, pump, voices, scheduler)
     ====================================================================== */
  function createDeck(E, trackId, seed, o) {
    o = o || {};
    var M = TR(), T = M.TRACKS[trackId], ctx = E.ctx, mk = E.mk;
    var fx = T.fx || {};
    var D = {
      id: trackId, track: T, seed: seed >>> 0, bar: 0, barStart: 0, evs: null, ei: 0, sd: 60 / T.bpm / 4,
      phase: o.phase || 'idle', phaseBar: 0, intensity: clamp(num(o.intensity, 0.5), 0, 1), started: false, done: false,
      voices: [], persistent: [], nodes: [], parts: {}, killAt: null, endTime: null, voiceCount: 0, lastSection: null
    };
    function node(n) { D.nodes.push(n); return mk(n); }
    D.out = node(ctx.createGain()); D.out.gain.value = 0;
    D.revSend = node(ctx.createGain()); D.revSend.gain.value = 0;
    D.delSend = node(ctx.createGain()); D.delSend.gain.value = 0;
    D.filter = node(ctx.createBiquadFilter()); D.filter.type = 'lowpass'; D.filter.Q.value = 0.7;
    D.sweep = node(ctx.createBiquadFilter()); D.sweep.type = 'lowpass'; D.sweep.frequency.value = 20000; D.sweep.Q.value = 1.1;
    D.pump = node(ctx.createGain());
    D.mix = node(ctx.createGain());
    D.pump.connect(D.mix); D.mix.connect(D.filter); D.filter.connect(D.sweep); D.sweep.connect(D.out); D.out.connect(E.bus);
    D.revSend.connect(E.revIn); D.delSend.connect(E.delIn);
    D.filter.frequency.value = cutoffFor(D.intensity);
    function cutoffFor(I) { var lo = num(fx.cutLo, 1000), hi = num(fx.cutHi, 16000); return lo * Math.pow(hi / lo, clamp(I * 1.3, 0, 1)); }
    D.cutoffFor = cutoffFor;
    Object.keys(T.parts).forEach(function (name) {
      var def = T.parts[name], P = { name: name, def: def, lastF: 0 };
      P.gate = node(ctx.createGain()); P.gate.gain.value = gateFor(def, D.intensity);
      P.input = node(ctx.createGain()); P.input.gain.value = num(def.vol, 0.5);
      P.input.connect(P.gate);
      var tail = P.gate;
      if (def.pan && ctx.createStereoPanner) { P.pan = node(ctx.createStereoPanner()); P.pan.pan.value = def.pan; tail.connect(P.pan); tail = P.pan; }
      tail.connect(def.pump && fx.pump ? D.pump : D.mix);
      if (def.rev) { P.rs = node(ctx.createGain()); P.rs.gain.value = def.rev; tail.connect(P.rs); P.rs.connect(D.revSend); }
      if (def.del) { P.ds = node(ctx.createGain()); P.ds.gain.value = def.del; tail.connect(P.ds); P.ds.connect(D.delSend); }
      P.target = P.gate.gain.value; P.offAt = P.target > 0 ? null : -1;
      D.parts[name] = P;
    });
    function gateFor(def, I) { var m = num(def.min, 0); return m <= 0 ? 1 : smooth01((I - m) / 0.14); }

    D.setIntensity = function (I, t) {
      I = clamp(I, 0, 1);
      if (Math.abs(I - D.intensity) < 0.01 && D.started) return;
      D.intensity = I; t = t == null ? ctx.currentTime : t;
      Object.keys(D.parts).forEach(function (k) {
        var P = D.parts[k], g = gateFor(P.def, I);
        if (Math.abs(g - P.target) < 0.02) return;
        P.target = g;
        P.gate.gain.cancelScheduledValues(t); P.gate.gain.setTargetAtTime(g, t, 0.45);
        P.offAt = g > 0.001 ? null : t + 1.6;          // keep scheduling notes while the layer fades out
      });
      D.filter.frequency.cancelScheduledValues(t); D.filter.frequency.setTargetAtTime(cutoffFor(I), t, 0.6);
    };
    function fade(param, to, t, dur) {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      if (dur <= 0.001) param.setValueAtTime(to, t); else param.linearRampToValueAtTime(to, t + dur);
    }
    D.start = function (t, fadeIn) {
      D.started = true; D.barStart = t; D.bar = 0;
      fade(D.out.gain, 1, t, fadeIn); fade(D.revSend.gain, num(fx.reverb, 0.25), t, fadeIn); fade(D.delSend.gain, num(fx.delay, 0.2), t, fadeIn);
      try { E.delay.delayTime.setTargetAtTime(Math.min(1.9, D.sd * 4 * num(fx.delayBeats, 0.75)), t, 0.05); } catch (e) { /* ignore */ }
      if (T.crackle && D.parts.crackle) {
        var s = mk(ctx.createBufferSource()); s.buffer = E.crackle(); s.loop = true; s.connect(D.parts.crackle.input);
        s.start(t); D.persistent.push(s);
      }
    };
    D.fadeOut = function (t, dur) {
      fade(D.out.gain, 0, t, dur); fade(D.revSend.gain, 0, t, dur); fade(D.delSend.gain, 0, t, dur);
      D.killAt = t + dur + 0.05;
    };
    D.kill = function () {
      if (D.dead) return;
      D.dead = true;
      D.voices.forEach(function (v) { releaseVoice(v, true); });
      D.voices.length = 0;
      D.persistent.forEach(function (s) { try { s.stop(); } catch (e) { /* ignore */ } try { s.disconnect(); } catch (e2) { /* ignore */ } });
      D.persistent.length = 0;
      D.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* ignore */ } });
      var i = E.decks.indexOf(D); if (i >= 0) E.decks.splice(i, 1);
    };
    /** Drag: switch phase on the next beat ('go' drops at once on the next 16th). */
    D.setPhase = function (ph, t) {
      if (ph === D.phase) return;
      t = t == null ? ctx.currentTime : t;
      var q = ph === 'go' ? D.sd : D.sd * 4;
      var at = D.barStart + Math.ceil((t + 0.04 - D.barStart) / q) * q;
      D.phase = ph; D.phaseBar = 0;
      cancelAfter(at);
      D.bar += 1; D.barStart = at; D.evs = null; D.ei = 0;
      if (ph === 'go') { D.sweep.frequency.cancelScheduledValues(at); D.sweep.frequency.setValueAtTime(20000, at); }
    };
    function cancelAfter(t) {
      D.voices.slice().forEach(function (v) { if (v.t0 >= t - 1e-4) releaseVoice(v, true); });
    }

    /* ---------------- voices ---------------- */
    function voice(t0, t1) { var v = { t0: t0, t1: t1, nodes: [], srcs: [], done: false }; D.voices.push(v); D.voiceCount++; return v; }
    function add(v, n) { v.nodes.push(n); mk(n); return n; }
    function src(v, n, t0, t1) {
      add(v, n); v.srcs.push(n);
      n.start(t0); n.stop(t1);
      if (v.srcs.length === 1) n.onended = function () { releaseVoice(v, false); };
      return n;
    }
    function releaseVoice(v, force) {
      if (v.done) return;
      v.done = true;
      if (force) v.srcs.forEach(function (s) { try { s.onended = null; s.stop(); } catch (e) { /* ignore */ } });
      v.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* ignore */ } });
      if (v.links) v.links.forEach(function (l) { try { l[0].disconnect(l[1]); } catch (e) { /* ignore */ } });
      v.nodes.length = 0; v.srcs.length = 0; v.links = null;
      if (!force) { var i = D.voices.indexOf(v); if (i >= 0) D.voices.splice(i, 1); }
    }
    D.prune = function () {
      // safety net: if onended never fires (some engines while suspended), drop voices long past their end
      var t = ctx.currentTime;
      for (var i = D.voices.length - 1; i >= 0; i--) { var v = D.voices[i]; if (v.done || v.t1 < t - 2) { releaseVoice(v, true); D.voices.splice(i, 1); } }
    };
    function gainEnv(v, t, att, peak, hold, rel) {
      var g = add(v, ctx.createGain()), p = g.gain;
      p.setValueAtTime(0.0001, t);
      p.linearRampToValueAtTime(peak, t + Math.max(0.002, att));
      if (hold > att) p.setValueAtTime(peak, t + hold);
      p.exponentialRampToValueAtTime(0.0001, t + Math.max(hold, att) + Math.max(0.01, rel));
      return g;
    }
    function decayEnv(v, t, peak, dec) { return gainEnv(v, t, 0.002, peak, 0, dec); }
    function noiseSrc(v, t, dur) {
      var s = ctx.createBufferSource(); s.buffer = E.noise; s.loop = true;
      add(v, s); v.srcs.push(s);
      s.start(t, E.rnd() * 1.5); s.stop(t + dur);
      if (v.srcs.length === 1) s.onended = function () { releaseVoice(v, false); };
      return s;
    }
    function filt(v, type, f, q) { var b = add(v, ctx.createBiquadFilter()); b.type = type; b.frequency.setValueAtTime(f, 0); if (q != null) b.Q.value = q; return b; }
    function shaper(v, amt) { var w = add(v, ctx.createWaveShaper()); w.curve = E.curve(amt); w.oversample = 'none'; return w; }
    function chain(list) { for (var i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]); return list[list.length - 1]; }
    function oscN(v, type, f, t0, t1, det) { var o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t0); if (det) o.detune.setValueAtTime(det, t0); return src(v, o, t0, t1); }

    var INST = {
      kick: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, dec = num(p.dec, 0.32), v = voice(t, t + dec + 0.05);
        var o = oscN(v, 'sine', num(p.f0, 150), t, t + dec + 0.05);
        o.frequency.exponentialRampToValueAtTime(num(p.f1, 46), t + 0.075);
        var g = decayEnv(v, t, vel, dec), out = g;
        o.connect(g);
        if (p.drive) { var w = shaper(v, p.drive); g.connect(w); out = w; }
        if (p.lp) { var l = filt(v, 'lowpass', p.lp); out.connect(l); out = l; }
        out.connect(P.input);
        if (p.click) {
          var n = noiseSrc(v, t, 0.02), hp = filt(v, 'highpass', 2500), cg = decayEnv(v, t, vel * p.click, 0.012);
          chain([n, hp, cg, P.input]);
        }
        pumpAt(t, e);
      },
      snare: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, dec = num(p.dec, 0.18), v = voice(t, t + dec + 0.05);
        var o = oscN(v, 'triangle', num(p.tone, 190), t, t + dec * 0.6 + 0.02);
        o.frequency.exponentialRampToValueAtTime(num(p.tone, 190) * 0.72, t + 0.05);
        var og = decayEnv(v, t, vel * 0.6, dec * 0.45);
        var n = noiseSrc(v, t, dec + 0.04), bp = filt(v, 'bandpass', num(p.bp, 1800), 0.7), ng = decayEnv(v, t, vel * num(p.noise, 0.8), dec);
        var sum = add(v, ctx.createGain()), out = sum;
        chain([o, og, sum]); chain([n, bp, ng, sum]);
        if (p.drive) { var w = shaper(v, p.drive); sum.connect(w); out = w; }
        if (p.lp) { var l = filt(v, 'lowpass', p.lp); out.connect(l); out = l; }
        out.connect(P.input);
      },
      clap: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, dec = num(p.dec, 0.15), v = voice(t, t + dec + 0.08);
        var n = noiseSrc(v, t, dec + 0.08), bp = filt(v, 'bandpass', num(p.bp, 1400), 1.6), g = add(v, ctx.createGain()), gp = g.gain;
        gp.setValueAtTime(0.0001, t);
        [0, 0.011, 0.022].forEach(function (o) { gp.setValueAtTime(vel, t + o); gp.exponentialRampToValueAtTime(vel * 0.25, t + o + 0.009); });
        gp.setValueAtTime(vel * 0.8, t + 0.033); gp.exponentialRampToValueAtTime(0.0001, t + 0.033 + dec);
        chain([n, bp, g, P.input]);
      },
      hat: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, dec = num(p.dec, 0.04), v = voice(t, t + dec + 0.03);
        chain([noiseSrc(v, t, dec + 0.03), filt(v, 'highpass', num(p.hp, 8000), 0.8), decayEnv(v, t, vel, dec), P.input]);
      },
      ohat: function (P, e, t, dur, vel) { INST.hat(P, e, t, dur, vel); },
      shaker: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, dec = num(p.dec, 0.05), v = voice(t, t + dec + 0.04);
        chain([noiseSrc(v, t, dec + 0.04), filt(v, 'bandpass', num(p.hp, 6000), 1.4), gainEnv(v, t, 0.012, vel, 0, dec), P.input]);
      },
      rim: function (P, e, t, dur, vel) {
        var v = voice(t, t + 0.06), g = decayEnv(v, t, vel * 0.7, 0.035), bp = filt(v, 'bandpass', 1900, 3);
        oscN(v, 'triangle', 1750, t, t + 0.06).connect(g); oscN(v, 'square', 820, t, t + 0.06).connect(g);
        chain([g, bp, P.input]);
      },
      tom: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, dec = num(p.dec, 0.3), v = voice(t, t + dec + 0.05);
        var o = oscN(v, 'sine', num(p.f0, 160), t, t + dec + 0.05);
        o.frequency.exponentialRampToValueAtTime(num(p.f1, 80), t + dec * 0.5);
        chain([o, decayEnv(v, t, vel, dec), P.input]);
        if (p.noise) chain([noiseSrc(v, t, 0.08), filt(v, 'lowpass', 1200), decayEnv(v, t, vel * p.noise, 0.06), P.input]);
        if (P.name === 'kick') pumpAt(t, e);
      },
      metal: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, dec = num(p.dec, 0.08), f = num(p.f, 540), v = voice(t, t + dec + 0.04);
        var g = decayEnv(v, t, vel * 0.5, dec), hp = filt(v, 'highpass', 2600, 1.2);
        oscN(v, 'square', f, t, t + dec + 0.04).connect(g); oscN(v, 'square', f * 1.483, t, t + dec + 0.04).connect(g); oscN(v, 'square', f * 2.137, t, t + dec + 0.04).connect(g);
        chain([g, hp, P.input]);
      },
      bass: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, f = mtof(e.n), rel = 0.06, end = t + dur + rel, v = voice(t, end);
        var o = oscN(v, p.wave || 'sawtooth', f, t, end);
        if (p.glide && P.lastF && Math.abs(P.lastF - f) > 0.5) { o.frequency.setValueAtTime(P.lastF, t); o.frequency.exponentialRampToValueAtTime(f, t + p.glide); }
        P.lastF = f;
        var lp = filt(v, 'lowpass', num(p.cut, 400), num(p.q, 2)), cut = num(p.cut, 400), env = num(p.env, 1000) * vel;
        lp.frequency.setValueAtTime(cut + env, t); lp.frequency.exponentialRampToValueAtTime(Math.max(40, cut), t + num(p.dec, 0.2));
        var g = gainEnv(v, t, num(p.att, 0.004), vel, dur, rel), out = g;
        chain([o, lp, g]);
        if (p.sub) { var s = oscN(v, 'sine', f, t, end), sg = gainEnv(v, t, 0.006, vel * p.sub, dur, rel); chain([s, sg]); sg.connect(p.drive ? g : P.input); }
        if (p.drive) { var w = shaper(v, p.drive); g.connect(w); out = w; }
        out.connect(P.input);
      },
      sub: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, dec = Math.min(dur, num(p.dec, 1.5)), v = voice(t, t + dec + 0.3);
        chain([oscN(v, 'sine', mtof(e.n), t, t + dec + 0.3), gainEnv(v, t, 0.03, vel, dec * 0.4, dec * 0.6 + 0.25), P.input]);
      },
      pad: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, notes = [].concat(e.n), att = num(p.att, 0.3), rel = num(p.rel, 0.8), end = t + dur + rel, v = voice(t, end);
        var lp = filt(v, 'lowpass', num(p.cut, 1500), 0.8), g = gainEnv(v, t, att, vel / Math.sqrt(notes.length), dur, rel);
        var nv = Math.max(1, num(p.voices, 2)), det = num(p.detune, 8);
        notes.forEach(function (n) { for (var k = 0; k < nv; k++) oscN(v, p.wave || 'sawtooth', mtof(n), t, end, nv === 1 ? 0 : (k / (nv - 1) * 2 - 1) * det).connect(lp); });
        chain([lp, g, P.input]);
      },
      brass: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, notes = [].concat(e.n), att = num(p.att, 0.02), dec = num(p.dec, 0.25), end = t + dur + 0.12, v = voice(t, end);
        var cut = num(p.cut, 2400), lp = filt(v, 'lowpass', cut * 0.3, 1.5);
        lp.frequency.setValueAtTime(cut * 0.25, t);
        lp.frequency.linearRampToValueAtTime(cut * (0.8 + vel * 0.6), t + att + (p.sweep ? dur * 0.5 : 0.04));
        lp.frequency.exponentialRampToValueAtTime(cut * 0.5, t + att + Math.max(dec, 0.05) + (p.sweep ? dur * 0.5 : 0));
        var g = gainEnv(v, t, att, vel / Math.sqrt(notes.length), dur, 0.1);
        var nv = Math.max(1, num(p.voices, 2)), det = num(p.detune, 8);
        notes.forEach(function (n) { for (var k = 0; k < nv; k++) oscN(v, 'sawtooth', mtof(n), t, end, (k / Math.max(1, nv - 1) * 2 - 1) * det).connect(lp); });
        chain([lp, g, P.input]);
      },
      power: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, notes = [].concat(e.n), end = t + dur + 0.08, v = voice(t, end);
        var pre = add(v, ctx.createGain()); pre.gain.value = 0.5;
        notes.forEach(function (n, k) { oscN(v, 'sawtooth', mtof(n), t, end, k === 0 ? -7 : 7).connect(pre); });
        oscN(v, 'square', mtof(notes[0]), t, end, 4).connect(pre);
        var w = shaper(v, num(p.drive, 0.8)), lp = filt(v, 'lowpass', dur < 0.3 ? num(p.cut, 2400) * 0.55 : num(p.cut, 2400), 1);
        var g = gainEnv(v, t, 0.004, vel * 0.5, dur, 0.07);
        chain([pre, w, lp, g, P.input]);
      },
      keys: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, notes = [].concat(e.n), dec = num(p.dec, 1.2), end = t + Math.min(dur + 0.25, dec) + 0.1, v = voice(t, end);
        var g = gainEnv(v, t, 0.004, vel / Math.sqrt(notes.length), 0, Math.min(dur + 0.25, dec));
        notes.forEach(function (n) {
          var f = mtof(n), c = oscN(v, 'sine', f, t, end), m = oscN(v, 'sine', f * num(p.ratio, 1), t, end), mg = add(v, ctx.createGain());
          mg.gain.setValueAtTime(f * num(p.index, 1.2), t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.35);
          chain([m, mg, c.frequency]); c.connect(g);
        });
        g.connect(P.input);
      },
      bell: function (P, e, t, dur, vel) { INST.keys(P, e, t, dur, vel); },
      pluck: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, notes = [].concat(e.n), dec = num(p.dec, 0.15), end = t + Math.max(dur, dec * 2) + 0.05, v = voice(t, end);
        var lp = filt(v, 'lowpass', num(p.cut, 1200), num(p.q, 2)), cut = num(p.cut, 1200);
        lp.frequency.setValueAtTime(cut + num(p.env, 2000) * vel, t); lp.frequency.exponentialRampToValueAtTime(Math.max(60, cut * 0.6), t + dec);
        var g = gainEnv(v, t, 0.003, vel / Math.sqrt(notes.length), 0, dec * 1.6);
        notes.forEach(function (n) { oscN(v, p.wave || 'sawtooth', mtof(n), t, end).connect(lp); });
        chain([lp, g, P.input]);
      },
      lead: function (P, e, t, dur, vel) {
        var p = P.def.patch || {}, f = mtof(e.n), rel = num(p.rel, 0.2), end = t + dur + rel, v = voice(t, end);
        var lp = filt(v, 'lowpass', num(p.cut, 3000), 1), g = gainEnv(v, t, num(p.att, 0.01), vel, dur, rel), out = g;
        var nv = Math.max(1, num(p.voices, 2)), det = num(p.detune, 10);
        if (p.vib && !P.lfo) {   // one shared vibrato LFO per part, kept for the deck's lifetime
          P.lfo = mk(ctx.createOscillator()); P.lfo.frequency.value = 5.4; P.lfoG = mk(ctx.createGain()); P.lfoG.gain.value = p.vib * 60;
          P.lfo.connect(P.lfoG); P.lfo.start(ctx.currentTime); D.persistent.push(P.lfo); D.nodes.push(P.lfoG);
        }
        var from = p.porta && P.lastF && Math.abs(P.lastF / f - 1) < 0.6 ? P.lastF : 0;
        for (var k = 0; k < nv; k++) {
          var o = oscN(v, p.wave || 'sawtooth', f, t, end, nv === 1 ? 0 : (k / (nv - 1) * 2 - 1) * det);
          if (from) { o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(f, t + p.porta); }
          if (P.lfoG) { P.lfoG.connect(o.detune); (v.links || (v.links = [])).push([P.lfoG, o.detune]); }
          o.connect(lp);
        }
        P.lastF = f;
        lp.connect(g);
        if (p.drive) { var w = shaper(v, p.drive); g.connect(w); out = w; }
        out.connect(P.input);
      },
      crackle: function () { /* continuous: started with the deck */ },
      fx: function (P, e, t, dur, vel) {
        var k = e.k, v;
        if (k === 'crash') {
          v = voice(t, t + 2.2);
          chain([noiseSrc(v, t, 2.2), filt(v, 'highpass', 4200, 0.6), gainEnv(v, t, 0.003, vel * 0.55, 0, 2)]).connect(P.input);
        } else if (k === 'riser' || k === 'reverse') {
          v = voice(t, t + dur + 0.05);
          var bp = filt(v, k === 'riser' ? 'bandpass' : 'highpass', k === 'riser' ? 400 : 3000, k === 'riser' ? 2.5 : 0.7);
          if (k === 'riser') bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
          var g = add(v, ctx.createGain()); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel * 0.5, t + dur); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.03);
          chain([noiseSrc(v, t, dur + 0.05), bp, g, P.input]);
          if (k === 'riser') { var o = oscN(v, 'sawtooth', 110, t, t + dur), og = add(v, ctx.createGain()); o.frequency.exponentialRampToValueAtTime(880, t + dur); og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(vel * 0.06, t + dur); chain([o, og, P.input]); }
        } else if (k === 'down') {
          v = voice(t, t + dur + 0.1);
          var b2 = filt(v, 'bandpass', 5000, 2); b2.frequency.exponentialRampToValueAtTime(200, t + dur);
          chain([noiseSrc(v, t, dur + 0.1), b2, gainEnv(v, t, 0.02, vel * 0.4, 0, dur)]).connect(P.input);
        } else if (k === 'impact') {
          v = voice(t, t + 1.4);
          var s = oscN(v, 'sine', 90, t, t + 1.4); s.frequency.exponentialRampToValueAtTime(32, t + 0.9);
          chain([s, decayEnv(v, t, vel * 0.9, 1.2), P.input]);
          chain([noiseSrc(v, t, 0.3), filt(v, 'lowpass', 900), decayEnv(v, t, vel * 0.5, 0.25), P.input]);
        } else if (k === 'sweep') {
          var fp = D.sweep.frequency;
          fp.cancelScheduledValues(t); fp.setValueAtTime(num(e.from, 400), t); fp.exponentialRampToValueAtTime(num(e.to, 18000), t + dur);
          fp.setValueAtTime(20000, t + dur + 0.01);
        }
      }
    };
    D.INST = INST;
    function pumpAt(t, e) {
      var amt = num(fx.pump, 0); if (!amt) return;
      var kp = D.parts.kick; if (kp && kp.target < 0.3) return;
      var gap = D.sd * 4;
      if (D.evs) for (var j = D.ei + 1; j < D.evs.length; j++) if (D.evs[j].p === 'kick' && D.evs[j].t > e.t) { gap = (D.evs[j].t - e.t) * D.sd; break; }
      var rel = Math.min(gap * 0.92, D.sd * 4 * 0.85, 0.42), g = D.pump.gain;
      g.setValueAtTime(1, t); g.linearRampToValueAtTime(1 - amt, t + 0.008); g.linearRampToValueAtTime(1, t + Math.max(0.03, rel));
    }

    D.play = function (e, t) {
      var P = D.parts[e.p]; if (!P) return;
      if (P.target <= 0.001 && (P.offAt === -1 || (P.offAt != null && t > P.offAt))) return;     // silent layer: skip (CPU)
      if (D.voices.length > 110 && (e.p === 'hats' || e.p === 'arp' || e.p === 'perc' || e.p === 'ohat')) return;
      var fn = INST[P.def.inst]; if (!fn) return;
      fn(P, e, t, Math.max(0.02, num(e.d, 1) * D.sd), clamp(num(e.v, 0.8), 0, 1));
    };
    D.gen = function () {
      var o2 = { phase: D.phase, phaseBar: D.phaseBar };
      var g = M.generateBar(D.id, D.seed, D.bar, o2);
      D.lastSection = g.section;
      return g.events;
    };
    /** Schedule every event that starts before `until` (ctx seconds). live: skip events already in the past. */
    D.schedule = function (until, live) {
      var guard = 0;
      while (!D.done && guard++ < 64) {
        if (!D.evs) { D.evs = D.gen(); D.ei = 0; }
        while (D.ei < D.evs.length) {
          var e = D.evs[D.ei], t = D.barStart + e.t * D.sd;
          if (t >= until) return;
          if (!live || t >= ctx.currentTime - 0.03) D.play(e, Math.max(t, live ? ctx.currentTime : 0));
          D.ei++;
        }
        var barEnd = D.barStart + 16 * D.sd;
        if (T.oneShot && D.bar + 1 >= T.oneShot) { D.done = true; D.endTime = barEnd; return; }
        if (barEnd >= until) return;
        D.bar++; D.phaseBar++; D.barStart = barEnd; D.evs = null;
      }
    };
    E.decks.push(D);
    return D;
  }

  /* ======================================================================
     SETTINGS (CB.game.profile settings.audio: master, music, muted, musicOn)
     ====================================================================== */
  var local = { master: 0.8, music: 0.5, muted: false, musicOn: true };
  function profileApi() { var P = CB.game && CB.game.profile; return P && typeof P.peek === 'function' ? P : null; }
  function readAudio() {
    var P = profileApi();
    if (P) {
      try {
        var a = (P.peek().settings || {}).audio || {};
        return { master: num(a.master, 0.8), music: num(a.music, 0.5), muted: !!a.muted, musicOn: a.musicOn !== false };
      } catch (e) { /* fall through */ }
    }
    return local;
  }
  function effectiveVolume(a) {
    a = a || readAudio();
    if (a.muted || a.musicOn === false) return 0;
    return clamp(num(a.master, 0.8), 0, 1) * clamp(num(a.music, 0.5), 0, 1);
  }

  /* ======================================================================
     PLAYER (live AudioContext)
     ====================================================================== */
  var S = {
    ctx: null, E: null, cur: null, wanted: null, gestured: false, intensity: 0.5, ducks: {}, timer: null, hidden: false,
    idleSince: 0, lastVol: -1, ctor: null, stats: { ticks: 0, tickMs: 0, maxTickMs: 0, since: 0, decksMade: 0, ctxMade: 0 },
    race: { last: 0, pos: null, surge: 0, surgeT: 0, base: 0.55, lastI: -1, duck: -1 }, listeners: []
  };

  function audible() { return S.gestured && effectiveVolume() > 0.0005 && !S.hidden; }
  function ensureCtx() {
    if (S.ctx && S.ctx.state !== 'closed') return S.ctx;
    var C = S.ctor || ctxCtor();
    if (!C) return null;
    try { S.ctx = new C({ latencyHint: 'playback' }); } catch (e) { try { S.ctx = new C(); } catch (e2) { return null; } }
    S.stats.ctxMade++;
    S.E = createEngine(S.ctx);
    S.lastVol = -1; applyVolume(true); applyDuck(true);
    return S.ctx;
  }
  function applyVolume(force) {
    var v = effectiveVolume();
    if (!S.E) return v;
    if (!force && Math.abs(v - S.lastVol) < 0.002) return v;
    S.lastVol = v;
    var t = S.ctx.currentTime, p = S.E.vol.gain;
    p.cancelScheduledValues(t); p.setTargetAtTime(v * 0.9, t, force ? 0.01 : 0.12);
    return v;
  }
  function duckLevel() { var g = 1; Object.keys(S.ducks).forEach(function (k) { g *= 1 - clamp(S.ducks[k], 0, 1); }); return g; }
  function applyDuck(force, tc) {
    if (!S.E) return;
    var t = S.ctx.currentTime, p = S.E.duck.gain;
    p.cancelScheduledValues(t); p.setTargetAtTime(duckLevel(), t, force ? 0.01 : (tc || 0.25));
  }
  function startTimer() {
    if (S.timer || !hasWin) return;
    S.timer = setInterval(tick, 50);
  }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
  function tick() {
    var t0 = nowMs();
    var ctx = S.ctx; if (!ctx || !S.E) { stopTimer(); return; }
    if (ctx.state !== 'running') return;
    var now = ctx.currentTime;
    S.E.decks.slice().forEach(function (d) {
      if (d.killAt != null && now >= d.killAt) { d.kill(); return; }
      if (d.killAt == null) d.schedule(now + 0.22, true);
      d.prune();
      if (d === S.cur && d.done && now >= d.endTime + 1.2) onStingerEnd(d);
    });
    if (!S.E.decks.length) {
      if (!S.idleSince) S.idleSince = now;
      if (now - S.idleSince > 2.5) { stopTimer(); try { ctx.suspend(); } catch (e) { /* ignore */ } }
    } else S.idleSince = 0;
    var ms = nowMs() - t0;
    S.stats.ticks++; S.stats.tickMs += ms; if (ms > S.stats.maxTickMs) S.stats.maxTickMs = ms;
  }
  function onStingerEnd(d) {
    var after = d.after;
    d.fadeOut(S.ctx.currentTime, 1.2);
    S.cur = null;
    if (after && after.context) { S.wanted = { context: after.context, opts: after.opts || {} }; startWanted(); }
    else S.wanted = null;
  }
  function newSeed() { return (Math.floor(Math.random() * 4294967296)) >>> 0; }

  function startWanted() {
    var w = S.wanted; if (!w || !audible()) return false;
    var M = TR(); if (!M) return false;
    var ctx = ensureCtx(); if (!ctx) return false;
    if (ctx.state === 'suspended') { try { var pr = ctx.resume(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { /* ignore */ } }
    var o = w.opts || {}, id = M.trackFor(w.context, o), T = M.TRACKS[id];
    if (o.intensity != null) S.intensity = clamp(o.intensity, 0, 1);
    var t = ctx.currentTime;
    if (S.cur && !S.cur.dead && S.cur.id === id && !o.restart && S.cur.killAt == null && !T.oneShot) {
      if (o.phase) S.cur.setPhase(o.phase, t);
      S.cur.setIntensity(S.intensity, t);
      return true;
    }
    var fade = num(o.fade, T.oneShot ? 0.25 : 1.8);
    if (S.cur && !S.cur.dead) S.cur.fadeOut(t, T.oneShot ? 0.35 : fade);
    var d = createDeck(S.E, id, o.seed != null ? o.seed : newSeed(), { intensity: S.intensity, phase: o.phase });
    d.after = o.after || null;
    d.context = w.context;
    d.start(t + 0.06, T.oneShot ? 0.02 : fade);
    S.cur = d; S.stats.decksMade++;
    if (!S.stats.since) S.stats.since = nowMs();
    S.idleSince = 0;
    startTimer();
    tick();
    return true;
  }

  function play(context, opts) {
    S.wanted = { context: context || 'menu', opts: opts || {} };
    if (opts && opts.intensity != null) S.intensity = clamp(opts.intensity, 0, 1);
    var ok = startWanted();
    return { pending: !ok, track: TR() ? TR().trackFor(S.wanted.context, S.wanted.opts) : null };
  }
  function fadeAll(fade) {
    if (!S.E) return;
    var t = S.ctx.currentTime;
    S.E.decks.slice().forEach(function (d) {
      if (fade <= 0) d.kill(); else if (d.killAt == null) d.fadeOut(t, fade);
    });
    S.cur = null;
    if (fade <= 0 && !S.E.decks.length) stopTimer();
  }
  function stop(opts) {
    opts = opts || {};
    if (!opts.keepWanted) S.wanted = null;
    fadeAll(num(opts.fade, 1.2));
  }
  function setIntensity(x) {
    S.intensity = clamp(num(x, 0.5), 0, 1);
    if (S.cur && !S.cur.dead) S.cur.setIntensity(S.intensity);
    return S.intensity;
  }
  function duck(amount, opts) {
    opts = opts || {};
    var r = opts.reason || 'user', a = clamp(num(amount, 0), 0, 1);
    if (a <= 0) delete S.ducks[r]; else S.ducks[r] = a;
    applyDuck(false, opts.time);
    return duckLevel();
  }
  function settingsChanged() {
    var v = effectiveVolume();
    if (v <= 0.0005) { if (S.cur || (S.E && S.E.decks.length)) { applyVolume(); fadeAll(0.4); } return; }
    applyVolume();
    if (!S.cur && S.wanted) startWanted();
  }
  function setVolume(v) {
    v = clamp(num(v, 0.5), 0, 1);
    var P = CB.game && CB.game.profile;
    if (P && typeof P.setSetting === 'function') { try { P.setSetting('audio.music', v); } catch (e) { local.music = v; } }
    else local.music = v;
    settingsChanged();
    return v;
  }
  function setEnabled(on) {
    var P = CB.game && CB.game.profile;
    if (P && typeof P.setSetting === 'function') { try { P.setSetting('audio.musicOn', !!on); } catch (e) { local.musicOn = !!on; } }
    else local.musicOn = !!on;
    settingsChanged();
    return !!on;
  }

  /* ---------------- gesture / visibility ---------------- */
  function onGesture() {
    if (S.gestured) return;
    S.gestured = true;
    S.listeners.forEach(function (off) { off(); }); S.listeners = [];
    if (!S.wanted) S.wanted = { context: contextForRoute(currentRoute()), opts: { intensity: 0.4 } };
    startWanted();
  }
  function onVisibility() {
    S.hidden = !!(hasWin && document.hidden);
    if (!S.ctx) return;
    try {
      if (S.hidden) S.ctx.suspend();
      else if (S.E && S.E.decks.length) { var p = S.ctx.resume(); if (p && p.catch) p.catch(function () {}); startTimer(); }
      else if (S.wanted && !S.cur) startWanted();
    } catch (e) { /* ignore */ }
  }

  /* ---------------- context resolution (pure) ---------------- */
  var HUB_ROUTES = { menu: 1, career: 1, challenges: 1, achievements: 1, replays: 1, profile: 1, settings: 1, multiplayer: 1, title: 1 };
  function contextForRoute(route) {
    route = String(route || 'menu');
    if (route === 'atelier' || route === 'garage' || route === 'cars') return 'garage';
    if (HUB_ROUTES[route]) return 'menu';
    if (route === 'race' || route === 'drift' || route === 'arcade' || route === 'f1' || route === 'derby' || route === 'drag') return route;
    return 'menu';
  }
  function currentRoute() {
    try { var r = CB.router && CB.router.current && CB.router.current(); return r && r.route; } catch (e) { return null; }
  }
  /** mode of a race-ui cue: F1 sessions run inside race-ui while the router sits on #/f1. */
  function modeOf(info) {
    var m = info && info.mode || 'race';
    if ((m === 'race' || !m) && currentRoute() === 'f1') return 'f1';
    return m;
  }

  /* ---------------- mode hooks ---------------- */
  function cue(source, info) {
    info = info || {};
    var mode = source === 'derby' ? 'derby' : source === 'drag' ? 'drag' : modeOf(info);
    var o = { trackId: info.trackId };
    var scr = info.screen;
    if (info.paused != null) duck(info.paused ? 0.55 : 0, { reason: 'pause', time: 0.2 });
    if (scr === 'pause') { duck(0.55, { reason: 'pause', time: 0.2 }); return; }
    if (scr === 'resume') { duck(0, { reason: 'pause' }); return; }
    if (scr === 'setup' || scr === 'discipline' || scr === 'bracket') {
      duck(0, { reason: 'engine' }); duck(0, { reason: 'pause' });
      o.intensity = 0.25; if (mode === 'drag') o.phase = 'idle';
      play(mode, o);
    } else if (scr === 'loading') { o.intensity = 0.32; play(mode, o); }
    else if (scr === 'race' || scr === 'play') {
      S.race.pos = null; S.race.surge = 0; S.race.lastI = -1;
      o.intensity = mode === 'drag' ? 0.5 : 0.5; if (mode === 'drag') o.phase = 'idle';
      duck(0.3, { reason: 'engine', time: 0.6 });
      play(mode, o);
    } else if (scr === 'results') {
      duck(0, { reason: 'engine' }); duck(0, { reason: 'pause' });
      play('results', { won: info.won !== false, after: { context: mode, opts: { trackId: info.trackId, intensity: 0.18, phase: mode === 'drag' ? 'idle' : undefined } } });
    } else if (scr === 'closed') { duck(0, { reason: 'engine' }); duck(0, { reason: 'pause' }); }
  }
  /** race state -> intensity (pure; exported for tests). d: {lap, laps, position, field, nitro, speed_kph, phase, combo, alive, total} */
  function raceIntensity(d, R, dt) {
    R = R || { pos: null, surge: 0 };
    var I = 0.55;
    if (d.phase === 'countdown' || d.phase === 'grid' || d.phase === 'formation') I = 0.4;
    if (num(d.laps, 0) > 1 && num(d.lap, 0) >= d.laps - 1 && !d.finished) I += 0.25;           // final lap
    if (d.position != null) {
      if (R.pos != null && d.position < R.pos) R.surge = Math.min(0.3, R.surge + 0.16);      // gained a place
      R.pos = d.position;
      if (d.position === 1 && num(d.field, 2) > 1) I += 0.06;
    }
    R.surge = Math.max(0, num(R.surge, 0) - num(dt, 0.2) * 0.03);
    I += R.surge;
    if (d.nitro) I += 0.22;
    if (d.combo) I += 0.12 * clamp(d.combo / 3, 0, 1);
    if (d.total) I += 0.4 * clamp(1 - num(d.alive, d.total) / d.total, 0, 1);
    return clamp(I, 0, 1);
  }
  function frame(source, d) {
    if (!d || !S.cur) return;
    var t = nowMs();
    if (t - S.race.last < 200) return;
    var dt = S.race.last ? (t - S.race.last) / 1000 : 0.2;
    S.race.last = t;
    if (source === 'drag' && d.phase) {
      var ph = d.phase === 'run' || d.phase === 'shutdown' || d.phase === 'done' ? 'go' : d.phase === 'staging' || d.phase === 'burnout' || d.phase === 'tree' || d.phase === 'prestage' ? 'stage' : 'idle';
      if (S.cur.id === 'quarter-mile') S.cur.setPhase(ph);
      setIntensity(ph === 'go' ? 0.9 : 0.5);
    } else {
      var I = raceIntensity(d, S.race, dt);
      if (Math.abs(I - S.race.lastI) > 0.02) { S.race.lastI = I; setIntensity(I); }
    }
    var dk = 0.26 + 0.16 * clamp(num(d.speed_kph, 0) / 260, 0, 1);
    if (Math.abs(dk - S.race.duck) > 0.03) { S.race.duck = dk; duck(dk, { reason: 'engine', time: 0.5 }); }
  }

  /* ======================================================================
     OFFLINE RENDER + WAV
     ====================================================================== */
  function renderOffline(id, seconds, opts) {
    opts = opts || {};
    var g = hasWin ? window : globalThis, O = g.OfflineAudioContext || g.webkitOfflineAudioContext;
    if (!O) return Promise.reject(new Error('no OfflineAudioContext'));
    var sr = opts.sampleRate || 44100, ctx = new O(2, Math.ceil(sr * seconds), sr);
    var E = createEngine(ctx);
    E.vol.gain.value = 0.9;
    var d = createDeck(E, id, opts.seed != null ? opts.seed : 1, { intensity: num(opts.intensity, 0.8), phase: opts.phase });
    d.start(0.02, 0.3);
    var phases = (opts.phases || []).slice().sort(function (a, b) { return a.at - b.at; });
    var steps = (opts.intensities || []).slice().sort(function (a, b) { return a.at - b.at; });
    var marks = phases.map(function (p) { return { at: p.at, fn: function () { d.setPhase(p.phase, p.at); } }; })
      .concat(steps.map(function (p) { return { at: p.at, fn: function () { d.setIntensity(p.value, p.at); } }; }))
      .sort(function (a, b) { return a.at - b.at; });
    marks.forEach(function (m) { d.schedule(m.at, false); m.fn(); });
    d.schedule(seconds, false);
    var t0 = nowMs();
    return ctx.startRendering().then(function (buf) { buf._renderMs = nowMs() - t0; buf._voices = d.voiceCount; buf._nodes = E.nodesMade; return buf; });
  }
  function toWav(buf) {
    var ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate, bytes = 44 + len * ch * 2;
    var ab = new ArrayBuffer(bytes), v = new DataView(ab), o = 0;
    function s(str) { for (var i = 0; i < str.length; i++) v.setUint8(o++, str.charCodeAt(i)); }
    s('RIFF'); v.setUint32(o, bytes - 8, true); o += 4; s('WAVE'); s('fmt '); v.setUint32(o, 16, true); o += 4;
    v.setUint16(o, 1, true); o += 2; v.setUint16(o, ch, true); o += 2; v.setUint32(o, sr, true); o += 4;
    v.setUint32(o, sr * ch * 2, true); o += 4; v.setUint16(o, ch * 2, true); o += 2; v.setUint16(o, 16, true); o += 2;
    s('data'); v.setUint32(o, len * ch * 2, true); o += 4;
    var data = []; for (var c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    for (var i = 0; i < len; i++) for (c = 0; c < ch; c++) { var x = clamp(data[c][i], -1, 1); v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2; }
    return ab;
  }

  /* ======================================================================
     WIRING (browser only)
     ====================================================================== */
  function install() {
    if (!hasWin || S.installed) return;
    S.installed = true;
    try { if (navigator.userActivation && navigator.userActivation.hasBeenActive) S.gestured = true; } catch (e) { /* ignore */ }
    if (!S.gestured) ['pointerdown', 'keydown', 'touchend', 'mousedown'].forEach(function (ev) {
      var fn = function () { onGesture(); };
      window.addEventListener(ev, fn, true);
      S.listeners.push(function () { window.removeEventListener(ev, fn, true); });
    });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', function () { try { if (S.ctx) S.ctx.suspend(); } catch (e) { /* ignore */ } });
    document.addEventListener('cb:route', function (e) {
      var r = e && e.detail && e.detail.route;
      var c = contextForRoute(r);
      if (c === 'menu' || c === 'garage') { duck(0, { reason: 'engine' }); duck(0, { reason: 'pause' }); }
      // race-ui / derby / drag cue their own screens; the route only sets the opening context
      play(c, { intensity: c === 'menu' || c === 'garage' ? 0.5 : 0.25, phase: c === 'drag' ? 'idle' : undefined });
    });
    var hook = function () {
      var P = profileApi();
      if (P && typeof P.subscribe === 'function' && !S.unsub) { S.unsub = P.subscribe(function () { settingsChanged(); }); return true; }
      return false;
    };
    if (!hook()) document.addEventListener('DOMContentLoaded', hook);
  }

  var api = {
    play: play, stop: stop, setVolume: setVolume, setEnabled: setEnabled, setIntensity: setIntensity, duck: duck,
    cue: cue, frame: frame, renderOffline: renderOffline, toWav: toWav,
    isEnabled: function () { return readAudio().musicOn !== false; },
    getVolume: function () { return readAudio().music; },
    state: function () {
      return {
        gestured: S.gestured, context: S.wanted && S.wanted.context, track: S.cur ? S.cur.id : null, section: S.cur ? S.cur.lastSection : null,
        bar: S.cur ? S.cur.bar : null, phase: S.cur ? S.cur.phase : null, intensity: S.intensity, duck: duckLevel(), ducks: Object.assign({}, S.ducks),
        volume: effectiveVolume(), ctxState: S.ctx ? S.ctx.state : 'none', decks: S.E ? S.E.decks.length : 0,
        voices: S.E ? S.E.decks.reduce(function (n, d) { return n + d.voices.length; }, 0) : 0
      };
    },
    stats: function () {
      var st = S.stats, el = st.since ? (nowMs() - st.since) / 1000 : 0;
      return { ticks: st.ticks, avgTickMs: st.ticks ? st.tickMs / st.ticks : 0, maxTickMs: st.maxTickMs, schedMsPerSec: el ? st.tickMs / el : 0,
               contexts: st.ctxMade, decks: st.decksMade, nodesMade: S.E ? S.E.nodesMade : 0, live: api.state().voices };
    },
    _: {
      createEngine: createEngine, createDeck: createDeck, effectiveVolume: effectiveVolume, readAudio: readAudio, contextForRoute: contextForRoute,
      raceIntensity: raceIntensity, onGesture: onGesture, tick: tick, S: S, local: local,
      setCtor: function (C) { S.ctor = C; },
      reset: function () {
        if (S.E) S.E.destroy();
        stopTimer();
        if (S.ctx && S.ctx.close) { try { S.ctx.close(); } catch (e) { /* ignore */ } }
        S.ctx = null; S.E = null; S.cur = null; S.wanted = null; S.gestured = false; S.ducks = {}; S.intensity = 0.5; S.hidden = false;
        S.race = { last: 0, pos: null, surge: 0, base: 0.55, lastI: -1, duck: -1 };
        S.stats = { ticks: 0, tickMs: 0, maxTickMs: 0, since: 0, decksMade: 0, ctxMade: 0 };
        local.master = 0.8; local.music = 0.5; local.muted = false; local.musicOn = true;
      }
    }
  };
  CB.music = api;
  install();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

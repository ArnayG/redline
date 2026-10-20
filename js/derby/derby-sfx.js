/* ==========================================================================
   Redline — js/derby/derby-sfx.js
   CB.derby.sfx : synthesised WebAudio sound for Demolition Derby (no assets).
     create({muted, volume, mobile}) -> sfx { start() (call from a user gesture), frame(snap, followId, dt), event(ev, dist),
                                      sting(name), setMuted(b), isMuted(), suspend(), resume(), destroy(), stats() }
   Layered impacts (low thump + distorted metal crunch + panel ring + glass tinkle on big hits + a debris-rattle tail,
   scaled by energy and zone), scrape and tyre-squeal loops, a RAM BOOST whoosh + jet loop, explosions with sub-bass,
   a crowd that roars on big hits / eliminations, synthesised announcer stings (chords) and an engine note that gets
   rougher with damage. A voice limiter keeps it cheap (10 one-shots on phones, 24 on desktop); a master compressor
   gives the crunch punch. Safe without WebAudio (every call is a no-op). iOS unlock is handled globally by CB.device.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function isMobile() { try { return !!(CB.device && CB.device.info && CB.device.info().mobile); } catch (e) { return false; } }

  function create(opts) {
    opts = opts || {};
    var S = { muted: !!opts.muted, vol: num(opts.volume, 0.8), ctx: null, master: null, noise: null, eng: null, flame: null, crowd: null, scrape: null, squeal: null, jet: null,
      lastCrash: 0, voices: 0, maxVoices: opts.mobile != null ? (opts.mobile ? 10 : 24) : (isMobile() ? 10 : 24), dropped: 0, played: 0, scrapeLvl: 0, wasBoost: false, curve: null, rnd: 98765 };
    function rnd() { S.rnd = (S.rnd * 1103515245 + 12345) & 0x7fffffff; return S.rnd / 0x7fffffff; }
    function AC() { return typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null; }
    function start() {
      if (S.ctx) { try { if (S.ctx.state === 'suspended') S.ctx.resume(); } catch (e) { /* ignore */ } return true; }
      var C = AC(); if (!C) return false;
      try { S.ctx = new C(); } catch (e) { S.ctx = null; return false; }
      var c = S.ctx;
      var comp = c.createDynamicsCompressor();
      try { comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.18; } catch (e2) { /* ignore */ }
      S.master = c.createGain(); S.master.gain.value = S.muted ? 0 : S.vol; S.master.connect(comp); comp.connect(c.destination);
      var len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0), seed = 12345;
      for (var i = 0; i < len; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed / 0x3fffffff - 1; }
      S.noise = buf;
      // crunch distortion curve
      var n = 1024, cv = new Float32Array(n);
      for (var k = 0; k < n; k++) { var x = k / (n - 1) * 2 - 1; cv[k] = Math.tanh(x * 6) * 0.9; }
      S.curve = cv;
      // engine: two detuned oscillators -> waveshaper (rough when damaged) -> lowpass -> gain, plus a rattle noise
      var o1 = c.createOscillator(), o2 = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
      o1.type = 'sawtooth'; o2.type = 'square'; o1.frequency.value = 50; o2.frequency.value = 25.5;
      lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 2;
      var g2 = c.createGain(); g2.gain.value = 0.35;
      o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.gain.value = 0; g.connect(S.master);
      var rn = loopNoise(), rbp = c.createBiquadFilter(), rg = c.createGain();
      rbp.type = 'bandpass'; rbp.frequency.value = 900; rbp.Q.value = 1.2; rg.gain.value = 0;
      rn.connect(rbp); rbp.connect(rg); rg.connect(S.master);
      o1.start(); o2.start();
      S.eng = { o1: o1, o2: o2, lp: lp, g: g, rattle: rg };
      S.flame = loopBand(1400, 0.7, 'lowpass');
      S.crowd = loopBand(1100, 0.6, 'bandpass'); S.crowd.base = 0.016; S.crowd.swell = 0; S.crowd.g.gain.value = 0.016;
      S.scrape = loopBand(2600, 3.5, 'bandpass');
      S.squeal = loopBand(1750, 14, 'bandpass');
      S.jet = loopBand(700, 0.8, 'lowpass');
      return true;
    }
    function loopNoise() { var s = S.ctx.createBufferSource(); s.buffer = S.noise; s.loop = true; s.start(0, rnd() * 1.5); return s; }
    function loopBand(freq, q, type) {
      var src = loopNoise(), f = S.ctx.createBiquadFilter(), g = S.ctx.createGain();
      f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(S.master);
      return { g: g, f: f };
    }
    function voice(dur) {
      if (!S.ctx || S.muted) return false;
      if (S.voices >= S.maxVoices) { S.dropped++; return false; }
      S.voices++; S.played++;
      setTimeout(function () { S.voices = Math.max(0, S.voices - 1); }, Math.round((dur + 0.08) * 1000));
      return true;
    }
    function burst(dur, freq, q, gain, type, delay, shaped, sweep) {
      if (!voice(dur)) return;
      var c = S.ctx, t = c.currentTime + (delay || 0);
      var src = c.createBufferSource(); src.buffer = S.noise;
      var f = c.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.setValueAtTime(freq, t); f.Q.value = q || 1;
      if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + dur);
      var g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      var node = f;
      src.connect(f);
      if (shaped && S.curve) { var ws = c.createWaveShaper(); ws.curve = S.curve; f.connect(ws); node = ws; }
      node.connect(g); g.connect(S.master);
      src.start(t, rnd() * 1.5); src.stop(t + dur + 0.05);
    }
    function tone(freq, dur, gain, type, slide, delay) {
      if (!voice(dur)) return;
      var c = S.ctx, t = c.currentTime + (delay || 0), o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(S.master); o.start(t); o.stop(t + dur + 0.05);
    }
    function chord(freqs, dur, gain, type, delay) { freqs.forEach(function (f, i) { tone(f, dur, gain / Math.sqrt(freqs.length), type, null, (delay || 0) + i * 0.004); }); }
    function cheer(k) { if (S.crowd) S.crowd.swell = Math.min(1, S.crowd.swell + k); }

    /** layered crunch: thump + distorted crunch + panel ring + (big) glass tinkle + debris rattle tail */
    function crunch(en, att, zone, big, wall) {
      var side = zone === 'left' || zone === 'right';
      var a = clamp(att, 0, 1);
      tone(72 + 30 * (1 - en), 0.22 + en * 0.35, 0.85 * en * a, 'sine', 0.42);                         // low thump
      if (big) tone(42, 0.55, 0.6 * en * a, 'sine', 0.6);                                                  // sub on big hits
      burst(0.14 + en * 0.38, (side ? 1700 : 1150) - en * 450, 0.9, 0.6 * en * a, 'bandpass', 0, true, 0.55); // metal crunch (distorted)
      tone((side ? 520 : 380) + rnd() * 120, 0.18 + en * 0.25, 0.12 * en * a, 'triangle', 0.86, 0.01);      // panel ring
      if (!wall) tone((side ? 690 : 510) + rnd() * 90, 0.14 + en * 0.2, 0.08 * en * a, 'square', 0.8, 0.02);
      if (big) for (var i = 0; i < 4; i++) tone(2600 + rnd() * 3600, 0.05 + rnd() * 0.08, 0.05 * a, 'sine', 1, 0.03 + rnd() * 0.18);   // glass tinkle
      var n = big ? 5 : en > 0.4 ? 3 : 1;
      for (var j = 0; j < n; j++) burst(0.04 + rnd() * 0.05, 2500 + rnd() * 2500, 2, 0.12 * en * a * (1 - j / (n + 1)), 'highpass', 0.12 + j * (0.07 + rnd() * 0.08)); // debris rattle
    }

    function sting(name) {
      if (!S.ctx || S.muted) return;
      switch (name) {
        case 'takedown': chord([110, 165, 220, 330], 0.7, 0.32, 'sawtooth'); burst(0.4, 600, 0.7, 0.35, 'lowpass', 0, true); chord([147, 220, 294], 0.9, 0.22, 'sawtooth', 0.22); cheer(0.8); break;
        case 'combo': [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.12, 0.13, 'square', null, i * 0.055); }); break;
        case 'revenge': chord([196, 233, 294], 0.5, 0.25, 'sawtooth'); chord([175, 208, 262], 0.6, 0.22, 'sawtooth', 0.18); break;
        case 'win': cheer(1); [523, 659, 784].forEach(function (f, i) { tone(f, 0.3, 0.2, 'triangle', null, i * 0.14); }); chord([523, 659, 784, 1047], 1.1, 0.3, 'triangle', 0.44); break;
        case 'lose': [392, 330, 262, 196].forEach(function (f, i) { tone(f, 0.32, 0.18, 'triangle', null, i * 0.18); }); break;
        case 'sudden': for (var i = 0; i < 3; i++) { tone(220, 0.22, 0.2, 'square', 0.7, i * 0.3); tone(110, 0.22, 0.16, 'sawtooth', 0.7, i * 0.3); } break;
        case 'pickup': tone(660, 0.08, 0.16, 'square'); tone(990, 0.12, 0.16, 'square', 1.2, 0.07); break;
        case 'boost': burst(0.55, 300, 0.8, 0.4, 'lowpass', 0, false, 9); tone(70, 0.5, 0.35, 'sawtooth', 2.2); break;
        default: break;
      }
    }

    /** one sim event at distance `dist` (m) from the listener */
    function event(e, dist, follow) {
      if (!S.ctx || S.muted || !e) return;
      var att = clamp(1 - num(dist, 0) / 90, 0.06, 1);
      var now = S.ctx.currentTime;
      switch (e.type) {
        case 'impact': case 'wall': {
          if (now - S.lastCrash < 0.035 && !e.big) return;
          S.lastCrash = now;
          var en = clamp(Math.max(Math.sqrt(num(e.energy, 20000)) / 360, num(e.vn, 0) / 24), 0.08, 1);
          crunch(en, att, e.zone, !!e.big, e.type === 'wall');
          if (e.big) cheer(0.55 * att);
          break;
        }
        case 'scrape': S.scrapeLvl = Math.min(1, S.scrapeLvl + 0.5 * att); break;
        case 'hammer': if (e.miss) { burst(0.25, 500, 0.8, 0.14 * att, 'lowpass'); break; } tone(620, 0.6, 0.35 * att, 'triangle', 0.98); tone(931, 0.4, 0.22 * att, 'sine'); crunch(0.85, att, 'left', true, false); cheer(0.5 * att); break;
        case 'hammer-swing': burst(0.28, 500, 0.8, 0.14 * att, 'lowpass', 0, false, 3); break;
        case 'explode':
          burst(1.6, 380, 0.6, 0.95 * att, 'lowpass', 0, true, 0.3); tone(45, 1.3, 0.9 * att, 'sine', 0.55); tone(90, 0.6, 0.5 * att, 'sawtooth', 0.4);
          for (var i = 0; i < 6; i++) burst(0.05, 1800 + rnd() * 2000, 1.5, 0.18 * att, 'bandpass', 0.15 + i * 0.12 + rnd() * 0.1);   // crackle
          cheer(1 * att); break;
        case 'eliminated': tone(55, 0.9, 0.5 * att, 'sine', 0.5); cheer(0.9 * att); break;
        case 'launch': tone(160, 0.55, 0.32 * att, 'sawtooth', 2.4); burst(0.3, 900, 0.7, 0.3 * att, 'bandpass', 0, true); cheer(0.7 * att); break;
        case 'land': if (e.big) crunch(0.5, att, 'front', false, true); break;
        case 'puncture': burst(0.6, 5000, 4, 0.28 * att, 'highpass', 0, false, 0.5); break;
        case 'wheel-off': tone(260, 0.25, 0.25 * att, 'square', 0.5); burst(0.4, 3000, 2, 0.2 * att, 'highpass', 0.05); break;
        case 'part-off': tone(300, 0.2, 0.22 * att, 'square', 0.6); burst(0.3, 2400, 1.5, 0.18 * att, 'bandpass', 0.03, true); break;
        case 'light': for (var g2 = 0; g2 < 3; g2++) tone(3000 + rnd() * 3000, 0.06, 0.05 * att, 'sine', 1, g2 * 0.03); break;
        case 'nitro': burst(0.6, 900, 0.8, 0.3 * att, 'bandpass'); break;
        case 'shield': tone(440, 0.6, 0.22 * att, 'sine', 2); break;
        case 'repair': tone(520, 0.12, 0.2, 'square'); tone(780, 0.15, 0.2, 'square', 1, 0.12); break;
        case 'magnet': tone(110, 0.8, 0.25 * att, 'sawtooth', 1.6); break;
        case 'oil': case 'caltrops': burst(0.3, 700, 1, 0.2 * att, 'lowpass'); break;
        case 'fire': burst(0.8, 600, 0.5, 0.25 * att, 'lowpass', 0, false, 2); break;
        case 'pickup': if (follow) sting('pickup'); break;
        case 'countdown': tone(660, 0.18, 0.3, 'square'); break;
        case 'go': tone(990, 0.5, 0.35, 'square'); burst(0.6, 2000, 0.5, 0.2, 'bandpass'); cheer(0.8); break;
        case 'win': cheer(1); break;
        default: break;
      }
    }
    /** per frame: engine of the followed car, scrape / squeal / jet / flame loops, crowd bed, events */
    function frame(snap, followId, dt) {
      if (!S.ctx || !snap || !snap.cars) return;
      var c = null; snap.cars.forEach(function (x) { if (x.id === followId) c = x; });
      c = c || snap.cars[0];
      var t = S.ctx.currentTime, k = 0.08;
      dt = num(dt, 0.016);
      var E = S.eng;
      if (E && c) {
        var sp = Math.abs(num(c.speed, 0)), thr = num(c.throttle, 0), dead = c.out || (c.engine && c.engine.stalled);
        var dmg = c.engine ? clamp(1 - num(c.engine.hp, 1), 0, 1) : 0, boost = !!((c.ram && c.ram.active) || c.boosting);
        var f = 38 + sp * 3.2 + thr * 26 + (boost ? 14 : 0);
        E.o1.frequency.setTargetAtTime(f * (1 + dmg * 0.04 * Math.sin(t * 23)), t, k); E.o2.frequency.setTargetAtTime(f * 0.5 + dmg * 6 * Math.sin(t * 31), t, k);
        E.lp.frequency.setTargetAtTime(300 + thr * 900 + sp * 12 + (boost ? 600 : 0), t, k);
        E.g.gain.setTargetAtTime(dead ? 0 : 0.06 + thr * 0.07, t, 0.1);
        E.rattle.gain.setTargetAtTime(dead ? 0 : dmg * 0.07 * (0.4 + thr), t, 0.1);
        // tyre squeal from sliding (slip flag × speed) and the RAM BOOST jet
        var slide = c.out ? 0 : clamp(num(c.slip, 0), 0, 1) * clamp((sp - 6) / 16, 0, 1);
        if (S.squeal) { S.squeal.g.gain.setTargetAtTime(slide * 0.06, t, 0.06); S.squeal.f.frequency.setTargetAtTime(1600 + sp * 8, t, 0.1); }
        if (boost && !S.wasBoost) sting('boost');
        S.wasBoost = boost;
        if (S.jet) { S.jet.g.gain.setTargetAtTime(boost ? 0.14 : 0, t, boost ? 0.05 : 0.2); S.jet.f.frequency.setTargetAtTime(boost ? 900 + sp * 20 : 400, t, 0.1); }
      }
      var flameOn = 0;
      snap.cars.forEach(function (x) {
        (x.acc || []).forEach(function (a) { if (a.id === 'flamethrower' && a.active) { var d = c ? Math.hypot(x.x - c.x, x.y - c.y) : 0; flameOn = Math.max(flameOn, clamp(1 - d / 60, 0.1, 1)); } });
      });
      if (S.flame) S.flame.g.gain.setTargetAtTime(flameOn * 0.22, t, 0.05);
      (snap.events || []).forEach(function (e) {
        var d = c && e.x != null ? Math.hypot(e.x - c.x, e.y - c.y) : 0;
        event(e, d, c && (e.carId === c.id || e.otherId === c.id));
      });
      S.scrapeLvl = Math.max(0, S.scrapeLvl - dt * 3.2);
      if (S.scrape) S.scrape.g.gain.setTargetAtTime(S.scrapeLvl * 0.16, t, 0.04);
      if (S.crowd) {
        S.crowd.swell = Math.max(0, S.crowd.swell - dt * 0.3);
        S.crowd.g.gain.setTargetAtTime(S.crowd.base + S.crowd.swell * 0.11, t, 0.25);
        S.crowd.f.frequency.setTargetAtTime(1000 + S.crowd.swell * 500, t, 0.3);
      }
    }
    function setMuted(b) { S.muted = !!b; if (S.master && S.ctx) S.master.gain.setTargetAtTime(S.muted ? 0 : S.vol, S.ctx.currentTime, 0.05); }
    return {
      start: start, frame: frame, event: event, sting: sting, setMuted: setMuted, isMuted: function () { return S.muted; },
      stats: function () { return { voices: S.voices, max: S.maxVoices, played: S.played, dropped: S.dropped, running: !!S.ctx }; },
      setSlow: function (k) { if (S.master && S.ctx && !S.muted) S.master.gain.setTargetAtTime(S.vol * (k ? 0.55 : 1), S.ctx.currentTime, 0.1); },
      suspend: function () { try { if (S.ctx) S.ctx.suspend(); } catch (e) { /* ignore */ } },
      resume: function () { try { if (S.ctx) S.ctx.resume(); } catch (e) { /* ignore */ } },
      destroy: function () { try { if (S.ctx) S.ctx.close(); } catch (e) { /* ignore */ } S.ctx = null; S.eng = null; S.flame = null; S.crowd = null; S.scrape = null; S.squeal = null; S.jet = null; }
    };
  }

  CB.derby.sfx = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.sfx;
})();

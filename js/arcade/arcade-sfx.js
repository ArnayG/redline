/* ==========================================================================
   Redline — js/arcade/arcade-sfx.js
   CB.arcade.sfx : synthesized Web Audio effects for the Arcade gameplay layer (no samples, zero dependencies).

     var sfx = CB.arcade.sfx.create({ volume 0..1 })
     sfx.unlock()                 create / resume the AudioContext (call from a user gesture: key / pointer)
     sfx.events(list, playerId)   gameplay events -> sounds (only what concerns or is near the player)
     sfx.frame(state, dt)         continuous layers: nitro roar, roulette ticks, drift spark hiss
     sfx.setMuted(bool) / sfx.muted() / sfx.setVolume(v) / sfx.destroy()
   Sounds: whoosh (nitro / boost / pad), item-box sparkle, roulette ticks + item chime, bonk (boing), shield ping,
   oil splat, EMP zap, lightning crack, coin blip, mini-turbo tier blips, rocket launch, rocket-start fanfare.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};

(function () {
  'use strict';

  function create(opts) {
    opts = opts || {};
    var A = { ctx: null, master: null, noise: null, muted: !!opts.muted, vol: opts.volume == null ? 0.55 : opts.volume, loops: {}, lastTick: -1, lastTier: 0 };
    var AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

    function unlock() {
      if (!AC) return false;
      try {
        if (!A.ctx) {
          A.ctx = new AC();
          A.master = A.ctx.createGain();
          A.master.gain.value = A.muted ? 0 : A.vol;
          A.master.connect(A.ctx.destination);
          var len = A.ctx.sampleRate * 1.5, buf = A.ctx.createBuffer(1, len, A.ctx.sampleRate), d = buf.getChannelData(0);
          for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
          A.noise = buf;
        }
        if (A.ctx.state === 'suspended' && A.ctx.resume) A.ctx.resume();
      } catch (e) { A.ctx = null; return false; }
      return true;
    }
    function ok() { return A.ctx && A.ctx.state !== 'closed' && !A.muted; }
    function now() { return A.ctx.currentTime; }
    function env(g, t, a, peak, d) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    }
    function tone(type, f0, f1, dur, peak, delay) {
      if (!ok()) return;
      var t = now() + (delay || 0), o = A.ctx.createOscillator(), g = A.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      env(g, t, 0.006, peak, dur);
      o.connect(g); g.connect(A.master); o.start(t); o.stop(t + dur + 0.05);
    }
    function noise(dur, f0, f1, q, peak, delay, type) {
      if (!ok() || !A.noise) return;
      var t = now() + (delay || 0), s = A.ctx.createBufferSource(), f = A.ctx.createBiquadFilter(), g = A.ctx.createGain();
      s.buffer = A.noise; s.loop = true;
      f.type = type || 'bandpass'; f.Q.value = q || 1;
      f.frequency.setValueAtTime(f0, t); if (f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
      env(g, t, Math.min(0.08, dur * 0.3), peak, dur);
      s.connect(f); f.connect(g); g.connect(A.master); s.start(t); s.stop(t + dur + 0.1);
    }
    var SND = {
      whoosh: function (big) { noise(big ? 0.9 : 0.6, 500, big ? 4200 : 2800, 0.8, big ? 0.5 : 0.35); tone('sawtooth', 90, big ? 220 : 160, big ? 0.7 : 0.45, 0.08); },
      sparkle: function () { [1320, 1760, 2093, 2637].forEach(function (f, i) { tone('sine', f, f, 0.16, 0.12, i * 0.045); }); noise(0.25, 6000, 9000, 2, 0.06); },
      tick: function () { tone('square', 1100, 1100, 0.025, 0.05); },
      chime: function () { tone('triangle', 880, 880, 0.18, 0.18); tone('triangle', 1318, 1318, 0.3, 0.16, 0.08); },
      bonk: function () { tone('sine', 220, 70, 0.22, 0.5); tone('square', 660, 180, 0.3, 0.08, 0.02); noise(0.12, 900, 300, 1, 0.25); },
      boing: function () { tone('sine', 300, 900, 0.18, 0.18); tone('sine', 900, 400, 0.25, 0.12, 0.18); },
      ping: function () { tone('sine', 1760, 1760, 0.35, 0.18); tone('sine', 2637, 2637, 0.25, 0.1, 0.01); },
      splat: function () { noise(0.35, 700, 160, 1.2, 0.35, 0, 'lowpass'); tone('sine', 140, 60, 0.3, 0.25); },
      zap: function () { tone('sawtooth', 1800, 120, 0.4, 0.14); noise(0.35, 3000, 600, 3, 0.18); },
      crack: function () { noise(0.08, 5000, 3000, 0.5, 0.6); noise(0.9, 400, 80, 0.7, 0.45, 0.05, 'lowpass'); },
      coin: function () { tone('square', 988, 988, 0.06, 0.08); tone('square', 1319, 1319, 0.14, 0.08, 0.06); },
      tier: function (n) { tone('triangle', 600 + n * 300, 900 + n * 400, 0.12, 0.14); },
      rocket: function () { noise(0.7, 900, 300, 1, 0.3); tone('sawtooth', 160, 420, 0.5, 0.06); },
      fanfare: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone('square', f, f, 0.12, 0.07, i * 0.07); }); },
      bog: function () { tone('sawtooth', 120, 50, 0.6, 0.12); },
      shieldUp: function () { tone('sine', 440, 1320, 0.3, 0.12); },
      ghost: function () { tone('sine', 660, 330, 0.6, 0.1); tone('sine', 990, 495, 0.6, 0.06); }
    };

    function events(list, me) {
      if (!ok()) return;
      (list || []).forEach(function (e) {
        var mine = e.carId === me;
        switch (e.type) {
          case 'itemBox': if (mine) SND.sparkle(); break;
          case 'itemGot': if (mine) SND.chime(); break;
          case 'nitroStart': if (mine) SND.whoosh(true); break;
          case 'boost': if (mine && e.kind !== 'slip') SND.whoosh(e.kind === 'mega' || e.kind === 'start' || /drift3/.test(e.kind)); break;
          case 'slipstream': if (mine) noise(0.5, 1500, 3500, 1, 0.2); break;
          case 'hit': if (mine || e.by === me) { if (e.kind === 'oil') SND.splat(); else SND.bonk(); if (e.kind === 'rocket') SND.boing(); } break;
          case 'blocked': if (mine || e.by === me) SND.ping(); break;
          case 'emp': SND.zap(); break;
          case 'lightning': SND.crack(); break;
          case 'coin': if (mine) SND.coin(); break;
          case 'canister': if (mine) { SND.chime(); noise(0.3, 2000, 5000, 1, 0.15); } break;
          case 'driftTier': if (mine && e.tier) SND.tier(e.tier); break;
          case 'itemUse':
            if (!mine) break;
            if (e.item === 'rocket') SND.rocket(); else if (e.item === 'shield') SND.shieldUp(); else if (e.item === 'ghost') SND.ghost(); else if (e.item === 'oil') SND.splat();
            break;
          case 'start': if (mine) { if (e.grade === 'perfect' || e.grade === 'good') SND.fanfare(); else if (e.grade === 'over') SND.bog(); } break;
          case 'landing': if (mine) noise(0.2, 300, 120, 1, e.big ? 0.45 : 0.25, 0, 'lowpass'); break;
          default: break;
        }
      });
    }

    /** continuous layers */
    function loop(name, on, build) {
      var L = A.loops[name];
      if (on && !L && ok()) { L = A.loops[name] = build(); }
      else if (!on && L) {
        try { L.g.gain.setTargetAtTime(0.0001, now(), 0.08); var src = L.src; setTimeout(function () { try { src.stop(); } catch (e) { /* ignore */ } }, 400); } catch (e) { /* ignore */ }
        delete A.loops[name];
      }
      return L;
    }
    function frame(st, dt) {
      if (!A.ctx) return;
      var P = st && st.player;
      var burning = !!(P && P.nitroOn) && !A.muted;
      loop('nitro', burning, function () {
        var s = A.ctx.createBufferSource(), f = A.ctx.createBiquadFilter(), g = A.ctx.createGain();
        s.buffer = A.noise; s.loop = true; f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.7;
        g.gain.value = 0.0001; g.gain.setTargetAtTime(0.22, now(), 0.05);
        s.connect(f); f.connect(g); g.connect(A.master); s.start();
        return { src: s, g: g, f: f };
      });
      if (A.loops.nitro) A.loops.nitro.f.frequency.setTargetAtTime(800 + Math.random() * 500, now(), 0.05);
      var drifting = !!(P && P.drift) && !A.muted;
      loop('drift', drifting, function () {
        var s = A.ctx.createBufferSource(), f = A.ctx.createBiquadFilter(), g = A.ctx.createGain();
        s.buffer = A.noise; s.loop = true; f.type = 'highpass'; f.frequency.value = 4500;
        g.gain.value = 0.0001; g.gain.setTargetAtTime(0.06, now(), 0.05);
        s.connect(f); f.connect(g); g.connect(A.master); s.start();
        return { src: s, g: g, f: f };
      });
      if (A.loops.drift && P && P.drift) A.loops.drift.g.gain.setTargetAtTime(0.04 + 0.04 * P.drift.tier, now(), 0.1);
      // roulette ticks slow down with the strip
      if (P && P.roulette && P.roulette.strip) {
        var R = P.roulette, p = Math.min(1, R.t / R.dur), pos = Math.floor((1 - Math.pow(1 - p, 3)) * (R.strip.length - 1));
        if (pos !== A.lastTick) { A.lastTick = pos; if (ok()) SND.tick(); }
      } else A.lastTick = -1;
    }

    return {
      unlock: unlock, events: events, frame: function (st, dt) { try { frame(st, dt); } catch (e) { /* audio never breaks the game */ } },
      setMuted: function (m) { A.muted = !!m; if (A.master) A.master.gain.value = A.muted ? 0 : A.vol; if (A.muted) Object.keys(A.loops).forEach(function (k) { loop(k, false); }); },
      muted: function () { return A.muted; },
      setVolume: function (v) { A.vol = Math.max(0, Math.min(1, +v || 0)); if (A.master && !A.muted) A.master.gain.value = A.vol; },
      play: function (name, arg) { if (SND[name] && ok()) SND[name](arg); },
      destroy: function () { Object.keys(A.loops).forEach(function (k) { loop(k, false); }); try { if (A.ctx && A.ctx.close) A.ctx.close(); } catch (e) { /* ignore */ } A.ctx = null; },
      SOUNDS: Object.keys(SND)
    };
  }

  CB.arcade.sfx = { create: create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.arcade.sfx;

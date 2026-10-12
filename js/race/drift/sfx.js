/* ==========================================================================
   FORGE Atelier — js/race/drift/sfx.js
   CB.race.drift.sfx : small, satisfying UI sounds for the drift scorer popups (combo arpeggios, bank
   chime, zone dings, swing whoosh, scrape buzz). Engine / tyre squeal / limiter stay in js/race/audio.js.

     var fx = CB.race.drift.sfx.create();      // lazily opens its own AudioContext on start()
     fx.start()                                  // call from a user gesture (key / click)
     fx.update(scorerState)                      // plays each new popup once (tracked by popup.seq)
     fx.setMuted(b), fx.destroy()
     CB.race.drift.sfx.plan(popup) -> [{ f, t, d, g, type }]   pure: notes for a popup (Node-testable)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

(function () {
  'use strict';

  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  var C5 = 523.25;
  function semi(n) { return C5 * Math.pow(2, n / 12); }

  /** Notes for one popup. f = Hz, t = start offset s, d = duration s, g = gain, type = oscillator type. */
  function plan(p) {
    if (!p || !p.kind) return [];
    var k = p.kind, pts = num(p.points, 0), out = [], i;
    switch (k) {
      case 'combo': {
        var m = clamp(parseInt(String(p.text || '').replace(/[^0-9]/g, ''), 10) || 2, 2, 5);
        var base = (m - 2) * 2;
        [0, 4, 7, 12].forEach(function (n, j) { out.push({ f: semi(base + n), t: j * 0.055, d: 0.16, g: 0.07, type: 'triangle' }); });
        if (m >= 5) out.push({ f: semi(base + 19), t: 0.24, d: 0.32, g: 0.06, type: 'sine' });
        break;
      }
      case 'bank': {
        // bigger banks ring higher and longer
        var lift = clamp(Math.floor(Math.log(Math.max(1, pts) / 500) / Math.LN2), 0, 5);
        var notes = [0, 7, 12, 16].slice(0, 2 + Math.min(2, lift));
        for (i = 0; i < notes.length; i++) out.push({ f: semi(notes[i] + lift), t: i * 0.07, d: 0.22, g: 0.075, type: 'sine' });
        break;
      }
      case 'zone': case 'bonus': case 'entry': case 'long': case 'tandem': case 'manji':
        out.push({ f: semi(12), t: 0, d: 0.12, g: 0.06, type: 'sine' }, { f: semi(19), t: 0.06, d: 0.2, g: 0.055, type: 'sine' });
        break;
      case 'swing':
        out.push({ f: semi(-5), t: 0, d: 0.1, g: 0.05, type: 'triangle', slide: semi(5) });
        break;
      case 'scrape': case 'offtrack': case 'backwards':
        out.push({ f: 150, t: 0, d: 0.16, g: 0.06, type: 'square', lp: 900 }, { f: 112, t: 0.12, d: 0.2, g: 0.06, type: 'square', lp: 900 });
        break;
      default: break;
    }
    return out;
  }

  function create(opts) {
    opts = opts || {};
    var Ctor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    var ctx = null, master = null, muted = !!opts.muted, lastSeq = -1, playing = 0;
    function start() {
      if (!Ctor) return false;
      try {
        if (!ctx) { ctx = new Ctor(); master = ctx.createGain(); master.gain.value = num(opts.volume, 0.8); master.connect(ctx.destination); }
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
        return true;
      } catch (e) { ctx = null; return false; }
    }
    function play(notes) {
      if (!ctx || muted || ctx.state !== 'running' || playing > 24) return;
      var t0 = ctx.currentTime + 0.01;
      notes.forEach(function (n) {
        try {
          var o = ctx.createOscillator(), g = ctx.createGain(), dst = master;
          o.type = n.type || 'sine';
          o.frequency.setValueAtTime(n.f, t0 + n.t);
          if (n.slide) o.frequency.exponentialRampToValueAtTime(n.slide, t0 + n.t + n.d);
          if (n.lp) { var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = n.lp; lp.connect(master); dst = lp; }
          g.gain.setValueAtTime(0.0001, t0 + n.t);
          g.gain.exponentialRampToValueAtTime(n.g, t0 + n.t + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.d);
          o.connect(g); g.connect(dst);
          o.start(t0 + n.t); o.stop(t0 + n.t + n.d + 0.05);
          playing++; o.onended = function () { playing--; };
        } catch (e) { /* ignore */ }
      });
    }
    function update(st) {
      var list = st && (st.popups || st.events);
      if (!list || !list.length) return 0;
      var n = 0, top = lastSeq;
      for (var i = 0; i < list.length; i++) {
        var p = list[i], s = num(p.seq, -1);
        if (s > lastSeq) { if (lastSeq >= 0 || i === list.length - 1) { play(plan(p)); n++; } top = Math.max(top, s); }
      }
      lastSeq = top;
      return n;
    }
    return {
      start: start, update: update, play: play,
      reset: function () { lastSeq = -1; },
      setMuted: function (b) { muted = !!b; },
      destroy: function () { try { if (ctx && ctx.close) ctx.close(); } catch (e) { /* ignore */ } ctx = null; }
    };
  }

  CB.race.drift.sfx = { create: create, plan: plan };
})();
if (typeof module !== 'undefined') module.exports = CB.race.drift.sfx;

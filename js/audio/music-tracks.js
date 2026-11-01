/* ==========================================================================
   Redline — js/audio/music-tracks.js
   CB.musicTracks : the soundtrack as data + a deterministic generative sequencer (pure, no Web Audio).

   Every piece here is original material written for Redline (chords, bass lines, drum patterns and motifs);
   nothing is transcribed from an existing recording. js/audio/music.js turns the events into sound.

   API
     CB.musicTracks.TRACKS                 id -> track definition (bpm, key, parts, patterns, motifs)
     CB.musicTracks.CONTEXTS               context -> track id ('menu', 'race', 'drift', ...)
     CB.musicTracks.trackFor(context, o)   -> track id  (o.trackId 'sakura-*' picks the Sakura Pass drift piece)
     CB.musicTracks.generateBar(id, seed, bar, o)
          -> { bar, section, chord, events: [{ t, d, p, n, v, k? }] }
             t / d in 16th steps from the bar start (swing already applied), p = part name (track.parts),
             n = midi note or array of notes, v = velocity 0..1, k = fx kind for p 'fx'.
          o.phase: drag only — 'idle' | 'stage' | 'go'; o.phaseBar: bars since that phase began.
     The same (id, seed, bar, o) always yields the same events: variation comes from the seed and the bar index
     (per-phrase hat / fill / melody mutations, chord inversions, breakdown placement), never from Math.random.

   Classic script, zero dependencies, loads in Node (module.exports) for tests.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});

(function () {
  'use strict';

  /* ------------------------------------------------------------------ helpers */
  var NOTE_IDX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midi(name) {
    var m = /^([A-G])([#b]?)(-?\d)$/.exec(String(name));
    if (!m) throw new Error('music: bad note ' + name);
    return 12 * (+m[3] + 1) + NOTE_IDX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  /** 'F2|A3 C4 E4' -> { bass: 41, notes: [57, 60, 64] } */
  function chord(spec) {
    var p = spec.split('|');
    return { bass: midi(p[0].trim()), notes: p[1].trim().split(/\s+/).map(midi), name: spec };
  }
  function hash32() {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < arguments.length; i++) {
      var s = String(arguments[i]);
      for (var j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619) >>> 0; }
      h ^= 0x9e; h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }
  /** 'x...o...-...X...' -> [[step, vel], ...]   x = 1, X = 1 (accent), o = 0.6, - = 0.32 (ghost) */
  function pat(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === 'x' || c === 'X') out.push([i, c === 'X' ? 1 : 0.88]);
      else if (c === 'o') out.push([i, 0.6]);
      else if (c === '-') out.push([i, 0.32]);
    }
    return out;
  }

  var SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10],
    harmMinor: [0, 2, 3, 5, 7, 8, 11], phrygian: [0, 1, 3, 5, 7, 8, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10]
  };
  function deg(T, d) {
    var sc = SCALES[T.scale] || SCALES.minor, L = sc.length;
    var o = Math.floor(d / L), i = ((d % L) + L) % L;
    return T.rootMidi + sc[i] + 12 * o;
  }

  /* ==================================================================== TRACKS
     parts: name -> { inst, min (intensity at which the layer fades in), vol, pan, rev, del, pump, patch }
     inst ids are js/audio/music.js instruments: kick snare clap hat ohat shaker tom rim metal bass sub pad keys
     pluck lead brass power bell crackle fx. */
  var TRACKS = {};

  /* --- Neon Lounge — main menu / hub: chill synthwave, 90 bpm, A minor, laid back ---------------------- */
  TRACKS['neon-lounge'] = {
    id: 'neon-lounge', name: 'Neon Lounge', mood: 'chill synthwave', bpm: 90, swing: 0.1, rootMidi: midi('A4'), scale: 'minor',
    fx: { reverb: 0.32, delay: 0.24, delayBeats: 0.75, cutLo: 1400, cutHi: 15000, pump: 0.42, crackle: 0.05 },
    chords: ['F2|A3 C4 E4 G4', 'G2|B3 D4 E4', 'E2|G3 B3 D4', 'A2|G3 B3 C4 E4', 'D2|F3 A3 C4 E4', 'F2|A3 C4 E4', 'G2|F3 B3 D4', 'A2|E3 A3 B3 E4'],
    parts: {
      kick:   { inst: 'kick', min: 0.12, vol: 0.85, patch: { f0: 120, f1: 44, dec: 0.42, click: 0.12 } },
      snare:  { inst: 'snare', min: 0.18, vol: 0.5, rev: 0.35, patch: { tone: 190, noise: 0.8, dec: 0.22, bp: 1800 } },
      hats:   { inst: 'hat', min: 0.3, vol: 0.32, pan: 0.18, patch: { dec: 0.045, hp: 7500 } },
      bass:   { inst: 'bass', min: 0, vol: 0.62, pump: true, patch: { wave: 'sawtooth', cut: 260, env: 700, q: 3, dec: 0.5, sub: 0.6, att: 0.01 } },
      chords: { inst: 'pad', min: 0, vol: 0.34, pump: true, rev: 0.4, del: 0.05, patch: { wave: 'sawtooth', voices: 2, detune: 9, cut: 1500, att: 0.5, rel: 1.2 } },
      arp:    { inst: 'pluck', min: 0.42, vol: 0.2, pan: -0.25, rev: 0.25, del: 0.45, pump: true, patch: { wave: 'square', cut: 1800, env: 2400, dec: 0.22 } },
      lead:   { inst: 'lead', min: 0.6, vol: 0.24, pan: 0.1, rev: 0.4, del: 0.35, patch: { wave: 'sawtooth', voices: 2, detune: 6, cut: 2600, vib: 0.18, att: 0.04, rel: 0.35, porta: 0.05 } },
      fx:     { inst: 'fx', min: 0, vol: 0.4, rev: 0.6 }
    },
    drums: {
      kick: ['x.....x...x.....', 'x.....x.x.......'],
      snare: ['....x.......x...', '....x.......x..-'],
      hats: ['o.x.o.x.o.x.o.x.', 'o.x.o.xoo.x.o.xo', '-.x.-.x.-.x.-.x-']
    },
    fills: [{ snare: '............x-xx' }, { snare: '..........-.x.x.' }],
    bass: { style: 'pulse', pattern: 'x.....x.x...x...' },
    harmony: { style: 'pad' },
    arp: { order: [0, 1, 2, 3, 2, 1], rate: 2, oct: 12 },
    lead: {
      phrases: [
        [[0, 6, 7], [6, 2, 6], [8, 6, 4], [14, 2, 5], [16, 8, 4], [24, 4, 2], [28, 4, 3]],
        [[0, 6, 7], [6, 2, 9], [8, 8, 8], [16, 4, 7], [20, 4, 6], [24, 8, 4]]
      ],
      verse: 'none'
    },
    form: { breakChance: 0.35 }
  };

  /* --- Tape Garage — the car builder / My Cars: lo-fi hip-hop, 82 bpm, D dorian, swung, Rhodes + crackle - */
  TRACKS['tape-garage'] = {
    id: 'tape-garage', name: 'Tape Garage', mood: 'lo-fi groove', bpm: 82, swing: 0.2, rootMidi: midi('D4'), scale: 'dorian',
    fx: { reverb: 0.26, delay: 0.16, delayBeats: 0.5, cutLo: 1100, cutHi: 9000, pump: 0.28, crackle: 0.22 },
    chords: ['Bb2|D4 F4 A4 C5', 'A2|C#4 E4 G4 Bb4', 'D2|C4 E4 F4 A4', 'G2|Bb3 D4 F4 A4', 'Bb2|D4 F4 A4 C5', 'A2|G3 C#4 E4', 'D2|F4 A4 C5 E5', 'C2|Bb3 E4 G4 D5'],
    parts: {
      kick:   { inst: 'kick', min: 0.1, vol: 0.9, patch: { f0: 110, f1: 46, dec: 0.36, click: 0.06, lp: 2200 } },
      snare:  { inst: 'snare', min: 0.14, vol: 0.5, rev: 0.25, patch: { tone: 210, noise: 0.7, dec: 0.18, bp: 2200, lp: 6000 } },
      hats:   { inst: 'shaker', min: 0.22, vol: 0.26, pan: 0.2, patch: { dec: 0.06, hp: 5500 } },
      bass:   { inst: 'bass', min: 0, vol: 0.56, patch: { wave: 'triangle', cut: 500, env: 300, q: 1, dec: 0.6, sub: 0.7, glide: 0.04 } },
      chords: { inst: 'keys', min: 0, vol: 0.42, pump: true, rev: 0.35, patch: { ratio: 1, index: 1.4, dec: 1.6, trem: 4.2 } },
      lead:   { inst: 'bell', min: 0.45, vol: 0.18, pan: -0.15, rev: 0.4, del: 0.4, patch: { ratio: 3.5, index: 0.8, dec: 0.9 } },
      crackle:{ inst: 'crackle', min: 0, vol: 0.5 },
      fx:     { inst: 'fx', min: 0, vol: 0.3, rev: 0.5 }
    },
    drums: {
      kick: ['x......x.x......', 'x......x..x...x.', 'x.......xx......'],
      snare: ['....x.......x...', '....x.......x.-.', '....x..-....x...'],
      hats: ['x.o.x.o.x.o.x.oo', 'x.oox.o.x.o.x.o.']
    },
    fills: [{ snare: '..........-.x.--' }, { kick: '..x.....x.x.....' }],
    bass: { style: 'lazy', pattern: 'x.....x...x....-' },
    harmony: { style: 'comp', pattern: 'x......x..x.....', len: 6 },
    lead: {
      phrases: [
        [[2, 2, 4], [4, 4, 6], [10, 2, 4], [12, 6, 3], [22, 2, 1], [24, 8, 0]],
        [[0, 2, 7], [2, 2, 6], [4, 6, 4], [12, 4, 5], [18, 2, 4], [20, 4, 2], [26, 6, 3]]
      ],
      verse: 'sparse'
    },
    crackle: true,
    form: { breakChance: 0.2 }
  };

  /* --- Redline Run — races: driving electronic, 126 bpm, E minor, rolling sidechained bass ----------------- */
  TRACKS['redline-run'] = {
    id: 'redline-run', name: 'Redline Run', mood: 'driving electronic', bpm: 126, swing: 0, rootMidi: midi('E4'), scale: 'minor',
    fx: { reverb: 0.22, delay: 0.2, delayBeats: 0.75, cutLo: 900, cutHi: 17000, pump: 0.62 },
    chords: ['E2|E3 G3 B3 D4', 'C2|E3 G3 C4', 'G2|D3 G3 B3', 'D2|F#3 A3 D4', 'A2|E3 A3 C4', 'C2|E3 G3 B3', 'D2|F#3 A3 D4', 'B1|D#3 F#3 B3'],
    parts: {
      kick:   { inst: 'kick', min: 0.2, vol: 1, patch: { f0: 150, f1: 47, dec: 0.32, click: 0.35 } },
      clap:   { inst: 'clap', min: 0.3, vol: 0.5, rev: 0.3, patch: { bp: 1400, dec: 0.16 } },
      hats:   { inst: 'hat', min: 0.15, vol: 0.34, pan: 0.15, patch: { dec: 0.04, hp: 8000 } },
      ohat:   { inst: 'ohat', min: 0.45, vol: 0.26, pan: -0.12, patch: { dec: 0.18, hp: 7000 } },
      perc:   { inst: 'rim', min: 0.7, vol: 0.22, pan: 0.35, del: 0.3 },
      bass:   { inst: 'bass', min: 0, vol: 0.62, pump: true, patch: { wave: 'sawtooth', cut: 320, env: 1500, q: 6, dec: 0.12, sub: 0.45 } },
      chords: { inst: 'pad', min: 0.1, vol: 0.24, pump: true, rev: 0.35, patch: { wave: 'sawtooth', voices: 3, detune: 12, cut: 2200, att: 0.08, rel: 0.6 } },
      arp:    { inst: 'pluck', min: 0.35, vol: 0.22, pan: 0.22, del: 0.35, pump: true, patch: { wave: 'sawtooth', cut: 900, env: 4200, q: 5, dec: 0.13 } },
      lead:   { inst: 'lead', min: 0.62, vol: 0.26, rev: 0.3, del: 0.25, patch: { wave: 'sawtooth', voices: 3, detune: 14, cut: 3800, vib: 0.12, att: 0.01, rel: 0.2 } },
      fx:     { inst: 'fx', min: 0, vol: 0.45, rev: 0.5 }
    },
    drums: {
      kick: ['x...x...x...x...', 'x...x...x...x..o'],
      clap: ['....x.......x...'],
      hats: ['..x...x...x...x.', '-.x--.x--.x--.x-', 'o.x.o.x.o.xoo.x.'],
      ohat: ['..x...x...x...x.'],
      perc: ['...x..x.......x.', '.x.....x..x.....']
    },
    fills: [{ clap: '....x.......x.xx', kick: 'x...x...x.......' }, { clap: '....x.....x.xxxx' }, { kick: 'x...x...x.x.x.x.' }],
    bass: { style: 'rolling' },
    harmony: { style: 'stab', pattern: 'x.....x.....x...', len: 3 },
    arp: { order: [0, 1, 2, 1, 3, 2, 1, 2], rate: 1, oct: 12 },
    lead: {
      phrases: [
        [[0, 3, 7], [3, 3, 6], [6, 2, 4], [8, 4, 7], [12, 4, 9], [16, 3, 8], [19, 3, 7], [22, 2, 6], [24, 8, 4]],
        [[0, 3, 4], [3, 3, 6], [6, 2, 7], [8, 4, 8], [12, 2, 7], [14, 2, 6], [16, 6, 7], [22, 2, 9], [24, 8, 11]]
      ],
      verse: 'none'
    },
    form: { breakChance: 0.5 }
  };

  /* --- Apex Overdrive — drift: Eurobeat-inspired, 150 bpm, F# minor, octave bass, brass stabs, fast lead -- */
  TRACKS['apex-overdrive'] = {
    id: 'apex-overdrive', name: 'Apex Overdrive', mood: 'eurobeat-inspired', bpm: 150, swing: 0, rootMidi: midi('F#4'), scale: 'minor',
    fx: { reverb: 0.2, delay: 0.16, delayBeats: 0.75, cutLo: 1300, cutHi: 18000, pump: 0.5 },
    chords: ['F#2|F#3 A3 C#4', 'D2|F#3 A3 D4', 'E2|G#3 B3 E4', 'C#2|E#3 G#3 C#4', 'B1|F#3 B3 D4', 'D2|F#3 A3 D4', 'E2|G#3 B3 E4', 'F#2|F#3 A3 C#4'],
    parts: {
      kick:   { inst: 'kick', min: 0.15, vol: 1, patch: { f0: 165, f1: 50, dec: 0.26, click: 0.45 } },
      clap:   { inst: 'clap', min: 0.25, vol: 0.55, rev: 0.3, patch: { bp: 1500, dec: 0.15 } },
      snare:  { inst: 'snare', min: 0.55, vol: 0.32, rev: 0.25, patch: { tone: 220, noise: 0.9, dec: 0.14, bp: 2600 } },
      hats:   { inst: 'hat', min: 0.1, vol: 0.3, pan: 0.15, patch: { dec: 0.03, hp: 9000 } },
      ohat:   { inst: 'ohat', min: 0.2, vol: 0.3, pan: -0.15, patch: { dec: 0.14, hp: 7500 } },
      bass:   { inst: 'bass', min: 0, vol: 0.6, pump: true, patch: { wave: 'sawtooth', cut: 520, env: 1800, q: 4, dec: 0.1, sub: 0.3 } },
      chords: { inst: 'brass', min: 0.25, vol: 0.26, pump: true, rev: 0.3, patch: { voices: 3, detune: 10, cut: 2800, att: 0.02, dec: 0.2 } },
      arp:    { inst: 'pluck', min: 0.45, vol: 0.18, pan: -0.25, del: 0.3, patch: { wave: 'square', cut: 2000, env: 3500, dec: 0.08 } },
      lead:   { inst: 'lead', min: 0.5, vol: 0.27, pan: 0.05, rev: 0.28, del: 0.22, patch: { wave: 'sawtooth', voices: 3, detune: 16, cut: 4500, vib: 0.16, att: 0.008, rel: 0.12, porta: 0.025 } },
      fx:     { inst: 'fx', min: 0, vol: 0.45, rev: 0.5 }
    },
    drums: {
      kick: ['x...x...x...x...'],
      clap: ['....x.......x...'],
      snare: ['....x.......x...', '....x.......x..x'],
      hats: ['x.x.x.x.x.x.x.x.', 'xxx.xxx.xxx.xxx.'],
      ohat: ['..x...x...x...x.']
    },
    fills: [{ snare: '........x.x.xxxx' }, { snare: '....x...xxxxxxxx' }, { clap: '....x.......xxxx' }],
    bass: { style: 'octave' },
    harmony: { style: 'stab', pattern: 'x..x..x...x..x..', len: 2 },
    arp: { order: [0, 1, 2, 3, 2, 1, 0, 1], rate: 1, oct: 24 },
    lead: {
      phrases: [
        [[0, 2, 7], [2, 2, 8], [4, 2, 9], [6, 4, 11], [10, 2, 9], [12, 4, 8], [16, 2, 7], [18, 2, 8], [20, 2, 9], [22, 2, 8], [24, 4, 7], [28, 4, 6]],
        [[0, 2, 5], [2, 2, 6], [4, 2, 7], [6, 4, 9], [10, 2, 7], [12, 4, 6], [16, 3, 7], [19, 3, 8], [22, 2, 9], [24, 8, 10]],
        [[0, 3, 11], [3, 3, 10], [6, 2, 9], [8, 4, 10], [12, 4, 9], [16, 2, 8], [18, 2, 9], [20, 2, 10], [22, 2, 11], [24, 8, 12]]
      ],
      verse: 'arp'
    },
    form: { breakChance: 0.4 }
  };

  /* --- Sakura Pass — mellow drift on the cherry-blossom mountain: city-pop / lo-fi, 86 bpm, D major ------- */
  TRACKS['sakura-pass'] = {
    id: 'sakura-pass', name: 'Petal Drift', mood: 'city-pop lo-fi', bpm: 86, swing: 0.1, rootMidi: midi('D4'), scale: 'major',
    fx: { reverb: 0.3, delay: 0.22, delayBeats: 0.75, cutLo: 1500, cutHi: 12000, pump: 0.25, crackle: 0.1 },
    chords: ['G2|F#3 B3 D4 A4', 'A2|G3 C#4 E4 B4', 'F#2|E3 A3 C#4', 'B2|A3 D4 F#4', 'E2|D3 G3 B3 F#4', 'F#2|E3 A#3 C#4', 'B2|A3 C#4 D4 F#4', 'A2|G3 C#4 F#4'],
    parts: {
      kick:   { inst: 'kick', min: 0.12, vol: 0.8, patch: { f0: 115, f1: 48, dec: 0.32, click: 0.08, lp: 2600 } },
      snare:  { inst: 'rim', min: 0.18, vol: 0.4, rev: 0.4 },
      clap:   { inst: 'clap', min: 0.4, vol: 0.32, rev: 0.4, patch: { bp: 1200, dec: 0.18 } },
      hats:   { inst: 'shaker', min: 0.2, vol: 0.22, pan: 0.22, patch: { dec: 0.05, hp: 6500 } },
      bass:   { inst: 'bass', min: 0, vol: 0.6, patch: { wave: 'square', cut: 650, env: 1400, q: 4, dec: 0.22, sub: 0.55, glide: 0.03 } },
      chords: { inst: 'keys', min: 0, vol: 0.4, pump: true, rev: 0.35, del: 0.1, patch: { ratio: 1, index: 1.1, dec: 1.4, trem: 3.4 } },
      pad:    { inst: 'pad', min: 0.3, vol: 0.14, rev: 0.5, patch: { wave: 'triangle', voices: 2, detune: 7, cut: 2400, att: 0.8, rel: 1.4 } },
      lead:   { inst: 'lead', min: 0.48, vol: 0.2, pan: -0.1, rev: 0.45, del: 0.4, patch: { wave: 'triangle', voices: 1, cut: 3200, vib: 0.22, att: 0.03, rel: 0.4, porta: 0.06 } },
      crackle:{ inst: 'crackle', min: 0, vol: 0.32 },
      fx:     { inst: 'fx', min: 0, vol: 0.3, rev: 0.6 }
    },
    drums: {
      kick: ['x.......x.x.....', 'x......x..x.....'],
      snare: ['....x.......x...', '....x.......x..-'],
      clap: ['............x...'],
      hats: ['x.o.x.o.x.o.x.o.', 'x.oox.o.x.oox.o.']
    },
    fills: [{ snare: '..........x.x.xx' }, { kick: 'x.......x.x...x.' }],
    bass: { style: 'citypop' },
    harmony: { style: 'comp', pattern: 'x..x..x...x..x..', len: 3 },
    lead: {
      phrases: [
        [[0, 3, 9], [3, 3, 8], [6, 2, 7], [8, 6, 4], [16, 2, 5], [18, 2, 4], [20, 4, 2], [24, 8, 4]],
        [[0, 4, 7], [4, 2, 8], [6, 2, 9], [8, 6, 11], [16, 3, 9], [19, 3, 8], [22, 2, 7], [24, 8, 8]]
      ],
      verse: 'sparse'
    },
    crackle: true,
    form: { breakChance: 0.25 }
  };

  /* --- Candy Boost — arcade: bright, playful, 140 bpm, C major, square leads and bouncy bass ------------- */
  TRACKS['candy-boost'] = {
    id: 'candy-boost', name: 'Candy Boost', mood: 'bright arcade pop', bpm: 140, swing: 0, rootMidi: midi('C5'), scale: 'major',
    fx: { reverb: 0.2, delay: 0.2, delayBeats: 0.5, cutLo: 1800, cutHi: 18000, pump: 0.4 },
    chords: ['F2|F3 A3 C4 E4', 'G2|G3 B3 D4', 'E2|E3 G3 B3 D4', 'A2|A3 C4 E4', 'F2|F3 A3 C4', 'G2|G3 B3 D4 F4', 'C2|E3 G3 C4', 'C2|G3 C4 E4'],
    parts: {
      kick:   { inst: 'kick', min: 0.15, vol: 0.95, patch: { f0: 170, f1: 55, dec: 0.22, click: 0.3 } },
      clap:   { inst: 'clap', min: 0.25, vol: 0.5, rev: 0.28, patch: { bp: 1600, dec: 0.14 } },
      hats:   { inst: 'hat', min: 0.12, vol: 0.28, pan: 0.2, patch: { dec: 0.03, hp: 9000 } },
      perc:   { inst: 'tom', min: 0.55, vol: 0.32, pan: -0.25, patch: { f0: 420, f1: 260, dec: 0.12 } },
      bass:   { inst: 'bass', min: 0, vol: 0.55, pump: true, patch: { wave: 'square', cut: 700, env: 1600, q: 2, dec: 0.12, sub: 0.4 } },
      chords: { inst: 'pluck', min: 0.2, vol: 0.2, pump: true, rev: 0.25, patch: { wave: 'square', cut: 2600, env: 2000, dec: 0.18 } },
      arp:    { inst: 'pluck', min: 0.4, vol: 0.16, pan: 0.3, del: 0.3, patch: { wave: 'triangle', cut: 5000, env: 2000, dec: 0.09 } },
      lead:   { inst: 'lead', min: 0.5, vol: 0.22, rev: 0.22, del: 0.2, patch: { wave: 'square', voices: 2, detune: 5, cut: 5200, vib: 0.2, att: 0.005, rel: 0.1, porta: 0.02 } },
      fx:     { inst: 'fx', min: 0, vol: 0.4, rev: 0.4 }
    },
    drums: {
      kick: ['x...x...x...x...', 'x...x...x...x.x.'],
      clap: ['....x.......x...'],
      hats: ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.'],
      perc: ['......x......x..', '...x......x...x.']
    },
    fills: [{ perc: '........x.x.xxxx' }, { clap: '....x.......x.xx' }],
    bass: { style: 'bounce' },
    harmony: { style: 'stab', pattern: '..x...x...x...x.', len: 2 },
    arp: { order: [0, 2, 1, 3, 2, 1], rate: 1, oct: 24 },
    lead: {
      phrases: [
        [[0, 2, 4], [2, 2, 4], [4, 2, 5], [6, 2, 7], [8, 4, 9], [12, 4, 7], [16, 2, 5], [18, 2, 4], [20, 4, 2], [24, 4, 4], [28, 4, 0]],
        [[0, 2, 4], [2, 2, 4], [4, 2, 5], [6, 2, 7], [8, 4, 9], [12, 2, 11], [14, 2, 9], [16, 4, 7], [20, 2, 9], [22, 2, 8], [24, 8, 7]]
      ],
      verse: 'none'
    },
    form: { breakChance: 0.3 }
  };

  /* --- Pit Wall — Formula 1: tense, cinematic, 116 bpm, D harmonic minor, string ostinato + taiko --------- */
  TRACKS['pit-wall'] = {
    id: 'pit-wall', name: 'Pit Wall', mood: 'tense cinematic', bpm: 116, swing: 0, rootMidi: midi('D4'), scale: 'harmMinor',
    fx: { reverb: 0.42, delay: 0.12, delayBeats: 0.75, cutLo: 700, cutHi: 12000, pump: 0.18 },
    chords: ['D2|D3 F3 A3', 'Bb1|D3 F3 Bb3', 'G1|G3 Bb3 D4', 'A1|A2 C#3 E3 A3', 'D2|D3 F3 A3', 'Eb2|Eb3 G3 Bb3', 'Bb1|D3 F3 Bb3', 'A1|C#3 E3 G3 A3'],
    parts: {
      kick:   { inst: 'tom', min: 0.25, vol: 0.9, rev: 0.4, patch: { f0: 110, f1: 52, dec: 0.6, noise: 0.25 } },
      snare:  { inst: 'snare', min: 0.55, vol: 0.36, rev: 0.5, patch: { tone: 160, noise: 0.6, dec: 0.3, bp: 1500 } },
      hats:   { inst: 'hat', min: 0.35, vol: 0.2, pan: 0.25, patch: { dec: 0.025, hp: 9500 } },
      bass:   { inst: 'pluck', min: 0, vol: 0.4, rev: 0.15, patch: { wave: 'sawtooth', cut: 450, env: 1300, q: 3, dec: 0.12 } },
      sub:    { inst: 'sub', min: 0.4, vol: 0.4, patch: { dec: 1.6 } },
      chords: { inst: 'pad', min: 0, vol: 0.3, rev: 0.5, patch: { wave: 'sawtooth', voices: 3, detune: 8, cut: 1100, att: 0.9, rel: 1.6 } },
      brass:  { inst: 'brass', min: 0.6, vol: 0.3, rev: 0.45, patch: { voices: 2, detune: 6, cut: 900, att: 0.25, dec: 1.4, sweep: 1 } },
      lead:   { inst: 'lead', min: 0.72, vol: 0.18, rev: 0.6, del: 0.2, patch: { wave: 'sawtooth', voices: 2, detune: 7, cut: 2600, vib: 0.25, att: 0.35, rel: 0.8 } },
      fx:     { inst: 'fx', min: 0, vol: 0.5, rev: 0.7 }
    },
    drums: {
      kick: ['x.....x...x.....', 'x.....x...x...o.'],
      snare: ['........x.......', '........x.....-x'],
      hats: ['x-x-x-x-x-x-x-x-', 'x.x.x.x.x.x.x.x.']
    },
    fills: [{ kick: 'x.....x...x.xoxx' }, { snare: '........x...xxxx' }],
    bass: { style: 'ostinato' },
    harmony: { style: 'pad' },
    brass: true,
    lead: {
      phrases: [
        [[0, 8, 7], [8, 8, 8], [16, 12, 9], [28, 4, 8]],
        [[0, 8, 11], [8, 8, 10], [16, 16, 7]]
      ],
      verse: 'none'
    },
    form: { breakChance: 0.3 }
  };

  /* --- Scrap Heap — derby: heavy, distorted industrial rock, 100 bpm, E phrygian, power-chord chugs -------- */
  TRACKS['scrap-heap'] = {
    id: 'scrap-heap', name: 'Scrap Heap', mood: 'industrial rock', bpm: 100, swing: 0, rootMidi: midi('E3'), scale: 'phrygian',
    fx: { reverb: 0.16, delay: 0.08, delayBeats: 0.5, cutLo: 1200, cutHi: 14000, pump: 0.15, drive: 0.45 },
    chords: ['E2|E2 B2 E3', 'E2|E2 B2 E3', 'F2|F2 C3 F3', 'G2|G2 D3 G3', 'E2|E2 B2 E3', 'E2|E2 B2 E3', 'C2|C3 G3 C4', 'D2|D3 A3 D4'],
    parts: {
      kick:   { inst: 'kick', min: 0.1, vol: 1, patch: { f0: 140, f1: 42, dec: 0.3, click: 0.6, drive: 0.6 } },
      snare:  { inst: 'snare', min: 0.15, vol: 0.62, rev: 0.25, patch: { tone: 180, noise: 1, dec: 0.2, bp: 2000, drive: 0.5 } },
      hats:   { inst: 'metal', min: 0.3, vol: 0.2, pan: 0.2, patch: { dec: 0.06 } },
      perc:   { inst: 'metal', min: 0.6, vol: 0.24, pan: -0.3, rev: 0.35, patch: { dec: 0.3, f: 410 } },
      bass:   { inst: 'bass', min: 0, vol: 0.55, patch: { wave: 'sawtooth', cut: 360, env: 800, q: 2, dec: 0.14, sub: 0.5, drive: 0.5 } },
      chords: { inst: 'power', min: 0.2, vol: 0.32, patch: { drive: 0.85, cut: 2600 } },
      lead:   { inst: 'lead', min: 0.7, vol: 0.18, rev: 0.25, patch: { wave: 'sawtooth', voices: 2, detune: 20, cut: 3000, vib: 0.3, att: 0.02, rel: 0.2, drive: 0.6 } },
      fx:     { inst: 'fx', min: 0, vol: 0.45, rev: 0.4 }
    },
    drums: {
      kick: ['x.x...x.x.x...x.', 'x.x.x...x.x..xx.', 'xx....x.x.x...x.'],
      snare: ['....x.......x...', '....x.......x..x'],
      hats: ['x.x.x.x.x.x.x.x.', 'x-x-x-x-x-x-x-x-'],
      perc: ['......x.......x.', '..x.......x.....']
    },
    fills: [{ snare: '........x.xxxxxx' }, { kick: 'x.x.x.x.xxxxxxxx', snare: '....x.......x.x.' }],
    bass: { style: 'chug' },
    harmony: { style: 'chug' },
    lead: {
      phrases: [
        [[0, 4, 7], [4, 2, 8], [6, 2, 7], [8, 8, 5], [16, 4, 4], [20, 4, 5], [24, 8, 1]],
        [[0, 2, 7], [2, 2, 8], [4, 4, 10], [8, 4, 8], [12, 4, 7], [16, 16, 8]]
      ],
      verse: 'none'
    },
    form: { breakChance: 0.3 }
  };

  /* --- Quarter Mile — drag: staging tension build, then a hard drop on the green, 128 bpm, A minor -------- */
  TRACKS['quarter-mile'] = {
    id: 'quarter-mile', name: 'Quarter Mile', mood: 'build and drop', bpm: 128, swing: 0, rootMidi: midi('A4'), scale: 'minor',
    fx: { reverb: 0.25, delay: 0.18, delayBeats: 0.75, cutLo: 800, cutHi: 18000, pump: 0.66 },
    chords: ['A1|A2 E3 A3 C4', 'F1|F2 C3 A3 C4', 'C2|C3 G3 C4 E4', 'G1|G2 D3 B3 D4'],
    parts: {
      kick:   { inst: 'kick', min: 0, vol: 1, patch: { f0: 160, f1: 45, dec: 0.36, click: 0.4 } },
      clap:   { inst: 'clap', min: 0, vol: 0.5, rev: 0.3, patch: { bp: 1400, dec: 0.16 } },
      snare:  { inst: 'snare', min: 0, vol: 0.42, rev: 0.3, patch: { tone: 200, noise: 0.9, dec: 0.12, bp: 2400 } },
      hats:   { inst: 'hat', min: 0, vol: 0.3, pan: 0.15, patch: { dec: 0.035, hp: 8500 } },
      ohat:   { inst: 'ohat', min: 0.4, vol: 0.26, pan: -0.15, patch: { dec: 0.16, hp: 7500 } },
      bass:   { inst: 'bass', min: 0, vol: 0.62, pump: true, patch: { wave: 'sawtooth', cut: 300, env: 2000, q: 7, dec: 0.12, sub: 0.5 } },
      chords: { inst: 'pad', min: 0, vol: 0.26, pump: true, rev: 0.4, patch: { wave: 'sawtooth', voices: 3, detune: 14, cut: 1800, att: 0.1, rel: 0.6 } },
      lead:   { inst: 'lead', min: 0.4, vol: 0.25, rev: 0.3, del: 0.3, patch: { wave: 'sawtooth', voices: 3, detune: 16, cut: 4200, vib: 0.1, att: 0.01, rel: 0.2 } },
      fx:     { inst: 'fx', min: 0, vol: 0.55, rev: 0.5 }
    },
    drums: {
      kick: ['x...x...x...x...'],
      clap: ['....x.......x...'],
      hats: ['..x...x...x...x.', 'xxx.xxx.xxx.xxx.'],
      ohat: ['..x...x...x...x.']
    },
    fills: [{ clap: '....x.......xxxx' }],
    bass: { style: 'rolling' },
    harmony: { style: 'stab', pattern: 'x.....x.....x...', len: 4 },
    lead: {
      phrases: [
        [[0, 2, 7], [2, 2, 7], [4, 4, 9], [8, 2, 7], [10, 2, 6], [12, 4, 4], [16, 2, 7], [18, 2, 7], [20, 4, 10], [24, 4, 9], [28, 4, 7]],
        [[0, 3, 11], [3, 3, 10], [6, 2, 9], [8, 8, 7], [16, 3, 9], [19, 3, 8], [22, 2, 7], [24, 8, 6]]
      ],
      verse: 'none'
    },
    build: true,
    form: { breakChance: 0 }
  };

  /* --- Stingers ------------------------------------------------------------------------------------------ */
  TRACKS['victory'] = {
    id: 'victory', name: 'Chequered', mood: 'victory stinger', bpm: 120, swing: 0, rootMidi: midi('C5'), scale: 'major', oneShot: 3,
    fx: { reverb: 0.4, delay: 0.2, delayBeats: 0.75, cutLo: 18000, cutHi: 18000, pump: 0 },
    parts: {
      kick:   { inst: 'kick', min: 0, vol: 0.9, patch: { f0: 150, f1: 45, dec: 0.5, click: 0.3 } },
      snare:  { inst: 'snare', min: 0, vol: 0.4, rev: 0.4, patch: { tone: 200, noise: 0.9, dec: 0.12, bp: 2400 } },
      chords: { inst: 'brass', min: 0, vol: 0.34, rev: 0.45, patch: { voices: 3, detune: 10, cut: 3200, att: 0.03, dec: 2.2 } },
      lead:   { inst: 'lead', min: 0, vol: 0.3, rev: 0.45, del: 0.3, patch: { wave: 'sawtooth', voices: 3, detune: 12, cut: 5000, vib: 0.2, att: 0.01, rel: 0.6 } },
      bass:   { inst: 'sub', min: 0, vol: 0.5, patch: { dec: 2 } },
      fx:     { inst: 'fx', min: 0, vol: 0.5, rev: 0.6 }
    },
    script: function (bar, T) {
      var e = [];
      if (bar === 0) {
        [[0, 0], [2, 2], [4, 4], [6, 7]].forEach(function (x) { e.push({ t: x[0], d: 2, p: 'lead', n: deg(T, x[1]), v: 0.8 }); });
        e.push({ t: 8, d: 8, p: 'lead', n: deg(T, 9), v: 0.95 });
        [0, 2, 4, 6].forEach(function (t) { e.push({ t: t, d: 1, p: 'snare', n: 0, v: 0.4 + t * 0.06 }); });
        e.push({ t: 8, d: 24, p: 'chords', n: [midi('F4'), midi('A4'), midi('C5'), midi('E5')], v: 0.9 });
        e.push({ t: 8, d: 8, p: 'bass', n: midi('F2'), v: 0.9 });
        e.push({ t: 8, d: 1, p: 'kick', n: 0, v: 1 });
        e.push({ t: 8, d: 16, p: 'fx', k: 'crash', v: 0.8 });
      } else if (bar === 1) {
        e.push({ t: 0, d: 4, p: 'lead', n: deg(T, 8), v: 0.8 });
        e.push({ t: 4, d: 4, p: 'lead', n: deg(T, 11), v: 0.85 });
        e.push({ t: 8, d: 24, p: 'lead', n: deg(T, 14), v: 1 });
        e.push({ t: 8, d: 24, p: 'chords', n: [midi('C4'), midi('E4'), midi('G4'), midi('B4'), midi('D5')], v: 1 });
        e.push({ t: 8, d: 24, p: 'bass', n: midi('C2'), v: 1 });
        e.push({ t: 8, d: 1, p: 'kick', n: 0, v: 1 });
        e.push({ t: 8, d: 24, p: 'fx', k: 'crash', v: 1 });
      }
      return e;
    }
  };
  TRACKS['defeat'] = {
    id: 'defeat', name: 'Cool Down', mood: 'defeat stinger', bpm: 76, swing: 0, rootMidi: midi('A4'), scale: 'minor', oneShot: 3,
    fx: { reverb: 0.5, delay: 0.3, delayBeats: 0.75, cutLo: 2400, cutHi: 2400, pump: 0 },
    parts: {
      chords: { inst: 'pad', min: 0, vol: 0.3, rev: 0.6, patch: { wave: 'sawtooth', voices: 2, detune: 8, cut: 900, att: 0.4, rel: 2 } },
      lead:   { inst: 'keys', min: 0, vol: 0.38, rev: 0.5, del: 0.4, patch: { ratio: 1, index: 1, dec: 1.6, trem: 0 } },
      bass:   { inst: 'sub', min: 0, vol: 0.45, patch: { dec: 3 } },
      fx:     { inst: 'fx', min: 0, vol: 0.4, rev: 0.7 }
    },
    script: function (bar, T) {
      var e = [];
      if (bar === 0) {
        [[0, 4], [3, 3], [6, 2], [9, 1]].forEach(function (x) { e.push({ t: x[0], d: 4, p: 'lead', n: deg(T, x[1]), v: 0.7 }); });
        e.push({ t: 0, d: 16, p: 'chords', n: [midi('F3'), midi('A3'), midi('C4'), midi('E4')], v: 0.8 });
        e.push({ t: 0, d: 16, p: 'bass', n: midi('F2'), v: 0.7 });
        e.push({ t: 0, d: 16, p: 'fx', k: 'down', v: 0.5 });
      } else if (bar === 1) {
        e.push({ t: 0, d: 24, p: 'lead', n: deg(T, 0), v: 0.75 });
        e.push({ t: 0, d: 32, p: 'chords', n: [midi('E3'), midi('A3'), midi('C4'), midi('G4')], v: 0.85 });
        e.push({ t: 0, d: 32, p: 'bass', n: midi('A1'), v: 0.8 });
      }
      return e;
    }
  };

  /* ================================================================ CONTEXTS */
  var CONTEXTS = {
    menu: 'neon-lounge', hub: 'neon-lounge', title: 'neon-lounge', career: 'neon-lounge', multiplayer: 'neon-lounge',
    garage: 'tape-garage', atelier: 'tape-garage', cars: 'tape-garage',
    race: 'redline-run', drift: 'apex-overdrive', 'drift-sakura': 'sakura-pass', arcade: 'candy-boost', f1: 'pit-wall',
    derby: 'scrap-heap', drag: 'quarter-mile', victory: 'victory', defeat: 'defeat'
  };
  function isSakura(id) { return /sakura/i.test(String(id || '')); }
  /** Resolve a play() context to a track id. o: { trackId (the circuit / map id), won, trackOverride } */
  function trackFor(context, o) {
    o = o || {};
    if (o.track && TRACKS[o.track]) return o.track;
    var c = String(context || 'menu');
    if (TRACKS[c]) return c;
    if (c === 'results') return o.won === false ? 'defeat' : 'victory';
    if (c === 'drift' && isSakura(o.trackId)) return 'sakura-pass';
    return CONTEXTS[c] || CONTEXTS.menu;
  }

  /* ============================================================== GENERATOR */
  function prep(T) {
    if (T._chords || !T.chords) return T;
    T._chords = T.chords.map(chord);
    return T;
  }
  function chordAt(T, bar) { return T._chords ? T._chords[((bar % T._chords.length) + T._chords.length) % T._chords.length] : null; }

  /** Section of a looping track at a bar: 32-bar blocks = verse (8) chorus (8) verse (8) chorus (8);
      a seeded share of blocks turns the last 4 bars into a breakdown (no kick/bass, riser, sweep into the drop). */
  function sectionOf(T, seed, bar) {
    if (bar < 4 && !T.build) return 'intro';
    var block = Math.floor(bar / 32), inBlock = bar % 32;
    var r = rng(hash32(seed, T.id, 'block', block));
    var hasBreak = block > 0 && r() < ((T.form && T.form.breakChance) || 0);
    if (hasBreak && inBlock >= 28) return 'break';
    return Math.floor(inBlock / 8) % 2 === 0 ? 'verse' : 'chorus';
  }

  function swingT(T, step) { return (step % 2 === 1) ? step + (T.swing || 0) : step; }

  function mutateMotif(T, motif, r) {
    var m = motif.map(function (x) { return x.slice(); });
    var nMut = Math.floor(r() * 3);
    for (var k = 0; k < nMut; k++) {
      var i = 1 + Math.floor(r() * Math.max(1, m.length - 2));
      if (!m[i]) continue;
      var c = r();
      if (c < 0.5) m[i][2] += r() < 0.5 ? -1 : 1;              // neighbour tone
      else if (c < 0.7 && m[i][1] >= 4) {                        // split a long note into two
        var half = Math.floor(m[i][1] / 2);
        m.splice(i + 1, 0, [m[i][0] + half, m[i][1] - half, m[i][2] + (r() < 0.5 ? 1 : 2)]);
        m[i][1] = half;
      } else if (c < 0.85) m[i][2] += 7 * (r() < 0.3 ? 1 : 0);   // occasional octave lift
      // else: keep (repetition is musical too)
    }
    return m;
  }

  function drumEvents(T, seed, bar, section, out) {
    var D = T.drums || {}, phrase = Math.floor(bar / 8);
    var rp = rng(hash32(seed, T.id, 'drums', phrase));
    var choice = {};
    Object.keys(D).forEach(function (part) { choice[part] = pick(rp, D[part]); });
    // chorus prefers the busier variants
    if (section === 'chorus') Object.keys(D).forEach(function (part) { if (D[part].length > 1 && rp() < 0.6) choice[part] = D[part][D[part].length - 1]; });
    var fill = null;
    if (bar % 8 === 7 && T.fills && T.fills.length) fill = pick(rng(hash32(seed, T.id, 'fill', phrase)), T.fills);
    if (bar % 4 === 3 && !fill && T.fills && rng(hash32(seed, T.id, 'mini', bar))() < 0.25) fill = T.fills[0];
    Object.keys(choice).forEach(function (part) {
      if (!T.parts[part]) return;
      if (section === 'break' && (part === 'kick' || part === 'snare' || part === 'clap' || part === 'perc')) return;
      if (section === 'intro' && (part === 'snare' || part === 'clap' || part === 'perc')) return;
      var steps = pat(choice[part]);
      if (fill && fill[part]) steps = steps.filter(function (s) { return s[0] < 8; }).concat(pat(fill[part]).filter(function (s) { return s[0] >= 8; }));
      var rv = rng(hash32(seed, T.id, part, bar));
      steps.forEach(function (s) {
        var v = s[1] * (0.9 + 0.1 * rv());                      // humanised velocity
        out.push({ t: swingT(T, s[0]), d: 1, p: part, n: 0, v: v });
      });
    });
    if (section === 'break') {
      // hats thin out to quarter pulses, a riser and a filter sweep lead back into the drop
      if (bar % 32 === 28) out.push({ t: 0, d: 64, p: 'fx', k: 'riser', v: 0.7 });
      if (bar % 32 === 28) out.push({ t: 0, d: 64, p: 'fx', k: 'sweep', from: 500, to: 18000, v: 1 });
    }
    if (section !== 'break' && bar % 32 === 0 && bar > 0) out.push({ t: 0, d: 16, p: 'fx', k: 'crash', v: 0.7 });
    if (bar % 8 === 7 && section !== 'break' && rng(hash32(seed, T.id, 'rev', phrase))() < 0.4) out.push({ t: 8, d: 8, p: 'fx', k: 'reverse', v: 0.5 });
  }

  function bassEvents(T, seed, bar, ch, section, out) {
    if (!T.bass || !T.parts.bass || section === 'break') return;
    var b = ch.bass, style = T.bass.style, r = rng(hash32(seed, T.id, 'bass', bar)), i;
    function ev(t, d, n, v) { out.push({ t: swingT(T, t), d: d, p: 'bass', n: n, v: v }); }
    var next = chordAt(T, bar + 1);
    if (style === 'rolling') {
      for (i = 0; i < 16; i++) if (i % 4 !== 0) ev(i, 1, b + (i % 4 === 2 && r() < 0.15 ? 12 : 0), i % 4 === 2 ? 0.95 : 0.75);
    } else if (style === 'octave') {
      for (i = 0; i < 16; i += 2) ev(i, 1.5, b + (i % 4 === 2 ? 12 : 0), i % 4 === 2 ? 1 : 0.8);
      if (bar % 2 === 1) { ev(14, 1, b + 12, 0.9); ev(15, 1, next ? next.bass + 12 : b + 12, 0.9); }
    } else if (style === 'pulse') {
      pat(T.bass.pattern).forEach(function (s, k) { ev(s[0], k === 0 ? 6 : 2, b + (s[0] === 8 ? 12 : 0), s[1]); });
    } else if (style === 'lazy') {
      pat(T.bass.pattern).forEach(function (s) { ev(s[0], s[0] === 0 ? 6 : 3, b + (s[0] === 10 ? 7 : s[0] === 15 ? (next ? next.bass - b - 1 : -2) : 0), s[1]); });
    } else if (style === 'citypop') {
      var walk = [[0, 3, 0], [3, 1, 12], [4, 2, 7], [6, 2, 0], [8, 2, 12], [10, 1, 10], [11, 2, 7], [14, 2, 5]];
      if (r() < 0.4) walk[7] = [14, 2, next ? next.bass - b + (next.bass - b > 6 ? -12 : 0) - 1 : 2];
      walk.forEach(function (w) { ev(w[0], w[1], b + w[2], w[0] % 4 === 0 ? 0.95 : 0.7); });
    } else if (style === 'bounce') {
      for (i = 0; i < 16; i += 2) ev(i, 1.4, b + (i % 4 === 2 ? 12 : 0) + (i === 14 && r() < 0.5 ? 7 : 0), i % 4 === 0 ? 0.95 : 0.8);
    } else if (style === 'ostinato') {
      var cell = [0, 0, 12, 0, 7, 0, 12, 0, 0, 0, 12, 0, 8, 0, 7, 0];
      for (i = 0; i < 16; i++) out.push({ t: i, d: 0.9, p: 'bass', n: b + 12 + cell[i], v: i % 4 === 0 ? 0.95 : 0.6 });
      if (T.parts.sub && bar % 2 === 0) out.push({ t: 0, d: 32, p: 'sub', n: b, v: 0.8 });
    } else if (style === 'chug') {
      var cp = pick(rng(hash32(seed, T.id, 'chug', Math.floor(bar / 4))), ['xxx.xxx.xx.xxx.x', 'x.xxx.xxx.xx.xxx', 'xx.xx.xxxx.xx.xx']);
      pat(cp).forEach(function (s) { ev(s[0], 0.8, b, s[0] % 4 === 0 ? 1 : 0.72); });
    }
  }

  function harmonyEvents(T, seed, bar, ch, section, out) {
    if (!T.harmony || !T.parts.chords) return;
    var r = rng(hash32(seed, T.id, 'inv', Math.floor(bar / 16)));
    var notes = ch.notes.slice();
    if (r() < 0.35 && notes.length > 2) { notes = notes.slice(); notes[notes.length - 1] -= 12; notes.sort(function (a, b) { return a - b; }); }   // seeded inversion
    var H = T.harmony;
    if (H.style === 'pad') out.push({ t: 0, d: 16, p: 'chords', n: notes, v: section === 'break' ? 0.7 : 0.85 });
    else if (H.style === 'stab' || H.style === 'comp') {
      if (section === 'break') { out.push({ t: 0, d: 16, p: 'chords', n: notes, v: 0.6 }); return; }
      pat(H.pattern).forEach(function (s) { out.push({ t: swingT(T, s[0]), d: H.len || 2, p: 'chords', n: notes, v: s[1] }); });
    } else if (H.style === 'chug') {
      if (bar % 2 === 0) out.push({ t: 0, d: 6, p: 'chords', n: notes, v: 1 });
      var cp = pick(rng(hash32(seed, T.id, 'pc', Math.floor(bar / 4))), ['......x.x.x...x.', '......xx..x.x...', '........x.x.x.x.']);
      pat(cp).forEach(function (s) { out.push({ t: s[0], d: 1, p: 'chords', n: notes, v: 0.8 }); });
    }
    if (T.parts.pad) out.push({ t: 0, d: 16, p: 'pad', n: notes.map(function (n) { return n + 12; }), v: 0.7 });
    if (T.brass && T.parts.brass && bar % 4 === 0) out.push({ t: 0, d: 14, p: 'brass', n: [ch.bass + 12, ch.bass + 19, ch.bass + 24], v: 0.85 });
  }

  function arpEvents(T, seed, bar, ch, section, out) {
    if (!T.arp || !T.parts.arp) return;
    var A = T.arp, notes = ch.notes, k = 0;
    var r = rng(hash32(seed, T.id, 'arp', Math.floor(bar / 8)));
    var oct = A.oct + (r() < 0.25 ? 12 : 0) - (A.oct >= 24 && r() < 0.3 ? 12 : 0);
    for (var t = 0; t < 16; t += A.rate) {
      var idx = A.order[k++ % A.order.length] % notes.length;
      out.push({ t: swingT(T, t), d: A.rate * 0.9, p: 'arp', n: notes[idx] + oct, v: t % 4 === 0 ? 0.9 : 0.65 });
    }
  }

  function leadEvents(T, seed, bar, section, out) {
    if (!T.lead || !T.parts.lead) return;
    var L = T.lead;
    var inPhrase = bar % 8, pair = Math.floor(inPhrase / 2), half = inPhrase % 2;
    var play = section === 'chorus' || (section === 'verse' && L.verse === 'sparse');
    if (section === 'verse' && L.verse === 'arp' && T.parts.arp) play = false;
    if (!play || section === 'break' || section === 'intro') return;
    var idx = pair % L.phrases.length;
    if (section === 'chorus' && pair === 3) idx = L.phrases.length - 1;
    var r = rng(hash32(seed, T.id, 'lead', Math.floor(bar / 16), pair));
    var motif = (pair === 0 && Math.floor(bar / 16) % 2 === 0) ? L.phrases[idx] : mutateMotif(T, L.phrases[idx], r);
    var sparse = section === 'verse';
    motif.forEach(function (m, j) {
      var st = m[0] - half * 16;
      if (st < 0 || st >= 16) return;
      if (sparse && j % 2 === 1) return;
      out.push({ t: swingT(T, st), d: Math.min(m[1], 32 - m[0]), p: 'lead', n: deg(T, m[2]), v: (j === 0 ? 0.95 : 0.8) * (sparse ? 0.8 : 1) });
    });
  }

  /* drag build: 'stage' bars grow denser (snare roll 8ths -> 16ths -> 32nds), the bass pedals on the tonic and a riser +
     high-pass-to-open sweep repeat every 4 bars; 'idle' is a sparse pad + pulse; 'go' is the full groove with a crash. */
  function buildEvents(T, seed, bar, o, out) {
    var ph = o.phase || 'idle', pb = Math.max(0, o.phaseBar | 0), ch = chordAt(T, 0), i;
    if (ph === 'idle') {
      out.push({ t: 0, d: 16, p: 'chords', n: ch.notes, v: 0.5 });
      for (i = 0; i < 16; i += 4) out.push({ t: i, d: 2, p: 'bass', n: ch.bass, v: 0.5 });
      for (i = 2; i < 16; i += 4) out.push({ t: i, d: 1, p: 'hats', n: 0, v: 0.35 });
      return 'idle';
    }
    if (ph === 'stage') {
      var lvl = Math.min(pb, 7), rate = lvl < 2 ? 4 : lvl < 4 ? 2 : lvl < 6 ? 1 : 0.5;
      for (i = 0; i < 16; i += 4) out.push({ t: i, d: 1, p: 'kick', n: 0, v: 0.7 + lvl * 0.04 });
      for (var t = 0; t < 16; t += rate) out.push({ t: t, d: 0.5, p: 'snare', n: 0, v: 0.3 + 0.6 * (t / 16) * (0.4 + lvl / 12) });
      for (i = 0; i < 16; i += 2) out.push({ t: i, d: 1, p: 'bass', n: ch.bass + (lvl >= 4 && i % 4 === 2 ? 12 : 0), v: 0.6 + lvl * 0.04 });
      out.push({ t: 0, d: 16, p: 'chords', n: ch.notes.map(function (n) { return n + (lvl >= 6 ? 12 : 0); }), v: 0.55 + lvl * 0.04 });
      if (pb % 4 === 0) { out.push({ t: 0, d: 64, p: 'fx', k: 'riser', v: 0.55 + lvl * 0.05 }); out.push({ t: 0, d: 64, p: 'fx', k: 'sweep', from: 350, to: 9000, v: 1 }); }
      return 'build';
    }
    return null;   // 'go' -> normal generator (with a drop marker on its first bar)
  }

  /** Deterministic bar generator. */
  function generateBar(id, seed, bar, o) {
    o = o || {};
    var T = TRACKS[id] || TRACKS[trackFor(id, o)];
    prep(T);
    bar = Math.max(0, bar | 0); seed = seed >>> 0;
    var out = [], section;
    if (T.script) {
      out = T.script(bar, T) || [];
      section = bar < (T.oneShot || 2) ? 'stinger' : 'end';
      return { bar: bar, section: section, chord: null, events: out, track: T.id };
    }
    var ch = chordAt(T, bar);
    if (T.build) {
      var bs = buildEvents(T, seed, bar, o, out);
      if (bs) return { bar: bar, section: bs, chord: ch, events: out, track: T.id };
      if ((o.phaseBar | 0) === 0) { out.push({ t: 0, d: 32, p: 'fx', k: 'crash', v: 1 }); out.push({ t: 0, d: 16, p: 'fx', k: 'impact', v: 1 }); }
      section = (Math.floor(bar / 8) % 2 === 0) ? 'chorus' : 'verse';
      if ((o.phaseBar | 0) < 8) section = 'chorus';
    } else section = sectionOf(T, seed, bar);
    drumEvents(T, seed, bar, section, out);
    bassEvents(T, seed, bar, ch, section, out);
    harmonyEvents(T, seed, bar, ch, section, out);
    arpEvents(T, seed, bar, ch, section, out);
    leadEvents(T, seed, bar, section, out);
    out.sort(function (a, b) { return a.t - b.t; });
    return { bar: bar, section: section, chord: ch ? ch.name : null, events: out, track: T.id };
  }

  /* ============================================================== EXPORTS */
  var api = {
    TRACKS: TRACKS, CONTEXTS: CONTEXTS, SCALES: SCALES,
    trackFor: trackFor, generateBar: generateBar, sectionOf: function (id, seed, bar) { return sectionOf(prep(TRACKS[id]), seed >>> 0, bar | 0); },
    list: function () { return Object.keys(TRACKS).map(function (k) { var T = TRACKS[k]; return { id: T.id, name: T.name, mood: T.mood, bpm: T.bpm, stinger: !!T.oneShot }; }); },
    _: { midi: midi, chord: chord, hash32: hash32, rng: rng, pat: pat, deg: deg, isSakura: isSakura }
  };
  CB.musicTracks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

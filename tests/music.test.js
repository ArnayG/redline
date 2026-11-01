/* tests/music.test.js — CB.music (js/audio/music.js) + the generative sequencer (js/audio/music-tracks.js).
   A mock AudioContext stands in for Web Audio: it records node creation, connections, source start/stop and fires
   onended as fake time advances, so the tests can check the gesture gate, volume settings and node release. */
'use strict';
const path = require('path');

function fresh() {
  // load both scripts as if in a page without window/document (no gesture listeners), isolated from other test files
  const saved = { window: globalThis.window, document: globalThis.document };
  delete globalThis.window; delete globalThis.document;
  const pT = path.join(__dirname, '..', 'js', 'audio', 'music-tracks.js'), pM = path.join(__dirname, '..', 'js', 'audio', 'music.js');
  delete require.cache[pT]; delete require.cache[pM];
  const T = require(pT), M = require(pM);
  if (saved.window !== undefined) globalThis.window = saved.window;
  if (saved.document !== undefined) globalThis.document = saved.document;
  return { T, M };
}

/* ------------------------------------------------------------------ mock Web Audio */
function makeMock() {
  const made = [], ctxs = [];
  class Param {
    constructor(v) { this.value = v; this.n = 0; }
    setValueAtTime(v) { this.value = v; this.n++; return this; }
    linearRampToValueAtTime(v) { this.value = v; this.n++; return this; }
    exponentialRampToValueAtTime(v) { if (!(v > 0)) throw new RangeError('exp ramp to ' + v); this.value = v; this.n++; return this; }
    setTargetAtTime(v) { this.value = v; this.n++; return this; }
    cancelScheduledValues() { return this; }
  }
  class Node {
    constructor(ctx, kind, params) {
      this.ctx = ctx; this.kind = kind; this.outs = new Set();
      (params || []).forEach((p) => { this[p] = new Param(p === 'frequency' ? 440 : p === 'gain' ? 1 : 0); });
      made.push(this);
    }
    connect(d) { if (!d) throw new Error('connect to nothing'); this.outs.add(d); return d; }
    disconnect(d) { if (d) this.outs.delete(d); else this.outs.clear(); }
  }
  class Source extends Node {
    constructor(ctx, kind, params) { super(ctx, kind, params); this.startT = null; this.stopT = null; this.ended = false; this.onended = null; ctx.sources.push(this); }
    start(t) { if (this.startT !== null) throw new Error('start twice'); this.startT = t || 0; }
    stop(t) { if (this.startT === null) throw new Error('stop before start'); this.stopT = t == null ? this.ctx.currentTime : t; }
  }
  class Ctx {
    constructor() {
      this.currentTime = 0; this.sampleRate = 8000; this.state = 'running'; this.sources = [];
      this.destination = new Node(this, 'destination');
      ctxs.push(this);
    }
    createGain() { return new Node(this, 'gain', ['gain']); }
    createBiquadFilter() { return new Node(this, 'biquad', ['frequency', 'Q', 'gain']); }
    createDelay() { return new Node(this, 'delay', ['delayTime']); }
    createConvolver() { return new Node(this, 'convolver'); }
    createWaveShaper() { return new Node(this, 'shaper'); }
    createStereoPanner() { return new Node(this, 'panner', ['pan']); }
    createDynamicsCompressor() { return new Node(this, 'comp', ['threshold', 'knee', 'ratio', 'attack', 'release']); }
    createOscillator() { return new Source(this, 'osc', ['frequency', 'detune']); }
    createBufferSource() { return new Source(this, 'buffer', ['playbackRate']); }
    createBuffer(ch, len, sr) { const d = []; for (let i = 0; i < ch; i++) d.push(new Float32Array(len)); return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: (i) => d[i] }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    advance(dt) {
      this.currentTime += dt;
      this.sources.forEach((s) => { if (!s.ended && s.stopT !== null && s.stopT <= this.currentTime) { s.ended = true; if (s.onended) s.onended(); } });
    }
  }
  return { Ctx, made, ctxs };
}

function withProfile(audio, fn) {
  const CB = globalThis.CB, prev = CB.game;
  CB.game = Object.assign({}, prev || {}, { profile: { peek: () => ({ settings: { audio } }), setSetting: (p, v) => { audio[p.split('.')[1]] = v; } } });
  try { return fn(); } finally { CB.game = prev; }
}
function noProfile(fn) {
  const CB = globalThis.CB, prev = CB.game;
  CB.game = Object.assign({}, prev || {}); delete CB.game.profile;
  try { return fn(); } finally { CB.game = prev; }
}
function run(M, ctx, seconds) { for (let t = 0; t < seconds; t += 0.05) { ctx.advance(0.05); M._.tick(); } }

/* ------------------------------------------------------------------ sequencer */
test('music: every context maps to a track, Sakura Pass is detected by track id, results pick a stinger', () => {
  const { T } = fresh();
  const want = { menu: 'neon-lounge', hub: 'neon-lounge', garage: 'tape-garage', atelier: 'tape-garage', race: 'redline-run', drift: 'apex-overdrive',
    arcade: 'candy-boost', f1: 'pit-wall', derby: 'scrap-heap', drag: 'quarter-mile', victory: 'victory', defeat: 'defeat' };
  Object.keys(want).forEach((c) => assert.equal(T.trackFor(c), want[c], c));
  assert.equal(T.trackFor('drift', { trackId: 'sakura-pass' }), 'sakura-pass');
  assert.equal(T.trackFor('drift', { trackId: 'kurogane-pass' }), 'apex-overdrive');
  assert.equal(T.trackFor('results', { won: true }), 'victory');
  assert.equal(T.trackFor('results', { won: false }), 'defeat');
  assert.equal(T.trackFor('nonsense'), 'neon-lounge');
  // tempos asked for: race 120-130, drift ~150
  assert.ok(T.TRACKS['redline-run'].bpm >= 120 && T.TRACKS['redline-run'].bpm <= 130);
  assert.ok(Math.abs(T.TRACKS['apex-overdrive'].bpm - 150) <= 4);
});

test('music: generated events are well-formed for every track (parts exist, notes in range, times inside the bar)', () => {
  const { T } = fresh();
  Object.keys(T.TRACKS).forEach((id) => {
    const Tr = T.TRACKS[id];
    for (let bar = 0; bar < 72; bar++) {
      ['idle', 'stage', 'go'].forEach((phase) => {
        const g = T.generateBar(id, 99, bar, { phase, phaseBar: bar % 9 });
        g.events.forEach((e) => {
          assert.ok(Tr.parts[e.p], id + ' bar ' + bar + ' unknown part ' + e.p);
          assert.ok(e.t >= 0 && e.t < 16.5, id + ' t ' + e.t);
          assert.ok(e.d > 0, id + ' d');
          assert.ok(e.v > 0 && e.v <= 1.0001, id + ' v ' + e.v);
          if (e.p !== 'fx') [].concat(e.n).forEach((n) => assert.ok(Number.isFinite(n) && n >= 0 && n <= 108, id + ' note ' + n));
        });
      });
    }
  });
});

test('music: the sequencer is deterministic for a seed, varies with the seed and across loops', () => {
  const { T } = fresh();
  const songs = (id, seed, from, n) => { const a = []; for (let b = from; b < from + n; b++) a.push(T.generateBar(id, seed, b).events); return JSON.stringify(a); };
  ['neon-lounge', 'redline-run', 'apex-overdrive', 'scrap-heap', 'sakura-pass'].forEach((id) => {
    assert.equal(songs(id, 42, 0, 64), songs(id, 42, 0, 64), id + ' same seed');
    assert.notEqual(songs(id, 42, 0, 64), songs(id, 43, 0, 64), id + ' other seed');
    assert.notEqual(songs(id, 42, 32, 32), songs(id, 42, 64, 32), id + ' loops vary');
  });
  // drag: staging builds (denser each bar), the green drops with a crash + impact
  const st = (pb) => T.generateBar('quarter-mile', 1, 10 + pb, { phase: 'stage', phaseBar: pb }).events.filter((e) => e.p === 'snare').length;
  assert.ok(st(6) > st(2) && st(2) > 0, 'snare roll accelerates');
  const go = T.generateBar('quarter-mile', 1, 20, { phase: 'go', phaseBar: 0 }).events;
  assert.ok(go.some((e) => e.k === 'crash') && go.some((e) => e.k === 'impact'), 'drop');
});

/* ------------------------------------------------------------------ player */
test('music: no AudioContext before a user gesture; one context is created after it and reused', () => noProfile(() => {
  const { M } = fresh(); const mock = makeMock();
  M._.reset(); M._.setCtor(mock.Ctx);
  const r = M.play('menu');
  assert.equal(r.pending, true);
  assert.equal(r.track, 'neon-lounge');
  M.play('race', { intensity: 0.6 });
  assert.equal(mock.ctxs.length, 0, 'nothing before the gesture');
  M._.onGesture();
  assert.equal(mock.ctxs.length, 1);
  assert.equal(M.state().track, 'redline-run', 'the latest request starts');
  for (let i = 0; i < 6; i++) { M.play(i % 2 ? 'menu' : 'drift'); run(M, mock.ctxs[0], 2.5); }
  M.stop({ fade: 0 });
  M.play('arcade');
  assert.equal(mock.ctxs.length, 1, 'the context is reused across plays and stops');
  M._.reset();
}));

test('music: volume, mute and the Music on/off switch come from the profile settings', () => {
  const { M } = fresh(); const mock = makeMock();
  const audio = { master: 0.5, music: 0.4, muted: false, musicOn: true };
  withProfile(audio, () => {
    assert.ok(Math.abs(M._.effectiveVolume() - 0.2) < 1e-9);
    audio.muted = true; assert.equal(M._.effectiveVolume(), 0);
    audio.muted = false; audio.musicOn = false; assert.equal(M._.effectiveVolume(), 0);
    // switched off: a gesture still creates nothing
    M._.reset(); M._.setCtor(mock.Ctx);
    M.play('menu'); M._.onGesture();
    assert.equal(mock.ctxs.length, 0, 'music off -> no context');
    M.setEnabled(true);
    assert.equal(audio.musicOn, true);
    assert.equal(mock.ctxs.length, 1, 'turning it on starts the remembered context');
    const S = M._.S;
    assert.ok(Math.abs(S.E.vol.gain.value - 0.2 * 0.9) < 1e-6, 'gain follows master x music');
    M.setVolume(1);
    assert.equal(audio.music, 1);
    assert.ok(Math.abs(S.E.vol.gain.value - 0.5 * 0.9) < 1e-6);
    audio.muted = true; M.setVolume(1);
    run(M, mock.ctxs[0], 1);
    assert.equal(M.state().decks, 0, 'mute fades the music out and releases it');
    M._.reset();
  });
});

test('music: stop releases every voice and deck node; crossfades leave one deck', () => noProfile(() => {
  const { M } = fresh(); const mock = makeMock();
  M._.reset(); M._.setCtor(mock.Ctx);
  M._.onGesture();
  M.play('drift', { intensity: 1 });
  const ctx = mock.ctxs[0], S = M._.S;
  const master = new Set(S.E.master.concat([ctx.destination]));
  run(M, ctx, 6);
  assert.ok(M.state().voices > 0, 'voices are playing');
  M.play('race', { intensity: 1 });
  assert.equal(M.state().decks, 2, 'crossfading');
  run(M, ctx, 3);
  assert.equal(M.state().decks, 1, 'the old deck is gone after the fade');
  M.stop({ fade: 0 });
  assert.equal(M.state().decks, 0);
  assert.equal(M.state().voices, 0);
  const live = mock.made.filter((n) => !master.has(n) && n.outs.size > 0);
  assert.equal(live.length, 0, 'connected non-master nodes after stop: ' + live.map((n) => n.kind).join(','));
  const unstopped = ctx.sources.filter((s) => s.startT !== null && s.stopT === null);
  assert.equal(unstopped.length, 0, 'every started source was stopped');
  M._.reset();
}));

test('music: repeated race round trips do not leak decks, voices or contexts', () => noProfile(() => {
  const { M } = fresh(); const mock = makeMock();
  M._.reset(); M._.setCtor(mock.Ctx);
  M._.onGesture();
  const ctx = () => mock.ctxs[0];
  for (let i = 0; i < 12; i++) {
    M.cue('race-ui', { screen: 'setup', mode: i % 3 === 0 ? 'drift' : 'race' }); run(M, ctx(), 0.5);
    M.cue('race-ui', { screen: 'race', mode: 'race' }); run(M, ctx(), 2);
    M.frame('race-ui', { lap: 2, laps: 3, position: 1, field: 8, speed_kph: 200 });
    M.cue('race-ui', { screen: 'pause' }); assert.ok(M.state().duck < 0.5, 'paused -> quieter');
    M.cue('race-ui', { screen: 'resume' });
    M.cue('race-ui', { screen: 'results', mode: 'race' }); run(M, ctx(), 7);
    M.play('menu'); run(M, ctx(), 3);
    assert.ok(M.state().decks <= 1, 'round trip ' + i + ' decks ' + M.state().decks);
    assert.ok(M.state().voices < 120, 'voices bounded');
  }
  assert.equal(mock.ctxs.length, 1);
  assert.equal(M.state().track, 'neon-lounge');
  assert.equal(M.state().duck, 1, 'leaving to the menu clears engine / pause ducks');
  M.stop({ fade: 0 });
  M._.reset();
}));

test('music: race state drives intensity (final lap, places gained, nitro) and ducks under the engine', () => noProfile(() => {
  const { M } = fresh();
  const RI = M._.raceIntensity;
  const base = RI({ lap: 0, laps: 3, position: 5, field: 8 }, { pos: null, surge: 0 });
  const final = RI({ lap: 2, laps: 3, position: 5, field: 8 }, { pos: null, surge: 0 });
  const nitro = RI({ lap: 0, laps: 3, position: 5, field: 8, nitro: true }, { pos: null, surge: 0 });
  const R = { pos: 5, surge: 0 }, gain = RI({ lap: 0, laps: 3, position: 4, field: 8 }, R);
  assert.ok(final > base + 0.2, 'final lap');
  assert.ok(nitro > base + 0.15, 'nitro');
  assert.ok(gain > base, 'position gain');
  assert.ok(RI({ alive: 2, total: 10 }, {}) > RI({ alive: 10, total: 10 }, {}), 'derby: fewer survivors, more intensity');
  M._.reset();
  M.duck(0.3, { reason: 'engine' }); M.duck(0.5, { reason: 'pause' });
  assert.ok(Math.abs(M.state().duck - 0.35) < 1e-9, 'ducks multiply');
  M.duck(0, { reason: 'pause' });
  assert.ok(Math.abs(M.state().duck - 0.7) < 1e-9);
  assert.equal(M._.contextForRoute('atelier'), 'garage');
  assert.equal(M._.contextForRoute('settings'), 'menu');
  assert.equal(M._.contextForRoute('derby'), 'derby');
  M._.reset();
}));

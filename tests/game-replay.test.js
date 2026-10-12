/* Node tests for js/game/replay.js — recorder, codec/serialization roundtrip, size cap, storage, interpolation,
   headless player, pixel filters, auto-record install. Run: node tests/run.js replay */
'use strict';
const assert = require('node:assert/strict');
const R = require('../js/game/replay.js');
const T = typeof test === 'function' ? test : (n, f) => module.exports[n] = f;
if (typeof test !== 'function') module.exports = {};

/* ---------------------------------------------------------------- fake session */
const RADIUS = 160, L = 2 * Math.PI * RADIUS;
function makeSession(opts) {
  opts = opts || {};
  const nCars = opts.cars || 4, laps = opts.laps || 2;
  const cars = [];
  for (let i = 0; i < nCars; i++) {
    cars.push({ id: 'c' + i, isPlayer: i === nCars - 1, name: 'Driver ' + i, team: 'Team ' + (i % 2), number: 10 + i,
      color: '#' + (0x334455 + i * 0x101010).toString(16), accent: '#111111', bodyStyle: 'coupe', length_m: 4.5, width_m: 1.9,
      build: { body: { style: 'coupe' }, n: i % 2 }, dist: -i * 9, speed: 0, base: 40 + (nCars - i) * 0.4 + (i === nCars - 1 ? 1.6 : 0) });
  }
  let t = 0, events = [], lastLap = {};
  const geom = { length: L, ds: 2, samples: [] };
  for (let s = 0; s < L; s += 2) { const a = s / RADIUS; geom.samples.push({ x: Math.cos(a) * RADIUS, y: Math.sin(a) * RADIUS, hw: 6, s }); }
  geom.startLine = { x: RADIUS, y: 0, heading: Math.PI / 2 };
  const session = {
    config: { trackId: 'test-ring', mode: 'race', laps, weather: 'dry', timeOfDay: 'day' },
    trackDef: { id: 'test-ring', name: 'Test Ring', theme: { grass: '#2f5a2c' } },
    geom,
    phase() { return t < 1 ? 'grid' : t < 3 ? 'countdown' : session.allDone() ? 'finished' : 'racing'; },
    allDone() { return cars.every((c) => c.dist >= laps * L); },
    update(dt) {
      t += dt;
      if (t < 3) return;
      cars.forEach((c) => {
        if (c.dist >= laps * L) { c.speed = Math.max(0, c.speed - 20 * dt); c.dist += c.speed * dt; return; }
        c.speed = Math.min(c.base, c.speed + 12 * dt);
        c.dist += c.speed * dt;
        const lap = Math.floor(Math.max(0, c.dist) / L);
        if (lastLap[c.id] != null && lap > lastLap[c.id]) events.push({ type: 'lap', carId: c.id, value: 30 });
        lastLap[c.id] = lap;
      });
      if (Math.abs(t - 10) < dt / 2) events.push({ type: 'collision', carId: 'c0', otherId: 'c1', x: 1, y: 2, intensity: 0.8 });
      if (Math.abs(t - 12) < dt / 2) events.push({ type: 'wall', carId: 'c2', x: 3, y: 4, intensity: 0.5 });
    },
    snapshot() {
      const order = cars.slice().sort((a, b) => b.dist - a.dist);
      const snap = {
        t, phase: session.phase(), countdown: { lightsOn: t < 1 ? 0 : Math.min(5, Math.floor(t - 1) * 3), lightsOut: t >= 3, goTime: 3 },
        lapsTotal: laps, mode: 'race', weather: 'dry', timeOfDay: 'day', playerId: cars[nCars - 1].id, fastestLap: null,
        cars: cars.map((c) => {
          const d = Math.max(0, c.dist), s = d % L, a = s / RADIUS, lap = Math.floor(d / L);
          const pos = order.indexOf(c) + 1, ahead = order[pos - 2];
          return {
            id: c.id, isPlayer: c.isPlayer, name: c.name, team: c.team, number: c.number, color: c.color, accent: c.accent, build: c.build,
            bodyStyle: c.bodyStyle, length_m: 4.5, width_m: 1.9, x: Math.cos(a) * RADIUS, y: Math.sin(a) * RADIUS, heading: a + Math.PI / 2,
            speed: c.speed, rpm: 3000 + c.speed * 80, redline: 7500, gear: Math.min(6, 1 + Math.floor(c.speed / 9)), maxGear: 6, steerAngle: 0.02,
            throttle: 0.8, brake: 0, slipF: 0.01, slipR: 0.02, skidding: 0, wheelspin: 0, surface: 'asphalt', lap, s, position: pos,
            currentLap_s: t - 3 - lap * 30, lastLap_s: lap > 0 ? 30 + c.number * 0.01 : null, bestLap_s: lap > 0 ? 30 : null,
            sectors: [null, null, null], lastSectors: [null, null, null], bestSectors: [null, null, null],
            gapAhead_s: ahead ? (ahead.dist - c.dist) / Math.max(1, c.speed) : null, gapLeader_s: pos === 1 ? 0 : (order[0].dist - c.dist) / Math.max(1, c.speed),
            finished: c.dist >= laps * L, finishTime_s: null, penalties_s: 0, dnf: false, wrongWay: false, trackLimits: 0, lapValid: true, offTrack: false
          };
        }),
        events, ghost: null
      };
      events = [];
      return snap;
    },
    results() { return { mode: 'race', lapsTotal: laps, classification: cars.map((c, i) => ({ position: i + 1, id: c.id, name: c.name })) }; },
    restart() { t = 0; cars.forEach((c, i) => { c.dist = -i * 9; c.speed = 0; }); lastLap = {}; },
    get t() { return t; }
  };
  return session;
}
function runRecorded(opts) {
  const s = makeSession(opts), rec = R.createRecorder(s, opts && opts.rec);
  const dt = 1 / 120, end = (opts && opts.seconds) || 40;
  for (let i = 0; i < end * 120; i++) { s.update(dt); if (i % 2 === 0) rec.capture(s.snapshot()); }
  return { s, rec, rep: rec.finish({ results: s.results() }) };
}
function memBackend() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; }

/* ---------------------------------------------------------------- low-level codec */
T('replay: base64 roundtrip at every padding length', () => {
  for (let n = 0; n < 40; n++) {
    const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 37 + n) & 255;
    const b = R._internal.base64Decode(R._internal.base64Encode(a));
    assert.deepEqual(Array.from(b), Array.from(a));
  }
  assert.equal(R._internal.base64Encode(new Uint8Array([102, 111, 111])), Buffer.from('foo').toString('base64'));
});

T('replay: LZ compressor roundtrips random and repetitive data', () => {
  const rnd = new Uint8Array(5000); let x = 1; for (let i = 0; i < rnd.length; i++) { x = (x * 1103515245 + 12345) >>> 0; rnd[i] = x >>> 24; }
  const rep = new Uint8Array(20000); for (let i = 0; i < rep.length; i++) rep[i] = (i % 17) * 3;
  [rnd, rep, new Uint8Array(0), new Uint8Array([1, 2, 3])].forEach((src) => {
    const c = R._internal.lzCompress(src), d = R._internal.lzDecompress(c, src.length);
    assert.deepEqual(Array.from(d), Array.from(src));
  });
  assert.ok(R._internal.lzCompress(rep).length < rep.length / 20, 'repetitive data compresses well');
});

T('replay: crc32 matches the standard check value', () => {
  assert.equal(R._internal.crc32(R._internal.utf8Encode('123456789')), 0xCBF43926);
});

/* ---------------------------------------------------------------- recorder */
T('replay: recorder decimates 60 Hz captures to ~30 Hz and records all cars', () => {
  const { rec, rep } = runRecorded({ seconds: 20 });
  const st = rec.stats();
  assert.equal(rep.cars.length, 4);
  assert.ok(st.dropped > 0, 'some captures were decimated');
  const hz = (rep.frames.t.length - 1) / rep.meta.duration;
  assert.ok(hz > 27 && hz < 33, 'effective rate ~30 Hz, got ' + hz.toFixed(2));
  assert.ok(rep.frames.t instanceof Float64Array && rep.cars[0].ch.v instanceof Uint16Array && rep.cars[0].ch.thr instanceof Uint8Array, 'typed arrays');
  assert.equal(rep.meta.trackId, 'test-ring');
  assert.equal(rep.meta.playerId, 'c3');
  assert.ok(rep.outline && rep.outline.x.length > 20, 'track outline embedded');
  assert.equal(rep.builds.length, 2, 'builds deduplicated');
  assert.ok(rep.meta.goT != null && Math.abs(rep.meta.goT - 3) < 0.05, 'lights-out time');
});

T('replay: markers include start, laps, overtakes, collisions and walls', () => {
  const { rep } = runRecorded({ seconds: 40 });
  const types = new Set(rep.markers.map((m) => m.type));
  ['start', 'lap', 'overtake', 'collision', 'wall'].forEach((k) => assert.ok(types.has(k), 'has ' + k + ' marker: ' + [...types]));
  const ov = rep.markers.filter((m) => m.type === 'overtake');
  assert.ok(ov.some((m) => m.carId === 'c3'), 'faster player car overtakes');
  for (let i = 1; i < rep.markers.length; i++) assert.ok(rep.markers[i].t >= rep.markers[i - 1].t, 'sorted');
  assert.ok(rep.highlights.length > 0 && rep.highlights.length <= 12);
});

T('replay: restart (time going backwards) resets the recording', () => {
  const s = makeSession(), rec = R.createRecorder(s);
  for (let i = 0; i < 600; i++) { s.update(1 / 60); rec.capture(s.snapshot()); }
  const before = rec.frameCount;
  s.restart();
  for (let i = 0; i < 60; i++) { s.update(1 / 60); rec.capture(s.snapshot()); }
  assert.ok(rec.frameCount < before && rec.frameCount <= 61, 'reset after restart');
  assert.equal(rec.stats().restarts, 1);
});

T('replay: adaptive halving keeps memory bounded on long sessions', () => {
  const s = makeSession({ laps: 50 }), rec = R.createRecorder(s, { maxFrames: 400 });
  for (let i = 0; i < 60 * 40; i++) { s.update(1 / 60); rec.capture(s.snapshot()); }
  assert.ok(rec.frameCount < 400, 'frames bounded: ' + rec.frameCount);
  assert.ok(rec.stats().decimations >= 1);
  const rep = rec.finish();
  assert.ok(rep.meta.duration > 39);
});

/* ---------------------------------------------------------------- serialization */
T('replay: serialize/deserialize roundtrip preserves data within quantization', () => {
  const { rep } = runRecorded({ seconds: 30 });
  const str = R.serialize(rep);
  assert.equal(typeof str, 'string');
  assert.match(str, /^[A-Za-z0-9+/=]+$/);
  const back = R.deserialize(str);
  assert.equal(back.frames.t.length, rep.frames.t.length);
  assert.equal(back.cars.length, rep.cars.length);
  assert.deepEqual(back.cars.map((c) => c.info.name), rep.cars.map((c) => c.info.name));
  for (let ci = 0; ci < rep.cars.length; ci++) {
    const a = rep.cars[ci].ch, b = back.cars[ci].ch;
    for (let f = 0; f < rep.frames.t.length; f += 7) {
      assert.ok(Math.abs(a.x[f] - b.x[f]) <= 0.006, 'x');
      assert.ok(Math.abs(a.y[f] - b.y[f]) <= 0.006, 'y');
      assert.ok(Math.abs(R._internal.wrapAngle(a.h[f] - b.h[f])) <= 0.0002, 'heading');
      assert.equal(b.v[f], a.v[f]); assert.equal(b.pos[f], a.pos[f]); assert.equal(b.lap[f], a.lap[f]); assert.equal(b.flags[f], a.flags[f]);
      if (Number.isNaN(a.gapA[f])) assert.ok(Number.isNaN(b.gapA[f]), 'null gap preserved');
      else assert.ok(Math.abs(a.gapA[f] - b.gapA[f]) <= 0.0006, 'gap');
    }
    assert.deepEqual(back.cars[ci].slow, rep.cars[ci].slow);
  }
  for (let f = 0; f < rep.frames.t.length; f++) assert.ok(Math.abs(rep.frames.t[f] - back.frames.t[f]) <= 0.0003);
  const J = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(back.events, J(rep.events));
  assert.deepEqual(back.markers, J(rep.markers));
  assert.deepEqual(back.builds, rep.builds);
  // compact: well under raw JSON size
  const jsonish = rep.frames.t.length * rep.cars.length * 23 * 8;
  assert.ok(str.length < jsonish / 6, 'compact: ' + str.length + ' vs ' + jsonish);
});

T('replay: corrupted data is rejected by checksum / magic', () => {
  const { rep } = runRecorded({ seconds: 8 });
  const bytes = R.encode(rep);
  const bad = bytes.slice(); bad[bad.length - 5] ^= 0x55;
  assert.throws(() => R.decode(bad), /checksum|corrupt|LZ|truncated/);
  assert.throws(() => R.deserialize('bm90IGEgcmVwbGF5'), /not a Redline replay/);
});

T('replay: size cap progressively degrades until the replay fits', () => {
  const { rep } = runRecorded({ seconds: 40 });
  const full = R.serializeEx(rep);
  assert.ok(full.fits && full.degraded.length === 0);
  const cap = Math.floor(full.chars * 0.45);
  const small = R.serializeEx(rep, { maxChars: cap });
  assert.ok(small.fits, 'fits after degradation');
  assert.ok(small.chars <= cap);
  assert.ok(small.degraded.length > 0, 'degradation steps recorded: ' + small.degraded);
  const back = R.deserialize(small.data);
  assert.deepEqual(back.meta.degraded, small.degraded);
  assert.throws(() => R.serialize(rep, { maxChars: 50 }), /cannot fit/);
});

T('replay: resample and trim', () => {
  const { rep } = runRecorded({ seconds: 30 });
  const r10 = R.resample(rep, 10);
  assert.ok(r10.frames.t.length < rep.frames.t.length / 2.5);
  assert.equal(r10.cars[0].ch.x.length, r10.frames.t.length);
  const tr = R.trim(rep, 10, 20);
  assert.ok(Math.abs(tr.meta.duration - 10) < 0.1, 'trim duration ' + tr.meta.duration);
  assert.ok(tr.markers.every((m) => m.t >= 0 && m.t <= tr.meta.duration + 1e-6));
  const snap = R.snapshotAt(tr, 0), snapO = R.snapshotAt(rep, 10);
  assert.ok(Math.abs(snap.cars[0].x - snapO.cars[0].x) < 0.6, 'trimmed start matches original t=10');
});

/* ---------------------------------------------------------------- snapshot reconstruction */
T('replay: snapshotAt produces RACE-SPEC compatible snapshots with smooth interpolation', () => {
  const { rep } = runRecorded({ seconds: 30 });
  const snap = R.snapshotAt(rep, 15.0123);
  ['t', 'phase', 'countdown', 'lapsTotal', 'mode', 'weather', 'timeOfDay', 'playerId', 'fastestLap', 'cars', 'events', 'ghost'].forEach((k) => assert.ok(k in snap, 'snapshot.' + k));
  const carKeys = ['id', 'isPlayer', 'name', 'team', 'number', 'color', 'accent', 'build', 'bodyStyle', 'length_m', 'width_m', 'x', 'y', 'heading', 'speed', 'rpm',
    'redline', 'gear', 'maxGear', 'steerAngle', 'throttle', 'brake', 'slipF', 'slipR', 'skidding', 'wheelspin', 'surface', 'lap', 's', 'position', 'currentLap_s',
    'lastLap_s', 'bestLap_s', 'sectors', 'lastSectors', 'bestSectors', 'gapAhead_s', 'gapLeader_s', 'finished', 'finishTime_s', 'penalties_s', 'dnf', 'wrongWay',
    'trackLimits', 'lapValid', 'offTrack'];
  snap.cars.forEach((c) => carKeys.forEach((k) => assert.ok(k in c, 'car.' + k)));
  assert.equal(snap.phase, 'racing');
  assert.equal(snap.cars.filter((c) => c.isPlayer).length, 1);
  // interpolated point lies on the circle (Catmull-Rom between 30 Hz samples)
  snap.cars.forEach((c) => assert.ok(Math.abs(Math.hypot(c.x, c.y) - RADIUS) < 0.05, 'on circle: ' + Math.hypot(c.x, c.y)));
  // follow another car
  const s2 = R.snapshotAt(rep, 15, { followId: 'c0' });
  assert.equal(s2.playerId, 'c0'); assert.ok(s2.cars.find((c) => c.id === 'c0').isPlayer);
  // continuity
  let prev = null;
  for (let t = 10; t < 11; t += 0.01) {
    const c = R.snapshotAt(rep, t).cars[0];
    if (prev) assert.ok(Math.hypot(c.x - prev.x, c.y - prev.y) < 0.7, 'no jumps');
    prev = c;
  }
  assert.equal(R.snapshotAt(rep, 0.5).phase, 'grid');
  assert.equal(R.snapshotAt(rep, 2).phase, 'countdown');
});

T('replay: eventsBetween returns snapshot events in a window', () => {
  const { rep } = runRecorded({ seconds: 20 });
  const t0 = rep.frames.t[0];
  const evs = R.eventsBetween(rep, 9.9 - t0, 10.1 - t0);
  assert.ok(evs.some((e) => e.type === 'collision' && e.carId === 'c0' && e.otherId === 'c1'));
});

/* ---------------------------------------------------------------- storage */
T('replay: store keeps the last 5, protects pinned, exposes flat list fields', () => {
  const be = memBackend(); R.store.setBackend(be); R.store.clear();
  try {
    const ids = [];
    for (let i = 0; i < 7; i++) {
      const { rep } = runRecorded({ seconds: 6 });
      const r = R.store.save(rep, { name: 'Race ' + i, pinned: i === 0 });
      assert.ok(r.ok, 'saved'); ids.push(r.id);
    }
    const list = R.store.list();
    assert.equal(list.length, 5);
    assert.ok(list.some((x) => x.id === ids[0]), 'pinned survives');
    assert.ok(!list.some((x) => x.id === ids[1]), 'oldest unpinned evicted');
    const it = list[0];
    ['id', 'name', 'trackId', 'duration', 'mode', 'laps', 'carCount', 'createdAt', 'size'].forEach((k) => assert.ok(it[k] != null, 'list.' + k));
    assert.ok(!('data' in it));
    assert.ok(it.thumb && it.thumb.pts.length > 10);
    const raw = JSON.parse(be.getItem('forge.replays.v1'));
    assert.equal(raw.items.length, 5);
    const loaded = R.store.load(ids[6]);
    assert.equal(loaded.meta.name, 'Race 6'); assert.equal(loaded.cars.length, 4);
    assert.ok(R.store.rename(ids[6], 'Renamed')); assert.equal(R.store.list().find((x) => x.id === ids[6]).name, 'Renamed');
    const ex = R.store.exportString(ids[6]); assert.match(ex, /^REDLINE-REPLAY:/);
    const imp = R.store.importString(ex, { name: 'Imported' });
    assert.ok(imp.result.ok); assert.equal(R.store.list().length, 5);
    assert.ok(R.store.remove(imp.result.id)); assert.equal(R.store.list().length, 4);
    // exports made before the Redline rebrand (FORGE-REPLAY:) still import
    const legacy = R.store.importString(ex.replace(/^REDLINE-REPLAY:/, 'FORGE-REPLAY:'), { name: 'Legacy' });
    assert.ok(legacy.result.ok, 'FORGE-REPLAY: prefix imports'); assert.ok(R.store.remove(legacy.result.id));
    assert.equal(R.store.list().length, 4);
    assert.ok(R.list().length === 4, 'top-level list alias');
    // total cap triggers eviction
    const { rep } = runRecorded({ seconds: 6 });
    const chars = R.serializeEx(rep).chars;
    const r = R.store.save(rep, { totalChars: chars * 2.5 });
    assert.ok(r.ok && r.evicted.length >= 1, 'evicted to honor total cap');
  } finally { R.store.clear(); R.store.setBackend(null); }
});

T('replay: store works without localStorage (memory fallback)', () => {
  R.store.setBackend(null);
  const had = globalThis.localStorage; try { delete globalThis.localStorage; } catch (e) { /* ignore */ }
  try {
    R.store.clear();
    const { rep } = runRecorded({ seconds: 5 });
    const r = R.store.save(rep);
    assert.ok(r.ok && r.memoryOnly);
    assert.equal(R.store.list().length, 1);
    assert.ok(R.store.load(r.id));
  } finally { R.store.clear(); if (had) globalThis.localStorage = had; }
});

/* ---------------------------------------------------------------- headless player */
T('replay: headless player plays, seeks, clamps speed and ends', () => {
  const { rep } = runRecorded({ seconds: 12 });
  const p = R.createPlayer(R.deserialize(R.serialize(rep)), null, null, {});
  assert.ok(Math.abs(p.duration - rep.meta.duration) < 1e-3);
  const seen = [];
  p.on('ended', () => seen.push('ended'));
  p.speed(10); assert.equal(p.speed(), 4);
  p.speed(0.1); assert.equal(p.speed(), 0.25);
  p.speed(2);
  p.play(); assert.ok(p.playing);
  p.tick(0.5); assert.ok(Math.abs(p.time - 1) < 1e-9);
  p.seek(5); assert.equal(p.time, 5);
  p.seek(-3); assert.equal(p.time, 0);
  p.seek(1e9); assert.equal(p.time, p.duration);
  p.play(); assert.equal(p.time, 0, 'play at end restarts');
  for (let i = 0; i < 100; i++) p.tick(0.1);
  assert.ok(!p.playing && seen.includes('ended'));
  assert.equal(p.followCar('c1').following, 'c1');
  assert.equal(p.snapshot(3).playerId, 'c1');
  p.setCamera('helicopter'); assert.equal(p.camera, 'helicopter');
  p.setCamera('nonsense'); assert.equal(p.camera, 'chase');
  assert.ok(p.cameras.includes('orbit-car') && p.cameras.includes('trackside'));
  p.destroy();
});

T('replay: camera rig produces finite cameras for every mode', () => {
  const { rep } = runRecorded({ seconds: 10 });
  const geom = R.outlineGeom(rep.outline);
  assert.ok(geom.samples.length > 20 && Math.abs(geom.length - L) / L < 0.05);
  const rig = R.createCameraRig(geom), snap = R.snapshotAt(rep, 8), car = snap.cars[0];
  R.CAMERAS.forEach((m) => {
    for (let i = 0; i < 5; i++) {
      const c = rig.update(m, car, snap, 1 / 60, 1280, 720, { x: 0, y: 0, zoom: 5, rot: 0 });
      ['x', 'y', 'zoom', 'rot'].forEach((k) => assert.ok(Number.isFinite(c[k]), m + '.' + k));
    }
  });
});

/* ---------------------------------------------------------------- attach / install */
T('replay: attach records transparently through session.snapshot()', () => {
  const s = makeSession(), orig = s.snapshot;
  const rec = R.attach(s);
  for (let i = 0; i < 600; i++) { s.update(1 / 60); s.snapshot(); }
  assert.ok(rec.frameCount > 250);
  const rep = rec.finishAndDetach();
  assert.equal(s.snapshot, orig, 'detached');
  assert.ok(rep.meta.results && rep.meta.results.classification.length === 4);
});

T('replay: install() wraps CB.race.engine.createSession and finalizes on finish', () => {
  const CB = globalThis.CB; CB.race = CB.race || {};
  const prevEngine = CB.race.engine;
  CB.race.engine = { createSession: () => makeSession({ laps: 1 }) };
  const got = [];
  const uninstall = R.install({ onReplay: (r) => got.push(r), tailSeconds: 2 });
  try {
    const s = CB.race.engine.createSession({ trackId: 'test-ring' });
    assert.equal(typeof s.replayRecorder, 'function');
    for (let i = 0; i < 60 * 40 && !got.length; i++) { s.update(1 / 60); s.snapshot(); }
    assert.equal(got.length, 1, 'replay produced at end of session');
    assert.equal(R.last(), got[0]);
    assert.ok(got[0].markers.some((m) => m.type === 'finish'));
    // restart after finalize records a fresh replay
    s.restart();
    for (let i = 0; i < 120; i++) { s.update(1 / 60); s.snapshot(); }
    assert.ok(s.replayRecorder().frameCount > 50);
  } finally { uninstall(); CB.race.engine = prevEngine; }
});

/* ---------------------------------------------------------------- pixel filters */
function img(w, h, fn) { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; } return { width: w, height: h, data: d }; }
T('replay: pixel filters — identity, B&W, vignette, grain determinism, presets', () => {
  const base = () => img(40, 30, (x, y) => [200, 100 + x, 50 + y]);
  const a = base(), b = base();
  R.filters.apply(a, {}); assert.deepEqual(Array.from(a.data), Array.from(b.data), 'identity');
  const bw = R.filters.apply(base(), { bw: 1 });
  for (let i = 0; i < bw.data.length; i += 4) { assert.ok(Math.abs(bw.data[i] - bw.data[i + 1]) <= 1 && Math.abs(bw.data[i + 1] - bw.data[i + 2]) <= 1); }
  const flat = () => img(41, 41, () => [180, 180, 180]);
  const v = R.filters.apply(flat(), { vignette: 1 });
  assert.ok(v.data[0] < v.data[(20 * 41 + 20) * 4] - 40, 'corners darker');
  const g1 = R.filters.apply(flat(), { grain: 0.5, seed: 3 }), g2 = R.filters.apply(flat(), { grain: 0.5, seed: 3 });
  assert.deepEqual(Array.from(g1.data), Array.from(g2.data), 'grain deterministic per seed');
  const c = R.filters.apply(img(2, 1, (x) => (x ? [200, 200, 200] : [60, 60, 60])), { contrast: 0.6 });
  assert.ok(c.data[0] < 60 && c.data[4] > 200, 'contrast expands');
  Object.keys(R.filters.presets).forEach((k) => { const o = R.filters.apply(base(), R.filters.presets[k]); assert.equal(o.data.length, 40 * 30 * 4); });
  assert.deepEqual(R.cropRect(1600, 900, 1), { x: 350, y: 0, w: 900, h: 900 });
  assert.deepEqual(R.cropRect(1600, 900, 0), { x: 0, y: 0, w: 1600, h: 900 });
});

T('replay: screen/world transforms are inverse', () => {
  const cam = { x: 10, y: -5, zoom: 7.5, rot: 0.7 }, W = 800, H = 600;
  const p = R._internal.worldToScreen(20, 3, cam, W, H);
  const d = R._internal.screenToWorld(p.x - W / 2, p.y - H / 2, cam.zoom, cam.rot);
  assert.ok(Math.abs(cam.x + d.x - 20) < 1e-9 && Math.abs(cam.y + d.y - 3) < 1e-9);
});

/* ---------------------------------------------------------------- 3D viewer: camera mapping + fallback */
const C3 = R.camera3d;
const ALL3D = ['cockpit', 'hood', 'bumper', 'chase', 'chase-far', 'tv', 'heli', 'map'];

T('replay 3D: every replay camera maps onto a renderer3d mode', () => {
  const want = { director: ['tv', null], chase: ['chase', null], cockpit: ['cockpit', null], 'orbit-car': ['chase', 'orbit'], helicopter: ['heli', null],
    trackside: ['tv', null], tv: ['tv', null], north: ['map', null], free: ['chase', 'free'] };
  R.CAMERAS.forEach((c) => {
    assert.ok(want[c], 'mapping covers ' + c);
    assert.deepEqual(C3.forMode(c, ALL3D), { mode: want[c][0], ctl: want[c][1] }, c);
  });
  assert.equal(C3.forMode('nonsense', ALL3D).mode, 'chase');
  // modes the renderer does not offer fall back to chase (no 2D renderer -> no map, no interior -> no cockpit)
  const noMap = ALL3D.filter((m) => m !== 'map' && m !== 'cockpit');
  assert.equal(C3.forMode('north', noMap).mode, 'chase');
  assert.equal(C3.forMode('cockpit', noMap).mode, 'chase');
  assert.deepEqual(C3.uiCameras(true, ALL3D), ['director', 'chase', 'cockpit', 'orbit-car', 'helicopter', 'tv', 'north']);
  assert.ok(!C3.uiCameras(true, noMap).includes('north') && !C3.uiCameras(true, noMap).includes('cockpit'));
  assert.ok(!C3.uiCameras(false).includes('cockpit') && C3.uiCameras(false).includes('trackside'));
});

T('replay 3D: backend choice prefers WebGL, falls back to 2D', () => {
  const base = { real: true, has3d: true, supported3d: true, has2d: true };
  assert.equal(C3.pickBackend(base), '3d');
  assert.equal(C3.pickBackend(Object.assign({}, base, { supported3d: false })), 'race2d');
  assert.equal(C3.pickBackend(Object.assign({}, base, { has3d: false })), 'race2d');
  assert.equal(C3.pickBackend(Object.assign({}, base, { graphics: '2d' })), 'race2d');
  assert.equal(C3.pickBackend(Object.assign({}, base, { builtin: true })), 'builtin');
  assert.equal(C3.pickBackend(Object.assign({}, base, { real: false })), 'builtin', 'outline-only replays use the built-in view');
  assert.equal(C3.pickBackend({ real: true, has3d: false, has2d: false }), 'builtin');
});

T('replay 3D: free / orbit camera math', () => {
  const pose = { x: 120, y: -40, heading: 0.8, elev: 2 };
  const F = { yaw: 1.1, pitch: 0.3, dist: 9, fov: 45, roll: 0.2, ox: 1.5, oy: -0.5, oh: 0.8, lock: true };
  const cam = C3.free(F, pose);
  ['eye', 'target', 'up'].forEach((k) => cam[k].forEach((v) => assert.ok(Number.isFinite(v), k)));
  assert.ok(Math.abs(Math.hypot(cam.eye[0] - cam.target[0], cam.eye[1] - cam.target[1], cam.eye[2] - cam.target[2]) - 9) < 1e-9);
  assert.ok(Math.abs(cam.target[0] - 121.5) < 1e-9 && Math.abs(cam.target[2] - 40.5) < 1e-9 && Math.abs(cam.target[1] - 2.8) < 1e-9, 'sim y -> GL -z');
  const f = [cam.target[0] - cam.eye[0], cam.target[1] - cam.eye[1], cam.target[2] - cam.eye[2]];
  assert.ok(Math.abs(f[0] * cam.up[0] + f[1] * cam.up[1] + f[2] * cam.up[2]) < 1e-9 && Math.abs(Math.hypot(...cam.up) - 1) < 1e-9, 'up ⟂ view, unit');
  // seeding from a camera state reproduces it
  const seed = C3.seedFree({ mode: 'chase', eye: cam.eye, target: cam.target, fov: 45 }, pose, true);
  const again = C3.free(Object.assign(seed, { roll: 0.2 }), pose);
  for (let i = 0; i < 3; i++) { assert.ok(Math.abs(again.eye[i] - cam.eye[i]) < 1e-6); assert.ok(Math.abs(again.target[i] - cam.target[i]) < 1e-6); }
  // cockpit / map shots seed a default exterior framing behind the car
  const d = C3.seedFree({ mode: 'cockpit', eye: [0, 1, 0], target: [5, 1, 0], fov: 70 }, pose, true);
  assert.equal(d.lock, true); assert.ok(d.dist > 4);
  // unlocked: target is absolute, so moving the car does not move the camera
  const un = Object.assign({}, F, { lock: false, ox: 121.5, oy: -40.5 });
  assert.deepEqual(C3.free(un, pose).eye, C3.free(un, { x: 0, y: 0, heading: 0, elev: 2 }).eye);
  // pan moves the target sideways for a horizontal drag
  const P0 = Object.assign({}, F), P1 = C3.panFree(Object.assign({}, F), 100, 0, 600);
  assert.ok(Math.hypot(P1.ox - P0.ox, P1.oy - P0.oy) > 0.1);
  // projection: the target sits at the screen centre
  const pr = C3.project({ eye: cam.eye, target: cam.target, up: cam.up, fov: 45 }, cam.target, 800, 450);
  assert.ok(Math.abs(pr.x - 400) < 1e-6 && Math.abs(pr.y - 225) < 1e-6);
  // orbit: finite, circles the car, shortens the boom when a wall is in the way
  const o1 = C3.orbit(pose, 0.5, { length: 4.5 }), o2 = C3.orbit(pose, 0.5, { length: 4.5 }, () => 0.5);
  const r1 = Math.hypot(o1.eye[0] - pose.x, o1.eye[2] + pose.y), r2 = Math.hypot(o2.eye[0] - pose.x, o2.eye[2] + pose.y);
  assert.ok(r1 > 5 && Math.abs(r2 - r1 * 0.5) < 1e-6);
  assert.ok(C3.orbit(pose, 0.5, null, null, () => 10).eye[1] >= 10.5, 'kept above terrain');
});

function stubCtx() {
  return new Proxy({}, { get(t, k) { if (k in t) return t[k]; if (k === 'measureText') return () => ({ width: 10 }); if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} }); return () => {}; }, set(t, k, v) { t[k] = v; return true; } });
}
function stubCanvas() { const c = stubCtx(); return { width: 800, height: 450, clientWidth: 800, clientHeight: 450, style: {}, getContext: () => c }; }
function fakeR3(opts) {
  opts = opts || {};
  const log = { created: 0, destroyed: 0, modes: [], ctl: [], renders: 0, ctlCalls: [] };
  const mod = {
    CAMERA_MODES: ALL3D.slice(),
    isSupported: () => opts.supported !== false,
    create(canvas) {
      if (opts.throws) throw new Error('no webgl');
      log.created++;
      let mode = 'chase', ctl = null;
      return {
        is3D: true, glCanvas: { tag: 'gl' },
        render(snap) {
          log.renders++;
          if (opts.renderThrows) throw new Error('boom');
          const p = snap.cars.find((c) => c.isPlayer);
          if (ctl) log.ctlCalls.push(ctl({ dt: 1 / 60, mode, snap, player: p, pose: { x: p.x, y: p.y, heading: p.heading, elev: 0 }, dims: { length: 4.5 }, safeFraction: () => 1, groundY: () => 0 }));
        },
        setCamera(m) { log.modes.push(m); mode = m; return m; }, getCamera: () => mode, cameraModes: () => ALL3D.slice(),
        setCameraController(fn) { ctl = fn; log.ctl.push(!!fn); },
        getCameraState: () => ({ mode, eye: [0, 3, 8], target: [0, 1, 0], up: [0, 1, 0], fov: 60 }),
        reset() {}, resize() {}, destroy() { log.destroyed++; }
      };
    }
  };
  return { mod, log };
}
function with3D(fake, fn) {
  const G = globalThis.CB, hadRace = Object.prototype.hasOwnProperty.call(G, 'race');
  const race = hadRace ? G.race : (G.race = {}), keys = ['renderer3d', 'renderer', 'ui'];
  const keep = keys.map((k) => [Object.prototype.hasOwnProperty.call(race, k), race[k]]);
  race.renderer3d = fake; delete race.renderer; delete race.ui;
  try { return fn(); }
  finally {
    keys.forEach((k, i) => { if (keep[i][0]) race[k] = keep[i][1]; else delete race[k]; });
    if (!hadRace) delete G.race;
  }
}

T('replay 3D: player drives renderer3d cameras, orbit/free controllers, follow and teardown', () => {
  const { rep, s } = runRecorded({ seconds: 14 });
  const { mod, log } = fakeR3();
  with3D(mod, () => {
    const p = R.createPlayer(rep, undefined, null, { canvas: stubCanvas(), geom: s.geom, trackDef: s.trackDef, camera: 'chase' });
    assert.ok(p.is3D && !p.builtin && log.created === 1);
    assert.deepEqual(p.cameras, ['director', 'chase', 'cockpit', 'orbit-car', 'helicopter', 'tv', 'north']);
    p.seek(8);
    assert.equal(log.modes[log.modes.length - 1], 'chase');
    const expect = { cockpit: 'cockpit', helicopter: 'heli', tv: 'tv', trackside: 'tv', north: 'map', 'orbit-car': 'chase' };
    Object.keys(expect).forEach((c) => { p.setCamera(c); assert.equal(p.mode3d, expect[c], c); });
    // orbit: the controller overrides the built-in camera around the followed car
    p.setCamera('orbit-car'); const before = log.ctlCalls.length; p.render();
    const oc = log.ctlCalls[log.ctlCalls.length - 1];
    assert.ok(log.ctlCalls.length > before && oc && oc.eye && oc.target);
    const car = p.lastSnapshot.cars.find((c) => c.isPlayer);
    assert.ok(Math.abs(oc.target[0] - car.x) < 1e-9 && Math.abs(oc.target[2] + car.y) < 1e-9);
    // non-controller modes leave the built-in camera alone
    p.setCamera('chase'); p.render(); assert.equal(log.ctlCalls[log.ctlCalls.length - 1], false);
    // follow-car selector re-targets the renderer's player car
    p.followCar('c1'); assert.equal(p.lastSnapshot.playerId, 'c1');
    assert.ok(p.lastSnapshot.cars.find((c) => c.id === 'c1').isPlayer);
    // free camera
    p.setCamera('free'); assert.ok(p.getFreeCamera3d()); p.render();
    assert.ok(log.ctlCalls[log.ctlCalls.length - 1].eye);
    // director: shots resolve to 3D modes only
    p.setCamera('director'); for (let i = 0; i < 40; i++) { p.seek(i * 0.3); }
    assert.ok(['tv', 'chase', 'heli', 'cockpit'].includes(p.mode3d));
    // backward seek re-feeds a snapshot at the new time
    p.seek(2); assert.ok(Math.abs(p.lastSnapshot.replay.t - 2) < 1e-6);
    p.destroy();
    assert.equal(log.destroyed, 1); assert.equal(log.ctl[log.ctl.length - 1], false, 'controller cleared');
  });
});

T('replay 3D: falls back to the 2D view when WebGL is missing, refused or failing', () => {
  const { rep, s } = runRecorded({ seconds: 6 });
  const mk = (fake, o) => with3D(fake, () => R.createPlayer(rep, undefined, null, Object.assign({ canvas: stubCanvas(), geom: s.geom, trackDef: s.trackDef }, o || {})));
  let f = fakeR3({ supported: false }), p = mk(f.mod); assert.ok(!p.is3D && p.builtin && f.log.created === 0); p.destroy();
  f = fakeR3({ throws: true }); p = mk(f.mod); assert.ok(!p.is3D && p.builtin); p.destroy();
  f = fakeR3(); p = mk(f.mod, { graphics: '2d' }); assert.ok(!p.is3D && f.log.created === 0); p.destroy();
  f = fakeR3(); p = mk(f.mod, { builtin: true }); assert.ok(!p.is3D && p.builtin); p.destroy();
  // no geometry (outline-only replay): built-in view
  f = fakeR3(); p = with3D(f.mod, () => R.createPlayer(rep, undefined, null, { canvas: stubCanvas() }));
  assert.ok(!p.is3D && f.log.created === 0); p.destroy();
  // a renderer that keeps throwing is destroyed and replaced by the top-down view
  f = fakeR3({ renderThrows: true }); p = mk(f.mod);
  assert.ok(p.is3D);
  with3D(f.mod, () => { for (let i = 0; i < 4; i++) p.render(); });
  assert.ok(!p.is3D && p.builtin && f.log.destroyed === 1);
  assert.ok(p.cameras.includes('trackside') && !p.cameras.includes('cockpit'));
  p.destroy();
});

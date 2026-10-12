/* ==========================================================================
   FORGE Atelier — js/race/drift/tracks.js
   CB.race.drift.tracks : drift-focused circuits (docs/DRIFT-SPEC.md §4), registered into CB.race.tracks.

     CB.race.drift.tracks.list          -> [def]   ('kurogane-pass', 'dockyard-sliders', 'circle-lab')
     CB.race.drift.tracks.ids           -> ['kurogane-pass', ...]
     CB.race.drift.tracks.get(id)       -> def | null
     CB.race.drift.tracks.isDrift(defOrId) -> bool
     CB.race.drift.tracks.zones(geomOrDef, def?) -> resolved drift zones in geom meters (see below)
     CB.race.drift.tracks.install(T?)   -> registers the defs into CB.race.tracks (idempotent; runs at load)

   Every def is produced by CB.race.tracks.makeTrack (exact same shape as the catalog circuits:
   points, widthKeys, theme, style, scenery[], wallType, kerbs, runoff, barrier, ...) and then
   decorated with drift metadata:
     def.mode        = 'drift'
     def.drift       = { duration_s, medals: {bronze, silver, gold, platinum}, defaultTune, camera, tandem }
     def.driftZones  = [{ id, name, kind: 'clip'|'zone'|'swing', clip: 'inner'|'outer'|null,
                          side (+1 left / -1 right of race direction), u, u0, u1 (lap fractions),
                          s, s0, s1 (layout meters), lateral (signed m from centerline, +left),
                          radius (m, clip proximity radius / zone half-depth), dir (corner turn +1 L / -1 R),
                          corner (name), points (bonus hint) }]
   zones(geom) maps the lap fractions onto the built geometry (s, s0, s1, index, x, y, heading) so
   scorers / HUD / 3D markers can use them directly.  Pure, Node-testable, zero deps.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

CB.race.drift.tracks = (function () {
  'use strict';

  function getT() {
    if (CB.race.tracks && typeof CB.race.tracks.makeTrack === 'function') return CB.race.tracks;
    if (typeof require === 'function' && typeof module !== 'undefined') {
      try { return require('../tracks.js'); } catch (e) { /* not in Node / missing */ }
    }
    return null;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function round2(v) { return Math.round(v * 100) / 100; }

  var DRIFT_BRANDS = ['KUROGANE', 'REDLINE', 'NOVA TYRES', 'APEX FUEL', 'SLIDEWAYS', 'HELIX OIL', 'RPM WORKS', 'TOUGE KINGS', 'SMOKE SHOW', 'CARBONWERK'];
  var CONTAINER_COLORS = ['#b8352b', '#2a5d9f', '#d9862b', '#2f7d4f', '#7b2f86', '#c9c3b6', '#1f6f78', '#8a5a2b', '#d4b23a', '#4d5560'];

  /* =================================================================== SPECS
     Authored as turtle layouts (see tracks.js). Width 14-22 m everywhere (drift-wide). */
  var SPECS = [];

  /* ---------------- 1. Kurogane Pass — mountain drift circuit ---------------- */
  SPECS.push({
    id: 'kurogane-pass', name: 'Kurogane Pass', short: 'Kurogane', country: 'Japan', city: 'Hakone, Kanagawa',
    desc: 'An autumn mountain pass closed for the night: chained switchback hairpins up the ridge, flowing S-bends ' +
      'through the maples and a fast downhill sweeper into the Oni hairpin. Guardrails close enough to kiss.',
    difficulty: 3, surface: { grip: 0.96, type: 'road' }, width_m: 17, defaultLaps: 2, timeOfDay: 'dusk',
    theme: { grass: '#4a5a2c', asphalt: '#36373b', kerbA: '#f2f2f2', kerbB: '#c8202a', sand: '#7d6b4f', sky: '#e9a77a',
      line: '#f1e7c4', wall: '#c9ccd0', barrier: '#b7bcc2', tree: '#7a3a1c', ground: '#4a5a2c', rock: '#7c7468',
      accent: '#ff5a1f', glow: '#ffb070', night: false },
    style: { touge: true, drift: true }, wallType: 'guardrail', gravel: false,
    kerbs: { width: 0.9, radius: 80, outside: false },
    runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 3.2, right: 3.2 },
    elevation_m: 260, tags: ['drift', 'touge', 'hairpins', 'mountain', 'guardrails'],
    layout: [
      ['S', 150, { w: 18, name: 'Toride Straight' }],
      ['R', 70, 40, { noSand: true }],
      ['L', 55, 70, { name: 'Kiri S', noSand: true }],
      ['R', 50, 30, { name: 'Kiri S2', noSand: true }],
      ['S', 60],
      ['L', 36, 180, { name: 'Ichi Hairpin', w: 21, noSand: true }],
      ['S', 200, { fixed: true }],
      ['R', 38, 180, { name: 'Ni Hairpin', w: 21, noSand: true }],
      ['S', 200, { fixed: true }],
      ['L', 36, 180, { name: 'San Hairpin', w: 21, noSand: true }],
      ['S', 120],
      ['R', 60, 60, { name: 'Momiji S', noSand: true }],
      ['L', 50, 60, { name: 'Momiji S2', noSand: true }],
      ['S', 220],
      ['L', 80, 90, { name: 'Tenbo Sweeper', noSand: true }],
      ['S', 260, { auto: true, name: 'Downhill' }],
      ['R', 42, 90, { name: 'Kaminari', noSand: true }],
      ['L', 40, 180, { name: 'Oni Hairpin', w: 21, noSand: true }],
      ['L', 55, 60, { name: 'Shimo', noSand: true }],
      ['S', 80, { auto: true }],
      ['R', 55, 60, { name: 'Gate', noSand: true }],
      ['S', 60, { w: 18 }]
    ],
    drift: { duration_s: 180, medals: { bronze: 25000, silver: 60000, gold: 120000, platinum: 200000 }, defaultTune: 'street',
      camera: 'chase', tandem: true },
    scenery: function (c) {
      var L = c.L, r = c.rng;
      // dense autumn forest: maples + cedars on both sides, deeper on the outside of the mountain
      c.trees(0, L, 1, { spacing: 10, off: 2, depth: 3, rowGap: 8, variants: ['maple', 'cedar', 'maple', 'pine'], density: 0.8, rMin: 2.2, rMax: 4 });
      c.trees(0, L, -1, { spacing: 10, off: 2, depth: 3, rowGap: 8, variants: ['cedar', 'maple', 'pine', 'maple'], density: 0.8, rMin: 2.2, rMax: 4 });
      for (var s = 25; s < L; s += 55) c.add('rock', s + r.range(-18, 18), r.chance(0.5) ? 1 : -1, r.range(1, 5), { r: r.range(1.2, 3.4) });
      // hairpins: chevrons on the outside, road lamps, tyre stacks, spectator tents on the inside
      c.corners.forEach(function (cn) {
        if (cn.r <= 45 && cn.deg >= 150) {
          c.add('billboard', cn.mid, cn.outside, 0.4, { l: 14, w: 0.5, h: 1.6, variant: 'chevron', text: '>>>' });
          c.add('tyres', cn.s0 + cn.len * 0.6, cn.outside, 0.3, { l: Math.min(40, cn.len * 0.6), w: 1.4, h: 1.0, color: '#1d1d1d' });
          c.add('lamp', cn.mid - 15, cn.outside, 1.4, { r: 0.3, h: 7, variant: 'road', lit: true });
          c.add('lamp', cn.mid + 15, cn.outside, 1.4, { r: 0.3, h: 7, variant: 'road', lit: true });
          c.add('tent', cn.mid, cn.inside, 6, { l: 8, w: 6, h: 3, color: r.pick(['#ffffff', '#ff5a1f', '#c8202a']) });
        } else if (cn.deg >= 60) {
          c.add('billboard', cn.s0 - 40, cn.outside, 1.2, { l: 10, w: 0.8, h: 3, text: r.pick(DRIFT_BRANDS) });
        }
      });
      // start / finish: torii gate, teahouse, parking with spectator cars, judges tower
      c.add('tower', L - 12, 1, 1.8, { l: 7, w: 1.2, h: 7, variant: 'torii', color: '#c8202a' });
      c.add('building', L - 70, -1, 4, { l: 22, w: 12, h: 6, variant: 'teahouse', color: '#6b4a32', accent: '#2b2b2b' });
      c.add('building', 75, 1, 4, { l: 36, w: 20, h: 2, variant: 'parking', color: '#55585c' });
      c.add('tower', 40, -1, 3, { l: 6, w: 6, h: 10, variant: 'timing', text: 'JUDGES' });
      c.row('billboard', 20, 140, -1, 40, 0.6, function () { return { l: 9, w: 0.6, h: 2.2, text: r.pick(DRIFT_BRANDS) }; });
      c.row('lamp', 0, L, 1, 90, 1.2, { r: 0.3, h: 7, variant: 'road', lit: true });
      c.marshals(300, 0.8);
    }
  });

  /* ---------------- 2. Dockyard Sliders — harbor drift park ---------------- */
  SPECS.push({
    id: 'dockyard-sliders', name: 'Dockyard Sliders', short: 'Dockyard', country: 'Japan', city: 'Yokohama Port',
    desc: 'Wide-open industrial asphalt on a container terminal at night. Long, linked sweepers walled in by stacked ' +
      'shipping containers, a looping container-yard hairpin and a dry-dock hairpin under the gantry cranes.',
    difficulty: 2, surface: { grip: 0.97, type: 'asphalt' }, width_m: 19, defaultLaps: 3, timeOfDay: 'night',
    theme: { grass: '#2a2d31', asphalt: '#2e3034', kerbA: '#ffcc00', kerbB: '#1b1b1b', sand: '#4a4a48', sky: '#0b1020',
      line: '#ffd84a', wall: '#c9ccd2', barrier: '#5b616b', tree: '#2f4a33', ground: '#3a3c40', water: '#0a2238',
      glow: '#ffb84a', accent: '#ffcc00', rock: '#5c5f63', night: true },
    style: { street: true, night: true, drift: true, industrial: true }, wallType: 'concrete', gravel: false,
    kerbs: { width: 1.2, radius: 140, outside: true, exitLen: 18, entryLen: 8 },
    runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 4, right: 4 },
    tags: ['drift', 'harbor', 'night', 'wide', 'containers'],
    layout: [
      ['S', 220, { w: 21, name: 'Quay Straight' }],
      ['L', 90, 75, { name: 'Crane Sweeper' }],
      ['S', 80],
      ['L', 60, 105, { name: 'Gantry' }],
      ['S', 120],
      ['R', 80, 45, { name: 'Reefer Flick' }],
      ['L', 80, 45, { name: 'Reefer Flick 2' }],
      ['S', 60],
      ['R', 70, 90, { name: 'Bollard' }],
      ['L', 42, 140, { name: 'Container Loop', w: 20 }],
      ['S', 160, { auto: true, name: 'Stack Alley' }],
      ['L', 110, 60, { name: 'Long Sweeper' }],
      ['R', 55, 70, { name: 'Pier Kink' }],
      ['L', 38, 140, { name: 'Dry Dock Hairpin', w: 20 }],
      ['S', 200, { auto: true }],
      ['S', 40, { w: 21 }]
    ],
    drift: { duration_s: 150, medals: { bronze: 20000, silver: 50000, gold: 100000, platinum: 170000 }, defaultTune: 'street',
      camera: 'chase', tandem: true },
    scenery: function (c) {
      var L = c.L, r = c.rng;
      // container walls: rows of 40 ft / 20 ft boxes, 1-3 high, stacked just behind the concrete barriers
      function containers(s0, s1, side, off) {
        var s = s0;
        while (s < s1) {
          var forty = r.chance(0.6), l = forty ? 12.2 : 6.1, tiers = r.int(1, 3);
          c.add('building', s + l / 2, side, off + r.range(0, 0.6), { l: l, w: 2.44, h: 2.6 * tiers, variant: 'container',
            color: r.pick(CONTAINER_COLORS), accent: r.pick(CONTAINER_COLORS), text: r.pick(['REDLINE CARGO', 'NOVA', 'KESTREL', 'ORBITAL', 'MERIDIAN']) });
          s += l + r.range(0.3, 1.2);
        }
      }
      c.straights.forEach(function (st) { containers(st.s0 + 6, st.s1 - 6, 1, 0.8); containers(st.s0 + 6, st.s1 - 6, -1, 0.8); });
      c.corners.forEach(function (cn) { containers(cn.s0, cn.s1, cn.outside, 0.8); });
      // gantry cranes along the quay + warehouse sheds
      [0.15, 0.35, 0.55, 0.8].forEach(function (u, k) {
        c.add('tower', u * L, k % 2 ? 1 : -1, 22, { l: 18, w: 16, h: 48, variant: 'crane', color: k % 2 ? '#d94a1e' : '#2a6fdb', accent: '#f2f2f2', lit: true });
      });
      c.buildings(L * 0.2, L * 0.5, -1, { off: 18, lMin: 40, lMax: 70, wMin: 24, wMax: 36, hMin: 10, hMax: 16, colors: ['#4a5058', '#5b6168', '#3d434a'], accents: ['#ffcc00', '#d94a1e'], lit: true, gapMin: 6, gapMax: 14 });
      // harbour water beyond the quay
      for (var s = 0; s < 260; s += 45) c.add('water', s, -1, 24, { r: 30, variant: 'harbour', color: '#0a2238' });
      c.add('building', 120, -1, 46, { l: 40, w: 9, h: 3, variant: 'yacht', color: '#e9e9e9', accent: '#1d3557' });
      // floodlights everywhere (night event), tyre stacks at the hairpins, judges tower + grandstand
      c.row('lamp', 0, L, 1, 45, 0.6, { r: 0.35, h: 18, variant: 'flood', lit: true, color: '#fff1d0' });
      c.row('lamp', 22, L, -1, 45, 0.6, { r: 0.35, h: 18, variant: 'flood', lit: true, color: '#fff1d0' });
      c.cornerFurniture({ tyreR: 60, boardR: 0, countdownBoards: false, tyreColor: '#ffcc00' });
      c.add('grandstand', L - 120, 1, 3, { l: 70, w: 14, h: 10, color: '#2c2f36', accent: '#ffcc00', lit: true });
      c.add('tower', L - 40, 1, 3, { l: 9, w: 9, h: 14, variant: 'timing', text: 'JUDGES', color: '#30343b', accent: '#ffcc00' });
      for (var b = 60; b < L; b += 160) c.add('billboard', b, r.chance(0.5) ? 1 : -1, 0.5, { l: 20, w: 1, h: 5, text: r.pick(DRIFT_BRANDS), lit: true });
      c.marshals(260, 0.6);
    }
  });

  /* ---------------- 3. Circle Lab — skidpad + figure-8 practice area ---------------- */
  SPECS.push({
    id: 'circle-lab', name: 'Circle Lab', short: 'Circle Lab', country: 'Germany', city: 'Redline Proving Ground',
    desc: 'The Redline dynamics lab: a constant-radius skidpad loop flowing into a figure-8 over a steel bridge. ' +
      'Learn to hold angle, swing left-to-right and link transitions before taking it to the mountains.',
    difficulty: 1, surface: { grip: 0.98, type: 'asphalt' }, width_m: 20, defaultLaps: 5, timeOfDay: 'day',
    theme: { grass: '#5d8a3c', asphalt: '#3a3c40', kerbA: '#1fb6ff', kerbB: '#f4f4f4', sand: '#d2bd88', sky: '#a9cdee',
      line: '#ffffff', wall: '#dcdcdc', barrier: '#9aa0a6', tree: '#3d6a2e', ground: '#5d8a3c', bridge: '#7d848c',
      accent: '#1fb6ff', rock: '#8a8478', night: false },
    style: { figure8: true, drift: true, skidpad: true }, wallType: 'tyres', gravel: false,
    crossing: 'bridge', bridgeUpper: 'first',
    kerbs: { width: 1.2, radius: 120, outside: true },
    runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 8, right: 8 },
    tags: ['drift', 'skidpad', 'figure-8', 'practice', 'bridge'],
    heading0: 90,
    layout: [
      ['S', 100, { w: 20, name: 'Lab Straight' }],
      ['R', 45, 135, { name: 'West Loop', noSand: true }],
      ['S', 180, { auto: true, name: 'Crossover' }],
      ['L', 60, 270, { name: 'Skidpad', noSand: true }],
      ['S', 180, { auto: true, name: 'Underpass' }],
      ['R', 45, 135, { name: 'West Hook', noSand: true }]
    ],
    drift: { duration_s: 120, medals: { bronze: 15000, silver: 40000, gold: 80000, platinum: 140000 }, defaultTune: 'street',
      camera: 'chase', tandem: false },
    scenery: function (c) {
      var L = c.L, r = c.rng;
      // instruction cones around the skidpad + loops (outside the barriers)
      c.corners.forEach(function (cn) {
        for (var s = cn.s0; s <= cn.s1; s += 9) {
          c.add('cone', s, cn.inside, 0.6, { r: 0.4 });
          c.add('cone', s + 4.5, cn.outside, 0.6, { r: 0.4 });
        }
        c.add('tyres', cn.s0 + cn.len * 0.5, cn.outside, 0.4, { l: Math.min(60, cn.len * 0.5), w: 1.4, h: 1.0, color: '#1fb6ff' });
      });
      var pad = c.corners.filter(function (k) { return k.name === 'Skidpad'; })[0];
      c.add('pits', 50, 1, 6, { l: 100, w: 16, h: 8, text: 'CIRCLE LAB', color: '#e9e9e9', accent: '#1fb6ff' });
      c.add('tower', 50, 1, 26, { l: 8, w: 8, h: 18, variant: 'timing', text: 'LAB CONTROL' });
      if (pad) {
        c.add('grandstand', pad.mid, pad.outside, 4, { l: 60, w: 12, h: 8, color: '#c8cdd4', accent: '#1fb6ff' });
        c.add('tower', pad.s0 + pad.len * 0.2, pad.outside, 6, { l: 6, w: 6, h: 14, variant: 'timing', text: 'SKIDPAD' });
      }
      for (var k = 0; k < 4; k++) c.add('tent', 10 + k * 16, 1, 48, { l: 12, w: 10, h: 4, color: r.pick(['#ffffff', '#1fb6ff', '#1b1b1b']) });
      c.straights.forEach(function (st) {
        c.trees(st.s0, st.s1, 1, { spacing: 24, off: 14, depth: 2, rowGap: 10, variants: ['birch', 'oak'], density: 0.5 });
        c.trees(st.s0, st.s1, -1, { spacing: 24, off: 14, depth: 2, rowGap: 10, variants: ['birch', 'oak'], density: 0.5 });
      });
      c.row('lamp', 0, L, 1, 70, 1.5, { r: 0.35, h: 12, variant: 'street' });
      c.row('billboard', 40, L - 40, -1, 180, 1.0, function () { return { l: 12, w: 0.8, h: 3, text: r.pick(DRIFT_BRANDS) }; });
    }
  });

  /* ============================================================= ZONES */

  /** auto drift zones from the turtle segments (lap fractions; robust to the spline/layout length difference) */
  function authorZones(def, spec, T) {
    var t = T.turtle(def.layout, { heading0: spec.heading0 || 0 });
    var Lt = t.length, segs = t.segments, zones = [], n = 0;
    function widthAt(sg) { return (sg.opts && sg.opts.w) || spec.width_m; }
    function push(z) {
      z.id = def.id + ':z' + (n++);
      z.u = round2(mod(z.s, Lt) / Lt * 1e4) / 1e4;
      z.u0 = round2(mod(z.s0, Lt) / Lt * 1e4) / 1e4;
      z.u1 = round2(mod(z.s1, Lt) / Lt * 1e4) / 1e4;
      z.s = round2(mod(z.s, Lt)); z.s0 = round2(mod(z.s0, Lt)); z.s1 = round2(mod(z.s1, Lt));
      zones.push(z);
    }
    segs.forEach(function (sg, i) {
      if (sg.kind === 'S' || sg.deg < 35 || sg.r > 160) return;
      var hw = widthAt(sg) / 2, dir = sg.dir, name = sg.name || ('Turn ' + (i + 1));
      var apexes = sg.deg >= 150 ? [0.3, 0.7] : [0.5];
      apexes.forEach(function (f, k) {
        var s = sg.s0 + sg.len * f;
        push({ name: name + (apexes.length > 1 ? (k ? ' exit apex' : ' entry apex') : ' apex'), kind: 'clip', clip: 'inner',
          side: dir, dir: dir, corner: name, s: s, s0: s - 6, s1: s + 6, lateral: round2(dir * (hw - 1.2)), radius: 3.5,
          points: sg.r < 40 ? 600 : 400 });
      });
      var o0 = sg.s0 + sg.len * 0.35, o1 = sg.s1 + Math.min(25, sg.len * 0.3);
      push({ name: name + ' outer zone', kind: 'zone', clip: 'outer', side: -dir, dir: dir, corner: name,
        s: (o0 + o1) / 2, s0: o0, s1: o1, lateral: round2(-dir * (hw - 2)), radius: 3, points: 300 });
    });
    // swing (transition) zones: two opposite-direction corners with < 70 m between them
    var arcs = segs.filter(function (sg) { return sg.kind !== 'S' && sg.deg >= 20; });
    for (var a = 0; a < arcs.length; a++) {
      var A = arcs[a], B = arcs[(a + 1) % arcs.length];
      if (A === B || A.dir === B.dir) continue;
      var gap = mod(B.s0 - A.s1, Lt);
      if (gap > 70) continue;
      push({ name: (A.name || 'Turn') + ' / ' + (B.name || 'Turn') + ' swing', kind: 'swing', clip: null, side: 0, dir: B.dir,
        corner: B.name || null, s: A.s1 + gap / 2, s0: A.s1 - Math.min(15, A.len / 3), s1: B.s0 + Math.min(15, B.len / 3),
        lateral: 0, radius: widthAt(B) / 2, points: 350 });
    }
    zones.sort(function (p, q) { return p.u - q.u; });
    return zones;
  }

  /** zones mapped onto a built geometry: s / s0 / s1 in geom meters + index, x, y, heading */
  function zones(geomOrDef, defArg) {
    var T = getT();
    var geom = geomOrDef && geomOrDef.samples ? geomOrDef : null;
    var def = defArg || (geom ? geom.def : geomOrDef);
    if (!def || !def.driftZones) return [];
    if (!geom) { if (!T) return def.driftZones.slice(); geom = T.build(def); }
    var L = geom.length;
    return def.driftZones.map(function (z) {
      var s = z.u * L, p = T ? T.pointAt(geom, s, z.lateral || 0) : null;
      var out = {};
      for (var k in z) if (Object.prototype.hasOwnProperty.call(z, k)) out[k] = z[k];
      out.s = round2(s); out.s0 = round2(mod(z.u0 * L, L)); out.s1 = round2(mod(z.u1 * L, L));
      if (p) {
        var hw = p.width / 2;
        // keep inner clips / outer zones on the asphalt of the built track (width noise / hairpin widening)
        if (z.kind !== 'swing') out.lateral = round2(clamp(z.lateral, -(hw - 0.8), hw - 0.8));
        p = T.pointAt(geom, s, out.lateral);
        out.index = p.index; out.x = round2(p.x); out.y = round2(p.y); out.heading = p.heading;
      }
      out.hit = false;
      return out;
    });
  }

  /* ============================================================= BUILD + REGISTER */

  var defs = [], byId = {}, errors = [];

  function makeDef(spec, T) {
    var def = T.makeTrack({
      id: spec.id, name: spec.name, short: spec.short, country: spec.country, city: spec.city, desc: spec.desc,
      difficulty: spec.difficulty, surface: spec.surface, theme: spec.theme, width_m: spec.width_m, layout: spec.layout,
      scale: spec.scale, style: spec.style, kerbs: spec.kerbs, runoff: spec.runoff, barrier: spec.barrier, gravel: spec.gravel,
      wallType: spec.wallType, crossing: spec.crossing, bridgeUpper: spec.bridgeUpper, defaultLaps: spec.defaultLaps,
      timeOfDay: spec.timeOfDay, tags: spec.tags, elevation_m: spec.elevation_m, heading0: spec.heading0,
      sectors: spec.sectors, scenery: spec.scenery
    });
    def.mode = 'drift';
    def.drift = spec.drift;
    def.driftZones = authorZones(def, spec, T);
    return def;
  }

  function buildAll(T) {
    if (defs.length) return defs;
    SPECS.forEach(function (spec) {
      try {
        var d = makeDef(spec, T);
        defs.push(d); byId[d.id] = d;
      } catch (e) {
        errors.push({ id: spec.id, error: String((e && e.message) || e) });
        if (typeof console !== 'undefined') console.warn('[drift/tracks] ' + spec.id + ': ' + ((e && e.message) || e));
      }
    });
    return defs;
  }

  function install(Targ) {
    var T = Targ || getT();
    if (!T) return false;
    buildAll(T);
    defs.forEach(function (d) {
      if (typeof T.register === 'function') {
        if (!(T.get && T.get(d.id))) T.register(d);
        return;
      }
      var list = T.list || (T.list = []);
      // replace a stale copy (script loaded twice) instead of duplicating
      var at = -1;
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === d.id) at = i;
      if (at >= 0) list[at] = d; else list.push(d);
      if (T.byId) T.byId[d.id] = d;
      if (T.ids && T.ids.indexOf(d.id) < 0) T.ids.push(d.id);
      if (T.get && T.get(d.id) !== d) {
        // byId not shared with get(): wrap get() so it also resolves drift tracks
        var prevGet = T.get;
        T.get = function (id) { return byId[id] || prevGet(id); };
        T.geometry = function (id) { var dd = T.get(id); return dd ? T.build(dd) : null; };
      }
    });
    return true;
  }

  function isDrift(x) {
    var id = typeof x === 'string' ? x : x && x.id;
    var d = byId[id] || (x && typeof x === 'object' ? x : null);
    return !!(d && (d.mode === 'drift' || (d.style && d.style.drift) || (d.tags && d.tags.indexOf('drift') >= 0)));
  }

  install();

  return {
    list: defs,
    get ids() { return defs.map(function (d) { return d.id; }); },
    byId: byId,
    specs: SPECS,
    errors: errors,
    get: function (id) { return byId[id] || null; },
    isDrift: isDrift,
    zones: zones,
    install: install
  };
})();

if (typeof module !== 'undefined') module.exports = CB.race.drift.tracks;

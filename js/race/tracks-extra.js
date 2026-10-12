/* ==========================================================================
   FORGE Atelier — js/race/tracks-extra.js
   CB.race.tracksExtra : three extra detailed circuits registered into CB.race.tracks.

     CB.race.tracksExtra.list            -> [def]  ('gruenwald-ring', 'shuto-night-loop', 'mesa-verde')
     CB.race.tracksExtra.ids             -> ['gruenwald-ring', ...]
     CB.race.tracksExtra.get(id)         -> def | null
     CB.race.tracksExtra.zones(geomOrDef)-> drift zones resolved onto the built geometry (same shape as
                                            CB.race.drift.tracks.zones; [] for defs without driftZones)
     CB.race.tracksExtra.install(T?)     -> registers the defs into CB.race.tracks (idempotent; runs at load)
     CB.race.tracksExtra.errors          -> [{ id, error }] specs that failed to build (normally empty)

   1. Grünwald Ring   — ~12 km forested Nordschleife-style ring: Hexenbach esses, the Fliegerhorst crest,
                        Fuchsbau compression, the Wehrseifen valley hairpin, a banked concrete Karussell,
                        Schwalbenschwanz and a 1.5 km Döttinger-style straight into the Hohenrain chicane.
   2. Shuto Night Loop — Tokyo C1-style elevated inner-loop at night: concrete walls on both sides, tunnel
                        sections, wide sweepers and junction S-bends; authored driftZones (drift + race).
   3. Mesa Verde       — high-desert road course with deep sand run-off, a 900 m backstretch, the
                        Rattlesnake hairpin and the blind Mesa Drop S.

   Every def is produced by CB.race.tracks.makeTrack (exact catalog shape: points, widthKeys, theme, style,
   scenery[], wallType, kerbs, runoff, barrier, ...) and then decorated with optional metadata that the
   renderers may use (all plain data, lap fractions u in [0,1) of the layout length):
     def.banking   = [{ name, u0, u1, deg }]             banked sections (Karussell)
     def.tunnels   = [{ name, u0, u1 }]                  covered sections (Shuto)
     def.elevation = [[u, metres], ...]                  relative height profile keys (feel / minimap)
     def.terrainAmplitude                                 hint for CB.gl.track buildGeometry({ terrainAmplitude })
     def.driftZones / def.drift                           as in js/race/drift/tracks.js (Shuto only)
   Pure, Node-testable, zero deps. Load after js/race/tracks.js.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};

CB.race.tracksExtra = (function () {
  'use strict';

  function getT() {
    if (CB.race.tracks && typeof CB.race.tracks.makeTrack === 'function') return CB.race.tracks;
    if (typeof require === 'function' && typeof module !== 'undefined') {
      try { return require('./tracks.js'); } catch (e) { /* not in Node / missing */ }
    }
    return null;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function round4(v) { return Math.round(v * 1e4) / 1e4; }

  var EU_BRANDS = ['REDLINE', 'RPM WORKS', 'HELIX OIL', 'NOVA TYRES', 'KESTREL', 'CARBONWERK', 'EIFELBRÄU', 'GRÜNWALD', 'MERIDIAN', 'APEX FUEL'];
  var JP_BRANDS = ['REDLINE', 'NOVA TYRES', 'SHUTOKO', 'KUROGANE', 'APEX FUEL', 'HELIX OIL', 'ORBITAL', 'TOKYO NIGHTS', 'SLIDEWAYS', 'RPM WORKS'];
  var US_BRANDS = ['REDLINE', 'MESA VERDE', 'NOVA TYRES', 'APEX FUEL', 'VOLTA', 'KESTREL', 'DESERT RAT', 'HELIX OIL', 'RPM WORKS', 'SIDEWINDER'];

  var SPECS = [];

  /* ---------------- 1. Grünwald Ring — the 12 km forest ring ---------------- */
  SPECS.push({
    id: 'gruenwald-ring', name: 'Grünwald Ring', short: 'Grünwald', country: 'Germany', city: 'Hocheifel',
    desc: 'Twelve kilometres of narrow, rolling ribbon through the pine forest: the Hexenbach esses, the airborne ' +
      'Fliegerhorst crest, the plunging Fuchsbau, the Wehrseifen valley hairpin, the banked concrete Karussell and ' +
      'a 1.5 km flat-out Höhe into the Hohenrain chicane. The Green Hell, Redline-style.',
    difficulty: 5, surface: { grip: 0.98, type: 'asphalt' }, width_m: 11.5, defaultLaps: 1, timeOfDay: 'day',
    theme: { grass: '#4b7531', asphalt: '#3a3b3e', kerbA: '#d8262a', kerbB: '#f2f2f2', sand: '#cbb88a', sky: '#9dc3e4',
      line: '#f3f3ee', wall: '#d2d4d6', barrier: '#a3a9ae', tree: '#24452a', ground: '#4b7531', rock: '#77736b',
      accent: '#1f8a3c', night: false },
    style: { forest: true, ring: true }, wallType: 'armco', gravel: true,
    kerbs: { width: 1.1, radius: 200, outside: true, exitLen: 18, entryLen: 8 },
    runoff: { left: 'grass', right: 'grass' }, barrier: { left: 4.5, right: 4.5 },
    elevation_m: 300, terrainAmplitude: 22,
    tags: ['endurance', 'forest', 'nordschleife', 'high-speed', 'technical', 'long', 'elevation'],
    layout: [
      ['S', 420, { w: 13.5, name: 'Start-Ziel' }],
      ['R', 50, 80, { name: 'Südkehre', w: 12.5 }], ['L', 85, 30, { name: 'Hexenbach' }], ['R', 85, 45, { name: 'Hexenbach II' }],
      ['L', 95, 30], ['R', 110, 25], ['L', 334, 30, { name: 'Quiddelbach' }], ['R', 334, 30], ['L', 500, 12, { name: 'Fliegerhorst' }],
      ['R', 260, 24], ['S', 420, { auto: true }],
      ['L', 200, 40, { name: 'Schwedenstein' }], ['S', 120],
      ['R', 42, 95, { name: 'Arenstein' }], ['S', 80],
      ['L', 160, 35, { name: 'Fuchsbau' }], ['R', 150, 30], ['L', 140, 62], ['R', 286, 30], ['L', 286, 30],
      ['L', 45, 70, { name: 'Adenauer Forst' }], ['R', 40, 70], ['L', 363, 30, { name: 'Metzgerfeld' }],
      ['R', 363, 30], ['L', 120, 40], ['R', 110, 40], ['R', 229, 30], ['L', 229, 30], ['R', 55, 90, { name: 'Kallental' }],
      ['L', 776, 24, { name: 'Wehrseifen Descent' }], ['R', 776, 24], ['L', 30, 100, { name: 'Wehrseifen', w: 12.5 }],
      ['S', 120],
      ['R', 40, 100, { name: 'Breitscheid' }], ['S', 300, { auto: true }],
      ['L', 350, 15, { name: 'Lauda-Links' }], ['R', 350, 15], ['R', 239, 30], ['L', 239, 30], ['L', 85, 45, { name: 'Ex-Mühle' }],
      ['R', 90, 45], ['L', 286, 30], ['R', 286, 30], ['R', 60, 90, { name: 'Bergwerk' }], ['R', 286, 30, { name: 'Kesselgrund' }],
      ['L', 286, 30], ['L', 450, 15], ['S', 200],
      ['R', 450, 15, { name: 'Kesselchen' }], ['L', 286, 30], ['R', 286, 30], ['S', 350, { auto: true }],
      ['R', 260, 22, { name: 'Steilstrecke' }], ['L', 260, 22], ['R', 382, 30], ['L', 382, 30], ['L', 80, 45, { name: 'Klostertal' }],
      ['S', 150],
      ['L', 32, 160, { name: 'Karussell', w: 13, noSand: true, kerbScale: 0.5 }], ['S', 120],
      ['R', 70, 90, { name: 'Hohe Acht' }], ['L', 80, 30, { name: 'Wippermann' }], ['R', 75, 50], ['S', 200],
      ['R', 50, 90, { name: 'Eschbach' }], ['S', 180],
      ['L', 60, 40, { name: 'Brünnchen' }], ['R', 55, 40], ['S', 200],
      ['L', 90, 35, { name: 'Pflanzgarten' }], ['R', 90, 35], ['S', 220],
      ['R', 36, 80, { name: 'Schwalbenschwanz', noSand: true }], ['L', 40, 45], ['S', 200],
      ['R', 150, 60, { name: 'Galgenberg' }], ['S', 1500, { auto: true, name: 'Döttinger Höhe', w: 12.5 }],
      ['R', 300, 10, { name: 'Antoniusbuche' }], ['L', 300, 10], ['S', 200],
      ['L', 25, 40, { name: 'Hohenrain', noSand: true }], ['R', 25, 80], ['L', 25, 40], ['S', 150, { w: 13.5 }]
    ],
    sectors: [0.33, 0.66],
    // relative heights (m) along the lap: climbs out of the valley, the Fuchsbau plunge, the long climb to Hohe Acht
    elevation: [[0, 0], [0.05, 12], [0.1, 30], [0.14, 34], [0.2, -10], [0.26, -45], [0.33, -85], [0.38, -110],
      [0.45, -95], [0.52, -70], [0.6, -40], [0.66, -15], [0.7, 10], [0.74, 25], [0.8, 18], [0.86, 8], [0.93, 2], [1, 0]],
    banking: [{ name: 'Karussell', deg: 14 }],
    scenery: function (c) {
      var L = c.L, r = c.rng;
      var conifers = ['pine', 'spruce', 'pine', 'spruce', 'birch'], mixed = ['oak', 'beech', 'pine', 'birch', 'spruce'];
      // the forest: dense rows of pine / spruce right behind the armco, mixed woodland deeper
      c.straights.forEach(function (st) {
        c.trees(st.s0, st.s1, 1, { spacing: 15, off: 3, depth: 2, rowGap: 9, variants: conifers, density: 0.7, rMin: 2.2, rMax: 3.8 });
        c.trees(st.s0, st.s1, -1, { spacing: 15, off: 3, depth: 2, rowGap: 9, variants: conifers, density: 0.7, rMin: 2.2, rMax: 3.8 });
      });
      c.corners.forEach(function (cn) {
        c.trees(cn.s0, cn.s1, cn.inside, { spacing: 16, off: 4, depth: 2, rowGap: 10, variants: mixed, density: 0.65 });
        if (cn.r > 120) c.trees(cn.s0, cn.s1, cn.outside, { spacing: 18, off: 6, depth: 1, variants: conifers, density: 0.6 });
      });
      for (var s = 40; s < L; s += 140) c.add('rock', s + r.range(-30, 30), r.chance(0.5) ? 1 : -1, r.range(2, 8), { r: r.range(1, 2.6) });
      // start / finish: grandstands, pit building, timing tower, the big "GRÜNWALD" pylon
      c.add('pits', L - 150, -1, 4, { l: 240, w: 18, h: 9, text: 'GRÜNWALD RING', color: '#e8e8e6', accent: '#1f8a3c' });
      for (var g = 0; g < 4; g++) c.add('grandstand', L - 290 + g * 62, 1, 4, { l: 56, w: 20, h: 14, color: '#c7ccd2', accent: '#1f8a3c' });
      c.add('tower', L - 40, -1, 28, { l: 10, w: 10, h: 34, variant: 'timing', text: 'GRÜNWALD' });
      c.add('grandstand', 160, -1, 5, { l: 60, w: 16, h: 10, color: '#c7ccd2', accent: '#d8262a' });
      // camping / fan zones with tents along the famous corners
      c.corners.forEach(function (cn) {
        if (!cn.name || cn.r > 110) return;
        for (var k = 0; k < 4; k++) {
          c.add('tent', cn.s0 + cn.len * (0.2 + k * 0.2), cn.outside, 10 + r.range(0, 8),
            { l: r.range(5, 9), w: r.range(4, 7), h: 3, color: r.pick(['#ffffff', '#d8262a', '#1f8a3c', '#f2c200', '#2a5d9f']) });
        }
      });
      // Karussell: concrete-bowl crowd, signs, tyre wall on the exit
      var kar = c.corners.filter(function (k) { return k.name === 'Karussell'; })[0];
      if (kar) {
        c.add('grandstand', kar.mid, kar.outside, 6, { l: 50, w: 12, h: 7, color: '#b9bec4', accent: '#1f8a3c' });
        c.add('billboard', kar.s0 - 60, kar.outside, 1.2, { l: 16, w: 1, h: 4, text: 'KARUSSELL' });
        c.add('tyres', kar.s1 + 10, kar.outside, 0.3, { l: 30, w: 1.4, h: 1, color: '#1d1d1d' });
      }
      // Höhe: kilometre boards and bridges' worth of sponsors on the long straight
      var hoehe = c.straights.filter(function (st) { return st.name === 'Döttinger Höhe'; })[0];
      if (hoehe) {
        for (var b = hoehe.s0 + 80; b < hoehe.s1 - 60; b += 160) c.add('billboard', b, r.chance(0.5) ? 1 : -1, 0.8, { l: 20, w: 1, h: 4, text: r.pick(EU_BRANDS) });
        c.add('tower', hoehe.s0 + hoehe.len * 0.5, 1, 30, { l: 6, w: 6, h: 42, variant: 'mast', color: '#b7bcc2' });
      }
      c.cornerFurniture({ tyreR: 55, boardR: 100, boardDist: 100, brands: EU_BRANDS });
      c.marshals(420, 1.0);
      c.row('lamp', L - 600, L - 20, -1, 60, 1.6, { r: 0.35, h: 12, variant: 'street' });
    }
  });

  /* ---------------- 2. Shuto Night Loop — elevated Tokyo inner loop ---------------- */
  SPECS.push({
    id: 'shuto-night-loop', name: 'Shuto Night Loop', short: 'Shuto Loop', country: 'Japan', city: 'Tokyo — C1 Inner Loop',
    desc: 'The elevated inner loop after midnight. Concrete walls inches from the mirrors, sodium-lit tunnels under ' +
      'Shiodome and Kasumigaseki, junction S-bends stacked over the canals and wide, fast sweepers made for ' +
      'holding a slide past the neon.',
    difficulty: 4, surface: { grip: 0.95, type: 'street' }, width_m: 15.5, defaultLaps: 3, timeOfDay: 'night',
    theme: { grass: '#1b1e26', asphalt: '#2a2c31', kerbA: '#f2f2f2', kerbB: '#2a2c31', sand: '#3b3f48', sky: '#060812',
      line: '#f4f0d8', wall: '#b9bcc4', barrier: '#5d626d', tree: '#1e3a2c', ground: '#22252d', water: '#081a2e',
      glow: '#ffb347', accent: '#00d4ff', rock: '#4a4e57', night: true },
    style: { street: true, night: true, drift: true, elevated: true, highway: true }, wallType: 'concrete', gravel: false,
    kerbs: { width: 0.6, radius: 90, outside: false },
    runoff: { left: 'tarmac', right: 'tarmac' }, barrier: { left: 2.2, right: 2.2 },
    elevation_m: 18, terrainAmplitude: 0,
    tags: ['night', 'walls', 'street', 'highway', 'city', 'drift', 'tunnels', 'sweepers'],
    layout: [
      ['S', 300, { w: 16.5, name: 'Yaesu Straight' }],
      ['R', 110, 55, { name: 'Edobashi JCT' }], ['L', 140, 25], ['R', 90, 60, { name: 'Takaracho' }],
      ['S', 160],
      ['L', 120, 40, { name: 'Ginza S' }], ['R', 100, 80, { name: 'Ginza S2' }], ['L', 130, 40],
      ['S', 260, { auto: true, name: 'Shiodome Tunnel', tunnel: true }],
      ['R', 75, 70, { name: 'Hamazakibashi' }], ['L', 150, 20], ['S', 150],
      ['R', 130, 40, { name: 'Shibakoen' }],
      ['S', 250, { auto: true, name: 'Ichinohashi' }],
      ['L', 100, 45, { name: 'Ichinohashi JCT' }], ['R', 70, 90, { name: 'Tanimachi' }], ['L', 60, 90, { name: 'Roppongi' }], ['R', 80, 45],
      ['S', 200],
      ['R', 60, 90, { name: 'Kasumigaseki' }],
      ['S', 300, { name: 'Kasumigaseki Tunnel', tunnel: true }],
      ['L', 140, 30, { name: 'Miyakezaka' }], ['R', 90, 60, { name: 'Daikancho' }], ['S', 200, { auto: true }],
      ['L', 100, 40, { name: 'Chidorigafuchi' }], ['R', 120, 50, { name: 'Takebashi' }], ['S', 150],
      ['R', 140, 50, { name: 'Kandabashi' }],
      ['S', 150, { w: 16.5 }]
    ],
    sectors: [0.34, 0.68],
    elevation: [[0, 0], [0.15, 4], [0.3, -6], [0.45, 2], [0.6, 6], [0.72, -8], [0.85, 3], [1, 0]],
    drift: { duration_s: 200, medals: { bronze: 30000, silver: 70000, gold: 140000, platinum: 230000 }, defaultTune: 'street',
      camera: 'chase', tandem: true },
    scenery: function (c) {
      var L = c.L, r = c.rng;
      var glass = ['#141a26', '#1b2333', '#202a3c', '#111621', '#262f44', '#1a1f2b'];
      var neon = ['#00d4ff', '#ff2b8a', '#ffd23f', '#7cff6b', '#ff6b3d', '#b36bff'];
      var tunnels = c.segments.filter(function (sg) { return sg.kind === 'S' && sg.opts.tunnel; }).map(function (sg) {
        return { s0: sg.s0, s1: sg.s1, len: sg.len, name: sg.name || 'Tunnel', tunnel: true };
      });
      function tunnelOf(s) {
        for (var k = 0; k < tunnels.length; k++) if (s >= tunnels[k].s0 - 20 && s <= tunnels[k].s1 + 20) return tunnels[k];
        return null;
      }
      // office towers / apartment blocks crowding both sides of the elevated road (not over the tunnels:
      // there the road is underground, lined with dense sodium lamps)
      c.straights.forEach(function (st) {
        if (tunnelOf((st.s0 + st.s1) / 2)) return;
        c.buildings(st.s0 + 6, st.s1 - 6, 1, { off: 5, lMin: 18, lMax: 46, wMin: 16, wMax: 36, hMin: 30, hMax: 160, colors: glass, accents: neon, lit: true, gapMin: 3, gapMax: 10 });
        c.buildings(st.s0 + 6, st.s1 - 6, -1, { off: 5, lMin: 18, lMax: 46, wMin: 16, wMax: 36, hMin: 30, hMax: 160, colors: glass, accents: neon, lit: true, gapMin: 3, gapMax: 10 });
      });
      c.corners.forEach(function (cn) {
        c.buildings(cn.s0, cn.s1, cn.outside, { off: 7, lMin: 18, lMax: 30, wMin: 14, wMax: 26, hMin: 25, hMax: 120, colors: glass, accents: neon, lit: true, gapMin: 6, gapMax: 14 });
      });
      // tunnels: lamp lines both sides every 12 m + tunnel portals
      tunnels.forEach(function (st) {
        c.row('lamp', st.s0, st.s1, 1, 12, 0.9, { r: 0.25, h: 5.5, variant: 'street', lit: true, color: '#ffb347' });
        c.row('lamp', st.s0 + 6, st.s1, -1, 12, 0.9, { r: 0.25, h: 5.5, variant: 'street', lit: true, color: '#ffb347' });
        [st.s0, st.s1].forEach(function (s, k) {
          [1, -1].forEach(function (side) {
            c.add('building', s + (k ? 8 : -8), side, 0.6, { l: 14, w: 6, h: 9, variant: 'tunnel-portal', color: '#7d828c', accent: '#ffb347', lit: true });
          });
        });
        c.add('billboard', st.s0 - 60, 1, 0.5, { l: 10, w: 0.6, h: 2.4, text: st.name.toUpperCase(), lit: true, color: '#1f7a3a', variant: 'road-sign' });
      });
      // highway lighting outside the tunnels (tall poles, alternating)
      for (var s = 0; s < L; s += 34) {
        if (tunnelOf(s)) continue;
        c.add('lamp', s, (Math.round(s / 34) % 2) ? 1 : -1, 0.9, { r: 0.3, h: 12, variant: 'flood', lit: true, color: '#fff1d6' });
      }
      // canals / bay under the junctions
      ['Edobashi JCT', 'Hamazakibashi', 'Ichinohashi JCT'].forEach(function (nm) {
        var cn = c.corners.filter(function (k) { return k.name === nm; })[0];
        if (!cn) return;
        for (var w = cn.s0 - 40; w < cn.s1 + 60; w += 40) c.add('water', w, cn.inside, 14, { r: 18, variant: 'harbour', color: '#081a2e' });
      });
      // landmarks: a red lattice tower and a ferris wheel on the skyline
      var shiba = c.corners.filter(function (k) { return k.name === 'Shibakoen'; })[0];
      if (shiba) c.add('tower', shiba.mid, shiba.outside, 70, { l: 40, w: 40, h: 333, variant: 'lattice', color: '#ff4a1c', accent: '#ffffff', lit: true });
      c.add('tower', L * 0.12, -1, 90, { l: 60, w: 30, h: 110, variant: 'observation-wheel', color: '#c9ccd6', accent: '#00d4ff', lit: true });
      // neon billboards on the walls + drift event furniture at the start
      for (var b = 90; b < L; b += 150) {
        if (tunnelOf(b)) continue;
        c.add('billboard', b, r.chance(0.5) ? 1 : -1, 0.9, { l: 22, w: 1, h: 6, text: r.pick(JP_BRANDS), lit: true, color: r.pick(neon) });
      }
      c.add('tower', L - 60, 1, 2, { l: 8, w: 8, h: 12, variant: 'timing', text: 'JUDGES', color: '#30343b', accent: '#00d4ff' });
      c.add('grandstand', 150, 1, 2.5, { l: 70, w: 12, h: 9, color: '#2a2f3a', accent: '#00d4ff', lit: true });
      c.add('pits', L - 250, 1, 2.5, { l: 120, w: 14, h: 7, text: 'DAIKOKU PA', color: '#22262f', accent: '#ff2b8a', lit: true });
      // impact attenuators (yellow tyre / water-barrel stacks) at the junction gores
      c.corners.forEach(function (cn) {
        if (cn.r <= 75) c.add('tyres', cn.s1 + 8, cn.outside, 1.0, { l: 8, w: 1.4, h: 1.0, color: '#ffd23f' });
      });
      c.marshals(400, 1.0);
    }
  });

  /* ---------------- 3. Mesa Verde — desert road course ---------------- */
  SPECS.push({
    id: 'mesa-verde', name: 'Mesa Verde Raceway', short: 'Mesa Verde', country: 'USA', city: 'Painted Desert, Arizona',
    desc: 'A high-desert road course carved between red-rock mesas. Huge sand run-offs punish every mistake: ' +
      'the Coyote first turn, the Rattlesnake hairpin, the blind Mesa Drop S and a 450 m backstretch into Sundown.',
    difficulty: 2, surface: { grip: 0.97, type: 'asphalt' }, width_m: 13.5, defaultLaps: 4, timeOfDay: 'day',
    theme: { grass: '#b39563', asphalt: '#45403c', kerbA: '#c8321e', kerbB: '#f4ecdc', sand: '#e0bf83', sky: '#7fb6e6',
      line: '#fbf6ea', wall: '#e2d6c2', barrier: '#a99c88', tree: '#6f7a3a', ground: '#bf9b62', rock: '#b0603a',
      accent: '#e07a1f', night: false },
    style: { desert: true }, wallType: 'armco', gravel: true,
    kerbs: { width: 1.4, radius: 240, outside: true, exitLen: 26, entryLen: 10 },
    runoff: { left: 'sand', right: 'sand' }, barrier: { left: 16, right: 16 },
    elevation_m: 1650, terrainAmplitude: 14,
    tags: ['desert', 'sand', 'runoff', 'flowing', 'high-speed'],
    layout: [
      ['S', 550, { w: 15, name: 'Main Straight' }],
      ['L', 35, 90, { name: 'Coyote' }], ['S', 150],
      ['R', 90, 45, { name: 'Arroyo' }], ['L', 70, 85, { name: 'Arroyo II' }], ['S', 250, { auto: true }],
      ['R', 120, 50, { name: 'Dry Wash' }], ['S', 200],
      ['L', 30, 160, { name: 'Rattlesnake', w: 14.5 }], ['S', 250],
      ['R', 60, 70, { name: 'Mesa Drop' }], ['L', 40, 90, { name: 'Mesa Drop II' }], ['S', 200],
      ['R', 100, 60, { name: 'Butte' }], ['S', 700, { auto: true, name: 'Backstretch' }],
      ['L', 55, 100, { name: 'Sundown' }], ['S', 200],
      ['R', 45, 60, { name: 'Cactus' }], ['L', 80, 120, { name: 'Last Chance' }],
      ['S', 300, { w: 15 }]
    ],
    sectors: [0.33, 0.62],
    elevation: [[0, 0], [0.12, 4], [0.3, 16], [0.42, 22], [0.47, 6], [0.55, 2], [0.75, -6], [0.9, -2], [1, 0]],
    scenery: function (c) {
      var L = c.L, r = c.rng;
      // red-rock mesas and boulder fields beyond the sand
      for (var s = 30; s < L; s += 45) {
        var side = r.chance(0.5) ? 1 : -1;
        c.add('rock', s + r.range(-15, 15), side, r.range(6, 40), { r: r.range(1.2, 3.6), color: '#b0603a' });
      }
      for (var m = 0; m < 14; m++) c.add('rock', r.range(0, L), r.chance(0.5) ? 1 : -1, r.range(60, 120), { r: r.range(6, 9), h: r.range(12, 30), variant: 'mesa', color: '#a5532f' });
      // desert scrub (creosote / sage) — scattered, low
      c.trees(0, L, 1, { spacing: 26, off: 5, depth: 2, rowGap: 14, variants: ['shrub'], density: 0.55, rMin: 0.9, rMax: 1.8, scatter: 18 });
      c.trees(0, L, -1, { spacing: 26, off: 5, depth: 2, rowGap: 14, variants: ['shrub'], density: 0.55, rMin: 0.9, rMax: 1.8, scatter: 18 });
      for (var bsh = 15; bsh < L; bsh += 70) c.add('bush', bsh, r.chance(0.5) ? 1 : -1, r.range(2, 10), { r: r.range(0.6, 1.3), color: '#8a8a4a' });
      // paddock: pits, grandstands, timing tower, RV camping
      c.add('pits', L - 160, -1, 4, { l: 220, w: 18, h: 8, text: 'MESA VERDE', color: '#efe6d6', accent: '#e07a1f' });
      for (var g = 0; g < 3; g++) c.add('grandstand', L - 260 + g * 64, 1, 4, { l: 58, w: 20, h: 13, color: '#d9d2c4', accent: '#c8321e' });
      c.add('tower', L - 40, -1, 26, { l: 10, w: 10, h: 26, variant: 'timing', text: 'MESA VERDE' });
      c.add('grandstand', 120, 1, 6, { l: 50, w: 14, h: 9, color: '#d9d2c4', accent: '#e07a1f' });
      for (var t = 0; t < 10; t++) c.add('tent', L - 420 + t * 20, -1, 30 + (t % 2) * 12, { l: 10, w: 8, h: 3.5, color: r.pick(['#ffffff', '#e07a1f', '#c8321e', '#2a5d9f']) });
      var back = c.straights.filter(function (st) { return st.name === 'Backstretch'; })[0];
      if (back) for (var b = back.s0 + 80; b < back.s1 - 40; b += 120) c.add('billboard', b, r.chance(0.5) ? 1 : -1, 1.0, { l: 18, w: 1, h: 4.5, text: r.pick(US_BRANDS) });
      var rs = c.corners.filter(function (k) { return k.name === 'Rattlesnake'; })[0];
      if (rs) c.add('grandstand', rs.mid, rs.outside, 8, { l: 44, w: 12, h: 7, color: '#d9d2c4', accent: '#c8321e' });
      c.row('lamp', L - 500, L - 20, 1, 70, 2, { r: 0.35, h: 14, variant: 'stadium' });
      c.cornerFurniture({ tyreR: 70, boardR: 130, brands: US_BRANDS });
      c.marshals(320, 1.0);
      for (var k = 0; k < 12; k++) c.add('cone', 40 + k * 8, -1, 1.5, { r: 0.4 });
    }
  });

  /* ============================================================= ZONES (Shuto) */

  /** auto drift zones from the turtle segments (lap fractions), same rules as js/race/drift/tracks.js */
  function authorZones(def, spec, T) {
    var t = T.turtle(def.layout, { heading0: spec.heading0 || 0 });
    var Lt = t.length, segs = t.segments, zones = [], n = 0;
    function widthAt(sg) { return (sg.opts && sg.opts.w) || spec.width_m; }
    function push(z) {
      z.id = def.id + ':z' + (n++);
      z.u = round4(mod(z.s, Lt) / Lt);
      z.u0 = round4(mod(z.s0, Lt) / Lt);
      z.u1 = round4(mod(z.s1, Lt) / Lt);
      if (z.u >= 1) z.u = 0; if (z.u0 >= 1) z.u0 = 0; if (z.u1 >= 1) z.u1 = 0;
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
          points: sg.r < 70 ? 600 : 400 });
      });
      var o0 = sg.s0 + sg.len * 0.35, o1 = sg.s1 + Math.min(25, sg.len * 0.3);
      push({ name: name + ' outer zone', kind: 'zone', clip: 'outer', side: -dir, dir: dir, corner: name,
        s: (o0 + o1) / 2, s0: o0, s1: o1, lateral: round2(-dir * (hw - 2)), radius: 3, points: 300 });
    });
    // swing (transition) zones: opposite-direction corners with < 70 m between them
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
        if (z.kind !== 'swing') out.lateral = round2(clamp(z.lateral, -(hw - 0.8), hw - 0.8));
        p = T.pointAt(geom, s, out.lateral);
        out.index = p.index; out.x = round2(p.x); out.y = round2(p.y); out.heading = p.heading;
      }
      out.hit = false;
      return out;
    });
  }

  /* ============================================================= METADATA */

  /** lap-fraction ranges of named layout segments flagged by a predicate */
  function segmentRanges(t, pred, pad) {
    var Lt = t.length, out = [];
    t.segments.forEach(function (sg) {
      if (!pred(sg)) return;
      var p = pad || 0;
      out.push({ name: sg.name || null, u0: round4(mod(sg.s0 - p, Lt) / Lt), u1: round4(mod(sg.s1 + p, Lt) / Lt),
        s0: round2(sg.s0), s1: round2(sg.s1) });
    });
    return out;
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
    var t = T.turtle(def.layout, { heading0: spec.heading0 || 0 });
    def.pack = 'extra';
    def.terrainAmplitude = spec.terrainAmplitude != null ? spec.terrainAmplitude : null;
    def.elevation = (spec.elevation || []).map(function (k) { return [k[0], k[1]]; });
    def.tunnels = segmentRanges(t, function (sg) { return !!sg.opts.tunnel; }, 0);
    def.banking = (spec.banking || []).map(function (b) {
      var r = segmentRanges(t, function (sg) { return sg.kind !== 'S' && sg.name === b.name; }, 0)[0];
      return r ? { name: b.name, deg: b.deg, u0: r.u0, u1: r.u1, s0: r.s0, s1: r.s1 } : null;
    }).filter(Boolean);
    if (spec.drift) {
      def.drift = spec.drift;
      def.driftZones = authorZones(def, spec, T);
      def.modes = ['race', 'drift'];
    } else {
      def.modes = ['race'];
    }
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
        if (typeof console !== 'undefined') console.warn('[tracks-extra] ' + spec.id + ': ' + ((e && e.message) || e));
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
      var at = -1;
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === d.id) at = i;
      if (at >= 0) list[at] = d; else list.push(d);
      if (T.byId) T.byId[d.id] = d;
      if (T.ids && T.ids.indexOf(d.id) < 0) T.ids.push(d.id);
      if (T.get && T.get(d.id) !== d) {
        // byId not shared with get(): wrap get() so it also resolves these tracks
        var prevGet = T.get;
        T.get = function (id) { return byId[id] || prevGet(id); };
        T.geometry = function (id) { var dd = T.get(id); return dd ? T.build(dd) : null; };
      }
    });
    return true;
  }

  install();

  return {
    list: defs,
    get ids() { return defs.map(function (d) { return d.id; }); },
    byId: byId,
    specs: SPECS,
    errors: errors,
    get: function (id) { return byId[id] || null; },
    zones: zones,
    install: install
  };
})();

if (typeof module !== 'undefined') module.exports = CB.race.tracksExtra;

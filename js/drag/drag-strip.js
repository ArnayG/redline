/* ==========================================================================
   Redline — js/drag/drag-strip.js
   CB.drag.strip : drag-race distances, splits, surfaces, venues and strip geometry (docs/DRAG-SPEC.md §1).
   Pure data / helpers. Loads in browsers (classic <script>) and in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.drag = CB.drag || {};

(function () {
  'use strict';
  var FT = 0.3048, MILE = 1609.344, KPH = 1 / 3.6;

  function dist(id, label, m) { return { id: id, label: label, m: m }; }
  function spd(id, label, kph) { return { id: id, label: label, v: kph * KPH, kph: kph }; }
  var S60 = dist('ft60', '60 ft', 60 * FT), S330 = dist('ft330', '330 ft', 330 * FT), S8 = dist('eighth', '1/8 mile', MILE / 8),
    S1000 = dist('ft1000', '1000 ft', 1000 * FT), S4 = dist('quarter', '1/4 mile', MILE / 4), S2 = dist('half', '1/2 mile', MILE / 2),
    SKM = dist('km', '1000 m', 1000);

  var DISTANCES = [
    { id: 'eighth', name: '1/8 mile', short: '1/8', m: MILE / 8, splits: [S60, S330, S8], traps: ['eighth'] },
    { id: 'quarter', name: '1/4 mile', short: '1/4', m: MILE / 4, splits: [S60, S330, S8, S1000, S4], traps: ['eighth', 'quarter'] },
    { id: 'half', name: '1/2 mile', short: '1/2', m: MILE / 2, splits: [S60, S330, S8, S4, S2], traps: ['eighth', 'quarter', 'half'] },
    { id: 'km', name: '1 km', short: '1 km', m: 1000, splits: [S60, S330, S8, S4, SKM], traps: ['eighth', 'quarter', 'km'] },
    { id: 'dig', name: 'Dig 0–200 km/h', short: '0–200', m: null, speed: true, toV: 200 * KPH, stripM: 1000,
      splits: [S60, spd('v100', '0–100 km/h', 100), spd('v160', '0–160 km/h', 160), spd('v200', '0–200 km/h', 200)], traps: [] },
    { id: 'roll', name: 'Roll 60–200 km/h', short: '60–200', m: null, speed: true, roll: true, fromV: 60 * KPH, toV: 200 * KPH, stripM: 1400,
      splits: [spd('v100', '60–100 km/h', 100), spd('v160', '60–160 km/h', 160), spd('v200', '60–200 km/h', 200)], traps: [] }
  ];
  var SURFACES = {
    prepped: { id: 'prepped', name: 'Prepped strip', desc: 'VHT-prepped launch pad: the most bite', grip: 1.10, wetness: 0, burnoutGain: 1.0, maxBonus: 0.08 },
    street: { id: 'street', name: 'Street', desc: 'Plain asphalt: no prep, less bite', grip: 1.0, wetness: 0, burnoutGain: 0.8, maxBonus: 0.05 },
    wet: { id: 'wet', name: 'Wet', desc: 'Damp tarmac: wheelspin city', grip: 0.62, wetness: 0.7, burnoutGain: 0.5, maxBonus: 0.03 }
  };
  var VENUES = {
    strip: { id: 'strip', name: 'Drag strip', desc: 'Two lanes, staging beams, Christmas tree, timing boards', beams: true },
    street: { id: 'street', name: 'Street', desc: 'City road, flagger start', beams: false }
  };
  var TREES = {
    pro: { id: 'pro', name: 'Pro tree', desc: 'All three ambers at once, green 0.4 s later', gap: 0.4 },
    sportsman: { id: 'sportsman', name: 'Sportsman', desc: 'Ambers count down 0.5 s apart', gap: 0.5 },
    flag: { id: 'flag', name: 'Flag start', desc: 'A flagger drops their arms', gap: 0 }
  };

  var GEO = {
    LANE_Y: 3.1, WALL_Y: 7.6, PRESTAGE_X: -0.178, STAGE_X: 0, DEEP_X: 0.10, ROLLOUT: 0.29,
    BURNOUT_X0: -30, BURNOUT_X1: -14, START_X: -22, TREE_X: 6, SHUTDOWN: 700, RETURN_Y: -24, TRAP_LEN: 66 * FT
  };

  function get(id) { for (var i = 0; i < DISTANCES.length; i++) if (DISTANCES[i].id === id) return DISTANCES[i]; return DISTANCES[1]; }
  function laneY(lane) { return lane === 1 ? -GEO.LANE_Y : GEO.LANE_Y; }
  /** Length of the strip (finish line, m from the stage beam) a renderer should build for a distance. */
  function stripLength(def) { def = typeof def === 'string' ? get(def) : def || DISTANCES[1]; return def.m || def.stripM || 1000; }
  function surface(id) { return SURFACES[id] || SURFACES.prepped; }

  CB.drag.strip = {
    FT: FT, MILE: MILE, DISTANCES: DISTANCES, SURFACES: SURFACES, VENUES: VENUES, TREES: TREES, GEO: GEO,
    LANE_Y: GEO.LANE_Y, list: function () { return DISTANCES.slice(); }, ids: function () { return DISTANCES.map(function (d) { return d.id; }); },
    get: get, laneY: laneY, stripLength: stripLength, surface: surface
  };
})();

if (typeof module !== 'undefined') module.exports = CB.drag.strip;

/* ==========================================================================
   Redline — js/arcade/stunt-maps.js
   The authored Arcade STUNT tracks (format: js/arcade/stunt-track.js). Pure data + registration.
   Every map: 45–90 s laps, guard rails everywhere except over gaps, a boost pad before every loop / gap,
   item-box rows, nitro canisters, boost rings (some floating over gaps), coins and arrow signs.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};
CB.arcade.stunt = CB.arcade.stunt || {};

(function (S) {
  'use strict';

  var MAPS = [
    /* 1 ---------------------------------------------------------------- starter loop-de-loop circuit */
    {
      id: 'loop-rush', name: 'Loop Rush', theme: 'stadium', laps: 3, width: 13, startAt: 90, difficulty: 'easy', estLap_s: 52,
      blurb: 'The starter: banked stadium bends, a boost-fed loop-the-loop, bunny-hop hills and a first little gap.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[2, 'len'], [10, 'len'], [18, 'drop']], gap: 50 },
      pieces: [
        { type: 'straight', len: 480, features: [{ type: 'box', at: 0.55, count: 4 }, { type: 'coin', at: 0.7, lat: 0, n: 5 }] },
        { type: 'turn', angle: 120, radius: 95, bank: 26, features: [{ type: 'can', at: 0.5, lat: 3.5 }, { type: 'arrow', at: 0.08, side: -1 }] },
        { type: 'straight', len: 150, features: [{ type: 'box', at: 0.35, count: 4 }, { type: 'pad', at: 0.8, lat: 0 }] },
        { type: 'loop', radius: 14, shift: 15, features: [{ type: 'coin', at: 0.42, lat: 0, n: 3, spacing: 5 }] },
        { type: 'straight', len: 70, features: [{ type: 'can', at: 0.5, lat: -3 }] },
        { type: 'turn', angle: -60, radius: 70, bank: 24, features: [{ type: 'arrow', at: 0.08, side: 1 }] },
        { type: 'straight', len: 120, features: [{ type: 'coin', at: 0.3, lat: 0, n: 5 }] },
        { type: 'turn', angle: 60, radius: 70, bank: 24, features: [{ type: 'arrow', at: 0.08, side: -1 }] },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 90, radius: 55, bank: 32, features: [{ type: 'arrow', at: 0.08, side: -1 }] },
        { type: 'straight', len: 30 },
        { type: 'hill', len: 44, height: 4.5 },
        { type: 'straight', len: 14 },
        { type: 'hill', len: 44, height: 4.5, features: [{ type: 'ring', at: 0.5, lat: 0, z: 4.0 }] },
        { type: 'straight', len: 14 },
        { type: 'hill', len: 44, height: 4.5 },
        { type: 'straight', len: 60, features: [{ type: 'box', at: 0.4, count: 4 }, { type: 'pad', at: 0.85, lat: 0 }] },
        { type: 'kicker', len: 18, angle: 12 },
        { type: 'gap', len: 24, drop: 0.5, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 24 },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 150, radius: 95, bank: 26, features: [{ type: 'can', at: 0.5, lat: 3.5 }, { type: 'arrow', at: 0.08, side: -1 }] },
        { type: 'straight', len: 120, features: [{ type: 'pad', at: 0.5, lat: -3 }, { type: 'pad', at: 0.5, lat: 3 }] }
      ]
    },

    /* 2 ---------------------------------------------------------------- canyon gap-jump run */
    {
      id: 'canyon-leap', name: 'Canyon Leap', theme: 'canyon', laps: 3, width: 12, startAt: 90, difficulty: 'normal', estLap_s: 68,
      blurb: 'Three canyon gaps, a sweeping boost drop, a mesa S-bend and a long banked climb back to the top.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[17, 'len'], [19, 'len'], [18, 'rise']], gap: 50 },
      pieces: [
        { type: 'straight', len: 330, features: [{ type: 'box', at: 0.55, count: 4 }, { type: 'pad', at: 0.9, lat: 0 }] },
        { type: 'kicker', len: 26, angle: 14 },
        { type: 'gap', len: 40, drop: 4, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 34 },
        { type: 'straight', len: 60, features: [{ type: 'coin', at: 0.3, lat: 2.5, n: 5 }] },
        { type: 'hill', len: 50, height: 4 },
        { type: 'turn', angle: 100, radius: 75, bank: 22, features: [{ type: 'can', at: 0.55, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'drop', len: 110, height: 14, features: [{ type: 'pad', at: 0.4, lat: 0 }, { type: 'pad', at: 0.75, lat: 0 }] },
        { type: 'turn', angle: -40, radius: 90, bank: 18, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'straight', len: 70, features: [{ type: 'box', at: 0.4, count: 3 }] },
        { type: 'turn', angle: 40, radius: 90, bank: 18 },
        { type: 'straight', len: 70, features: [{ type: 'pad', at: 0.85, lat: 0 }] },
        { type: 'kicker', len: 24, angle: 16 },
        { type: 'gap', len: 46, drop: 3, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 32 },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 80, radius: 65, bank: 25, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 160, features: [{ type: 'coin', at: 0.3, lat: -2, n: 5 }, { type: 'box', at: 0.6, count: 4 }] },
        { type: 'turn', angle: 90, radius: 60, bank: 30, rise: 16, features: [{ type: 'can', at: 0.5, lat: 3 }] },
        { type: 'straight', len: 120, features: [{ type: 'box', at: 0.45, count: 4 }, { type: 'pad', at: 0.9, lat: 0 }] },
        { type: 'kicker', len: 22, angle: 13 },
        { type: 'gap', len: 36, drop: 1 },
        { type: 'pitchTo', angle: 0, len: 30 },
        { type: 'turn', angle: 90, radius: 75, bank: 22, rise: 6, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 150, features: [{ type: 'can', at: 0.5, lat: 0 }] }
      ]
    },

    /* 3 ---------------------------------------------------------------- corkscrew + double loop */
    {
      id: 'corkscrew-carnival', name: 'Corkscrew Carnival', theme: 'toybox', laps: 3, width: 13, startAt: 90, difficulty: 'normal', estLap_s: 58,
      blurb: 'A giant toy room: back-to-back double loop, a full corkscrew, a hop gap and steep banked bowls.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[21, 'len'], [20, 'radius'], [16, 'drop']], gap: 50 },
      pieces: [
        { type: 'straight', len: 400, features: [{ type: 'box', at: 0.5, count: 4 }, { type: 'pad', at: 0.84, lat: -3 }, { type: 'pad', at: 0.94, lat: 3 }] },
        { type: 'loop', radius: 14, shift: 15 },
        { type: 'straight', len: 42, features: [{ type: 'pad', at: 0.5, lat: 0, len: 6 }] },
        { type: 'loop', radius: 15, shift: 15 },
        { type: 'straight', len: 80, features: [{ type: 'coin', at: 0.4, lat: 0, n: 5 }] },
        { type: 'turn', angle: 180, radius: 48, bank: 58, width: 16, features: [{ type: 'can', at: 0.5, lat: 5 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 160, features: [{ type: 'box', at: 0.4, count: 4 }, { type: 'coin', at: 0.75, lat: 2, n: 4 }] },
        { type: 'turn', angle: -45, radius: 70, bank: 22, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 45, radius: 70, bank: 22 },
        { type: 'straight', len: 60, features: [{ type: 'pad', at: 0.7, lat: 0 }] },
        { type: 'corkscrew', len: 85, radius: 7, turns: 1, dir: 1 },
        { type: 'straight', len: 60, features: [{ type: 'ring', at: 0.5, lat: 0, z: 1.2 }] },
        { type: 'hill', len: 50, height: 5 },
        { type: 'straight', len: 120, features: [{ type: 'pad', at: 0.8, lat: 0 }] },
        { type: 'kicker', len: 22, angle: 14 },
        { type: 'gap', len: 34, drop: 1, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 28 },
        { type: 'straight', len: 120, features: [{ type: 'can', at: 0.5, lat: 0 }, { type: 'coin', at: 0.75, lat: 0, n: 4 }] },
        { type: 'hill', len: 50, height: 4.5 },
        { type: 'turn', angle: 180, radius: 48, bank: 50, width: 15, features: [{ type: 'can', at: 0.5, lat: 4.5 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 200, features: [{ type: 'box', at: 0.5, count: 4 }] }
      ]
    },

    /* 4 ---------------------------------------------------------------- neon city wall-ride */
    {
      id: 'neon-wallride', name: 'Neon Wall-Ride', theme: 'neon', laps: 3, width: 13, startAt: 90, difficulty: 'hard', estLap_s: 62,
      blurb: 'Night city: ride the glowing walls, carve a half-pipe bowl and pull a loop under the skyline.',
      start: { pos: [0, 0, 0], heading: 0 },
      bankBlend: 18,
      solve: { vars: [[8, 'len'], [16, 'len']], gap: 50 },
      pieces: [
        { type: 'straight', len: 260, features: [{ type: 'box', at: 0.55, count: 4 }, { type: 'pad', at: 0.88, lat: 0 }] },
        { type: 'wall', len: 130, bank: 78, side: 1, features: [{ type: 'coin', at: 0.5, lat: 0, n: 6 }] },
        { type: 'straight', len: 60 },
        { type: 'turn', angle: 90, radius: 50, bank: 40, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 130, features: [{ type: 'box', at: 0.3, count: 4 }, { type: 'pad', at: 0.8, lat: 0 }] },
        { type: 'loop', radius: 15, shift: 15 },
        { type: 'straight', len: 70, features: [{ type: 'can', at: 0.5, lat: 0 }] },
        { type: 'turn', angle: 90, radius: 65, bank: 35, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 300, features: [{ type: 'box', at: 0.3, count: 4 }, { type: 'coin', at: 0.6, lat: -3, n: 5 }] },
        { type: 'hill', len: 80, height: 3 },
        { type: 'straight', len: 130 },
        { type: 'wall', len: 120, bank: 78, side: -1, features: [{ type: 'ring', at: 0.5, lat: 0, z: 1.2 }] },
        { type: 'straight', len: 60, features: [{ type: 'pad', at: 0.6, lat: 0 }] },
        { type: 'turn', angle: 180, radius: 38, bank: 68, width: 17, features: [{ type: 'can', at: 0.5, lat: 6 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 60 },
        { type: 'turn', angle: -90, radius: 65, bank: 30, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'straight', len: 150, features: [{ type: 'box', at: 0.5, count: 4 }, { type: 'pad', at: 0.85, lat: 0 }] },
        { type: 'turn', angle: 90, radius: 65, bank: 30, features: [{ type: 'can', at: 0.5, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 150, features: [{ type: 'pad', at: 0.5, lat: 0 }] }
      ]
    },

    /* 5 ---------------------------------------------------------------- mega-ramp drop with boost chains */
    {
      id: 'mega-drop', name: 'Mega Drop', theme: 'volcano', laps: 3, tagline: 'Spiral climb · mega drop · monster jump', timeOfDay: 'dusk', width: 13, startAt: 90, difficulty: 'normal', estLap_s: 68,
      blurb: 'Spiral up the volcano, plunge down the mega ramp on a boost chain and launch the monster jump.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[15, 'radius'], [16, 'len'], [6, 'height']], gap: 50 },
      pieces: [
        { type: 'straight', len: 380, features: [{ type: 'box', at: 0.55, count: 4 }, { type: 'coin', at: 0.75, lat: 0, n: 5 }] },
        { type: 'turn', angle: 180, radius: 80, bank: 26, features: [{ type: 'can', at: 0.5, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 110 },
        { type: 'turn', angle: 360, radius: 58, bank: 22, rise: 22, features: [{ type: 'can', at: 0.3, lat: 3 }, { type: 'coin', at: 0.6, lat: 3, n: 5 }] },
        { type: 'turn', angle: 360, radius: 58, bank: 22, rise: 22, features: [{ type: 'box', at: 0.5, count: 4 }] },
        { type: 'straight', len: 60, features: [{ type: 'pad', at: 0.7, lat: 0 }] },
        { type: 'drop', len: 170, height: 44, features: [{ type: 'pad', at: 0.25, lat: 0 }, { type: 'pad', at: 0.45, lat: 0 }, { type: 'pad', at: 0.65, lat: 0 }, { type: 'pad', at: 0.85, lat: 0 }] },
        { type: 'straight', len: 90, features: [{ type: 'coin', at: 0.4, lat: 0, n: 5 }] },
        { type: 'kicker', len: 28, angle: 17 },
        { type: 'gap', len: 64, drop: 2, features: [{ type: 'ring', at: 0.35, lat: 0, z: 0.5 }, { type: 'ring', at: 0.7, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 36 },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 50, radius: 80, bank: 20, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'hill', len: 48, height: 4.5 },
        { type: 'turn', angle: -50, radius: 80, bank: 20 },
        { type: 'turn', angle: 180, radius: 80, bank: 26, features: [{ type: 'can', at: 0.5, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 250, features: [{ type: 'box', at: 0.4, count: 4 }, { type: 'pad', at: 0.7, lat: 0 }] }
      ]
    },

    /* 6 ---------------------------------------------------------------- figure-8 with a crossover jump */
    {
      id: 'figure-8', name: 'Crossover 8', theme: 'stadium', laps: 3, tagline: 'Crossover jump · twin banked rings', width: 13, startAt: 60, difficulty: 'easy', estLap_s: 55,
      blurb: 'A giant figure-8: jump clean over the crossing traffic, then carve the twin banked rings.',
      timeOfDay: 'dusk',
      start: { pos: [0, 0, 0], heading: Math.PI / 4 },
      solve: { vars: [[12, 'len'], [18, 'len'], [11, 'height']], gap: 50 },
      pieces: [
        { type: 'straight', len: 190, features: [{ type: 'box', at: 0.75, count: 4 }] },
        { type: 'turn', angle: -100, radius: 240, bank: 28, features: [{ type: 'can', at: 0.5, lat: -3 }, { type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'hill', len: 70, height: 4, features: [{ type: 'coin', at: 0.5, lat: 0, n: 4 }] },
        { type: 'turn', angle: -70, radius: 95, bank: 40 },
        { type: 'straight', len: 40, features: [{ type: 'pad', at: 0.5, lat: 0 }] },
        { type: 'turn', angle: -100, radius: 240, bank: 28, features: [{ type: 'box', at: 0.5, count: 4 }] },
        { type: 'straight', len: 60 },
        { type: 'climb', len: 70, height: 6, features: [{ type: 'pad', at: 0.6, lat: 0 }] },
        { type: 'kicker', len: 22, angle: 16 },
        { type: 'gap', len: 56, drop: 0, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 30 },
        { type: 'drop', len: 50, height: 6 },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 100, radius: 240, bank: 28, features: [{ type: 'can', at: 0.5, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'hill', len: 70, height: 4, features: [{ type: 'coin', at: 0.5, lat: 0, n: 4 }] },
        { type: 'turn', angle: 70, radius: 95, bank: 40 },
        { type: 'straight', len: 40, features: [{ type: 'pad', at: 0.5, lat: 0 }] },
        { type: 'turn', angle: 100, radius: 240, bank: 28, features: [{ type: 'box', at: 0.5, count: 4 }] },
        { type: 'straight', len: 100, features: [{ type: 'pad', at: 0.5, lat: 0 }] }
      ]
    }
  ];

  S.MAPS = MAPS;
  if (typeof S.register === 'function') MAPS.forEach(function (m) { S.register(m); });
  else { S._pending = (S._pending || []).concat(MAPS); }

  if (typeof module !== 'undefined' && module.exports) module.exports = MAPS;
})(CB.arcade.stunt);

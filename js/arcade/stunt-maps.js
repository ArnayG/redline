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
        { type: 'straight', len: 480, features: [{ type: 'box', at: 0.55, count: 4 }, { type: 'coin', at: 0.7, lat: 0, n: 5 }, { type: 'star', at: 0.85, lat: 5 }] },
        { type: 'turn', angle: 120, radius: 95, bank: 26, features: [{ type: 'can', at: 0.5, lat: 3.5 }, { type: 'arrow', at: 0.08, side: -1 }] },
        { type: 'straight', len: 150, features: [{ type: 'box', at: 0.35, count: 4 }, { type: 'pad', at: 0.8, lat: 0 }] },
        { type: 'loop', radius: 14, shift: 15, features: [{ type: 'coin', at: 0.42, lat: 0, n: 3, spacing: 5 }, { type: 'star', at: 0.5, lat: 0, z: 1.2 }] },
        { type: 'straight', len: 70, features: [{ type: 'can', at: 0.5, lat: -3 }] },
        { type: 'turn', angle: -60, radius: 70, bank: 24, features: [{ type: 'arrow', at: 0.08, side: 1 }] },
        { type: 'straight', len: 120, features: [{ type: 'coin', at: 0.3, lat: 0, n: 5 }, { type: 'belt', at: 0.55, len: 36 }] },
        { type: 'turn', angle: 60, radius: 70, bank: 24, features: [{ type: 'arrow', at: 0.08, side: -1 }] },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 90, radius: 55, bank: 32, features: [{ type: 'arrow', at: 0.08, side: -1 }] },
        { type: 'straight', len: 30 },
        { type: 'hill', len: 44, height: 4.5 },
        { type: 'straight', len: 14 },
        { type: 'hill', len: 44, height: 4.5, features: [{ type: 'ring', fire: true, at: 0.5, lat: 0, z: 4.0 }] },
        { type: 'straight', len: 14 },
        { type: 'hill', len: 44, height: 4.5 },
        { type: 'straight', len: 60, features: [{ type: 'box', at: 0.4, count: 4 }, { type: 'pad', at: 0.85, lat: 0 }] },
        { type: 'kicker', len: 18, angle: 12 },
        { type: 'gap', len: 24, drop: 0.5, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 24 },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 150, radius: 95, bank: 26, features: [{ type: 'can', at: 0.5, lat: 3.5 }, { type: 'arrow', at: 0.08, side: -1 }] },
        { type: 'straight', len: 120, features: [{ type: 'pad', at: 0.5, lat: -3 }, { type: 'pad', at: 0.5, lat: 3 }, { type: 'star', at: 0.8, lat: -5 }] }
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
        { type: 'gap', len: 40, drop: 4, features: [{ type: 'ring', fire: true, at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 34 },
        { type: 'straight', len: 60, features: [{ type: 'coin', at: 0.3, lat: 2.5, n: 5 }, { type: 'star', at: 0.8, lat: -4.5 }] },
        { type: 'hill', len: 50, height: 4 },
        { type: 'turn', angle: 100, radius: 75, bank: 22, features: [{ type: 'can', at: 0.55, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'drop', len: 110, height: 14, features: [{ type: 'pad', at: 0.4, lat: 0 }, { type: 'pad', at: 0.75, lat: 0 }] },
        { type: 'turn', angle: -40, radius: 90, bank: 18, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'straight', len: 70, features: [{ type: 'box', at: 0.6, count: 3 }, { type: 'hazard', kind: 'boulder', at: 0.25, side: 1, period: 4.4 }] },
        { type: 'turn', angle: 40, radius: 90, bank: 18 },
        { type: 'straight', len: 70, features: [{ type: 'pad', at: 0.85, lat: 0 }] },
        { type: 'kicker', len: 24, angle: 16 },
        { type: 'gap', len: 46, drop: 3, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }, { type: 'star', at: 0.5, lat: 3.5, z: 1.5 }] },
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
        { type: 'straight', len: 150, features: [{ type: 'can', at: 0.5, lat: 0 }, { type: 'star', at: 0.8, lat: 4.5 }] }
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
        { type: 'loop', radius: 15, shift: 15, features: [{ type: 'star', at: 0.5, lat: 0, z: 1.2 }] },
        { type: 'straight', len: 80, features: [{ type: 'coin', at: 0.4, lat: 0, n: 5 }] },
        { type: 'turn', angle: 180, radius: 48, bank: 58, width: 16, features: [{ type: 'can', at: 0.5, lat: 5 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 160, features: [{ type: 'box', at: 0.3, count: 4 }, { type: 'hazard', kind: 'pendulum', at: 0.6, period: 3.0 }, { type: 'coin', at: 0.8, lat: 2, n: 4 }] },
        { type: 'turn', angle: -45, radius: 70, bank: 22, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 45, radius: 70, bank: 22 },
        { type: 'straight', len: 60, features: [{ type: 'pad', at: 0.7, lat: 0 }] },
        { type: 'corkscrew', len: 85, radius: 7, turns: 1, dir: 1, features: [{ type: 'star', at: 0.5, lat: 3.5, z: 1.2 }] },
        { type: 'straight', len: 60, features: [{ type: 'ring', fire: true, at: 0.5, lat: 0, z: 1.2 }] },
        { type: 'hill', len: 50, height: 5 },
        { type: 'straight', len: 120, features: [{ type: 'pad', at: 0.8, lat: 0 }] },
        { type: 'kicker', len: 22, angle: 14 },
        { type: 'gap', len: 34, drop: 1, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 28 },
        { type: 'straight', len: 120, features: [{ type: 'can', at: 0.5, lat: 0 }, { type: 'coin', at: 0.75, lat: 0, n: 4 }] },
        { type: 'hill', len: 50, height: 4.5 },
        { type: 'turn', angle: 180, radius: 48, bank: 50, width: 15, features: [{ type: 'can', at: 0.5, lat: 4.5 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 200, features: [{ type: 'box', at: 0.5, count: 4 }, { type: 'star', at: 0.8, lat: -5 }] }
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
        { type: 'wall', len: 130, bank: 78, side: 1, features: [{ type: 'coin', at: 0.5, lat: 0, n: 6 }, { type: 'star', at: 0.7, lat: 4.5, z: 1.2 }] },
        { type: 'straight', len: 60 },
        { type: 'turn', angle: 90, radius: 50, bank: 40, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 130, features: [{ type: 'box', at: 0.3, count: 4 }, { type: 'pad', at: 0.8, lat: 0 }] },
        { type: 'loop', radius: 15, shift: 15 },
        { type: 'straight', len: 70, features: [{ type: 'can', at: 0.5, lat: 0 }] },
        { type: 'turn', angle: 90, radius: 65, bank: 35, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 300, features: [{ type: 'box', at: 0.2, count: 4 }, { type: 'tunnel', at: 0.35, len: 110 }, { type: 'coin', at: 0.5, lat: -3, n: 5 }, { type: 'star', at: 0.85, lat: 5 }] },
        { type: 'hill', len: 80, height: 3 },
        { type: 'straight', len: 130 },
        { type: 'wall', len: 120, bank: 78, side: -1, features: [{ type: 'ring', at: 0.5, lat: 0, z: 1.2 }] },
        { type: 'straight', len: 60, features: [{ type: 'pad', at: 0.6, lat: 0 }] },
        { type: 'turn', angle: 180, radius: 38, bank: 68, width: 17, features: [{ type: 'can', at: 0.5, lat: 6 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 60 },
        { type: 'turn', angle: -90, radius: 65, bank: 30, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'straight', len: 150, features: [{ type: 'hazard', kind: 'piston', at: 0.25, side: 1, period: 2.4 }, { type: 'hazard', kind: 'piston', at: 0.25, side: -1, period: 2.4, phase: 0.5 }, { type: 'box', at: 0.6, count: 4 }, { type: 'pad', at: 0.85, lat: 0 }] },
        { type: 'turn', angle: 90, radius: 65, bank: 30, features: [{ type: 'can', at: 0.5, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }, { type: 'star', at: 0.7, lat: 5 }] },
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
        { type: 'turn', angle: 360, radius: 58, bank: 22, rise: 22, features: [{ type: 'box', at: 0.5, count: 4 }, { type: 'star', at: 0.8, lat: 5 }] },
        { type: 'straight', len: 60, features: [{ type: 'pad', at: 0.7, lat: 0 }] },
        { type: 'drop', len: 170, height: 44, features: [{ type: 'pad', at: 0.25, lat: 0 }, { type: 'pad', at: 0.45, lat: 0 }, { type: 'pad', at: 0.65, lat: 0 }, { type: 'pad', at: 0.85, lat: 0 }] },
        { type: 'straight', len: 90, features: [{ type: 'coin', at: 0.4, lat: 0, n: 5 }] },
        { type: 'kicker', len: 28, angle: 17 },
        { type: 'gap', len: 64, drop: 2, features: [{ type: 'ring', fire: true, at: 0.35, lat: 0, z: 0.5 }, { type: 'ring', fire: true, at: 0.7, lat: 0, z: 0.5 }, { type: 'star', at: 0.52, lat: -3.5, z: 1.5 }] },
        { type: 'pitchTo', angle: 0, len: 36 },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 50, radius: 80, bank: 20, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'hill', len: 48, height: 4.5 },
        { type: 'turn', angle: -50, radius: 80, bank: 20 },
        { type: 'turn', angle: 180, radius: 80, bank: 26, features: [{ type: 'can', at: 0.5, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 250, features: [{ type: 'hazard', kind: 'boulder', at: 0.25, side: 1, period: 4.0 }, { type: 'box', at: 0.5, count: 4 }, { type: 'pad', at: 0.75, lat: 0 }, { type: 'star', at: 0.9, lat: -5 }] }
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
        { type: 'gap', len: 56, drop: 0, features: [{ type: 'ring', fire: true, at: 0.5, lat: 0, z: 0.5 }, { type: 'star', at: 0.5, lat: 3.5, z: 1.5 }] },
        { type: 'pitchTo', angle: 0, len: 30 },
        { type: 'drop', len: 50, height: 6 },
        { type: 'straight', len: 40 },
        { type: 'turn', angle: 100, radius: 240, bank: 28, features: [{ type: 'can', at: 0.5, lat: 3 }, { type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'hill', len: 70, height: 4, features: [{ type: 'coin', at: 0.5, lat: 0, n: 4 }, { type: 'star', at: 0.5, lat: 4.5, z: 1.5 }] },
        { type: 'turn', angle: 70, radius: 95, bank: 40 },
        { type: 'straight', len: 40, features: [{ type: 'pad', at: 0.5, lat: 0 }, { type: 'hazard', kind: 'windmill', at: 0.9, period: 4.2 }] },
        { type: 'turn', angle: 100, radius: 240, bank: 28, features: [{ type: 'box', at: 0.5, count: 4 }] },
        { type: 'straight', len: 100, features: [{ type: 'pad', at: 0.5, lat: 0 }, { type: 'star', at: 0.8, lat: 4.5 }] }
      ]
    },

    /* 7 ---------------------------------------------------------------- sci-fi lab: barrel-roll tubes + zero-g */
    {
      id: 'tube-twister', name: 'Tube Twister', theme: 'lab', laps: 3, width: 13, startAt: 90, difficulty: 'normal', estLap_s: 48,
      tagline: 'Barrel rolls · double roll · zero-g · boost tunnel',
      blurb: 'A neon test lab: corkscrew through glass tubes, a double barrel roll, an upside-down zero-g ceiling run and a booster tunnel.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[12, 'len'], [13, 'radius']], gap: 50 },
      pieces: [
        { type: 'straight', len: 510, features: [{ type: 'box', at: 0.45, count: 4 }, { type: 'coin', at: 0.62, lat: 0, n: 5 }, { type: 'pad', at: 0.93, lat: 0 }] },
        { type: 'tube', len: 90, radius: 7, turns: 1, features: [{ type: 'star', at: 0.5, lat: 3.5, z: 1.2 }] },
        { type: 'straight', len: 70, features: [{ type: 'can', at: 0.5, lat: -3 }] },
        { type: 'turn', angle: 180, radius: 70, bank: 30, features: [{ type: 'arrow', at: 0.04, side: -1 }, { type: 'coin', at: 0.5, lat: 3, n: 4 }, { type: 'can', at: 0.7, lat: 3.5 }] },
        { type: 'straight', len: 130, features: [{ type: 'tunnel', at: 0.04, len: 112 }, { type: 'ring', fire: true, at: 0.95, lat: 0, z: 0.5 }] },
        { type: 'zerog', radius: 14, len: 60, features: [{ type: 'coin', at: 0.5, lat: 0, n: 4, spacing: 5 }] },
        { type: 'straight', len: 90, features: [{ type: 'box', at: 0.45, count: 4 }] },
        { type: 'turn', angle: -90, radius: 50, bank: 30, features: [{ type: 'arrow', at: 0.06, side: 1 }, { type: 'can', at: 0.5, lat: -3 }] },
        { type: 'turn', angle: 90, radius: 50, bank: 30, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 160, features: [{ type: 'box', at: 0.3, count: 4 }, { type: 'pad', at: 0.65, lat: -3 }, { type: 'pad', at: 0.88, lat: 3 }] },
        { type: 'tube', len: 140, radius: 7.5, turns: 2, features: [{ type: 'coin', at: 0.5, lat: 0, n: 5, spacing: 6 }] },
        { type: 'straight', len: 90, features: [{ type: 'ring', fire: true, at: 0.5, lat: 0, z: 0.5 }, { type: 'star', at: 0.8, lat: -4.5 }] },
        { type: 'straight', len: 80, features: [{ type: 'box', at: 0.5, count: 4 }] },
        { type: 'turn', angle: 180, radius: 120, bank: 26, features: [{ type: 'arrow', at: 0.04, side: -1 }, { type: 'coin', at: 0.35, lat: 3, n: 4 }, { type: 'star', at: 0.6, lat: 5 }, { type: 'can', at: 0.8, lat: 3.5 }] },
        { type: 'straight', len: 60, features: [{ type: 'pad', at: 0.5, lat: 0 }] }
      ]
    },

    /* 8 ---------------------------------------------------------------- lava world: two cannons, fire hoops, boulders */
    {
      id: 'volcano-cannon', name: 'Volcano Cannon Run', theme: 'volcano', laps: 3, width: 13, startAt: 90, difficulty: 'normal', estLap_s: 48,
      tagline: 'Two cannons · rings of fire · rolling boulders', timeOfDay: 'dusk',
      blurb: 'Get fired out of a cannon over the lava lake, dodge the rolling boulders, burn through rings of fire and get shot out again.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[13, 'len'], [15, 'radius'], [14, 'height']], gap: 50 },
      pieces: [
        { type: 'straight', len: 400, features: [{ type: 'box', at: 0.4, count: 4 }, { type: 'coin', at: 0.6, lat: 0, n: 5 }, { type: 'ring', fire: true, at: 0.78, lat: 0, z: 0.5 }] },
        { type: 'cannon', angle: 26, ramp: 24, len: 120, drop: 6, features: [{ type: 'ring', fire: true, at: 0.55, lat: 0, z: 0.5 }, { type: 'star', at: 0.82, lat: 0, z: 1.0 }] },
        { type: 'pitchTo', angle: 0, len: 45 },
        { type: 'straight', len: 60, features: [{ type: 'coin', at: 0.4, lat: 2.5, n: 4 }] },
        { type: 'drop', len: 110, height: 16, features: [{ type: 'pad', at: 0.35, lat: 0 }, { type: 'pad', at: 0.7, lat: 0 }] },
        { type: 'turn', angle: 180, radius: 75, bank: 28, features: [{ type: 'arrow', at: 0.04, side: -1 }, { type: 'can', at: 0.5, lat: 3.5 }] },
        { type: 'straight', len: 150, features: [{ type: 'hazard', kind: 'boulder', at: 0.4, side: 1, period: 4.2 }, { type: 'box', at: 0.75, count: 4 }] },
        { type: 'turn', angle: -60, radius: 80, bank: 22, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'turn', angle: 60, radius: 80, bank: 22, features: [{ type: 'arrow', at: 0.06, side: -1 }, { type: 'coin', at: 0.5, lat: 3, n: 4 }] },
        { type: 'straight', len: 130, features: [{ type: 'ring', fire: true, at: 0.3, lat: 0, z: 0.5 }, { type: 'box', at: 0.6, count: 4 }, { type: 'pad', at: 0.92, lat: 0 }] },
        { type: 'cannon', angle: 30, ramp: 26, len: 140, drop: 4, features: [{ type: 'ring', fire: true, at: 0.6, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 45 },
        { type: 'straight', len: 60, features: [{ type: 'can', at: 0.5, lat: 0 }] },
        { type: 'straight', len: 130, features: [{ type: 'hazard', kind: 'boulder', at: 0.45, side: -1, period: 3.8, phase: 0.4 }, { type: 'star', at: 0.8, lat: 4.5 }] },
        { type: 'climb', len: 130, height: 30, features: [{ type: 'box', at: 0.5, count: 4 }, { type: 'star', at: 0.85, lat: -4.5 }] },
        { type: 'turn', angle: 180, radius: 110, bank: 26, features: [{ type: 'arrow', at: 0.04, side: -1 }, { type: 'can', at: 0.5, lat: 3 }, { type: 'coin', at: 0.3, lat: 3, n: 4 }] },
        { type: 'straight', len: 160, features: [{ type: 'pad', at: 0.5, lat: 0 }] }
      ]
    },

    /* 9 ---------------------------------------------------------------- pinball table: bumpers, flippers, pistons */
    {
      id: 'pinball-wizard', name: 'Pinball Wizard', theme: 'pinball', laps: 3, width: 14, widthBlend: 22, startAt: 90, difficulty: 'hard', estLap_s: 48,
      tagline: 'Bumpers · flippers · pistons · ramp loop', timeOfDay: 'night',
      blurb: 'Race across a neon pinball table: ping off the bumpers, get kicked by the flippers, dodge the pistons and take the shortcut lane.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[8, 'len'], [9, 'radius']], gap: 50 },
      pieces: [
        { type: 'straight', len: 680, features: [{ type: 'box', at: 0.3, count: 4 }, { type: 'bumper', at: 0.55, lat: -3.5 }, { type: 'bumper', at: 0.6, lat: 3.5 }, { type: 'bumper', at: 0.65, lat: 0 }, { type: 'star', at: 0.6, lat: -6.2, z: 1.1 }, { type: 'coin', at: 0.82, lat: 0, n: 4 }] },
        { type: 'turn', angle: 180, radius: 50, bank: 40, width: 16, features: [{ type: 'arrow', at: 0.04, side: -1 }, { type: 'can', at: 0.5, lat: 4.5 }] },
        { type: 'straight', len: 300, features: [{ type: 'flipper', at: 0.2, side: 1 }, { type: 'flipper', at: 0.2, side: -1, phase: 0.5 }, { type: 'belt', at: 0.45, len: 36 }, { type: 'box', at: 0.75, count: 4 }, { type: 'star', at: 0.55, lat: 5.5 }] },
        { type: 'turn', angle: -90, radius: 45, bank: 30, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'straight', len: 70, features: [{ type: 'hazard', kind: 'piston', at: 0.3, side: 1, period: 2.4 }, { type: 'hazard', kind: 'piston', at: 0.7, side: -1, period: 2.4, phase: 0.5 }] },
        { type: 'turn', angle: 90, radius: 45, bank: 30, features: [{ type: 'arrow', at: 0.06, side: -1 }, { type: 'coin', at: 0.5, lat: 0, n: 4 }] },
        { type: 'straight', len: 80, features: [{ type: 'pad', at: 0.8, lat: 0 }] },
        { type: 'loop', radius: 14, shift: 16, features: [{ type: 'coin', at: 0.42, lat: 0, n: 3, spacing: 5 }] },
        { type: 'straight', len: 200, features: [{ type: 'can', at: 0.2, lat: 0 }, { type: 'belt', at: 0.5, len: 40 }, { type: 'box', at: 0.8, count: 4 }] },
        { type: 'turn', angle: 180, radius: 130, bank: 26, width: 26, features: [{ type: 'arrow', at: 0.02, side: -1 }, { type: 'split', at: 0.06, len: 230, div: 3, inner: 1 },
          { type: 'bumper', at: 0.3, lat: 8 }, { type: 'bumper', at: 0.45, lat: 6 }, { type: 'bumper', at: 0.6, lat: 9 }, { type: 'star', at: 0.52, lat: 8 }, { type: 'pad', at: 0.4, lat: -7 }] },
        { type: 'straight', len: 160, features: [{ type: 'box', at: 0.45, count: 4 }, { type: 'pad', at: 0.85, lat: 0 }] }
      ]
    },

    /* 10 --------------------------------------------------------------- floating islands linked by warp portals */
    {
      id: 'sky-highway', name: 'Sky Highway', theme: 'sky', laps: 3, width: 13, startAt: 90, difficulty: 'normal', estLap_s: 50,
      tagline: 'Warp portals · giant ski jump · mega loop',
      blurb: 'Island-hop above the clouds: warp between floating islands, launch the giant ski jump and pull the mega loop.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[22, 'len'], [19, 'len'], [20, 'height']], gap: 50 },
      pieces: [
        { type: 'straight', len: 500, features: [{ type: 'box', at: 0.45, count: 4 }, { type: 'coin', at: 0.65, lat: 0, n: 5 }] },
        { type: 'turn', angle: 90, radius: 70, bank: 25, features: [{ type: 'arrow', at: 0.06, side: -1 }, { type: 'can', at: 0.5, lat: 3 }] },
        { type: 'straight', len: 80, features: [{ type: 'star', at: 0.4, lat: -4.5 }] },
        { type: 'warp', by: [0, 45, -320] },
        { type: 'straight', len: 200, features: [{ type: 'box', at: 0.5, count: 4 }, { type: 'coin', at: 0.75, lat: -3, n: 4 }] },
        { type: 'turn', angle: 90, radius: 65, bank: 26, features: [{ type: 'arrow', at: 0.06, side: -1 }, { type: 'coin', at: 0.5, lat: 3, n: 4 }] },
        { type: 'straight', len: 180, features: [{ type: 'box', at: 0.3, count: 4 }, { type: 'pad', at: 0.65, lat: 0 }, { type: 'pad', at: 0.88, lat: 0 }] },
        { type: 'loop', radius: 22, shift: 16, features: [{ type: 'star', at: 0.5, lat: 0, z: 1.2 }] },
        { type: 'straight', len: 70, features: [{ type: 'can', at: 0.5, lat: 0 }] },
        { type: 'drop', len: 110, height: 16, features: [{ type: 'pad', at: 0.4, lat: 0 }, { type: 'pad', at: 0.75, lat: 0 }] },
        { type: 'kicker', len: 24, angle: 12 },
        { type: 'gap', len: 112, drop: 26, features: [{ type: 'ring', at: 0.3, lat: 0, z: 0.5 }, { type: 'ring', fire: true, at: 0.62, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 60 },
        { type: 'straight', len: 140, features: [{ type: 'coin', at: 0.5, lat: 0, n: 5 }] },
        { type: 'turn', angle: -50, radius: 90, bank: 22, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'turn', angle: 50, radius: 90, bank: 22, features: [{ type: 'arrow', at: 0.06, side: -1 }, { type: 'ring', fire: true, at: 0.6, lat: 0, z: 0.5 }] },
        { type: 'turn', angle: 90, radius: 70, bank: 25, features: [{ type: 'arrow', at: 0.06, side: -1 }, { type: 'can', at: 0.5, lat: 3 }] },
        { type: 'straight', len: 160, features: [{ type: 'box', at: 0.4, count: 4 }, { type: 'star', at: 0.7, lat: 4.5 }] },
        { type: 'warp', by: [0, -10, 320] },
        { type: 'straight', len: 90, features: [{ type: 'ring', fire: true, at: 0.6, lat: 0, z: 0.5 }] },
        { type: 'climb', len: 100, height: -8 },
        { type: 'turn', angle: 90, radius: 70, bank: 25, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 160, features: [{ type: 'pad', at: 0.5, lat: 0 }] }
      ]
    },

    /* 11 --------------------------------------------------------------- giant bedroom: Hot-Wheels track over furniture */
    {
      id: 'toybox-bedroom', name: 'Toy Box Bedroom', theme: 'bedroom', laps: 3, width: 13, widthBlend: 22, startAt: 90, difficulty: 'easy', estLap_s: 48,
      tagline: 'Wrecking balls · pinwheel · hop pads · shortcut',
      blurb: 'Orange plastic track across a giant kid’s bedroom: swinging wrecking balls, a spinning pinwheel, hop pads and a sneaky shortcut lane.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[7, 'len'], [8, 'radius']], gap: 50 },
      pieces: [
        { type: 'straight', len: 520, features: [{ type: 'box', at: 0.4, count: 4 }, { type: 'coin', at: 0.58, lat: 0, n: 5 }, { type: 'hazard', kind: 'pendulum', at: 0.82, period: 3.2 }] },
        { type: 'turn', angle: 90, radius: 70, bank: 28, features: [{ type: 'arrow', at: 0.06, side: -1 }, { type: 'can', at: 0.5, lat: 3.5 }] },
        { type: 'straight', len: 250, features: [{ type: 'spring', at: 0.2, lat: 0, w: 13 }, { type: 'star', at: 0.285, lat: 0, z: 2.6 }, { type: 'coin', at: 0.55, lat: 3, n: 4 }, { type: 'box', at: 0.8, count: 4 }] },
        { type: 'turn', angle: 90, radius: 60, bank: 26, features: [{ type: 'arrow', at: 0.06, side: -1 }] },
        { type: 'straight', len: 230, features: [{ type: 'hazard', kind: 'windmill', at: 0.14, period: 4.0 }, { type: 'coin', at: 0.55, lat: -3, n: 4 }, { type: 'pad', at: 0.92, lat: 0 }] },
        { type: 'loop', radius: 15, shift: 15, features: [{ type: 'coin', at: 0.42, lat: 0, n: 3, spacing: 5 }, { type: 'star', at: 0.5, lat: 0, z: 1.2 }] },
        { type: 'straight', len: 80, features: [{ type: 'can', at: 0.5, lat: 0 }] },
        { type: 'straight', len: 300, features: [{ type: 'box', at: 0.3, count: 4 }, { type: 'spring', at: 0.6, lat: -3.5, w: 5 }, { type: 'pad', at: 0.6, lat: 3.5 }, { type: 'hazard', kind: 'pendulum', at: 0.85, period: 2.8, phase: 0.3 }] },
        { type: 'turn', angle: 180, radius: 150, bank: 26, width: 26, features: [{ type: 'arrow', at: 0.02, side: -1 }, { type: 'split', at: 0.06, len: 240, div: 3, inner: 1 },
          { type: 'hazard', kind: 'pendulum', at: 0.35, lat: 8, amp: 3, period: 2.6 }, { type: 'star', at: 0.5, lat: 8 }, { type: 'hazard', kind: 'windmill', at: 0.62, lat: 8, r: 4.5, period: 3.4 }, { type: 'coin', at: 0.3, lat: -7, n: 4 }] },
        { type: 'straight', len: 160, features: [{ type: 'pad', at: 0.5, lat: 0 }] }
      ]
    },

    /* 12 --------------------------------------------------------------- glacier: half-pipe slaloms + ski jump */
    {
      id: 'glacier-halfpipe', name: 'Glacier Halfpipe', theme: 'glacier', laps: 3, width: 14, startAt: 90, difficulty: 'normal', estLap_s: 47,
      tagline: 'Half-pipe slaloms · ski jump · ice tube · drift zone',
      blurb: 'Carve the ice half-pipes wall to wall, power-slide the drift zone, fly the glacier ski jump and spin through the ice tube.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[12, 'len'], [16, 'radius'], [15, 'height']], gap: 50 },
      pieces: [
        { type: 'straight', len: 300, features: [{ type: 'box', at: 0.45, count: 4 }, { type: 'coin', at: 0.65, lat: 0, n: 5 }] },
        { type: 'halfpipe', len: 200, bank: 55, waves: 1.5, width: 20, features: [{ type: 'coin', at: 0.33, lat: 4, n: 4 }, { type: 'star', at: 0.5, lat: 7 }, { type: 'coin', at: 0.66, lat: -4, n: 4 }] },
        { type: 'straight', len: 60, features: [{ type: 'can', at: 0.5, lat: 0 }] },
        { type: 'halfpipe', len: 170, bank: 50, waves: 1, width: 20, dir: -1, features: [{ type: 'box', at: 0.5, count: 4 }, { type: 'star', at: 0.25, lat: -7 }] },
        { type: 'turn', angle: 180, radius: 80, bank: 25, features: [{ type: 'arrow', at: 0.04, side: -1 }, { type: 'driftZone', at: 0.02, len: 230 }, { type: 'can', at: 0.6, lat: 3 }] },
        { type: 'straight', len: 100, features: [{ type: 'box', at: 0.4, count: 4 }] },
        { type: 'drop', len: 100, height: 14, features: [{ type: 'pad', at: 0.4, lat: 0 }, { type: 'pad', at: 0.75, lat: 0 }] },
        { type: 'kicker', len: 22, angle: 13 },
        { type: 'gap', len: 72, drop: 12, features: [{ type: 'ring', at: 0.5, lat: 0, z: 0.5 }] },
        { type: 'pitchTo', angle: 0, len: 45 },
        { type: 'straight', len: 90, features: [{ type: 'coin', at: 0.4, lat: 0, n: 5 }, { type: 'pad', at: 0.9, lat: 0 }] },
        { type: 'tube', len: 90, radius: 7, turns: 1, features: [{ type: 'star', at: 0.5, lat: -3.5, z: 1.2 }] },
        { type: 'straight', len: 70, features: [{ type: 'can', at: 0.5, lat: 0 }] },
        { type: 'turn', angle: -60, radius: 70, bank: 26, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'turn', angle: 60, radius: 70, bank: 26, features: [{ type: 'arrow', at: 0.06, side: -1 }, { type: 'coin', at: 0.5, lat: 3, n: 4 }] },
        { type: 'climb', len: 140, height: 26, features: [{ type: 'box', at: 0.5, count: 4 }] },
        { type: 'turn', angle: 180, radius: 110, bank: 26, features: [{ type: 'arrow', at: 0.04, side: -1 }, { type: 'can', at: 0.5, lat: 3 }] },
        { type: 'straight', len: 160, features: [{ type: 'pad', at: 0.5, lat: 0 }] }
      ]
    },

    /* 13 --------------------------------------------------------------- rooftops: split shortcuts, crushers, cannon */
    {
      id: 'megacity-rooftops', name: 'Megacity Rooftops', theme: 'rooftops', laps: 3, width: 14, widthBlend: 22, startAt: 90, difficulty: 'hard', estLap_s: 56,
      tagline: 'Risky shortcuts · crushers · rooftop cannon', timeOfDay: 'dusk',
      blurb: 'Race across the skyline: every bend splits into a safe main line and a risky shortcut past hammers and crushers, then get fired roof to roof.',
      start: { pos: [0, 0, 0], heading: 0 },
      solve: { vars: [[15, 'len'], [16, 'radius'], [14, 'height']], gap: 50 },
      pieces: [
        { type: 'straight', len: 240, features: [{ type: 'box', at: 0.4, count: 4 }, { type: 'coin', at: 0.6, lat: 0, n: 5 }, { type: 'pad', at: 0.9, lat: 0 }] },
        { type: 'turn', angle: 90, radius: 60, bank: 24, width: 26, features: [{ type: 'arrow', at: 0.02, side: -1 }, { type: 'split', at: 0.06, len: 115, div: 3, inner: 1 },
          { type: 'hazard', kind: 'hammer', at: 0.5, lat: 8, w: 3.2, period: 2.4 }, { type: 'star', at: 0.8, lat: 8 }] },
        { type: 'straight', len: 110, features: [{ type: 'hazard', kind: 'piston', at: 0.5, side: 1, period: 2.2 }, { type: 'hazard', kind: 'piston', at: 0.5, side: -1, period: 2.2, phase: 0.5 }, { type: 'coin', at: 0.8, lat: 0, n: 3 }] },
        { type: 'turn', angle: -90, radius: 60, bank: 24, width: 26, features: [{ type: 'arrow', at: 0.02, side: 1 }, { type: 'split', at: 0.06, len: 115, div: -3, inner: -1 },
          { type: 'hazard', kind: 'pendulum', at: 0.45, lat: -8, amp: 3, period: 2.6 }, { type: 'coin', at: 0.4, lat: 7, n: 4 }] },
        { type: 'straight', len: 160, features: [{ type: 'box', at: 0.45, count: 4 }, { type: 'pad', at: 0.92, lat: 0 }] },
        { type: 'cannon', angle: 24, ramp: 24, len: 100, drop: 8, features: [{ type: 'ring', at: 0.6, lat: 0, z: 0.5 }, { type: 'star', at: 0.78, lat: 0, z: 1.0 }] },
        { type: 'pitchTo', angle: 0, len: 40 },
        { type: 'straight', len: 60, features: [{ type: 'can', at: 0.5, lat: 0 }] },
        { type: 'turn', angle: 180, radius: 95, bank: 26, width: 26, features: [{ type: 'arrow', at: 0.02, side: -1 }, { type: 'split', at: 0.07, len: 250, div: 3, inner: 1 },
          { type: 'hazard', kind: 'hammer', at: 0.35, lat: 8, w: 3.2, period: 2.6, phase: 0.3 }, { type: 'hazard', kind: 'piston', at: 0.65, side: 1, period: 2.4, ext: 6 }, { type: 'star', at: 0.82, lat: 8 }, { type: 'coin', at: 0.4, lat: -7, n: 4 }] },
        { type: 'straight', len: 150, features: [{ type: 'box', at: 0.4, count: 4 }] },
        { type: 'turn', angle: 90, radius: 45, bank: 24, width: 26, features: [{ type: 'arrow', at: 0.02, side: -1 }, { type: 'split', at: 0.06, len: 90, div: 3, inner: 1 },
          { type: 'hazard', kind: 'piston', at: 0.5, side: 1, period: 2.0, ext: 6 }, { type: 'coin', at: 0.5, lat: -7, n: 4 }] },
        { type: 'straight', len: 40, features: [{ type: 'hazard', kind: 'hammer', at: 0.5, lat: 0, w: 2.6, period: 2.8 }] },
        { type: 'turn', angle: -90, radius: 45, bank: 24, features: [{ type: 'arrow', at: 0.06, side: 1 }] },
        { type: 'straight', len: 80, features: [{ type: 'pad', at: 0.5, lat: 0 }] },
        { type: 'climb', len: 100, height: 8 },
        { type: 'straight', len: 300, features: [{ type: 'belt', at: 0.3, len: 40 }, { type: 'box', at: 0.6, count: 4 }, { type: 'hazard', kind: 'pendulum', at: 0.85, period: 3.0 }] },
        { type: 'turn', angle: 180, radius: 90, bank: 26, features: [{ type: 'arrow', at: 0.04, side: -1 }, { type: 'can', at: 0.5, lat: 3 }] },
        { type: 'straight', len: 160, features: [{ type: 'pad', at: 0.5, lat: 0 }] }
      ]
    }
  ];

  S.MAPS = MAPS;
  if (typeof S.register === 'function') MAPS.forEach(function (m) { S.register(m); });
  else { S._pending = (S._pending || []).concat(MAPS); }

  if (typeof module !== 'undefined' && module.exports) module.exports = MAPS;
})(CB.arcade.stunt);

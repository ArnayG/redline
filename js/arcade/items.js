/* ==========================================================================
   Redline — js/arcade/items.js
   CB.arcade.items : the Arcade power-up catalogue + position-weighted roulette. Pure logic, no DOM, Node-loadable.

   Items are car-themed and harmless ("grip never breaks": the only loss of control is the brief cartoon 360 from
   an oil slick). Each def: { id, name, short, glyph, color, uses, kind, desc, ...effect params }.

     CB.arcade.items.LIST / BY_ID / ids()
     CB.arcade.items.weightsFor(posFrac, opts) -> { id: weight }   posFrac 0 = leader .. 1 = last place
     CB.arcade.items.roll(rng, posFrac, opts) -> id                 rng() in [0,1) (seeded by the caller)
       opts { nCars, exclude: [ids], timeTrial }   solo / 2-car fields squash the extremes (lightning needs >= 4 cars)
     CB.arcade.items.rouletteStrip(rng, finalId, n) -> [ids]        cosmetic ticker sequence ending on finalId
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};

(function () {
  'use strict';

  /* Effect parameters live on the defs so gameplay.js and the tests read one source of truth.
     Speeds are expressed relative to the car's own top speed (vTop) so a city hatchback and a hypercar both feel it. */
  var LIST = [
    { id: 'turbo', name: 'Turbo', short: 'TURBO', glyph: 'T', color: '#ff8a1f', uses: 3, kind: 'self',
      desc: 'Three short turbo kicks', boost_s: 1.05, boostTop: 1.2, boostAccel: 13 },
    { id: 'oil', name: 'Oil Slick', short: 'OIL', glyph: 'O', color: '#3b3355', uses: 1, kind: 'drop',
      desc: 'Drop a slick behind you — cars that hit it spin a harmless 360', life_s: 28, radius: 1.9, dropBack: 5.5, throwFwd: 22,
      spin_s: 0.95, slowTo: 0.55 },
    { id: 'emp', name: 'Shockwave', short: 'EMP', glyph: 'E', color: '#33d6ff', uses: 1, kind: 'area',
      desc: 'Electric pulse that slows nearby cars', radius: 22, slow_s: 1.3, slowTo: 0.68 },
    { id: 'rocket', name: 'Bumper Rocket', short: 'ROCKET', glyph: 'R', color: '#ff3b4e', uses: 1, kind: 'projectile',
      desc: 'Homes in on the car ahead and bonks it (hold brake to fire backwards)', speed: 62, minSpeedOver: 22, life_s: 9,
      hitR: 2.2, hop_s: 1.0, hopH: 1.5, slowTo: 0.42 },
    { id: 'shield', name: 'Shield', short: 'SHIELD', glyph: 'S', color: '#62f0b5', uses: 1, kind: 'self',
      desc: 'Bubble that blocks one hit', life_s: 9 },
    { id: 'magnet', name: 'Magnet', short: 'MAGNET', glyph: 'M', color: '#d0d6e2', uses: 1, kind: 'self',
      desc: 'Reels you in toward the car ahead', life_s: 3.6, range: 140, accel: 7, top: 1.14 },
    { id: 'ghost', name: 'Ghost', short: 'GHOST', glyph: 'G', color: '#b9a8ff', uses: 1, kind: 'self',
      desc: 'Phase through cars, immune to hazards', life_s: 4.2, top: 1.05 },
    { id: 'mega', name: 'Mega Nitro', short: 'MEGA', glyph: 'N', color: '#2f7bff', uses: 1, kind: 'self',
      desc: 'Full nitro refill plus a super boost', boost_s: 2.4, boostTop: 1.3, boostAccel: 15 },
    { id: 'lightning', name: 'Lightning', short: 'BOLT', glyph: 'L', color: '#ffe14a', uses: 1, kind: 'global',
      desc: 'Slows every car ahead of you (rare, back of the pack only)', slow_s: 2.3, slowTo: 0.64 }
  ];
  var BY_ID = {};
  LIST.forEach(function (d) { BY_ID[d.id] = d; });

  /* Weight anchors at posFrac 0 (leader), 1/3, 2/3, 1 (last). Mario-Kart style catch-up: the leader gets defensive
     items, the back of the pack gets speed and the rare Lightning. Linear interpolation between anchors. */
  var TABLE = {
    turbo:     [10, 22, 26, 22],
    oil:       [38, 20, 8, 3],
    emp:       [14, 14, 8, 4],
    rocket:    [6, 20, 20, 15],
    shield:    [24, 12, 7, 4],
    magnet:    [0, 6, 13, 14],
    ghost:     [8, 8, 8, 8],
    mega:      [0, 2, 10, 18],
    lightning: [0, 0, 1.5, 7]
  };

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function weightsFor(posFrac, opts) {
    opts = opts || {};
    var f = clamp01(typeof posFrac === 'number' && isFinite(posFrac) ? posFrac : 0.5);
    var nCars = opts.nCars || 8;
    if (nCars <= 1) f = 0.5;                       // solo runs: a neutral mid-pack table
    else if (nCars === 2) f = 0.25 + f * 0.5;      // squash extremes in a 1v1
    var seg = f * 3, k = Math.min(2, Math.floor(seg)), t = seg - k;
    var out = {};
    var exclude = opts.exclude || [];
    Object.keys(TABLE).forEach(function (id) {
      var w = lerp(TABLE[id][k], TABLE[id][k + 1], t);
      if (id === 'lightning' && nCars < 4) w = 0;
      if (exclude.indexOf(id) >= 0) w = 0;
      if (w > 0) out[id] = w;
    });
    return out;
  }

  function roll(rng, posFrac, opts) {
    var w = weightsFor(posFrac, opts), ids = Object.keys(TABLE).filter(function (id) { return w[id] > 0; });
    var tot = 0, i;
    for (i = 0; i < ids.length; i++) tot += w[ids[i]];
    if (!(tot > 0)) return 'turbo';
    var r = (typeof rng === 'function' ? rng() : Math.random()) * tot;
    for (i = 0; i < ids.length; i++) { r -= w[ids[i]]; if (r < 0) return ids[i]; }
    return ids[ids.length - 1];
  }

  function rouletteStrip(rng, finalId, n) {
    n = n || 14;
    var out = [], prev = null;
    for (var i = 0; i < n - 1; i++) {
      var id;
      do { id = LIST[Math.floor((typeof rng === 'function' ? rng() : Math.random()) * LIST.length)].id; } while (id === prev);
      out.push(id); prev = id;
    }
    out.push(finalId);
    return out;
  }

  CB.arcade.items = {
    LIST: LIST, BY_ID: BY_ID, TABLE: TABLE,
    ids: function () { return LIST.map(function (d) { return d.id; }); },
    get: function (id) { return BY_ID[id] || null; },
    weightsFor: weightsFor, roll: roll, rouletteStrip: rouletteStrip
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.arcade.items;

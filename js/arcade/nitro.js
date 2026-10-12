/* ==========================================================================
   Redline — js/arcade/nitro.js
   CB.arcade.nitro : nitro meter, rocket-start rev gauge, powerslide mini-turbo tiers and slipstream charge.
   Pure logic (no DOM), Node-loadable. Used by js/arcade/gameplay.js; the constants are exported for the HUD/tests.

     createMeter() -> { level 0..1, burning, burnT, gained {source: total} }
     gain(meter, source, amount?) -> amount actually added   (source keys in GAIN; amount overrides the table)
     burn(meter, dt, held) -> true while burning              (needs MIN_START to ignite, burns BURN_RATE / s)

     createRev() / revStep(rev, dt, throttle) / revResult(rev) -> { grade: 'perfect'|'good'|'over'|'none', boost_s }
       The countdown rev gauge rises while the throttle is held and falls when released; keep the needle inside the
       sweet zone [SWEET_LO, SWEET_HI] at GO for a rocket start (PERFECT band inside it). Pinning it past OVER_REV
       floods the engine (no boost, a short bog) until the throttle is released. Works with digital keyboards.

     DRIFT_TIERS  [{tier 1 blue @ 0.95 s}, {2 orange @ 2.0 s}, {3 purple @ 3.3 s}] -> release boost seconds
     driftTier(charge_s) -> 0..3
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};

(function () {
  'use strict';

  var BURN_RATE = 0.27;        // meter / s  (full tank ~3.7 s)
  var MIN_START = 0.06;        // need a little in the tank to ignite
  var GAIN = {
    air: 0.11,                 // per second airborne
    landing: 0.08,             // clean landing after >= 0.45 s of air
    nearMiss: 0.05,
    slipstream: 0.10,
    drift: 0.055,              // per second of powerslide
    driftRelease: 0.04,        // x tier on release
    overtake: 0.06,
    canister: 0.34,
    ring: 0.10,
    passive: 0                 // AI difficulty adds its own passive trickle
  };

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  function createMeter(level) { return { level: clamp01(num(level, 0)), burning: false, burnT: 0, gained: {} }; }
  function gain(m, source, amount) {
    if (!m) return 0;
    var a = num(amount, GAIN[source] != null ? GAIN[source] : 0);
    var before = m.level;
    m.level = clamp01(m.level + a);
    var got = m.level - before;
    if (got > 0) m.gained[source] = (m.gained[source] || 0) + got;
    return got;
  }
  function burn(m, dt, held) {
    if (!m) return false;
    if (held && (m.burning ? m.level > 0 : m.level >= MIN_START)) {
      m.burning = true;
      m.level = clamp01(m.level - BURN_RATE * dt);
      m.burnT += dt;
      if (m.level <= 0) m.burning = false;
    } else {
      m.burning = false;
      m.burnT = 0;
    }
    return m.burning;
  }

  /* ---------------- rocket start ---------------- */
  var REV_UP = 0.95, REV_DOWN = 0.75;
  var SWEET_LO = 0.6, SWEET_HI = 0.86, PERFECT_LO = 0.68, PERFECT_HI = 0.8, OVER_REV = 0.97;
  function createRev() { return { v: 0, flooded: false, held: 0 }; }
  function revStep(r, dt, throttle) {
    var on = num(throttle, 0) > 0.5;
    if (on) { r.v = Math.min(1, r.v + REV_UP * dt); r.held += dt; }
    else { r.v = Math.max(0, r.v - REV_DOWN * dt); r.held = 0; r.flooded = false; }
    if (r.v >= OVER_REV && on) r.flooded = true;
    return r;
  }
  function revResult(r) {
    if (!r) return { grade: 'none', boost_s: 0 };
    if (r.flooded) return { grade: 'over', boost_s: 0, bog_s: 0.7 };
    if (r.v >= PERFECT_LO && r.v <= PERFECT_HI) return { grade: 'perfect', boost_s: 1.6 };
    if (r.v >= SWEET_LO && r.v <= SWEET_HI) return { grade: 'good', boost_s: 0.95 };
    return { grade: 'none', boost_s: 0 };
  }

  /* ---------------- powerslide mini-turbo ---------------- */
  var DRIFT_TIERS = [
    { tier: 1, at: 0.95, name: 'MINI-TURBO', color: '#3aa8ff', boost_s: 0.7 },
    { tier: 2, at: 2.0, name: 'SUPER TURBO', color: '#ff9a2a', boost_s: 1.25 },
    { tier: 3, at: 3.3, name: 'ULTRA TURBO', color: '#c45bff', boost_s: 1.9 }
  ];
  function driftTier(charge) {
    var t = 0;
    for (var i = 0; i < DRIFT_TIERS.length; i++) if (charge >= DRIFT_TIERS[i].at) t = DRIFT_TIERS[i].tier;
    return t;
  }

  /* ---------------- slipstream ---------------- */
  var SLIP = { minDs: 3.5, maxDs: 30, maxLat: 2.4, minSpeed: 18, charge_s: 1.5, boost_s: 1.15, push: 0.9 };

  CB.arcade.nitro = {
    BURN_RATE: BURN_RATE, MIN_START: MIN_START, GAIN: GAIN,
    createMeter: createMeter, gain: gain, burn: burn,
    REV: { up: REV_UP, down: REV_DOWN, sweetLo: SWEET_LO, sweetHi: SWEET_HI, perfectLo: PERFECT_LO, perfectHi: PERFECT_HI, over: OVER_REV },
    createRev: createRev, revStep: revStep, revResult: revResult,
    DRIFT_TIERS: DRIFT_TIERS, driftTier: driftTier, SLIP: SLIP
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.arcade.nitro;

/* ==========================================================================
   Redline — js/drag/drag-ai.js
   CB.drag.ai : drag AI drivers (reaction / launch / shift quality by difficulty), the auto-stager shared with the
   player's auto-stage assist, the rival ladder and single-elimination tournaments (docs/DRAG-SPEC.md §6).
   Pure logic, seeded (mulberry32), no Math.random. Loads in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.drag = CB.drag || {};

(function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { var n = Number(v); return v != null && isFinite(n) ? n : d; }
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    var f = function () {
      a = (a + 0x6D2B79F5) >>> 0; var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.state = function () { return a; }; f.set = function (s) { a = s >>> 0; };
    return f;
  }
  function gauss(r) { var u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // reaction targets (RT, s, from green incl. rollout), launch rpm error (fraction of the band), shift error (fraction of redline)
  var SKILL = {
    rookie: { rt: 0.34, rtSd: 0.08, red: 0.01, launch: 0.18, shift: 0.09, burnout: [0.8, 0.35], nitro: 0.6 },
    amateur: { rt: 0.2, rtSd: 0.06, red: 0.015, launch: 0.1, shift: 0.05, burnout: [0.9, 0.2], nitro: 0.8 },
    pro: { rt: 0.08, rtSd: 0.04, red: 0.02, launch: 0.05, shift: 0.03, burnout: [1, 0.1], nitro: 0.95 },
    alien: { rt: 0.03, rtSd: 0.022, red: 0.03, launch: 0.03, shift: 0.015, burnout: [1, 0.05], nitro: 1 }
  };
  function skillOf(d) { return SKILL[d] || SKILL.amateur; }

  /** Auto-stager: creep into the beams and stop staged (deep: past the pre-stage beam). view = session lane view. */
  function stageControl(v, deep) {
    var G = CB.drag.strip.GEO, target = v.stageTarget != null ? v.stageTarget : deep ? G.DEEP_X + 0.03 : 0.04;
    var gap = target - v.xFront, sp = v.vx;
    if (v.staged && (!deep || v.deep)) return { throttle: 0, brake: 1, analog: true };
    var want = gap > 6 ? 5 : gap > 1.5 ? 1.6 : gap > 0.3 ? 0.55 : 0.28;
    if (gap <= 0) return { throttle: 0, brake: 1 };
    if (sp > want + 0.25) return { throttle: 0, brake: clamp((sp - want) * 0.5, 0.15, 1), analog: true };
    if (sp < want) return { throttle: v.converter && sp > want * 0.5 ? 0 : clamp(0.36 + (want - sp) * 0.12, 0.3, 0.65), brake: 0, analog: true };
    return { throttle: 0, brake: 0, analog: true };
  }

  /** Hold-throttle that revs a held engine to rpm (free revving: idle..redline*1.02). */
  function holdThrottleFor(v, rpm) {
    if (v.ev || v.converter || v.lc) return 1;
    return clamp((rpm - v.idle) / Math.max(1, v.redline * 1.02 - v.idle), 0.05, 1);
  }

  function createDriver(opts) {
    opts = opts || {};
    var sk = skillOf(opts.difficulty), r = rng(num(opts.seed, 7) ^ 0x5bd1e995);
    var plan = {
      rt: (function () {
        var x = sk.rt + sk.rtSd * gauss(r);
        if (x < 0 && r() > sk.red / 0.08) x = -x * 0.5 + 0.005;     // most "early" draws are saved; a few stay red
        return clamp(x, -0.08, 0.8);
      })(),
      launchErr: sk.launch * gauss(r),
      shiftErr: [], burnout: sk.burnout[0] > r() ? 1 : 0, burnTarget: 82 + 16 * gauss(r) * sk.burnout[1] * 2,
      nitro: r() < sk.nitro, deep: opts.deep != null ? !!opts.deep : r() < 0.15
    };
    for (var g = 0; g < 12; g++) plan.shiftErr.push(sk.shift * gauss(r));
    var st = { burnDone: false, burnT: 0, lastGear: 1, shiftWait: 0, rolloutEst: num(opts.rolloutEst, 0.2) };

    function control(v, dt) {
      var inp = { throttle: 0, brake: 0, shiftUp: false, shiftDown: false, nitrous: false, analog: true };
      if (v.phase === 'burnout' && !st.burnDone && plan.burnout && v.inBox && !v.street) {
        st.burnT += dt;
        if (v.tyreTemp < plan.burnTarget && st.burnT < 7) { inp.throttle = 1; inp.brake = 1; return inp; }
        st.burnDone = true;
      }
      if (v.phase === 'burnout' || v.phase === 'staging' || (v.phase === 'tree' && !v.staged)) {
        st.burnDone = true;
        var sc = stageControl(v, plan.deep);
        // revving on the line while waiting for the other lane / the tree
        if (v.staged && (v.phase === 'tree' || v.otherStaged)) sc.throttle = Math.abs(v.vx) < 0.05 ? holdThrottleFor(v, launchRpm(v)) : 0;
        sc.analog = true;
        return sc;
      }
      if (v.phase === 'tree' && !v.left) {
        // hold, rev, release so the tyre clears the beam at green + rt
        inp.brake = 1; inp.throttle = Math.abs(v.vx) < 0.05 ? holdThrottleFor(v, launchRpm(v)) : 0;
        if (v.greenT != null && v.t >= v.greenT + plan.rt - (v.rolloutT != null ? v.rolloutT : st.rolloutEst)) { inp.brake = 0; inp.throttle = 1; }
        return inp;
      }
      if (v.finished) {
        inp.throttle = 0; inp.brake = v.xFront > v.finishX + 40 ? 0.55 : 0; return inp;
      }
      // the pass (also: roll race waiting for green at cruise)
      if (v.roll && v.greenT != null && v.t < v.greenT + plan.rt) { inp.throttle = v.cruiseThrottle; return inp; }
      inp.throttle = 1;
      if (!v.autoShift && v.gear >= 1 && v.gear < v.maxGear && !v.shifting && v.clutchLocked && v.vx > 3) {
        var target = v.optShift * (1 + plan.shiftErr[Math.min(11, v.gear)]);
        target = Math.min(target, v.redline * 1.0);
        if (v.rpm >= target || v.limiter) inp.shiftUp = true;
      }
      if (v.nitrousArmed && plan.nitro && v.xFront > 18) inp.nitrous = true;
      return inp;
    }
    function launchRpm(v) {
      if (v.ev || v.converter || v.lc) return v.redline;
      var band = v.launchBand || { lo: v.redline * 0.5, hi: v.redline * 0.7, best: v.redline * 0.6 };
      return band.best + (band.hi - band.lo) * plan.launchErr * 2;
    }
    return { control: control, plan: plan, setRollout: function (x) { st.rolloutEst = x; } };
  }

  /* ------------------------------------------------------------ rivals ladder */
  var RIVALS = [
    { id: 'diesel', name: 'Dex "Diesel" Moreno', model: 'mercedes-sprinter-vs30', difficulty: 'rookie', color: '#f2f2f2', bio: 'Delivers parcels by day. Delivers excuses by night.' },
    { id: 'hachi', name: 'Kaia "Hachi" Tanaka', model: 'toyota-sprinter-trueno-ae86', difficulty: 'rookie', color: '#f4f1ea', bio: 'Tofu-shop panda. Corners are more her thing.' },
    { id: 'mudflap', name: 'Marco "Mudflap" Silva', model: 'ford-f150-raptor-gen3', difficulty: 'amateur', color: '#3d4b5a', bio: 'Thinks every strip needs a jump at the end.' },
    { id: 'vtec', name: 'Rae "VTEC" Okafor', model: 'honda-civic-type-r-fl5', difficulty: 'amateur', color: '#e8e8e8', bio: 'Front-drive, wing up, never lifts.' },
    { id: 'pony', name: 'Billy "Pony" Hart', model: 'ford-mustang-gt-s650', difficulty: 'amateur', color: '#1f4fbf', bio: 'Leaves every Cars & Coffee sideways.' },
    { id: 'bavaria', name: 'Lena "Bavaria" Kraus', model: 'bmw-m4-g82', difficulty: 'pro', color: '#3fa34d', bio: 'Clean launches, cleaner spreadsheets.' },
    { id: 'redeye', name: 'Tyrell "Redeye" Banks', model: 'dodge-challenger-srt-hellcat', difficulty: 'pro', color: '#b3121b', bio: 'Supercharger whine as a personality.' },
    { id: 'stingray', name: 'Ava "Stingray" Quinn', model: 'chevrolet-corvette-c8', difficulty: 'pro', color: '#f2b705', bio: 'Mid-engine, mid-race trash talk.' },
    { id: 'godzilla', name: 'Kenji "Godzilla" Mori', model: 'nissan-gtr-r35', difficulty: 'alien', color: '#c9ced6', bio: 'AWD launches that feel like a catapult.' },
    { id: 'quad', name: 'Victor "Quad" Laurent', model: 'bugatti-chiron', difficulty: 'alien', color: '#1b2a4a', bio: 'Sixteen cylinders, four turbos, zero patience.' }
  ];
  var LKEY = 'forge.drag.ladder.v1', mem = null;
  function ls() { try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* blocked */ } return null; }
  var ladder = {
    RIVALS: RIVALS,
    load: function () {
      var s = ls(); var o = null;
      if (s) { try { o = JSON.parse(s.getItem(LKEY) || 'null'); } catch (e) { o = null; } } else o = mem;
      o = o && typeof o === 'object' ? o : {};
      o.beaten = Array.isArray(o.beaten) ? o.beaten.filter(function (id) { return RIVALS.some(function (r) { return r.id === id; }); }) : [];
      return o;
    },
    save: function (o) { var s = ls(); if (s) { try { s.setItem(LKEY, JSON.stringify(o)); } catch (e) { /* full */ } } else mem = o; },
    /** Index of the next rival to beat (RIVALS.length when the ladder is complete). */
    next: function (o) { o = o || ladder.load(); for (var i = 0; i < RIVALS.length; i++) if (o.beaten.indexOf(RIVALS[i].id) < 0) return i; return RIVALS.length; },
    unlocked: function (o, id) { o = o || ladder.load(); var i = RIVALS.findIndex(function (r) { return r.id === id; }); return i >= 0 && i <= ladder.next(o); },
    beat: function (id) { var o = ladder.load(); if (o.beaten.indexOf(id) < 0) o.beaten.push(id); ladder.save(o); return o; },
    get: function (id) { return RIVALS.filter(function (r) { return r.id === id; })[0] || null; },
    reset: function () { ladder.save({ beaten: [] }); }
  };
  /** Stock build for a rival / model id (CB.stock), or null. */
  function rivalBuild(r) {
    var id = typeof r === 'string' ? r : r && r.model;
    try { var x = CB.stock && CB.stock.build(id); return x ? x.build : null; } catch (e) { return null; }
  }

  /* ------------------------------------------------------------ tournament */
  /** entrants: [{ id, name, isPlayer, model?, build?, difficulty, color }] (4 or 8; padded with ladder rivals). */
  function tournamentCreate(o) {
    o = o || {};
    var r = rng(num(o.seed, 11) ^ 0x2545f491);
    var size = o.size === 8 ? 8 : 4;
    var ents = (o.entrants || []).slice(0, size);
    var pool = RIVALS.filter(function (x) { return !ents.some(function (e) { return e.id === x.id; }); });
    while (ents.length < size && pool.length) { var k = Math.floor(r() * pool.length); var x = pool.splice(k, 1)[0]; ents.push({ id: x.id, name: x.name, model: x.model, difficulty: x.difficulty, color: x.color }); }
    // seeded shuffle of the non-player entrants, the player stays in the top half (match 0)
    var pl = ents.filter(function (e) { return e.isPlayer; }), ai = ents.filter(function (e) { return !e.isPlayer; });
    for (var i = ai.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = ai[i]; ai[i] = ai[j]; ai[j] = t; }
    ents = pl.concat(ai);
    var rounds = [], n = ents.length, first = [];
    for (i = 0; i < n; i += 2) first.push({ a: i, b: i + 1, winner: null, summary: null });
    rounds.push(first);
    while (n > 2) { n /= 2; var rr = []; for (i = 0; i < n; i += 2) rr.push({ a: null, b: null, winner: null, summary: null }); rounds.push(rr); }
    return { v: 1, seed: num(o.seed, 11), size: size, entrants: ents, rounds: rounds, round: 0, champion: null };
  }
  function tRecord(t, ri, mi, winnerSide, summary) {
    var m = t.rounds[ri][mi];
    if (m.winner != null) return t;
    m.winner = winnerSide === 1 ? m.b : m.a; m.summary = summary || null;
    if (ri + 1 < t.rounds.length) {
      var nm = t.rounds[ri + 1][mi >> 1];
      if (mi % 2 === 0) nm.a = m.winner; else nm.b = m.winner;
    } else t.champion = m.winner;
    if (t.rounds[ri].every(function (x) { return x.winner != null; })) t.round = Math.min(ri + 1, t.rounds.length - 1);
    return t;
  }
  function tPending(t) {
    for (var ri = 0; ri < t.rounds.length; ri++) for (var mi = 0; mi < t.rounds[ri].length; mi++) {
      var m = t.rounds[ri][mi];
      if (m.winner == null && m.a != null && m.b != null) return { round: ri, match: mi, a: t.entrants[m.a], b: t.entrants[m.b], player: !!(t.entrants[m.a].isPlayer || t.entrants[m.b].isPlayer) };
    }
    return null;
  }
  /** Play every pending AI-vs-AI match available now. simFn(entA, entB, seed) -> { winner 0|1, summary }. */
  function tPlayAi(t, simFn) {
    var p, guard = 0;
    while ((p = tPending(t)) && !p.player && guard++ < 16) {
      var out = simFn(p.a, p.b, (t.seed * 31 + p.round * 7 + p.match) >>> 0) || { winner: 0 };
      tRecord(t, p.round, p.match, out.winner === 1 ? 1 : 0, out.summary);
    }
    return t;
  }
  function tPlayerOut(t) {
    return t.rounds.some(function (rd) { return rd.some(function (m) { return m.winner != null && (t.entrants[m.a].isPlayer || t.entrants[m.b].isPlayer) && !t.entrants[m.winner].isPlayer; }); });
  }

  CB.drag.ai = {
    SKILL: SKILL, createDriver: createDriver, stageControl: stageControl, holdThrottleFor: holdThrottleFor, rng: rng,
    RIVALS: RIVALS, ladder: ladder, rivalBuild: rivalBuild,
    tournament: { create: tournamentCreate, record: tRecord, pending: tPending, playAi: tPlayAi, playerOut: tPlayerOut,
      champion: function (t) { return t.champion == null ? null : t.entrants[t.champion]; } }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.drag.ai;

/* ==========================================================================
   Redline — js/f1/f1-strategy.js
   CB.f1.strategy : Formula 1 tyre / pit strategy (docs/F1-SPEC.md §5). Pure logic, no DOM, Node-loadable.

     plan(meta, laps, opts?) -> { stops, stints: [{ compound, laps, fromLap, toLap }], totalTime_s, alternatives, notes }
         meta  CB.f1.circuits.meta(...) (length_m, pit, real) or { length_m } / a lap time; laps = race laps
         opts  { weather 'dry'|'damp'|'wet', compounds ['soft','medium','hard'], twoCompoundRule (default: dry && laps >= 5),
                 startCompound, life { soft, medium, hard, inter, wet } (laps of useful life; default: CB.f1.car.COMPOUNDS
                 life_km / lap length / opts.wearMult, else race-distance fractions), wearMult, lapTime_s, pitLoss_s, rng () -> 0..1 (variety: picks among near-equal plans),
                 maxStops 2 }
     advice(car, ctx) -> { box, urgency 0..1, reasons, request: { tires: true, compound } } | null
         engine hook contract (CB.f1.hooks.advice delegates here). car.f1Strategy = plan (attached by assign()), car.f1 = the
         hooks' per-car state (tyre wear / compound read defensively), ctx { lapsRemaining, lap }.
     assign(car, meta, laps, opts) -> plan  (stores it on car.f1Strategy; used by hooks at carCreated)
     nextCompound(plan, lap) / stintAt(plan, lap)
     tyreInfo(car) -> { compound, wear (worst corner 0..1), wearAvg, age, temp } (reads several state shapes)
     LIFE_FRACTION, PACE                 defaults (life as a fraction of race distance, fresh-tyre pace offsets)

   Model: lap time of a stint lap = base x (1 + PACE[c]) + base x deg(wear) where wear grows ~linearly over the
   compound's life and deg rises steeply past ~75 % (the "cliff"). Plans are enumerated (0..2 stops, every compound
   order, split laps) and the fastest legal one wins; rng() picks among plans within 0.6 % for grid variety.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var DRY = ['soft', 'medium', 'hard'];
  /** useful life as a fraction of race distance when the car model gives no wear rate (game wear scales with distance) */
  var LIFE_FRACTION = { soft: 0.4, medium: 0.62, hard: 0.85, inter: 0.9, wet: 1.2 };
  /** fresh-tyre lap-time offset vs the soft (fraction of the lap) */
  var PACE = { soft: 0, medium: 0.009, hard: 0.017, inter: 0.06, wet: 0.09 };
  var CLIFF = 0.74;   // CB.f1.car: grip falls off steeply past 72 % wear
  /** ...but never shorter than this many laps (short quick races run without a stop unless the two-compound rule applies) */
  var MIN_LIFE = { soft: 3, medium: 5, hard: 7, inter: 6, wet: 8 };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function deg(w) {   // lap-time fraction lost at wear w (0..1+)
    w = Math.max(0, w);
    var d = 0.028 * Math.pow(w, 1.5);
    if (w > 0.7) d += 0.25 * Math.pow(w - 0.7, 2);
    if (w > 0.95) d += 0.5 * (w - 0.95);
    return d;
  }

  function carModule() { return CB.f1 && CB.f1.car ? CB.f1.car : null; }

  /** laps of life per compound: opts.life > CB.f1.car.compoundLife(meta) > race-distance fractions */
  function lifeOf(c, laps, meta, opts) {
    if (opts && opts.life && isNum(opts.life[c])) return Math.max(1, opts.life[c]);
    var M = carModule();
    // CB.f1.car.COMPOUNDS[c].life_km = distance to a worn-out tyre at wearMult 1: plan to ~85 % of it
    var CI = M && M.COMPOUNDS && M.COMPOUNDS[c];
    var Lm = num(meta && meta.length_m, NaN);
    if (CI && isNum(CI.life_km) && isNum(Lm) && Lm > 500) {
      var wm = Math.max(0.05, num(opts && opts.wearMult, 1));
      return Math.max(1, CI.life_km * 1000 / Lm * 0.85 / wm);
    }
    if (M && typeof M.compoundLife === 'function') {
      try { var l = M.compoundLife(c, { meta: meta, laps: laps, weather: opts && opts.weather }); if (isNum(l) && l > 0) return Math.max(1, l); } catch (e) { /* default */ }
    }
    return Math.max(MIN_LIFE[c] || 3, (LIFE_FRACTION[c] || 0.6) * laps);
  }

  function baseLap(meta, opts) {
    if (opts && isNum(opts.lapTime_s)) return opts.lapTime_s;
    var r = meta && meta.real;
    if (r && isNum(r.raceLap_s)) return r.raceLap_s;
    var L = num(meta && meta.length_m, 5000);
    return L / 58;   // ~210 km/h average
  }
  function pitLossOf(meta, opts) {
    if (opts && isNum(opts.pitLoss_s)) return opts.pitLoss_s;
    var p = meta && meta.pit;
    if (p && isNum(p.loss_s)) return p.loss_s;
    if (p && isNum(p.entry_s) && isNum(p.exit_s) && isNum(meta.length_m)) {
      var L = meta.length_m, lane = p.exit_s >= p.entry_s ? p.exit_s - p.entry_s : L - p.entry_s + p.exit_s;
      var vLim = num(p.speedLimit_ms, 80 / 3.6);
      return lane / vLim - lane / 70 + 2.5 + 3;
    }
    return 22;
  }

  function stintTime(c, n, life, base) {
    var t = 0;
    for (var i = 0; i < n; i++) t += base * (1 + (PACE[c] || 0) + deg((i + 0.5) / life));
    return t;
  }

  function plan(meta, laps, opts) {
    opts = opts || {};
    laps = Math.max(1, Math.round(num(laps, 5)));
    var weather = opts.weather || 'dry';
    var wet = weather === 'wet' || weather === 'damp';
    var rng = typeof opts.rng === 'function' ? opts.rng : null;
    var base = baseLap(meta, opts), loss = pitLossOf(meta, opts);
    var maxStops = clamp(Math.round(num(opts.maxStops, 2)), 0, 3);
    var comps = wet ? [weather === 'wet' ? 'wet' : 'inter'] : (Array.isArray(opts.compounds) && opts.compounds.length ? opts.compounds.filter(function (c) { return DRY.indexOf(c) >= 0; }) : DRY.slice());
    if (!comps.length) comps = DRY.slice();
    var rule = !wet && (opts.twoCompoundRule != null ? !!opts.twoCompoundRule : laps >= 5) && comps.length > 1;
    var life = {};
    comps.forEach(function (c) { life[c] = lifeOf(c, laps, meta, opts); });
    var cands = [];
    function push(seq, splits) {
      if (rule) { var u = {}; seq.forEach(function (c) { u[c] = 1; }); if (Object.keys(u).length < 2) return; }
      if (opts.startCompound && seq[0] !== opts.startCompound) return;
      var t = 0, from = 1, stints = [];
      for (var i = 0; i < seq.length; i++) {
        var n = splits[i];
        if (n < 1) return;
        if (n > life[seq[i]] * 1.08) return;   // would run off the cliff
        t += stintTime(seq[i], n, life[seq[i]], base);
        stints.push({ compound: seq[i], laps: n, fromLap: from, toLap: from + n - 1 });
        from += n;
      }
      t += (seq.length - 1) * loss;
      cands.push({ stops: seq.length - 1, stints: stints, totalTime_s: Math.round(t * 100) / 100 });
    }
    // 0 stops
    comps.forEach(function (c) { push([c], [laps]); });
    // 1 stop
    if (maxStops >= 1 && laps >= 2) comps.forEach(function (a) { comps.forEach(function (b) {
      for (var k = 1; k < laps; k++) push([a, b], [k, laps - k]);
    }); });
    // 2 stops
    if (maxStops >= 2 && laps >= 3) comps.forEach(function (a) { comps.forEach(function (b) { comps.forEach(function (c) {
      for (var k1 = 1; k1 < laps - 1; k1++) for (var k2 = 1; k1 + k2 < laps; k2++) push([a, b, c], [k1, k2, laps - k1 - k2]);
    }); }); });
    if (!cands.length && opts.startCompound) {   // the compound the car is on rules every plan out: plan from scratch
      opts = Object.assign({}, opts, { startCompound: null });
      return plan(meta, laps, opts);
    }
    if (!cands.length) {   // nothing legal within tyre life: best-effort longest-life split
      var order = comps.slice().sort(function (x, y) { return life[y] - life[x]; });
      var n = Math.max(2, Math.ceil(laps / life[order[0]]));
      var seq = [], sp = [];
      for (var i = 0; i < n; i++) { seq.push(order[i % Math.min(order.length, 2)]); sp.push(Math.floor(laps / n) + (i < laps % n ? 1 : 0)); }
      life[order[0]] = Infinity; if (order[1]) life[order[1]] = Infinity;
      push(seq, sp);
    }
    cands.sort(function (x, y) { return x.totalTime_s - y.totalTime_s; });
    var best = cands[0];
    if (rng && cands.length > 1) {
      // variety: any plan within 0.6 % of the best, preferring different compound orders / stop counts
      var near = [], seen = {};
      for (var j = 0; j < cands.length && near.length < 6; j++) {
        var c = cands[j];
        if (c.totalTime_s > best.totalTime_s * 1.006) break;
        var key = c.stints.map(function (s) { return s.compound; }).join('-');
        if (seen[key]) continue;
        seen[key] = 1; near.push(c);
      }
      if (near.length) best = near[Math.floor(rng() * near.length) % near.length];
    }
    var alts = [];
    var seen2 = {};
    cands.forEach(function (c) {
      var key = c.stints.map(function (s) { return s.compound; }).join('-');
      if (!seen2[key] && alts.length < 4) { seen2[key] = 1; alts.push(c); }
    });
    return {
      stops: best.stops, stints: best.stints, totalTime_s: best.totalTime_s, alternatives: alts, laps: laps,
      weather: weather, twoCompoundRule: rule, life: life, pitLoss_s: Math.round(loss * 10) / 10, lapTime_s: base,
      notes: (rule ? 'two dry compounds required · ' : '') + best.stops + '-stop: ' + best.stints.map(function (s) { return s.compound[0].toUpperCase() + s.laps; }).join(' → ')
    };
  }

  function stintAt(p, lap) {
    if (!p || !p.stints) return null;
    for (var i = 0; i < p.stints.length; i++) if (lap <= p.stints[i].toLap) return p.stints[i];
    return p.stints[p.stints.length - 1];
  }
  function nextCompound(p, lap) {
    if (!p || !p.stints) return 'medium';
    for (var i = 0; i < p.stints.length; i++) if (lap <= p.stints[i].toLap) return (p.stints[i + 1] || p.stints[i]).compound;
    return p.stints[p.stints.length - 1].compound;
  }

  /** Tyre state of a car whatever shape the hooks keep it in. */
  function tyreInfo(car) {
    var f = car && (car.f1 || (car.endurance && car.endurance.f1)) || {};
    var t = f.tyres || f.tyre || f;
    var wear = t.wear || t.tyreWear || f.tyreWear;
    var w = 0, wa = 0;
    if (Array.isArray(wear) && wear.length) { wear.forEach(function (x) { x = num(x, 0); if (x > w) w = x; wa += x; }); wa /= wear.length; }
    else if (isNum(wear)) { w = wa = wear; }
    var temp = t.temp || t.tyreTemp || f.tyreTemp;
    return {
      compound: t.compound || f.compound || null, wear: w, wearAvg: wa,
      age: num(t.age, num(t.ageLaps, num(f.tyreAge, 0))), temp: Array.isArray(temp) ? temp.slice() : null,
      used: f.compoundsUsed || t.compoundsUsed || null
    };
  }

  function assign(car, meta, laps, opts) {
    var p = plan(meta, laps, opts);
    if (car) car.f1Strategy = p;
    return p;
  }

  /** Live pit advice (engine hook `advice`). */
  function advice(car, ctx) {
    if (!car) return null;
    ctx = ctx || {};
    var left = num(ctx.lapsRemaining, 99);
    var lap = (car.tracker && isNum(car.tracker.lap) ? car.tracker.lap : num(ctx.lap, 0)) + 1;   // the lap being driven (1-based)
    if (ctx.mode && ctx.mode !== 'race') return { box: false, urgency: 0, reasons: ['not a race'], request: null };
    var ti = tyreInfo(car);
    if (!car.f1Strategy && ctx.meta && isNum(ctx.lapsTotal)) {
      // first call (CB.f1.hooks advice): plan the race from the compound the car started on
      var h = 2166136261, id = String(car.id);
      for (var k = 0; k < id.length; k++) { h ^= id.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; }
      var seed = h || 1;
      var rnd = function () { seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x6d2b79f5) >>> 0; return seed / 4294967296; };
      var used0 = Array.isArray(ti.used) && ti.used.length ? ti.used[0] : ti.compound;
      try {
        assign(car, ctx.meta, ctx.lapsTotal, { weather: ctx.weather, wearMult: ctx.wearMult, startCompound: DRY.indexOf(used0) >= 0 ? used0 : undefined,
          twoCompoundRule: ctx.requireTwoCompounds != null ? !!ctx.requireTwoCompounds : undefined, rng: rnd });
      } catch (e) { car.f1Strategy = null; }
    }
    var p = car.f1Strategy || null;
    var reasons = [], box = false, urgency = 0;
    var stops = car.pitStops || 0;
    var plannedStops = p ? p.stops : 1;
    if (left <= 1) return { box: false, urgency: 0, reasons: ['last lap'], request: null };
    // planned stop: this lap ends the current stint
    if (p) {
      var st = stintAt(p, lap);
      var idx = p.stints.indexOf(st);
      if (st && lap >= st.toLap && idx < p.stints.length - 1 && stops < plannedStops) { box = true; urgency = 0.6; reasons.push('planned stop (' + st.compound + ' stint done)'); }
    }
    // wear past the cliff with enough race left to pay back the stop
    if (ti.wear >= CLIFF && left >= 3) { box = true; urgency = Math.max(urgency, clamp((ti.wear - CLIFF) / 0.2 + 0.6, 0, 1)); reasons.push('tyres at ' + Math.round(ti.wear * 100) + '%'); }
    if (ti.wear >= 0.95 && left >= 2) { box = true; urgency = 1; }
    // two-compound rule: never finish on one dry compound
    var used = Array.isArray(ti.used) ? ti.used : null;
    var oneCompound = used ? used.filter(function (c, i, a) { return DRY.indexOf(c) >= 0 && a.indexOf(c) === i; }).length < 2 : stops === 0;
    if (p && p.twoCompoundRule && oneCompound && left === 2 && !box) { box = true; urgency = 0.8; reasons.push('mandatory compound change'); }
    // wear well under control: hold the stop for a lap or two (tyre management) unless planned this lap only
    if (box && urgency < 0.7 && ti.wear < 0.35 && !(p && p.twoCompoundRule && oneCompound && left <= 3)) { box = false; reasons.push('tyres still good, extending'); }
    var comp = p ? nextCompound(p, lap) : (left > 12 ? 'hard' : left > 6 ? 'medium' : 'soft');
    if (p && p.twoCompoundRule && oneCompound && ti.compound && comp === ti.compound) comp = ti.compound === 'medium' ? 'hard' : 'medium';
    if (p && (p.weather === 'wet' || p.weather === 'damp')) comp = p.weather === 'wet' ? 'wet' : 'inter';
    return { box: box, urgency: urgency, reasons: reasons, request: { tires: true, compound: comp } };
  }

  CB.f1.strategy = {
    plan: plan, advice: advice, assign: assign, nextCompound: nextCompound, stintAt: stintAt, tyreInfo: tyreInfo,
    LIFE_FRACTION: LIFE_FRACTION, PACE: PACE, CLIFF: CLIFF, _deg: deg
  };
})();

if (typeof module !== 'undefined') module.exports = CB.f1.strategy;

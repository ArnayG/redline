/* ==========================================================================
   Redline — js/drag/drag-launch.js
   CB.drag.launch : burnout heat, launch-rpm sweet spot, shift-window grading, shift lights, N2O params and the
   setup screen's quick tune (docs/DRAG-SPEC.md §4). Works on CB.race.vehicle params. Pure logic, loads in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.drag = CB.drag || {};

(function () {
  'use strict';
  function V() { return CB.race && CB.race.vehicle; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { var n = Number(v); return v != null && isFinite(n) ? n : d; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  var AMBIENT = 28, CURVE_STEP = 50, FT60 = 60 * 0.3048;

  /* ------------------------------------------------------------ burnout */
  var burnout = {
    AMBIENT: AMBIENT, IDEAL: [70, 95], HOT: 110,
    create: function () { return { temp: AMBIENT, heat: 0, overheated: false, spinT: 0 }; },
    /** o = { spinning, throttle 0..1, rpmFrac 0..1, powerFactor (~kW / 300), gain (surface) } */
    step: function (b, dt, o) {
      o = o || {};
      if (o.spinning) {
        var pf = clamp(num(o.powerFactor, 1), 0.35, 1.8);
        var rate = num(o.gain, 1) * (8 + 8 * pf) * clamp(num(o.throttle, 1), 0, 1) * (0.3 + 0.7 * clamp(num(o.rpmFrac, 0.7), 0, 1));
        b.temp += rate * dt; b.spinT += dt;
      }
      b.temp -= (b.temp - AMBIENT) * 0.009 * dt * (o.moving ? 1.6 : 1);
      b.temp = clamp(b.temp, AMBIENT - 5, 190);
      if (b.temp > burnout.HOT) b.overheated = true;
      b.heat = clamp((b.temp - AMBIENT) / (burnout.IDEAL[0] - AMBIENT), 0, 1);
      return b;
    },
    /** Grip multiplier delta for the tyre temperature on a surface (SURFACES[].maxBonus). */
    bonus: function (b, surf) {
      var T = typeof b === 'number' ? b : b.temp, mx = surf && surf.maxBonus != null ? surf.maxBonus : 0.06;
      if (T <= 40) return 0;
      if (T < 70) return mx * (T - 40) / 30;
      if (T <= 95) return mx;
      if (T <= 110) return lerp(mx, mx * 0.6, (T - 95) / 15);
      return lerp(mx * 0.6, -0.06, clamp((T - 110) / 30, 0, 1));
    },
    /** 0..1 "warm" for the vehicle's tyreWarm (Cup / slick drive grip needs heat). */
    warm: function (b) { var T = typeof b === 'number' ? b : b.temp; return clamp((T - 35) / 45, 0, 1); },
    label: function (b) { var T = typeof b === 'number' ? b : b.temp; return T < 45 ? 'cold' : T < 70 ? 'warming' : T <= 95 ? 'ideal' : T <= 110 ? 'hot' : 'overheated'; }
  };

  /* ------------------------------------------------------------ params variants */
  function copy(p, o) { var c = Object.assign({}, p, o || {}); return c; }
  function withLaunchRpm(p, rpm) {
    if (p.isEV || p.converter) return p;
    return copy(p, { launchRpm: clamp(rpm, p.idle + 300, p.redline * 0.98) });
  }
  /** Assists: tc 'car'|0..3, launchControl bool (only honoured when the build has it). */
  function withAssists(p, a) {
    a = a || {};
    var o = {};
    if (a.tc != null && a.tc !== 'car') o.tcLevel = clamp(Math.round(num(a.tc, p.tcLevel)), 0, 3);
    if (a.launchControl === false && p.launchControl) o.launchControl = false;
    return Object.keys(o).length ? copy(p, o) : p;
  }
  /** N2O: a constant-power shot from 2500 rpm (capped at +90 % torque), for the Pro Mod class. */
  function nitrousParams(p, shotHp) {
    shotHp = num(shotHp, 0);
    if (!(shotHp > 0) || p.isEV) return p;
    var kw = shotHp * 0.7457, tab = p.torqueTable.slice();
    for (var i = 0; i < tab.length; i++) {
      var rpm = i * CURVE_STEP;
      var on = clamp((rpm - 2500) / 600, 0, 1);
      if (on <= 0) continue;
      var add = kw * 1000 / (rpm * Math.PI / 30);
      tab[i] += Math.min(add, tab[i] * 0.9) * on;
    }
    return copy(p, { torqueTable: tab, powerKw: p.powerKw + kw, peakNm: Math.max(p.peakNm, Math.max.apply(null, tab)), nitrous: shotHp });
  }

  /* ------------------------------------------------------------ sweet spot */
  var ssCache = {};
  /** 60-ft time for a launch at rpm (held 1.2 s, then released). */
  function sixtyAt(p, rpm, env) {
    var Vh = V(), pp = withLaunchRpm(p, rpm);
    var s = Vh.createState(pp, { x: 0, y: 0, heading: 0, autoShift: true });
    var dt = 1 / 120, hold = { throttle: pp.converter || pp.isEV ? 1 : clamp((rpm - pp.idle) / Math.max(1, pp.redline * 1.02 - pp.idle), 0, 1), hold: true };
    for (var t = 0; t < 1.2; t += dt) Vh.step(pp, s, hold, dt, env);
    s.engineRpm = s.rpm = pp.isEV ? 0 : Math.max(s.engineRpm, Math.min(rpm, pp.redline));
    var inp = { throttle: 1 };
    for (t = 0; t < 6; t += dt) { Vh.step(pp, s, inp, dt, env); if (s.x >= FT60) return t + dt; }
    return 9;
  }
  /** Time from the brake release to the tyre clearing the stage beam (staged d0 m in), for an AI's release timing. */
  function rolloutTime(p, env, rpm, d0) {
    var Vh = V(), pp = rpm ? withLaunchRpm(p, rpm) : p, target = 0.29 - num(d0, 0.04);
    var s = Vh.createState(pp, { x: 0, y: 0, heading: 0, autoShift: true }), dt = 1 / 120;
    var hold = { throttle: pp.converter || pp.isEV || pp.launchControl ? 1 : clamp((num(rpm, pp.launchRpm) - pp.idle) / Math.max(1, pp.redline * 1.02 - pp.idle), 0, 1), hold: true };
    for (var t = 0; t < 1; t += dt) Vh.step(pp, s, hold, dt, env);
    for (t = 0; t < 2; t += dt) { Vh.step(pp, s, { throttle: 1 }, dt, env); if (s.x >= target) return t + dt; }
    return 0.3;
  }
  /** { lo, hi, best, t60, ev, converter, lc } — the band of launch rpm within 0.015 s of the best 60 ft. */
  function sweetSpot(p, env, opts) {
    opts = opts || {};
    env = env || { gripMult: 1 };
    var key = [p.powerKw, p.mass, p.redline, p.finalDrive, p.ratios && p.ratios[0], p.compound, p.layout, p.tcLevel, p.launchControl, p.nitrous || 0,
      num(env.gripMult, 1).toFixed(3), num(env.wetness, 0)].join('|');
    if (ssCache[key]) return ssCache[key];
    var r;
    if (p.isEV) r = { lo: 0, hi: 0, best: 0, ev: true };
    else if (p.launchControl && opts.lc !== false) r = { lo: p.launchRpm - 250, hi: p.launchRpm + 250, best: p.launchRpm, lc: true };
    else if (p.converter) {
      var st = Math.min(num(p.stallRpm, 2400), p.redline * 0.6);
      r = { lo: st * 0.85, hi: p.redline, best: st, converter: true };
    } else {
      var lo0 = p.idle + 700, hi0 = p.redline * 0.95, n = opts.samples || 11, pts = [];
      for (var i = 0; i < n; i++) { var rpm = lo0 + (hi0 - lo0) * i / (n - 1); pts.push({ rpm: rpm, t: sixtyAt(p, rpm, env) }); }
      var b = pts.reduce(function (m, x) { return x.t < m.t ? x : m; }, pts[0]);
      var tol = b.t + 0.015, lo = b.rpm, hi = b.rpm;
      pts.forEach(function (x) { if (x.t <= tol) { lo = Math.min(lo, x.rpm); hi = Math.max(hi, x.rpm); } });
      var w = (hi0 - lo0) / (n - 1) * 0.5;        // half a sample step either side of the measured band
      r = { lo: Math.max(lo0, lo - w * 0.6), hi: Math.min(hi0, hi + w * 0.6), best: b.rpm, t60: b.t };
      if (r.hi - r.lo < 500) { var m = (r.hi + r.lo) / 2; r.lo = m - 250; r.hi = m + 250; }
    }
    ssCache[key] = r;
    return r;
  }

  /* ------------------------------------------------------------ shifting */
  function optimalShift(p, gear) {
    var up = p.upshiftRpm || [];
    return num(up[Math.max(0, Math.min(up.length - 1, gear - 1))], p.redline * 0.95);
  }
  /** Grade an upshift taken at rpm from gear. limiterT = s spent on the limiter just before. */
  function grade(rpm, gear, p, limiterT) {
    var opt = optimalShift(p, gear), d = (rpm - opt) / p.redline;
    if (num(limiterT, 0) > 0.15) return 'late';
    if (Math.abs(d) <= 0.025) return 'perfect';
    if (Math.abs(d) <= 0.06) return 'good';
    return d < 0 ? 'early' : 'late';
  }
  /** Shift-light bar: level 0..1 from (optimal - 1800 rpm) to optimal, flash inside the perfect window. */
  function shiftLight(rpm, gear, p) {
    if (p.isEV || p.isCVT || gear >= p.maxGear || gear < 1) return { level: 0, flash: false, target: null };
    var opt = optimalShift(p, gear), lo = opt - Math.min(1800, opt * 0.3);
    var lvl = clamp((rpm - lo) / (opt - lo), 0, 1);
    return { level: lvl, flash: rpm >= opt - 0.025 * p.redline, target: opt };
  }

  /* ------------------------------------------------------------ quick tune */
  /** tuneBuild(build, { finalDrive, gearSpread (0.85..1.15, 1 = as built) }) -> new build (same Garage fields). */
  function tuneBuild(build, t) {
    t = t || {};
    var b = JSON.parse(JSON.stringify(build || {}));
    b.transmission = b.transmission || {};
    if (t.finalDrive != null && isFinite(t.finalDrive)) b.transmission.finalDrive = Math.round(clamp(t.finalDrive, 2.5, 5.5) * 100) / 100;
    var sp = num(t.gearSpread, 1);
    if (Math.abs(sp - 1) > 1e-3 && b.transmission.type !== 'single-speed' && b.transmission.type !== 'cvt') {
      var ratios = Array.isArray(b.transmission.ratios) && b.transmission.ratios.length ? b.transmission.ratios.slice() : null;
      if (!ratios && V()) { try { ratios = V().fromBuild(build).ratios.slice(); } catch (e) { ratios = null; } }
      if (ratios && ratios.length > 1) {
        var top = ratios[ratios.length - 1];
        b.transmission.ratios = ratios.map(function (r) { return Math.round(clamp(top * Math.pow(r / top, sp), 0.3, 7.5) * 1000) / 1000; });
        b.transmission.gears = ratios.length;
      }
    }
    return b;
  }

  CB.drag.launch = {
    burnout: burnout, withLaunchRpm: withLaunchRpm, withAssists: withAssists, nitrousParams: nitrousParams,
    sweetSpot: sweetSpot, sixtyAt: sixtyAt, rolloutTime: rolloutTime, optimalShift: optimalShift, grade: grade, shiftLight: shiftLight, tuneBuild: tuneBuild,
    _clearCache: function () { ssCache = {}; }
  };
})();

if (typeof module !== 'undefined') module.exports = CB.drag.launch;

/* ==========================================================================
   Redline — js/drag/drag-timing.js
   CB.drag.timing : beam crossings, splits, ET, trap speeds, timeslip text, personal bests and ghost share
   codes (docs/DRAG-SPEC.md §3). Pure logic (localStorage feature-detected). Loads in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.drag = CB.drag || {};

(function () {
  'use strict';
  function S() { return CB.drag.strip; }
  function num(v, d) { var n = Number(v); return v != null && isFinite(n) ? n : d; }
  var MPH = 2.2369363, KPH = 3.6;

  /* ------------------------------------------------------------ lane timer */
  function createLane(def) {
    var st = S(), G = st.GEO;
    def = typeof def === 'string' ? st.get(def) : def || st.get('quarter');
    var marks = {};
    def.splits.forEach(function (sp) { if (sp.m != null) marks[sp.id] = sp.m; });
    (def.traps || []).forEach(function (id) {
      var sp = def.splits.filter(function (x) { return x.id === id; })[0];
      if (sp) marks['trap:' + id] = sp.m - G.TRAP_LEN;
    });
    return {
      def: def.id, distM: def.m || null, speedRace: !!def.speed, toV: def.toV || null,
      started: false, tStart: null, tLeave: null, rt: null, et: null, trap: null, finished: false, finishT: null,
      marks: marks, cross: {}, splits: def.splits.map(function (sp) { return { id: sp.id, label: sp.label, m: sp.m == null ? null : sp.m, kph: sp.kph || null, t: null, v: null }; }),
      traps: {}, prevT: null, prevX: null, prevV: null
    };
  }
  /** Start the clock explicitly (roll races start at the green). */
  function startAt(lt, t) { if (!lt.started) { lt.started = true; lt.tStart = t; lt.tLeave = t; } return lt; }
  function lerpT(t0, t1, a0, a1, a) { return a1 === a0 ? t1 : t0 + (t1 - t0) * (a - a0) / (a1 - a0); }

  /** Feed one sample (sim time t, front-tyre position from the stage beam, speed m/s). Returns new split ids. */
  function update(lt, t, xF, v) {
    var out = [];
    var G = S().GEO;
    var pT = lt.prevT == null ? t : lt.prevT, pX = lt.prevX == null ? xF : lt.prevX, pV = lt.prevV == null ? v : lt.prevV;
    // the clock starts when the front tyre clears the stage beam (roll races: startAt(green) instead)
    if (!lt.started && lt.def !== 'roll' && xF >= G.ROLLOUT) {
      lt.started = true; lt.tStart = lt.tLeave = pX < G.ROLLOUT ? lerpT(pT, t, pX, xF, G.ROLLOUT) : t;
    }
    if (lt.started && !lt.finished) {
      var k;
      for (k in lt.marks) {
        if (lt.cross[k] == null && xF >= lt.marks[k]) lt.cross[k] = lerpT(pT, t, pX, xF, lt.marks[k]) - lt.tStart;
      }
      for (var i = 0; i < lt.splits.length; i++) {
        var sp = lt.splits[i];
        if (sp.t != null) continue;
        if (sp.m != null && lt.cross[sp.id] != null) {
          sp.t = lt.cross[sp.id];
          var tw = lt.cross['trap:' + sp.id];
          if (tw != null && sp.t > tw) { sp.v = G.TRAP_LEN / (sp.t - tw); lt.traps[sp.id] = sp.v; }
          else sp.v = lerpT(pV, v, pX, xF, sp.m);
          out.push(sp.id);
        } else if (sp.kph != null && v * KPH >= sp.kph && pV * KPH < sp.kph + 1e-9) {
          sp.t = lerpT(pT, t, pV, v, sp.kph / KPH) - lt.tStart; sp.v = sp.kph / KPH; out.push(sp.id);
        }
      }
      var last = lt.splits[lt.splits.length - 1];
      if (last.t != null) {
        lt.finished = true; lt.et = last.t; lt.finishT = lt.tStart + last.t; lt.trap = last.m != null ? last.v : null;
      }
    }
    lt.prevT = t; lt.prevX = xF; lt.prevV = v;
    return out;
  }
  function split(lt, id) { for (var i = 0; i < lt.splits.length; i++) if (lt.splits[i].id === id) return lt.splits[i]; return null; }

  /* ------------------------------------------------------------ formatting */
  function f3(v) { return v == null || !isFinite(v) ? '--.---' : (v < 0 ? '-' : '') + Math.abs(v).toFixed(3); }
  function speedStr(v, units) { if (v == null || !isFinite(v)) return '---.--'; return units === 'metric' ? (v * KPH).toFixed(1) + ' km/h' : (v * MPH).toFixed(2) + ' mph'; }
  function pad(s, w) { s = String(s); while (s.length < w) s += ' '; return s; }
  function padL(s, w) { s = String(s); while (s.length < w) s = ' ' + s; return s; }

  /** Monospace timeslip for one lane (or both when lane == null). res = session results. */
  function slipText(res, lane, opts) {
    opts = opts || {};
    var units = opts.units || 'imperial';
    var lanes = lane == null ? [0, 1] : [lane];
    lanes = lanes.filter(function (i) { return res.lanes[i] && res.lanes[i].kind !== 'none'; });
    var W = 19, lines = [];
    var title = opts.title || 'REDLINE DRAGWAY';
    lines.push(title);
    lines.push((res.distanceName || '') + (res.bracket ? '  BRACKET' : '') + (opts.date ? '  ' + opts.date : ''));
    lines.push(pad('', 14) + lanes.map(function (i) { return padL(i === 0 ? 'LEFT' : 'RIGHT', W); }).join(''));
    function row(label, fn) { lines.push(pad(label, 14) + lanes.map(function (i) { return padL(fn(res.lanes[i]), W); }).join('')); }
    row('NAME', function (l) { return String(l.name || '').slice(0, W - 1); });
    row('CAR', function (l) { return String(l.carName || '').slice(0, W - 1); });
    if (res.bracket) row('DIAL', function (l) { return f3(l.dial); });
    row('R/T', function (l) { return l.red ? f3(l.rt) + ' RED' : f3(l.rt); });
    var first = res.lanes[lanes[0]];
    (first.splits || []).forEach(function (sp, si) {
      row(sp.label.toUpperCase(), function (l) { var x = l.splits && l.splits[si]; return x ? f3(x.t) : f3(null); });
      if (sp.m != null && (sp.id === 'eighth' || sp.id === 'quarter' || sp.id === 'half' || sp.id === 'km')) {
        row('  ' + (units === 'metric' ? 'KM/H' : 'MPH'), function (l) { var x = l.splits && l.splits[si]; return x && x.t != null ? speedStr(x.v, units).replace(/ (mph|km\/h)$/, '') : '---.--'; });
      }
    });
    row('RESULT', function (l) { return l.won ? 'WIN' + (res.holeshot ? ' (HOLESHOT)' : '') : res.winner == null ? '-' : l.red ? 'RED LIGHT' : l.breakout ? 'BREAKOUT' : l.dq ? 'DQ' : 'LOSS'; });
    if (res.margin_s != null && lanes.length > 1) lines.push('MARGIN OF VICTORY ' + res.margin_s.toFixed(3) + ' s' + (res.marginFt != null ? ' (' + res.marginFt.toFixed(1) + ' ft)' : ''));
    return lines.join('\n');
  }

  /* ------------------------------------------------------------ records */
  var KEY = 'forge.drag.records.v1', memStore = null;
  function storage() { try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* blocked */ } return null; }
  function load() {
    var ls = storage();
    if (!ls) return memStore || (memStore = {});
    try { var o = JSON.parse(ls.getItem(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }
  function save(o) { var ls = storage(); if (!ls) { memStore = o; return; } try { ls.setItem(KEY, JSON.stringify(o)); } catch (e) { /* full */ } }
  /** Car key from a build: model / preset id + a short hash of the tuning fields that change the ET. */
  function carKey(build, fallback) {
    if (!build) return String(fallback || 'car');
    var b = build, base = (b.body && b.body.model) || b.presetId || b.name || fallback || 'car';
    var parts = [b.engine && b.engine.layout, b.engine && b.engine.displacement_l, b.engine && b.engine.aspiration, b.engine && b.engine.tune,
      b.engine && b.engine.type, b.transmission && b.transmission.type, b.transmission && b.transmission.finalDrive, b.drivetrain && b.drivetrain.layout,
      b.tires && b.tires.compound, b.weight && b.weight.ballast_kg, b.name];
    var str = JSON.stringify(parts), h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return base + '#' + (h >>> 0).toString(36);
  }
  /** Submit a lane result; returns { pb (new best ET), prev (old best|null), best }. */
  function submit(key, distanceId, lr) {
    if (!lr || lr.red || lr.dq || !isFinite(lr.et)) return { pb: false, prev: best(key, distanceId), best: best(key, distanceId) };
    var all = load(), k = key + '|' + distanceId, prev = all[k] || null;
    var rec = prev ? Object.assign({}, prev) : { runs: 0 };
    rec.runs = (rec.runs || 0) + 1;
    var pb = !prev || !(prev.et <= lr.et);
    if (pb) { rec.et = lr.et; rec.trap = lr.trap; rec.rt = lr.rt; rec.splits = (lr.splits || []).map(function (s) { return { id: s.id, t: s.t, v: s.v }; }); rec.carName = lr.carName; rec.at = Date.now(); }
    if (isFinite(lr.rt) && lr.rt >= 0 && !(rec.bestRt <= lr.rt)) rec.bestRt = lr.rt;
    if (isFinite(lr.trap) && !(rec.bestTrap >= lr.trap)) rec.bestTrap = lr.trap;
    all[k] = rec; save(all);
    return { pb: pb, prev: prev, best: rec };
  }
  function best(key, distanceId) { var r = load()[key + '|' + distanceId]; return r || null; }
  function clear() { save({}); }

  /* ------------------------------------------------------------ ghosts */
  function b64e(s) {
    var u = unescape(encodeURIComponent(s));
    if (typeof btoa === 'function') return btoa(u);
    return Buffer.from(u, 'binary').toString('base64');
  }
  function b64d(s) {
    var u = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    return decodeURIComponent(escape(u));
  }
  /** run = { name, carName, modelId, color, distanceId, rt, et, trap, trace: [x (m from the line) at 10 Hz from the green] } */
  function encodeGhost(run) {
    var tr = (run.trace || []).map(function (x) { return Math.round(x * 10); });
    var d = [], prev = 0;
    for (var i = 0; i < tr.length; i++) { d.push(tr[i] - prev); prev = tr[i]; }
    var o = { v: 1, n: String(run.name || 'Ghost').slice(0, 24), c: String(run.carName || '').slice(0, 40), m: run.modelId || null,
      k: run.color || null, d: run.distanceId, r: Math.round(num(run.rt, 0) * 1000), e: Math.round(num(run.et, 0) * 1000),
      s: Math.round(num(run.trap, 0) * 100), t: d.join(',') };
    return 'RLD1' + b64e(JSON.stringify(o)).replace(/=+$/, '');
  }
  function decodeGhost(code) {
    try {
      code = String(code || '').trim().replace(/\s+/g, '');
      if (code.slice(0, 4) !== 'RLD1') return null;
      var body = code.slice(4); while (body.length % 4) body += '=';
      var o = JSON.parse(b64d(body));
      if (!o || o.v !== 1 || typeof o.t !== 'string') return null;
      var acc = 0, trace = o.t.split(',').filter(function (x) { return x !== ''; }).map(function (x) { acc += Number(x) || 0; return acc / 10; });
      if (trace.length < 2 || !S().get(o.d)) return null;
      return { v: 1, name: o.n, carName: o.c, modelId: o.m, color: o.k, distanceId: o.d, rt: o.r / 1000, et: o.e / 1000, trap: o.s / 100, trace: trace };
    } catch (e) { return null; }
  }
  /** Ghost position (m from the line) at time tg seconds after its green. */
  function ghostX(run, tg) {
    var tr = run.trace, f = tg * 10;
    if (f <= 0) return tr[0];
    var i = Math.floor(f);
    if (i >= tr.length - 1) { var n = tr.length; var vEnd = (tr[n - 1] - tr[n - 2]) * 10; return tr[n - 1] + vEnd * (f - (n - 1)) / 10; }
    var a = f - i;
    return tr[i] + (tr[i + 1] - tr[i]) * a;
  }

  CB.drag.timing = {
    createLane: createLane, update: update, startAt: startAt, split: split, slipText: slipText, f3: f3, speedStr: speedStr, MPH: MPH,
    records: { KEY: KEY, load: load, submit: submit, best: best, clear: clear, carKey: carKey },
    encodeGhost: encodeGhost, decodeGhost: decodeGhost, ghostX: ghostX
  };
})();

if (typeof module !== 'undefined') module.exports = CB.drag.timing;

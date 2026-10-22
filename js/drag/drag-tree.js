/* ==========================================================================
   Redline — js/drag/drag-tree.js
   CB.drag.tree : the Christmas tree (Pro / Sportsman / flag start), red lights and the race decision
   (heads-up and bracket) — docs/DRAG-SPEC.md §2. Pure logic, plain JSON state. Loads in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.drag = CB.drag || {};

(function () {
  'use strict';
  function num(v, d) { var n = Number(v); return v != null && isFinite(n) ? n : d; }
  /** mulberry32 step on a seed -> [0, 1) */
  function rand(seed) {
    var t = (seed >>> 0) + 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  var GAP = { pro: 0.4, sportsman: 0.5 };

  function create(opts) {
    opts = opts || {};
    var type = opts.type === 'sportsman' || opts.type === 'flag' ? opts.type : 'pro';
    var h = Array.isArray(opts.handicap) ? [num(opts.handicap[0], 0), num(opts.handicap[1], 0)] : [0, 0];
    var m = Math.min(h[0], h[1]); h = [h[0] - m, h[1] - m];
    return { type: type, seed: (num(opts.seed, 1) >>> 0), handicap: h, armed: false, armT: null, startT: null,
      greenT: [null, null], red: [false, false], redT: [null, null] };
  }
  /** Both lanes staged at t: the auto-start fires the ambers 0.6–1.4 s later (flag: "ready" now, drop 1.0–2.4 s later). */
  function arm(tr, t) {
    if (tr.armed) return tr;
    tr.armed = true; tr.armT = t;
    var r1 = rand(tr.seed), r2 = rand(tr.seed ^ 0x9e3779b9);
    if (tr.type === 'flag') {
      tr.startT = t;
      var drop = t + 1.0 + 1.4 * r2;
      tr.greenT = [drop + tr.handicap[0], drop + tr.handicap[1]];
    } else {
      tr.startT = t + 0.6 + 0.8 * r1;
      var g = tr.type === 'sportsman' ? GAP.sportsman * 3 : GAP.pro;
      tr.greenT = [tr.startT + tr.handicap[0] + g, tr.startT + tr.handicap[1] + g];
    }
    return tr;
  }
  /** Mark a lane's red light (left before its green). */
  function foul(tr, lane, t) { if (!tr.red[lane]) { tr.red[lane] = true; tr.redT[lane] = t; } return tr; }
  /** Amber i (0 = top) on-time for a lane. */
  function amberT(tr, lane, i) {
    if (!tr.armed || tr.type === 'flag') return null;
    var base = tr.startT + tr.handicap[lane];
    return tr.type === 'sportsman' ? base + GAP.sportsman * i : base;
  }
  /** Bulbs of one side of the tree at time t. st = { preStaged, staged, deep } of that lane. */
  function lights(tr, t, lane, st) {
    st = st || {};
    var L = { preStage: !!st.preStaged && !st.deep, stage: !!st.staged, amber: [false, false, false], green: false, red: false };
    if (tr.armed && tr.type !== 'flag') {
      var gT = tr.greenT[lane];
      for (var i = 0; i < 3; i++) {
        var a = amberT(tr, lane, i);
        // ambers go out when the green comes on (or the red)
        L.amber[i] = t >= a && t < gT && !(tr.red[lane] && t >= tr.redT[lane]);
      }
      L.green = t >= gT && !tr.red[lane];
    } else if (tr.armed) L.green = t >= tr.greenT[lane] && !tr.red[lane];
    L.red = tr.red[lane] && t >= tr.redT[lane];
    return L;
  }
  function flagState(tr, t) {
    if (tr.type !== 'flag' || !tr.armed) return null;
    return t >= Math.min(tr.greenT[0], tr.greenT[1]) ? 'drop' : 'ready';
  }
  /** Reaction time of a lane that cleared the stage beam at tLeave (negative = red light). */
  function reaction(tr, lane, tLeave) { return tr.greenT[lane] == null ? null : tLeave - tr.greenT[lane]; }

  /**
   * decide(a, b, opts { bracket }) — a, b = { rt, et, red, dq, finished, dial, redT }.
   * -> { winner 0|1|null, reason 'red'|'dq'|'faster'|'breakout'|'closer'|'solo'|'none', margin_s, holeshot }
   */
  function decide(a, b, opts) {
    opts = opts || {};
    var L = [a || {}, b || {}];
    function bad(x) { return !!x.red || !!x.dq; }
    function fin(x) { return x.finished && isFinite(x.et) && isFinite(x.rt); }
    var res = { winner: null, reason: 'none', margin_s: null, holeshot: false };
    // a single lane (solo pass)
    if (!b || b.none) { res.winner = bad(L[0]) ? null : 0; res.reason = bad(L[0]) ? (L[0].red ? 'red' : 'dq') : 'solo'; return res; }
    if (L[0].red || L[1].red) {
      if (L[0].red && L[1].red) res.winner = num(L[0].redT, 0) <= num(L[1].redT, 0) ? 1 : 0;   // the first red loses
      else res.winner = L[0].red ? 1 : 0;
      res.reason = 'red';
      if (L[0].red && L[1].red) res.winner = num(L[0].rt, -1) < num(L[1].rt, -1) ? 1 : 0;
      return res;
    }
    if (L[0].dq || L[1].dq) { res.winner = L[0].dq && L[1].dq ? null : L[0].dq ? 1 : 0; res.reason = 'dq'; return res; }
    if (!fin(L[0]) || !fin(L[1])) {
      if (fin(L[0]) || fin(L[1])) { res.winner = fin(L[0]) ? 0 : 1; res.reason = 'faster'; }
      return res;
    }
    var pkg = [L[0].rt + L[0].et, L[1].rt + L[1].et];
    if (opts.bracket) {
      var d = [num(L[0].dial, L[0].et), num(L[1].dial, L[1].et)];
      var bo = [L[0].et < d[0], L[1].et < d[1]];
      if (bo[0] || bo[1]) {
        if (bo[0] && bo[1]) {               // both broke out: the smaller breakout wins
          var o0 = d[0] - L[0].et, o1 = d[1] - L[1].et;
          res.winner = o0 <= o1 ? 0 : 1; res.margin_s = Math.abs(o0 - o1);
        } else { res.winner = bo[0] ? 1 : 0; res.margin_s = Math.abs((L[0].et - d[0]) - (L[1].et - d[1])); }
        res.reason = 'breakout';
        return res;
      }
      // handicap start: the first to the finish = the lower rt + (et - dial)
      var p0 = L[0].rt + L[0].et - d[0], p1 = L[1].rt + L[1].et - d[1];
      res.winner = p0 <= p1 ? 0 : 1; res.reason = 'closer'; res.margin_s = Math.abs(p0 - p1);
      return res;
    }
    res.winner = pkg[0] <= pkg[1] ? 0 : 1;
    res.reason = 'faster';
    res.margin_s = Math.abs(pkg[0] - pkg[1]);
    var w = res.winner, l = 1 - w;
    res.holeshot = L[w].et > L[l].et && L[w].rt < L[l].rt;
    return res;
  }

  CB.drag.tree = { create: create, arm: arm, foul: foul, lights: lights, amberT: amberT, flagState: flagState, reaction: reaction,
    decide: decide, GAP: GAP, _rand: rand };
})();

if (typeof module !== 'undefined') module.exports = CB.drag.tree;

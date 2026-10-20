/* ==========================================================================
   Redline — js/race/gl/f1-scenery.js
   CB.gl.f1scenery : Formula 1 circuit furniture for the 3D scenery (docs/F1-SPEC.md §2). Load after
   js/race/gl/scenery.js (and js/f1/f1-circuits.js for the resolved metadata; it falls back to def.f1).

   CB.gl.scenery.buildGeometry calls CB.gl.f1scenery.decorate(api) for every track whose def has an `f1` block, with
   api = { wr (scenery Writer), B, geom, def, occ, note, gy(x, y), quality, Q, night, lin, mix, mul, COL, WHITE, rnd }.
   It adds, batched into the same static meshes as the rest of the scenery:
     * the pit wall between the track and the pit lane (concrete + catch fence) with the team pit-wall stands,
     * pit lane paint: the white line between the fast lane and the box lane, entry / exit lines, one box per team in
       the team colour (box_s order = CB.f1.teams order), PIT LIMIT boards at the lane entry,
     * DRS boards at each activation point plus the painted detection and activation lines across the track,
     * sector marker boards,
     * landmarks: the Las Vegas sphere (glowing), floodlight gantries are authored as lamps in the circuit recipe.
   decorate() also returns stats { pitWall_m, boxes, drsBoards }. Pure geometry through the Writer: runs in Node.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

CB.gl.f1scenery = (function () {
  'use strict';

  var PI = Math.PI;
  function mod(a, n) { return ((a % n) + n) % n; }
  function fin(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  function teamColours() {
    var T = CB.f1 && CB.f1.teams && CB.f1.teams.list;
    return Array.isArray(T) && T.length ? T.map(function (t) { return t.livery.primary; })
      : ['#ff8000', '#dc0000', '#1b2a59', '#b9bfc4', '#00594f', '#1663c7', '#1868db', '#f4f6fa', '#8e959a', '#f0f0f0', '#0c0c0d'];
  }

  /** resolved F1 metadata for the geometry (CB.f1.circuits.meta when loaded; otherwise derived from def.f1) */
  function metaFor(geom, def) {
    var C = CB.f1 && CB.f1.circuits;
    if (C && typeof C.meta === 'function') { try { var m = C.meta(def.id); if (m && Math.abs(m.length_m - geom.length) < 1) return m; } catch (e) { /* derive */ } }
    var F = def.f1 || {}, L = geom.length, P = F.pit || {};
    function sOf(u) { return mod(fin(u, 0), 1) * L; }
    var side = P.side > 0 ? 1 : -1, wid = P.width_m || 11, off = P.offset_m || (geom.samples[0].hw + 4 + wid / 2), sp = P.boxSpacing_m || 14;
    var entry = sOf(P.entry), exit = sOf(P.exit), b0 = sOf(P.box0 != null ? P.box0 : P.entry + 0.03);
    return {
      length_m: L, sectors_s: (geom.sectors || []).slice(1).map(function (s) { return s.start; }),
      drs: (F.drs || []).map(function (z) { return { detect_s: sOf(z.detect), start_s: sOf(z.start), end_s: sOf(z.end) }; }),
      pit: { side: side, entry_s: entry, exit_s: exit, length_m: mod(exit - entry, L), offset_m: off, width_m: wid, speedLimit_kph: P.speedLimit_kph || 80,
        box_s: function (i) { return mod(b0 + i * sp, L); }, boxSpacing_m: sp }
    };
  }

  function decorate(api) {
    var wr = api.wr, geom = api.geom, def = api.def || geom.def || {}, lin = api.lin, mix = api.mix, mul = api.mul, COL = api.COL || {};
    var WHITE = api.WHITE || [1, 1, 1, 1], night = !!api.night, gy = api.gy || function () { return 0; };
    var S = geom.samples, N = S.length, L = geom.length, ds = geom.ds || L / N;
    var stats = { pitWall_m: 0, boxes: 0, drsBoards: 0 };
    if (!wr || !S || !N || !def.f1) return stats;
    var M = metaFor(geom, def), P = M.pit, side = P.side;
    var concrete = COL.concrete || lin('#b9b6ae'), dark = COL.dark || lin('#25272b'), steel = COL.steel || lin('#9aa2aa');
    var paintW = lin('#f2f2f2'), yellow = lin('#f4c419'), green = lin('#22c55e');
    function sampleAt(s) { return S[Math.round(mod(s, L) / ds) % N]; }
    /** writer frame at arc s, on the centreline, heading along the track (+Z = right of the race direction) */
    function at(s, lat) {
      var sm = sampleAt(s), la = lat || 0;
      wr.at(sm.x + sm.nx * la, sm.y + sm.ny * la, sm.heading, gy(sm.x + sm.nx * la, sm.y + sm.ny * la));
      return sm;
    }
    // local Z of a signed lateral (left = +lateral) is -lateral
    function z(lat) { return -lat; }

    /* ---------- pit wall + stands (full-width lane section only) ---------- */
    var teams = teamColours(), step = 4;
    for (var d = 0; d < P.length_m; d += step) {
      var s = P.entry_s + d, sm = sampleAt(s), pq = sm.pit;
      if (!pq || pq.t < 0.98) continue;
      var lat = side * Math.max(sm.hw + 1.2, pq.inner - 0.7);
      at(s, 0);
      wr.use('paint', 'all');
      wr.boxY(0, -0.2, z(lat), step + 0.02, 1.15, 0.6, concrete, { top: mul(concrete, 0.85) });
      // painted lane line between the fast lane and the box lane + the pit lane edge line
      wr.face([[-step / 2, 0.035, z(side * pq.centre) - 0.12], [step / 2, 0.035, z(side * pq.centre) - 0.12], [step / 2, 0.035, z(side * pq.centre) + 0.12], [-step / 2, 0.035, z(side * pq.centre) + 0.12]], paintW, null, [0, -1, z(side * pq.centre)]);
      var ie = side * (pq.inner + 0.2);
      wr.face([[-step / 2, 0.035, z(ie) - 0.1], [step / 2, 0.035, z(ie) - 0.1], [step / 2, 0.035, z(ie) + 0.1], [-step / 2, 0.035, z(ie) + 0.1]], paintW, null, [0, -1, z(ie)]);
      // catch fence on the wall
      wr.use('metal', 'detail');
      if (Math.round(d / step) % 2 === 0) wr.boxY(0, 1.15, z(lat), 0.08, 3.6, 0.08, steel);
      stats.pitWall_m += step;
    }
    /* team boxes painted in the box lane + pit-wall stands */
    for (var t = 0; t < teams.length; t++) {
      var bs = P.box_s(t), bm = sampleAt(bs);
      if (!bm.pit) continue;
      var tc = lin(teams[t]), bl = side * (bm.pit.centre + bm.pit.outer) / 2, bw = Math.max(2.5, bm.pit.outer - bm.pit.centre - 0.6);
      at(bs, 0);
      wr.use('paint', 'all');
      var hl = Math.min(4.5, (P.boxSpacing_m || 12) / 2 - 0.6);
      [[-hl, -bw / 2, hl * 2, 0.22], [-hl, bw / 2 - 0.22, hl * 2, 0.22]].forEach(function (r) {
        wr.face([[r[0], 0.04, z(bl) + r[1]], [r[0] + r[2], 0.04, z(bl) + r[1]], [r[0] + r[2], 0.04, z(bl) + r[1] + r[3]], [r[0], 0.04, z(bl) + r[1] + r[3]]], tc, null, [0, -1, z(bl)]);
      });
      wr.face([[-hl, 0.04, z(bl) - bw / 2], [-hl + 0.3, 0.04, z(bl) - bw / 2], [-hl + 0.3, 0.04, z(bl) + bw / 2], [-hl, 0.04, z(bl) + bw / 2]], tc, null, [0, -1, z(bl)]);
      // pit-wall stand (gantry roof in team colour) on the track side of the wall
      var wl = side * Math.max(bm.hw + 1.2, bm.pit.inner - 0.7);
      wr.boxY(0, 1.15, z(wl), 3.6, 2.1, 1.4, mul(dark, 1.3));
      wr.boxY(0, 2.1, z(wl), 4.0, 2.35, 1.8, tc);
      stats.boxes++;
    }
    /* entry / exit: speed-limit boards on the pit side */
    [[P.entry_s + 10, 'PIT ' + (P.speedLimit_kph || 80)], [mod(P.entry_s + P.length_m - 20, L), 'PIT EXIT']].forEach(function (b) {
      var sm2 = sampleAt(b[0]), wlat = side * ((side > 0 ? sm2.wallL : sm2.wallR) + 1.5);
      at(b[0], 0);
      wr.use('metal', 'all'); wr.boxY(0, 0, z(wlat), 0.12, 2.6, 0.12, steel);
      wr.use(night ? 'signsLit' : 'signs', 'all');
      wr.signX(z(wlat) - 1.1, z(wlat) + 1.1, 2.0, 3.1, -0.08, -1, b[1], WHITE, 'plain', '#1d3d8f');
    });

    /* ---------- DRS: boards at activation, painted detection / activation lines ---------- */
    (M.drs || []).forEach(function (zn, k) {
      [[zn.detect_s, yellow, false], [zn.start_s, paintW, true]].forEach(function (ln) {
        var smL = at(ln[0], 0), hw = smL.hw;
        wr.use('paint', 'all');
        for (var q = -hw; q < hw - 0.2; q += 1.2) {
          wr.face([[-0.2, 0.03, q], [0.2, 0.03, q], [0.2, 0.03, q + 0.7], [-0.2, 0.03, q + 0.7]], ln[1], null, [0, -1, q]);
        }
        if (!ln[2]) return;
        // DRS board on both sides at the activation line
        [1, -1].forEach(function (sd) {
          var wlat2 = sd * ((sd > 0 ? smL.wallL : smL.wallR) + 1.2);
          at(ln[0], 0);
          wr.use('metal', 'all'); wr.boxY(0, 0, z(wlat2), 0.12, 2.8, 0.12, steel);
          wr.use(night ? 'signsLit' : 'signs', 'all');
          wr.signX(z(wlat2) - 1.0, z(wlat2) + 1.0, 2.0, 3.3, -0.08, -1, 'DRS', WHITE, 'plain', '#0b8f3a');
          stats.drsBoards++;
        });
      });
      void k; void green;
    });

    /* ---------- sector boards ---------- */
    (M.sectors_s || []).forEach(function (ss, k) {
      var smS = sampleAt(ss), sd = -side, wl3 = sd * ((sd > 0 ? smS.wallL : smS.wallR) + 1.5);
      at(ss, 0);
      wr.use('metal', 'all'); wr.boxY(0, 0, z(wl3), 0.1, 2.2, 0.1, steel);
      wr.use(night ? 'signsLit' : 'signs', 'all');
      wr.signX(z(wl3) - 0.7, z(wl3) + 0.7, 1.6, 2.5, -0.06, -1, 'S' + (k + 2), WHITE, 'plain', '#7a1fa2');
    });

    /* ---------- landmarks ---------- */
    (geom.scenery || []).forEach(function (o) {
      if (o.type !== 'f1-landmark' || o.variant !== 'sphere') return;
      var R = Math.max(10, Math.min(o.l, o.w) / 2), base = gy(o.x, o.y);
      wr.at(o.x, o.y, 0, base);
      wr.use(night || o.lit ? 'glow' : 'paint', 'all');
      var acc = lin(o.accent || '#ff2a8a'), body = lin(o.color || '#1b1b2e');
      wr.blob(0, R * 0.92, 0, R, R, R, night || o.lit ? mix(acc, [2.2, 1.2, 2.6, 1], 0.4) : body, null, 0);
      wr.use('paint', 'all');
      wr.cyl(0, -0.5, 0, R * 0.55, R * 0.5, R * 0.25, 16, mul(body, 1.3));
    });
    return stats;
  }

  return { decorate: decorate, metaFor: metaFor };
})();

if (typeof module !== 'undefined') module.exports = CB.gl.f1scenery;

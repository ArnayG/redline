/* ==========================================================================
   Redline — js/race/gl/derby-arena-mesh.js
   CB.gl.derbyArena : meshes for the Demolition Derby arenas (docs/DERBY-SPEC.md §2, §9).

     outline(def, step?) -> [{x, y, open}]          PURE closed CCW outline samples (open = the edge after it has no wall)
     buildGeometry(def, {quality}) -> PURE { groups {ground, outer, walls, obstacles, deco, crowd, glow, decal, glass},
                                             dynamic {fires[], lamps[], spots[], crushers[]}, stats {triangles, groups} }
     build(ctx, def, {quality}) -> { items, dyn, meshes {crusherPlate, flame}, stats, groundMaterial, destroy() }
   GL world = [x, z, -y] (sim x east, y north, z up). Uses CB.gl.derbyParts.Geo (load derby-parts.js first) and
   CB.derby.arenas for the signed distances. Deterministic (seeded per arena). Node-loadable.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.gl = CB.gl || {};

(function () {
  'use strict';
  var PI = Math.PI, TAU = PI * 2;
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function P() { return CB.gl.derbyParts; }
  function AR() { return CB.derby && CB.derby.arenas; }
  function hex(h, k) { return P().hex(h, k); }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1]; }
  function scale(c, k) { return [c[0] * k, c[1] * k, c[2] * k, c[3] == null ? 1 : c[3]]; }
  function W(x, y, h) { return [x, h, -y]; }   // sim -> GL
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function noise2(x, y) {
    // cheap value noise (deterministic)
    function hsh(i, j) { var h = Math.imul(i * 374761393 + j * 668265263, 1274126177) >>> 0; h = (h ^ (h >>> 13)) >>> 0; return (Math.imul(h, 1103515245) >>> 0) / 4294967296; }
    var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    var u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    var a = hsh(xi, yi), b = hsh(xi + 1, yi), c = hsh(xi, yi + 1), d = hsh(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  var THEME = {
    mud: { outer: '#4a5a2c', outer2: '#5a4a30', wall: '#b9b6ae', band: ['#c8261c', '#f2f2f2', '#1c4fc8', '#f2c200'], stands: '#6a4a2e', sky: 'dusk' },
    figure8: { outer: '#3f6a2a', outer2: '#4c7a32', wall: '#e8e8e8', band: ['#d01818', '#f2f2f2'], stands: '#5a5f68', sky: 'day' },
    junkyard: { outer: '#6a5a44', outer2: '#5a4a38', wall: '#7a5a3a', band: ['#8a4a2a', '#5a5a5a', '#9a7a3a'], stands: '#4a4a4a', sky: 'day' },
    ice: { outer: '#e8eef4', outer2: '#d0dce6', wall: '#f4f4f4', band: ['#1c4fc8', '#d01818'], stands: '#30343c', sky: 'night' },
    rooftop: { outer: '#2a2c30', outer2: '#33363b', wall: '#9a9a98', band: ['#f2c200', '#141414'], stands: '#555', sky: 'dusk' },
    colosseum: { outer: '#8a7050', outer2: '#7a6044', wall: '#c8a87a', band: ['#a8885a', '#b8986a'], stands: '#b09068', sky: 'night' }
  };
  function themeOf(def) { return THEME[def.theme] || THEME.mud; }

  /* ------------------------------------------------------------------ outline (pure) */
  function outline(def, step) {
    step = step || 2;
    var b = def.boundary, out = [];
    if (b.type === 'ellipse') {
      var per = PI * (3 * (b.rx + b.ry) - Math.sqrt((3 * b.rx + b.ry) * (b.rx + 3 * b.ry)));
      var n = Math.max(24, Math.round(per / step));
      for (var i = 0; i < n; i++) { var a = i / n * TAU; out.push({ x: Math.cos(a) * b.rx, y: Math.sin(a) * b.ry, open: false }); }
    } else if (b.type === 'roundrect') {
      var r = b.r, hw = b.hw - r, hh = b.hh - r;
      var corners = [[hw, -hh, -PI / 2], [hw, hh, 0], [-hw, hh, PI / 2], [-hw, -hh, PI]];
      // CCW: start bottom-right corner arc (from -90° to 0°), right side, top-right arc ...
      for (var c = 0; c < 4; c++) {
        var cc = corners[c], na = Math.max(4, Math.round(r * PI / 2 / step));
        for (var k = 0; k < na; k++) { var ang = cc[2] + k / na * PI / 2; out.push({ x: cc[0] + Math.cos(ang) * r, y: cc[1] + Math.sin(ang) * r, open: false }); }
        var nx = corners[(c + 1) % 4], ea = cc[2] + PI / 2;
        var sx = cc[0] + Math.cos(ea) * r, sy = cc[1] + Math.sin(ea) * r, ex = nx[0] + Math.cos(ea) * r, ey = nx[1] + Math.sin(ea) * r;
        var ls = Math.hypot(ex - sx, ey - sy), ns = Math.max(1, Math.round(ls / step));
        for (var q = 0; q < ns; q++) out.push({ x: sx + (ex - sx) * q / ns, y: sy + (ey - sy) * q / ns, open: false });
      }
    } else {
      var pts = b.pts, open = b.open || [];
      for (var e = 0; e < pts.length; e++) {
        var A = pts[e], B = pts[(e + 1) % pts.length], l = Math.hypot(B[0] - A[0], B[1] - A[1]), m = Math.max(1, Math.round(l / step));
        for (var s = 0; s < m; s++) out.push({ x: A[0] + (B[0] - A[0]) * s / m, y: A[1] + (B[1] - A[1]) * s / m, open: open.indexOf(e) >= 0, edge: e });
      }
    }
    return out;
  }
  /** outward unit normal of segment i -> i+1 (CCW outline: outward = right of the direction) */
  function segOut(o, i) { var A = o[i], B = o[(i + 1) % o.length], dx = B.x - A.x, dy = B.y - A.y, l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; }
  /** vertex normal (average of the adjacent segments) */
  function vtxOut(o, i) { var a = segOut(o, (i - 1 + o.length) % o.length), b = segOut(o, i), x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1; return [x / l, y / l]; }

  /* ------------------------------------------------------------------ geometry (pure) */
  function buildGeometry(def, opts) {
    opts = opts || {};
    var Geo = P().Geo, q = opts.quality || 'high', low = q === 'low', hi = q === 'high' || q === 'ultra';
    var R = P().rng(hashStr(def.id) || 7);
    var th = themeOf(def), A = AR();
    var G = {
      ground: new Geo(), outer: new Geo(), walls: new Geo(), obstacles: new Geo(), deco: new Geo(), crowd: new Geo(),
      glow: new Geo(), decal: new Geo(), glass: new Geo()
    };
    var dyn = { fires: [], lamps: [], spots: [], crushers: [], torches: [], turntables: [], pushers: [], conveyors: [] };
    var surf = def.surface || {}, base = hex(surf.color || '#6a5a44');
    var wallH = num(def.wall && def.wall.height, 1.2), style = (def.wall && def.wall.style) || 'concrete';
    var o = outline(def, low ? 3 : 2);
    var bd = def.bounds;
    var rooftop = def.theme === 'rooftop';
    var X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

    /* ---- arena floor: grid with colour variation */
    var cell = low ? 3 : hi ? 1.5 : 2;
    var x0 = bd.minX - 2, x1 = bd.maxX + 2, y0 = bd.minY - 2, y1 = bd.maxY + 2;
    var nx = Math.ceil((x1 - x0) / cell), ny = Math.ceil((y1 - y0) / cell);
    function floorCol(x, y) {
      var n = noise2(x * 0.18, y * 0.18) * 0.6 + noise2(x * 0.7 + 31, y * 0.7 + 17) * 0.4;
      var c;
      if (surf.kind === 'ice') { c = scale(mix(hex('#dfe9f2'), hex('#b4c8da'), n * 0.7), 0.78); }
      else if (surf.kind === 'asphalt') c = scale(base, 0.85 + n * 0.3);
      else if (surf.kind === 'concrete') c = scale(base, 0.82 + n * 0.32);
      else {
        c = scale(base, 0.72 + n * 0.5);
        // tyre ruts: concentric darker rings in dirt bowls
        var rr = Math.hypot(x / Math.max(1, bd.maxX), y / Math.max(1, bd.maxY));
        var rut = Math.pow(Math.abs(Math.sin(rr * 18 + n * 2)), 6) * 0.25;
        c = scale(c, 1 - rut);
      }
      // hazard tint (mud darker / wet, slush whiter)
      (def.hazards || []).forEach(function (h) {
        if (h.type !== 'mud' && h.type !== 'oil') return;
        var d = Math.hypot(x - h.x, y - h.y) / h.r;
        if (d < 1.15) {
          var t = clamp(1.15 - d, 0, 1);
          if (h.type === 'mud' && num(h.grip, 1) > 1) c = mix(c, hex('#b8c0c8'), t * 0.7);
          else if (h.type === 'mud') c = mix(c, hex('#2e2014'), t * 0.75);
        }
      });
      return c;
    }
    var inside = function (x, y) { var s = A.sdBoundary(def, x, y); return s.d > (s.open || rooftop ? -0.05 : -1.6); };
    var gIdx = {};
    var gg = G.ground;
    function gv(i, j) {
      var k = i + ',' + j;
      if (gIdx[k] != null) return gIdx[k];
      var x = x0 + i * cell, y = y0 + j * cell;
      // clamp floor vertices of the rooftop to the slab outline so the open edge is straight
      var hz = 0;
      return (gIdx[k] = gg.v(W(x, y, hz), [0, 1, 0], floorCol(x, y)));
    }
    for (var i = 0; i < nx; i++) for (var j = 0; j < ny; j++) {
      var cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell;
      if (!inside(cx, cy)) continue;
      var a = gv(i, j), b = gv(i + 1, j), c2 = gv(i + 1, j + 1), d = gv(i, j + 1);
      gg.i.push(a, b, c2, a, c2, d);
    }

    /* ---- surroundings */
    if (!rooftop) {
      var O = G.outer, oc1 = hex(th.outer), oc2 = hex(th.outer2), ro = 420, seg = low ? 32 : 64;
      var ctr = O.v([0, -0.06, 0], [0, 1, 0], oc1), first = O.p.length / 3;
      for (var k = 0; k < seg; k++) { var an = k / seg * TAU; O.v([Math.cos(an) * ro, -0.06, Math.sin(an) * ro], [0, 1, 0], k % 2 ? oc1 : oc2); }
      for (k = 0; k < seg; k++) O.i.push(ctr, first + (k + 1) % seg, first + k);
    } else {
      // the car park slab edge and the building facade dropping to the street 45 m below
      var F = G.walls, facade = hex('#6c6e72'), win = hex('#ffd890', 2.2), winOff = hex('#1a1c22');
      for (var s = 0; s < o.length; s++) {
        var p0 = o[s], p1 = o[(s + 1) % o.length], no = segOut(o, s);
        var a0 = [p0.x + no[0] * 0.3, p0.y + no[1] * 0.3], a1 = [p1.x + no[0] * 0.3, p1.y + no[1] * 0.3];
        F.quad(W(a0[0], a0[1], 0), W(a1[0], a1[1], 0), W(a1[0], a1[1], -45), W(a0[0], a0[1], -45), facade);
        F.quad(W(p0.x, p0.y, 0.0), W(p1.x, p1.y, 0.0), W(a1[0], a1[1], 0.0), W(a0[0], a0[1], 0.0), hex('#8a8a88'));
        // window rows
        for (var fl = 1; fl < 9; fl++) {
          var lit = R() < 0.45;
          var yy = -fl * 4.6;
          G.glow.quad(W(a0[0] + no[0] * 0.02, a0[1] + no[1] * 0.02, yy + 1.2), W(a1[0] + no[0] * 0.02, a1[1] + no[1] * 0.02, yy + 1.2), W(a1[0] + no[0] * 0.02, a1[1] + no[1] * 0.02, yy), W(a0[0] + no[0] * 0.02, a0[1] + no[1] * 0.02, yy), lit ? win : winOff);
        }
        if (p0.open) {
          // yellow / black hazard lip on the open edge
          G.decal.quad(W(p0.x - no[0] * 0.6, p0.y - no[1] * 0.6, 0.012), W(p1.x - no[0] * 0.6, p1.y - no[1] * 0.6, 0.012), W(p1.x, p1.y, 0.012), W(p0.x, p0.y, 0.012), s % 2 ? hex('#f2c200') : hex('#141414'));
        }
      }
      // street far below + city
      var S2 = G.outer, st = hex('#1c1d20');
      S2.quad([-600, -45, -600], [-600, -45, 600], [600, -45, 600], [600, -45, -600], st);
      for (var rx = -5; rx <= 5; rx++) {
        S2.quad([rx * 60 - 4, -44.95, -600], [rx * 60 - 4, -44.95, 600], [rx * 60 + 4, -44.95, 600], [rx * 60 + 4, -44.95, -600], hex('#2a2b2e'));
        S2.quad([-600, -44.95, rx * 60 - 4], [600, -44.95, rx * 60 - 4], [600, -44.95, rx * 60 + 4], [-600, -44.95, rx * 60 + 4], hex('#2a2b2e'));
      }
    }

    /* ---- walls along the outline (none on open edges) */
    var bandCols = th.band.map(function (c) { return hex(c); });
    var wc = hex(th.wall), wt = style === 'stone' ? 1.2 : style === 'scrap' ? 0.9 : 0.45;
    for (var sI = 0; sI < o.length; sI++) {
      var A0 = o[sI], A1 = o[(sI + 1) % o.length];
      if (A0.open) continue;
      var n0 = vtxOut(o, sI), n1 = vtxOut(o, (sI + 1) % o.length);
      var h0 = wallH, h1 = wallH;
      var colIn = wc, colTop = scale(wc, 1.08);
      var segLen = Math.hypot(A1.x - A0.x, A1.y - A0.y);
      var along = sI * segLen;
      if (style === 'concrete') { colIn = Math.floor(along / 9) % 3 === 0 ? bandCols[Math.floor(along / 27) % bandCols.length] : scale(wc, 0.95 + 0.1 * R()); }
      else if (style === 'barrier') colIn = sI % 2 ? hex('#d01818') : hex('#f2f2f2');
      else if (style === 'scrap') { h0 = wallH * (0.85 + R() * 0.35); h1 = h0; colIn = scale(hex(['#7a4a2a', '#5a5a5a', '#8a6a3a', '#4a3a2a', '#6a2a1a'][Math.floor(R() * 5)]), 0.8 + R() * 0.3); colTop = colIn; }
      else if (style === 'glass') { colIn = hex('#f4f4f4'); }
      else if (style === 'stone') { colIn = scale(wc, 0.85 + 0.2 * noise2(sI * 0.7, 3)); colTop = scale(wc, 1.05); }
      var i0 = [A0.x, A0.y], i1 = [A1.x, A1.y], e0 = [A0.x + n0[0] * wt, A0.y + n0[1] * wt], e1 = [A1.x + n1[0] * wt, A1.y + n1[1] * wt];
      var WG = G.walls;
      WG.quad(W(i0[0], i0[1], 0), W(i1[0], i1[1], 0), W(i1[0], i1[1], h1), W(i0[0], i0[1], h0), colIn);
      WG.quad(W(i0[0], i0[1], h0), W(i1[0], i1[1], h1), W(e1[0], e1[1], h1), W(e0[0], e0[1], h0), colTop);
      WG.quad(W(e0[0], e0[1], h0), W(e1[0], e1[1], h1), W(e1[0], e1[1], 0), W(e0[0], e0[1], 0), scale(colIn, 0.8));
      if (style === 'concrete' && sI % 2 === 0) G.decal.quad(W(i0[0] - n0[0] * 0.01, i0[1] - n0[1] * 0.01, 0.15), W(i1[0] - n1[0] * 0.01, i1[1] - n1[1] * 0.01, 0.15), W(i1[0] - n1[0] * 0.01, i1[1] - n1[1] * 0.01, 0.3), W(i0[0] - n0[0] * 0.01, i0[1] - n0[1] * 0.01, 0.3), hex('#141414'));
      if (style === 'glass') {
        // yellow kick strip + glass panes above the boards + posts
        G.decal.quad(W(i0[0] - n0[0] * 0.01, i0[1] - n0[1] * 0.01, 0.0), W(i1[0] - n1[0] * 0.01, i1[1] - n1[1] * 0.01, 0.0), W(i1[0] - n1[0] * 0.01, i1[1] - n1[1] * 0.01, 0.22), W(i0[0] - n0[0] * 0.01, i0[1] - n0[1] * 0.01, 0.22), hex('#f2c200'));
        G.glass.quad(W(i0[0] + n0[0] * 0.2, i0[1] + n0[1] * 0.2, h0), W(i1[0] + n1[0] * 0.2, i1[1] + n1[1] * 0.2, h1), W(i1[0] + n1[0] * 0.2, i1[1] + n1[1] * 0.2, h1 + 1.6), W(i0[0] + n0[0] * 0.2, i0[1] + n0[1] * 0.2, h0 + 1.6), [0.6, 0.75, 0.85, 0.18]);
        if (sI % 3 === 0) G.walls.aabb(W(i0[0] + n0[0] * 0.2, i0[1] + n0[1] * 0.2, h0 + 0.8), 0.04, 0.8, 0.04, hex('#d8dce2'));
      }
      if (style === 'stone') {
        // block lines + crenellation + torches
        if (sI % 2 === 0) G.decal.quad(W(i0[0] - n0[0] * 0.01, i0[1] - n0[1] * 0.01, h0 * 0.48), W(i1[0] - n1[0] * 0.01, i1[1] - n1[1] * 0.01, h1 * 0.48), W(i1[0] - n1[0] * 0.01, i1[1] - n1[1] * 0.01, h1 * 0.52), W(i0[0] - n0[0] * 0.01, i0[1] - n0[1] * 0.01, h0 * 0.52), hex('#7a6040'));
        if (sI % 3 === 0) WG.aabb(W((i0[0] + e0[0]) / 2, (i0[1] + e0[1]) / 2, h0 + 0.3), 0.4, 0.3, 0.4, colTop);
        if (sI % Math.max(1, Math.round(o.length / num(def.decor && def.decor.torches, 0) || 9999)) === 0 && def.decor && def.decor.torches) {
          var tp = [i0[0] - n0[0] * 0.25, i0[1] - n0[1] * 0.25];
          G.deco.cyl(W(tp[0], tp[1], h0 * 0.62), W(tp[0], tp[1], h0 * 0.8), 0.08, 0.16, 6, hex('#3a2a1a'), true);
          dyn.torches.push({ pos: W(tp[0], tp[1], h0 * 0.86), size: 0.6 });
        }
      }
      if (style === 'scrap' && !low && R() < 0.5) {
        // crushed car slabs leaning on the outside of the wall
        var mid = [(e0[0] + e1[0]) / 2 + n0[0] * 1.2, (e0[1] + e1[1]) / 2 + n0[1] * 1.2];
        var rot = Math.atan2(A1.y - A0.y, A1.x - A0.x);
        for (var sl = 0; sl < 2 + Math.floor(R() * 3); sl++) G.obstacles.ybox(W(mid[0], mid[1], 0.35 + sl * 0.62), rot + (R() - 0.5) * 0.4, 1.9, 0.3, 0.85, scale(hex(['#8a2a1a', '#2a4a8a', '#c8b040', '#3a6a3a', '#9a9a9a', '#5a3a6a'][Math.floor(R() * 6)]), 0.6 + R() * 0.3));
      }
    }

    /* ---- stands + crowd */
    var dec = def.decor || {};
    var standKind = dec.stands;
    if (standKind) {
      var tiers = standKind === 'colosseum' ? (low ? 5 : 8) : standKind === 'rink' ? 5 : 4, rise = standKind === 'colosseum' ? 1.1 : 0.85, depth = standKind === 'colosseum' ? 1.4 : 1.15;
      var gap = standKind === 'colosseum' ? 1.4 : 4.0;
      var standC = hex(th.stands), crowd = num(dec.crowd, 0.7) * (low ? 0.3 : hi ? 1 : 0.6);
      var shirt = ['#d23a2a', '#2a6fd2', '#e0b21a', '#f2f2f2', '#2aa860', '#141414', '#e06a1a', '#8a3ad2', '#c0c0c0', '#5a8a2a'].map(function (c) { return hex(c); });
      var skin = [hex('#f0c8a0'), hex('#c89870'), hex('#8a5a3a'), hex('#5a3a2a')];
      for (var sj = 0; sj < o.length; sj++) {
        var B0 = o[sj], B1 = o[(sj + 1) % o.length];
        if (B0.open) continue;
        var sn = segOut(o, sj);
        if (standKind === 'sides' && Math.abs(sn[1]) < 0.85) continue;
        var m0 = vtxOut(o, sj), m1 = vtxOut(o, (sj + 1) % o.length);
        var base0 = wallH + 0.2;
        if (standKind !== 'colosseum' && sj % 3 === 0) {
          var fd = wt + gap * 0.45, fp0 = [B0.x + m0[0] * fd, B0.y + m0[1] * fd];
          G.deco.cyl(W(fp0[0], fp0[1], 0), W(fp0[0], fp0[1], 3.6), 0.05, 0.05, 4, hex('#9aa0a8'), false);
        }
        if (standKind !== 'colosseum') {
          var fdd = wt + gap * 0.45, fa = [B0.x + m0[0] * fdd, B0.y + m0[1] * fdd], fb = [B1.x + m1[0] * fdd, B1.y + m1[1] * fdd];
          G.glass.quad(W(fa[0], fa[1], 0.2), W(fb[0], fb[1], 0.2), W(fb[0], fb[1], 3.6), W(fa[0], fa[1], 3.6), [0.55, 0.58, 0.62, 0.16]);
          G.deco.beam(W(fa[0], fa[1], 3.6), W(fb[0], fb[1], 3.6), 0.03, hex('#9aa0a8'));
        }
        for (var t = 0; t < tiers; t++) {
          var dIn = wt + gap + t * depth, dOut = dIn + depth, hT = base0 + t * rise;
          var q0 = [B0.x + m0[0] * dIn, B0.y + m0[1] * dIn], q1 = [B1.x + m1[0] * dIn, B1.y + m1[1] * dIn];
          var r0 = [B0.x + m0[0] * dOut, B0.y + m0[1] * dOut], r1 = [B1.x + m1[0] * dOut, B1.y + m1[1] * dOut];
          var tc = scale(standC, (t % 2 ? 0.92 : 1.05));
          G.deco.quad(W(q0[0], q0[1], hT), W(q1[0], q1[1], hT), W(r1[0], r1[1], hT), W(r0[0], r0[1], hT), tc);
          G.deco.quad(W(q0[0], q0[1], hT - rise), W(q1[0], q1[1], hT - rise), W(q1[0], q1[1], hT), W(q0[0], q0[1], hT), scale(tc, 0.75));
          if (t === 0) G.deco.quad(W(q0[0], q0[1], 0), W(q1[0], q1[1], 0), W(q1[0], q1[1], hT - rise), W(q0[0], q0[1], hT - rise), scale(tc, 0.6));
          // spectators
          var len = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]), np = Math.floor(len / 0.75);
          for (var pp = 0; pp < np; pp++) {
            if (R() > crowd) continue;
            var f = (pp + 0.5) / np, px = q0[0] + (q1[0] - q0[0]) * f + m0[0] * depth * 0.45, py = q0[1] + (q1[1] - q0[1]) * f + m0[1] * depth * 0.45;
            var sc = shirt[Math.floor(R() * shirt.length)], arms = R() < 0.25;
            if (low) G.crowd.aabb(W(px, py, hT + 0.38), 0.17, 0.38, 0.15, sc, true);
            else {
              var sit = R() < 0.4, bh = sit ? 0.24 : 0.32;
              G.crowd.aabb(W(px, py, hT + bh), 0.17, bh, 0.13, sc, true);
              G.crowd.aabb(W(px, py, hT + bh * 2 + 0.1), 0.09, 0.1, 0.09, skin[Math.floor(R() * skin.length)], true);
              if (arms) G.crowd.aabb(W(px, py, hT + bh * 2 + 0.22), 0.22, 0.04, 0.04, sc, true);
            }
          }
        }
        // back wall of the stands
        var dB = wt + gap + tiers * depth, hB = base0 + tiers * rise;
        var b0 = [B0.x + m0[0] * dB, B0.y + m0[1] * dB], b1 = [B1.x + m1[0] * dB, B1.y + m1[1] * dB];
        G.deco.quad(W(b0[0], b0[1], 0), W(b1[0], b1[1], 0), W(b1[0], b1[1], hB + (standKind === 'colosseum' ? 3.5 : 1.2)), W(b0[0], b0[1], hB + (standKind === 'colosseum' ? 3.5 : 1.2)), scale(standC, 0.7));
        if (standKind === 'colosseum') {
          // outer facade with arches
          var fo = dB + 0.6;
          var f0 = [B0.x + m0[0] * fo, B0.y + m0[1] * fo], f1 = [B1.x + m1[0] * fo, B1.y + m1[1] * fo];
          G.walls.quad(W(f0[0], f0[1], 0), W(f1[0], f1[1], 0), W(f1[0], f1[1], hB + 5), W(f0[0], f0[1], hB + 5), hex('#b89870'));
          if (sj % 2 === 0) for (var lv = 0; lv < 3; lv++) G.glow.quad(W(f0[0] + m0[0] * 0.02, f0[1] + m0[1] * 0.02, 1.5 + lv * 4), W(f1[0] + m1[0] * 0.02, f1[1] + m1[1] * 0.02, 1.5 + lv * 4), W(f1[0] + m1[0] * 0.02, f1[1] + m1[1] * 0.02, 3.6 + lv * 4), W(f0[0] + m0[0] * 0.02, f0[1] + m0[1] * 0.02, 3.6 + lv * 4), hex('#ff9a40', 0.9));
        }
      }
    }

    /* ---- light towers, spotlights, lamp posts, flags */
    function ringPos(k, n, off, phase) {
      var idx = Math.floor(((k + (phase || 0.5)) / n) * o.length) % o.length;
      var pt = o[idx], nn = vtxOut(o, idx);
      return { x: pt.x + nn[0] * off, y: pt.y + nn[1] * off, nx: nn[0], ny: nn[1], open: pt.open };
    }
    var nTow = num(dec.lights, 0) + num(dec.spotlights, 0);
    var standDepth = standKind ? wt + 2.2 + (standKind === 'colosseum' ? 8 : 5) * 1.3 : 6;
    for (var tw = 0; tw < nTow; tw++) {
      var rp = ringPos(tw, nTow, standDepth + 2, 0.5);
      var hT2 = def.decor.spotlights ? 26 : 20;
      G.deco.cyl(W(rp.x, rp.y, 0), W(rp.x, rp.y, hT2), 0.35, 0.22, 8, hex('#5a5f68'), false);
      G.deco.aabb(W(rp.x, rp.y, hT2 + 0.8), 1.6, 0.9, 0.3, hex('#30343c'));
      var lampPos = W(rp.x - rp.nx * 0.5, rp.y - rp.ny * 0.5, hT2 + 0.8);
      for (var lx = -1; lx <= 1; lx++) G.glow.aabb([lampPos[0] + lx * 0.9 * rp.ny, lampPos[1], lampPos[2] + lx * 0.9 * rp.nx], 0.35, 0.3, 0.35, hex('#fff6e0', 4));
      if (def.decor.spotlights && tw >= num(dec.lights, 0)) dyn.spots.push({ pos: lampPos, phase: tw * 1.7 });
      else dyn.lamps.push({ pos: lampPos, dir: [-rp.nx, -0.75, rp.ny] });
    }
    if (dec.lampPosts) {
      for (var lp = 0; lp < dec.lampPosts; lp++) {
        var rl = ringPos(lp, dec.lampPosts, -0.6, 0.3);
        if (rl.open) continue;
        G.deco.cyl(W(rl.x, rl.y, 0), W(rl.x, rl.y, 6), 0.08, 0.08, 6, hex('#5a5f68'), false);
        G.deco.beam(W(rl.x, rl.y, 6), W(rl.x - rl.nx * 1.4, rl.y - rl.ny * 1.4, 6.2), 0.05, hex('#5a5f68'));
        G.glow.aabb(W(rl.x - rl.nx * 1.4, rl.y - rl.ny * 1.4, 6.05), 0.35, 0.06, 0.18, hex('#ffe2a8', 4));
        dyn.lamps.push({ pos: W(rl.x - rl.nx * 1.4, rl.y - rl.ny * 1.4, 5.9), dir: [0, -1, 0], post: true });
      }
    }
    if (dec.flags) {
      var nf = low ? 6 : 14, fcs = ['#d23a2a', '#f2c200', '#2a6fd2', '#f2f2f2', '#2aa860'];
      for (var fg = 0; fg < nf; fg++) {
        var rf = ringPos(fg, nf, wt * 0.5, 0.25);
        if (rf.open) continue;
        G.deco.cyl(W(rf.x, rf.y, wallH), W(rf.x, rf.y, wallH + 4), 0.04, 0.04, 5, hex('#c8c8c8'), false);
        var tx = -rf.ny, ty = rf.nx;
        G.deco.quad(W(rf.x, rf.y, wallH + 4), W(rf.x + tx * 1.4, rf.y + ty * 1.4, wallH + 3.75), W(rf.x + tx * 1.4, rf.y + ty * 1.4, wallH + 3.05), W(rf.x, rf.y, wallH + 3.2), hex(fcs[fg % fcs.length]));
      }
    }
    if (dec.hay) {
      for (var hb = 0; hb < (low ? 6 : 16); hb++) {
        var rh = ringPos(hb, low ? 6 : 16, wt + 1.0, 0.1);
        G.deco.cyl(W(rh.x - rh.ny * 0.7, rh.y + rh.nx * 0.7, 0.6), W(rh.x + rh.ny * 0.7, rh.y - rh.nx * 0.7, 0.6), 0.6, 0.6, 10, hex('#d8b450'), true);
      }
    }
    if (dec.cranes) {
      dec.cranes.forEach(function (cp, ci) {
        var cx2 = cp[0] * 1.15, cy2 = cp[1] * 1.15, ht = 24;
        for (var leg = 0; leg < 4; leg++) { var lxo = (leg % 2 ? 0.8 : -0.8), lyo = (leg < 2 ? 0.8 : -0.8); G.deco.beam(W(cx2 + lxo, cy2 + lyo, 0), W(cx2 + lxo * 0.6, cy2 + lyo * 0.6, ht), 0.08, hex('#e0a020')); }
        for (var hy = 3; hy < ht; hy += 3) G.deco.beam(W(cx2 - 0.75, cy2 + 0.75, hy), W(cx2 + 0.75, cy2 - 0.75, hy + 2.5), 0.05, hex('#c88a18'));
        var bdir = Math.atan2(-cy2, -cx2) + (ci ? 0.4 : -0.3);
        var tip = [cx2 + Math.cos(bdir) * 26, cy2 + Math.sin(bdir) * 26];
        G.deco.beam(W(cx2, cy2, ht + 0.5), W(tip[0], tip[1], ht + 2), 0.35, hex('#e0a020'));
        G.deco.beam(W(cx2, cy2, ht + 0.5), W(cx2 - Math.cos(bdir) * 7, cy2 - Math.sin(bdir) * 7, ht + 0.8), 0.4, hex('#e0a020'));
        G.deco.aabb(W(cx2 - Math.cos(bdir) * 7, cy2 - Math.sin(bdir) * 7, ht - 0.4), 1.2, 1.0, 1.2, hex('#5a5a5a'));
        G.deco.beam(W(tip[0], tip[1], ht + 2), W(tip[0], tip[1], 9), 0.03, hex('#222222'));
        G.deco.cyl(W(tip[0], tip[1], 9), W(tip[0], tip[1], 8.6), 1.1, 1.1, 12, hex('#444444'), true);
        // the crane holds a crushed car above the yard
        G.obstacles.ybox(W(tip[0], tip[1], 7.8), bdir, 1.9, 0.5, 0.85, hex('#7a2a1a'));
      });
    }
    if (dec.stacks) {
      for (var stc = 0; stc < dec.stacks; stc++) {
        var rs = ringPos(stc, dec.stacks, wt + 3 + R() * 6, 0.37);
        var nst = 2 + Math.floor(R() * 5), rot2 = R() * PI;
        for (var lv2 = 0; lv2 < nst; lv2++) G.obstacles.ybox(W(rs.x, rs.y, 0.32 + lv2 * 0.6), rot2 + (R() - 0.5) * 0.5, 2.1, 0.3, 0.9, scale(hex(['#8a2a1a', '#2a4a8a', '#c8b040', '#3a6a3a', '#9a9a9a', '#5a3a6a', '#d0d0d0'][Math.floor(R() * 7)]), 0.55 + R() * 0.35));
      }
    }
    if (dec.fence) {
      for (var fe = 0; fe < o.length; fe += 2) {
        var pf = o[fe], nf2 = vtxOut(o, fe), d2 = wt + 12;
        G.deco.cyl(W(pf.x + nf2[0] * d2, pf.y + nf2[1] * d2, 0), W(pf.x + nf2[0] * d2, pf.y + nf2[1] * d2, 3), 0.05, 0.05, 4, hex('#8a8e94'), false);
        var pn = o[(fe + 2) % o.length], nn2 = vtxOut(o, (fe + 2) % o.length);
        [1, 2, 2.9].forEach(function (hw) { G.deco.beam(W(pf.x + nf2[0] * d2, pf.y + nf2[1] * d2, hw), W(pn.x + nn2[0] * d2, pn.y + nn2[1] * d2, hw), 0.015, hex('#8a8e94')); });
      }
    }
    if (dec.skyline) {
      for (var bl = 0; bl < (low ? 30 : 70); bl++) {
        var ang2 = R() * TAU, dist = 90 + R() * 260, bx = Math.cos(ang2) * dist, by = Math.sin(ang2) * dist;
        var bw = 8 + R() * 18, bh = -45 + 20 + R() * (dist > 200 ? 140 : 80), bc = scale(hex(['#3a3e48', '#4a4e58', '#2e323a', '#555a64'][Math.floor(R() * 4)]), 0.8 + R() * 0.4);
        G.deco.ybox(W(bx, by, (bh - 45) / 2), ang2, bw / 2, (bh + 45) / 2, bw / 2, bc, true);
        if (!low) for (var wy = -40; wy < bh - 3; wy += 4) {
          if (R() < 0.5) continue;
          var ca = Math.cos(ang2), sa = Math.sin(ang2), fx2 = bx - ca * (bw / 2 + 0.05), fy2 = by - sa * (bw / 2 + 0.05);
          G.glow.quad(W(fx2 + sa * bw * 0.4, fy2 - ca * bw * 0.4, wy + 1.4), W(fx2 - sa * bw * 0.4, fy2 + ca * bw * 0.4, wy + 1.4), W(fx2 - sa * bw * 0.4, fy2 + ca * bw * 0.4, wy), W(fx2 + sa * bw * 0.4, fy2 - ca * bw * 0.4, wy), hex(R() < 0.7 ? '#ffd890' : '#a8d8ff', 1.6));
        }
      }
    }
    if (dec.parkingLines) {
      for (var row = -1; row <= 1; row += 2) for (var pl = -9; pl <= 9; pl++) {
        var px2 = pl * 2.8 + 22, py2 = row * 27;
        if (px2 > 54 || px2 < 10) continue;
        G.decal.quad(W(px2 - 0.06, py2 - row * 4.6, 0.01), W(px2 + 0.06, py2 - row * 4.6, 0.01), W(px2 + 0.06, py2 + row * 0.0, 0.01), W(px2 - 0.06, py2, 0.01), hex('#e8e8e8'));
      }
      // painted arrows on the lower deck
      [[-40, 0, 0], [36, 12, PI], [36, -12, PI]].forEach(function (ar) { var c = Math.cos(ar[2]), s = Math.sin(ar[2]); G.decal.quad(W(ar[0] - c * 2 - s * 0.3, ar[1] - s * 2 + c * 0.3, 0.01), W(ar[0] - c * 2 + s * 0.3, ar[1] - s * 2 - c * 0.3, 0.01), W(ar[0] + c * 1 + s * 0.3, ar[1] + s * 1 - c * 0.3, 0.01), W(ar[0] + c * 1 - s * 0.3, ar[1] + s * 1 + c * 0.3, 0.01), hex('#e8e8e8')); G.decal.tri(W(ar[0] + c * 1 + s * 0.9, ar[1] + s * 1 - c * 0.9, 0.01), W(ar[0] + c * 2.6, ar[1] + s * 2.6, 0.01), W(ar[0] + c * 1 - s * 0.9, ar[1] + s * 1 + c * 0.9, 0.01), hex('#e8e8e8')); });
    }
    if (dec.rinkLines) {
      var red = hex('#d01818', 0.9), blue = hex('#1c4fc8', 0.9), hh2 = def.boundary.hh || 25;
      G.decal.quad(W(-0.3, -hh2, 0.01), W(0.3, -hh2, 0.01), W(0.3, hh2, 0.01), W(-0.3, hh2, 0.01), red);
      [-15, 15].forEach(function (bx2) { G.decal.quad(W(bx2 - 0.3, -hh2, 0.01), W(bx2 + 0.3, -hh2, 0.01), W(bx2 + 0.3, hh2, 0.01), W(bx2 - 0.3, hh2, 0.01), blue); });
      [-40, 40].forEach(function (bx3) { G.decal.quad(W(bx3 - 0.08, -hh2 + 3, 0.01), W(bx3 + 0.08, -hh2 + 3, 0.01), W(bx3 + 0.08, hh2 - 3, 0.01), W(bx3 - 0.08, hh2 - 3, 0.01), red); });
      function ring2(cx3, cy3, r3, col) { for (var k3 = 0; k3 < 40; k3++) { var a1 = k3 / 40 * TAU, a2 = (k3 + 1) / 40 * TAU; G.decal.quad(W(cx3 + Math.cos(a1) * r3, cy3 + Math.sin(a1) * r3, 0.012), W(cx3 + Math.cos(a2) * r3, cy3 + Math.sin(a2) * r3, 0.012), W(cx3 + Math.cos(a2) * (r3 - 0.25), cy3 + Math.sin(a2) * (r3 - 0.25), 0.012), W(cx3 + Math.cos(a1) * (r3 - 0.25), cy3 + Math.sin(a1) * (r3 - 0.25), 0.012), col); } }
      ring2(0, 0, 5.5, blue);
      [[-30, 10], [-30, -10], [30, 10], [30, -10]].forEach(function (c4) { ring2(c4[0], c4[1], 4.5, red); });
    }
    if (dec.crossing) {
      // big yellow X + "DANGER" chevrons at the figure-8 crossover
      for (var dg = -1; dg <= 1; dg += 2) {
        var ca2 = Math.cos(dg * PI / 4), sa2 = Math.sin(dg * PI / 4);
        G.decal.quad(W(-ca2 * 14 - sa2 * 0.4, -sa2 * 14 + ca2 * 0.4, 0.01), W(-ca2 * 14 + sa2 * 0.4, -sa2 * 14 - ca2 * 0.4, 0.01), W(ca2 * 14 + sa2 * 0.4, sa2 * 14 - ca2 * 0.4, 0.01), W(ca2 * 14 - sa2 * 0.4, sa2 * 14 + ca2 * 0.4, 0.01), hex('#f2c200'));
      }
      // lane lines around the islands
      (def.obstacles || []).forEach(function (ob) {
        if (ob.kind !== 'island') return;
        var rr2 = ob.r + 6.5;
        for (var k4 = 0; k4 < 48; k4 += 2) { var a3 = k4 / 48 * TAU, a4 = (k4 + 1) / 48 * TAU; G.decal.quad(W(ob.x + Math.cos(a3) * rr2, ob.y + Math.sin(a3) * rr2, 0.01), W(ob.x + Math.cos(a4) * rr2, ob.y + Math.sin(a4) * rr2, 0.01), W(ob.x + Math.cos(a4) * (rr2 - 0.18), ob.y + Math.sin(a4) * (rr2 - 0.18), 0.01), W(ob.x + Math.cos(a3) * (rr2 - 0.18), ob.y + Math.sin(a3) * (rr2 - 0.18), 0.01), hex('#e8e8e8')); }
      });
    }

    /* ---- obstacles */
    var OB = G.obstacles;
    (def.obstacles || []).forEach(function (ob, oi) {
      var k = ob.kind, h = num(ob.h, 1.2);
      if (ob.type === 'circle') {
        if (k === 'tyres') {
          var stacks = [[0, 0]];
          if (ob.r > 1.1) for (var s3 = 0; s3 < 6; s3++) stacks.push([Math.cos(s3 / 6 * TAU) * (ob.r - 0.45), Math.sin(s3 / 6 * TAU) * (ob.r - 0.45)]);
          if (ob.r > 1.7) for (var s4 = 0; s4 < 10; s4++) stacks.push([Math.cos((s4 + 0.5) / 10 * TAU) * (ob.r - 0.05), Math.sin((s4 + 0.5) / 10 * TAU) * (ob.r - 0.05)]);
          stacks.forEach(function (st2, si) {
            var nt = Math.max(2, Math.round(h / 0.26)) - (si > 6 ? 1 : 0);
            for (var tt = 0; tt < nt; tt++) {
              var col = tt === nt - 1 && (si + oi) % 2 ? hex('#e8e8e8') : (si + tt) % 5 === 0 ? hex('#c8261c') : hex('#151515');
              OB.cyl(W(ob.x + st2[0], ob.y + st2[1], tt * 0.26), W(ob.x + st2[0], ob.y + st2[1], tt * 0.26 + 0.24), 0.42, 0.42, low ? 8 : 12, col, tt === nt - 1);
            }
          });
        } else if (k === 'island') {
          OB.cyl(W(ob.x, ob.y, 0), W(ob.x, ob.y, h), ob.r, ob.r - 0.2, low ? 24 : 48, hex('#3e7a2a'), true);
          var nTy = Math.round(ob.r * TAU / 0.85);
          for (var ti = 0; ti < nTy; ti++) { var at = ti / nTy * TAU; OB.cyl(W(ob.x + Math.cos(at) * ob.r, ob.y + Math.sin(at) * ob.r, 0), W(ob.x + Math.cos(at) * ob.r, ob.y + Math.sin(at) * ob.r, 0.5), 0.42, 0.42, 8, ti % 2 ? hex('#e8e8e8') : hex('#c8261c'), true); }
          for (var bu = 0; bu < (low ? 4 : 12); bu++) { var ab = R() * TAU, rb = R() * (ob.r - 3); OB.sphere(W(ob.x + Math.cos(ab) * rb, ob.y + Math.sin(ab) * rb, h + 0.6), 0.9 + R() * 0.9, 7, 5, hex('#2e6a22'), 0.8, 3 + bu); }
          // billboard on the island
          OB.aabb(W(ob.x, ob.y, h + 2.4), 0.12, 2.4, 0.12, hex('#5a5f68'));
          G.deco.ybox(W(ob.x, ob.y, h + 4.6), 0, 0.15, 1.3, 4.2, hex(oi % 2 ? '#d01818' : '#1c4fc8'));
        } else if (k === 'pillar') {
          var stone = def.theme === 'colosseum';
          OB.cyl(W(ob.x, ob.y, 0), W(ob.x, ob.y, h), ob.r, ob.r * 0.92, low ? 8 : 16, stone ? hex('#d0b48a') : hex('#a8a8a4'), true);
          if (stone) { OB.aabb(W(ob.x, ob.y, h + 0.15), ob.r * 1.3, 0.15, ob.r * 1.3, hex('#c0a07a')); OB.aabb(W(ob.x, ob.y, 0.15), ob.r * 1.25, 0.15, ob.r * 1.25, hex('#c0a07a')); }
          else for (var sb = 0; sb < 4; sb++) OB.cyl(W(ob.x, ob.y, sb * 0.25), W(ob.x, ob.y, sb * 0.25 + 0.125), ob.r + 0.01, ob.r + 0.01, 12, hex('#f2c200'), false);
        } else if (k === 'barrel') {
          OB.cyl(W(ob.x, ob.y, 0), W(ob.x, ob.y, h), ob.r, ob.r, 12, hex(oi % 2 ? '#1c4fc8' : '#c8261c'), true);
          OB.cyl(W(ob.x, ob.y, h * 0.33), W(ob.x, ob.y, h * 0.36), ob.r + 0.02, ob.r + 0.02, 12, hex('#3a3a3a'), false);
          OB.cyl(W(ob.x, ob.y, h * 0.66), W(ob.x, ob.y, h * 0.69), ob.r + 0.02, ob.r + 0.02, 12, hex('#3a3a3a'), false);
        } else if (k === 'statue') {
          var bronze = hex('#8a6a3a'), ped = hex('#d8c8a8');
          OB.cyl(W(ob.x, ob.y, 0), W(ob.x, ob.y, 2), ob.r, ob.r * 0.85, 16, ped, true);
          OB.aabb(W(ob.x, ob.y, 2.2), ob.r * 0.6, 0.2, ob.r * 0.6, ped);
          OB.beam(W(ob.x - 0.3, ob.y, 2.4), W(ob.x - 0.25, ob.y, 3.6), 0.17, bronze); OB.beam(W(ob.x + 0.3, ob.y, 2.4), W(ob.x + 0.4, ob.y + 0.2, 3.6), 0.17, bronze);
          OB.aabb(W(ob.x, ob.y, 4.3), 0.5, 0.75, 0.3, bronze);
          OB.sphere(W(ob.x, ob.y, 5.4), 0.32, 10, 6, bronze);
          OB.cone(W(ob.x, ob.y, 5.6), W(ob.x, ob.y, 6.2), 0.36, 8, bronze);
          OB.beam(W(ob.x + 0.6, ob.y, 4.6), W(ob.x + 1.1, ob.y + 0.3, 7.2), 0.05, bronze);   // spear
          OB.cyl(W(ob.x - 0.7, ob.y, 4.2), W(ob.x - 0.8, ob.y, 4.2), 0.65, 0.65, 14, bronze, true);   // shield
        } else if (k === 'zamboni') {
          OB.aabb(W(ob.x, ob.y, 0.7), 2.2, 0.65, 1.0, hex('#f2f2f2'));
          OB.aabb(W(ob.x, ob.y, 0.25), 2.25, 0.2, 1.05, hex('#1c4fc8'));
          OB.aabb(W(ob.x + 0.6, ob.y, 1.8), 0.5, 0.45, 0.6, hex('#c8dcec'));
          [[1.4, 0.9], [1.4, -0.9], [-1.4, 0.9], [-1.4, -0.9]].forEach(function (wl) { OB.cyl(W(ob.x + wl[0], ob.y + wl[1], 0.35), W(ob.x + wl[0], ob.y + wl[1] * 1.15, 0.35), 0.35, 0.35, 10, hex('#151515'), true); });
        } else if (k === 'scrap') {
          for (var sp2 = 0; sp2 < 5; sp2++) OB.sphere(W(ob.x + (R() - 0.5) * ob.r, ob.y + (R() - 0.5) * ob.r, R() * h * 0.5), ob.r * (0.45 + R() * 0.4), 6, 4, scale(hex(['#7a4a2a', '#5a5a5a', '#8a6a3a', '#3a3a3a'][sp2 % 4]), 0.7 + R() * 0.4), 0.7, 20 + oi * 7 + sp2);
          for (var sp3 = 0; sp3 < 4; sp3++) OB.ybox(W(ob.x + (R() - 0.5) * ob.r * 1.2, ob.y + (R() - 0.5) * ob.r * 1.2, 0.4 + R() * h * 0.6), R() * PI, 0.2 + R() * 0.8, 0.05 + R() * 0.2, 0.2 + R() * 0.6, hex('#6a6a6a'));
        } else {
          OB.cyl(W(ob.x, ob.y, 0), W(ob.x, ob.y, h), ob.r, ob.r, 10, hex('#8a8a8a'), true);
        }
      } else {
        var rot3 = ob.rot || 0, hw = ob.hw, hh3 = ob.hh;
        if (k === 'container') {
          var cc3 = hex(['#c8501a', '#1c5a9a', '#2a7a3a', '#9a1a1a', '#d8a020'][oi % 5]);
          OB.ybox(W(ob.x, ob.y, h / 2), rot3, hw, h / 2, hh3, cc3);
          var ca3 = Math.cos(rot3), sa3 = Math.sin(rot3);
          for (var rb2 = -Math.floor(hw / 0.6); rb2 <= Math.floor(hw / 0.6); rb2++) {
            [-1, 1].forEach(function (sd) {
              var px3 = ob.x + ca3 * rb2 * 0.6 - sa3 * sd * (hh3 + 0.03), py3 = ob.y + sa3 * rb2 * 0.6 + ca3 * sd * (hh3 + 0.03);
              OB.ybox(W(px3, py3, h / 2), rot3, 0.07, h / 2 - 0.08, 0.03, scale(cc3, 0.78));
            });
          }
          OB.ybox(W(ob.x, ob.y, h + 0.02), rot3, hw, 0.04, hh3, scale(cc3, 0.9));
        } else if (k === 'car-pile') {
          var nl = Math.max(2, Math.round(h / 0.55));
          for (var cl = 0; cl < nl; cl++) {
            var rr3 = rot3 + (R() - 0.5) * 0.35, cc4 = scale(hex(['#8a2a1a', '#2a4a8a', '#c8b040', '#3a6a3a', '#9a9a9a', '#5a3a6a', '#d0d0d0'][Math.floor(R() * 7)]), 0.6 + R() * 0.35);
            OB.ybox(W(ob.x + (R() - 0.5) * 0.3, ob.y + (R() - 0.5) * 0.3, 0.28 + cl * 0.55), rr3, hw * (0.85 + R() * 0.15), 0.26, hh3 * (0.8 + R() * 0.2), cc4);
            OB.ybox(W(ob.x, ob.y, 0.34 + cl * 0.55), rr3, hw * 0.5, 0.06, hh3 * 0.82, hex('#141820'));
          }
        } else if (k === 'barrier') {
          var nb = Math.max(1, Math.round(hw / 1));
          for (var bb = 0; bb < nb; bb++) {
            var f2 = -hw + (bb + 0.5) * (2 * hw / nb), ca4 = Math.cos(rot3), sa4 = Math.sin(rot3);
            OB.ybox(W(ob.x + ca4 * f2, ob.y + sa4 * f2, h / 2), rot3, hw / nb - 0.02, h / 2, hh3, bb % 2 ? hex('#d01818') : hex('#f2f2f2'));
          }
        } else if (k === 'goal') {
          var gc = hex('#d01818'), sx = ob.x > 0 ? 1 : -1;
          [-1, 1].forEach(function (sd) { OB.cyl(W(ob.x - sx * hw, ob.y + sd * hh3, 0), W(ob.x - sx * hw, ob.y + sd * hh3, h), 0.06, 0.06, 6, gc, true); });
          OB.cyl(W(ob.x - sx * hw, ob.y - hh3, h), W(ob.x - sx * hw, ob.y + hh3, h), 0.06, 0.06, 6, gc, true);
          G.glass.ybox(W(ob.x + sx * 0.1, ob.y, h / 2), rot3, hw * 0.9, h / 2, hh3 * 0.95, [0.95, 0.95, 0.95, 0.35]);
          G.decal.quad(W(ob.x - sx * hw - sx * 0.05, ob.y - hh3 - 0.5, 0.012), W(ob.x - sx * hw - sx * 2.0, ob.y - hh3 - 0.5, 0.012), W(ob.x - sx * hw - sx * 2.0, ob.y + hh3 + 0.5, 0.012), W(ob.x - sx * hw - sx * 0.05, ob.y + hh3 + 0.5, 0.012), hex('#7ab8ff', 0.9));
        } else if (k === 'block') {
          OB.ybox(W(ob.x, ob.y, h / 2), rot3, hw, h / 2, hh3, hex('#8a8a86'));
          OB.ybox(W(ob.x + Math.cos(rot3) * (hw + 0.02), ob.y + Math.sin(rot3) * (hw + 0.02), 1.1), rot3, 0.02, 1.1, 0.9, hex('#4a4e56'));
          G.glow.ybox(W(ob.x + Math.cos(rot3) * (hw + 0.04), ob.y + Math.sin(rot3) * (hw + 0.04), 2.6), rot3, 0.01, 0.2, 0.5, hex('#40ff80', 2.5));
          OB.ybox(W(ob.x, ob.y, 0.3), rot3, hw + 0.02, 0.3, hh3 + 0.02, hex('#f2c200'));
        } else {
          OB.ybox(W(ob.x, ob.y, h / 2), rot3, hw, h / 2, hh3, hex('#7a7a78'));
        }
      }
    });

    /* ---- ramps + raised decks */
    (def.ramps || []).forEach(function (rp2, ri) {
      var c5 = Math.cos(rp2.rot || 0), s5 = Math.sin(rp2.rot || 0), hw2 = rp2.hw, hh4 = rp2.hh, h2 = rp2.h;
      function L(u, v) { return [rp2.x + c5 * u - s5 * v, rp2.y + s5 * u + c5 * v]; }
      var kick = rp2.kind === 'kicker';
      var top = kick ? hex(def.theme === 'junkyard' ? '#7a6a5a' : '#9a9a9a') : hex('#8e8e8c'), side = kick ? hex('#4a4038') : hex('#6e6e6c');
      var p00 = L(-hw2, -hh4), p10 = L(hw2, -hh4), p11 = L(hw2, hh4), p01 = L(-hw2, hh4);
      var WG2 = G.walls;
      WG2.quad(W(p00[0], p00[1], 0.01), W(p10[0], p10[1], h2), W(p11[0], p11[1], h2), W(p01[0], p01[1], 0.01), top);
      WG2.tri(W(p00[0], p00[1], 0), W(p10[0], p10[1], 0), W(p10[0], p10[1], h2), side);
      WG2.tri(W(p01[0], p01[1], 0), W(p11[0], p11[1], h2), W(p11[0], p11[1], 0), side);
      WG2.quad(W(p10[0], p10[1], 0), W(p11[0], p11[1], 0), W(p11[0], p11[1], h2), W(p10[0], p10[1], h2), scale(side, 0.8));
      // chevrons / hazard stripes on the slope
      var nch = kick ? 4 : 6;
      for (var ch = 0; ch < nch; ch++) {
        var u0 = -hw2 + (ch + 0.25) * (2 * hw2 / nch), u1 = u0 + 0.35 * (2 * hw2 / nch);
        var hz0 = h2 * (u0 + hw2) / (2 * hw2) + 0.015, hz1 = h2 * (u1 + hw2) / (2 * hw2) + 0.015;
        var a5 = L(u0, -hh4 * 0.9), b5 = L(u1, 0), c6 = L(u0, hh4 * 0.9);
        G.decal.tri(W(a5[0], a5[1], hz0), W(b5[0], b5[1], hz1), W(c6[0], c6[1], hz0), hex(kick ? '#f2c200' : '#e8e8e8'));
      }
      if (kick && def.theme === 'junkyard') {
        // crushed car under the kicker
        OB.ybox(W(rp2.x + c5 * hw2 * 0.5, rp2.y + s5 * hw2 * 0.5, h2 * 0.3), (rp2.rot || 0), hw2 * 0.5, h2 * 0.3, hh4 * 0.9, hex('#6a2a1a'));
      }
      void ri;
    });
    (def.floors || []).forEach(function (fl2) {
      var c7 = Math.cos(fl2.rot || 0), s7 = Math.sin(fl2.rot || 0), z = fl2.z;
      function L2(u, v) { return [fl2.x + c7 * u - s7 * v, fl2.y + s7 * u + c7 * v]; }
      var q00 = L2(-fl2.hw, -fl2.hh), q10 = L2(fl2.hw, -fl2.hh), q11 = L2(fl2.hw, fl2.hh), q01 = L2(-fl2.hw, fl2.hh);
      var topC = hex('#8c8c8a'), sideC = hex('#6a6a68');
      G.walls.quad(W(q00[0], q00[1], z), W(q10[0], q10[1], z), W(q11[0], q11[1], z), W(q01[0], q01[1], z), topC);
      [[q00, q10], [q10, q11], [q11, q01], [q01, q00]].forEach(function (e2, ei) {
        G.walls.quad(W(e2[0][0], e2[0][1], 0), W(e2[1][0], e2[1][1], 0), W(e2[1][0], e2[1][1], z), W(e2[0][0], e2[0][1], z), sideC);
        // hazard stripe on the deck edge
        var m3 = 18;
        for (var hs = 0; hs < m3; hs += 2) {
          var t0 = hs / m3, t1 = (hs + 1) / m3;
          var pA = [e2[0][0] + (e2[1][0] - e2[0][0]) * t0, e2[0][1] + (e2[1][1] - e2[0][1]) * t0], pB = [e2[0][0] + (e2[1][0] - e2[0][0]) * t1, e2[0][1] + (e2[1][1] - e2[0][1]) * t1];
          G.decal.quad(W(pA[0], pA[1], z - 0.05), W(pB[0], pB[1], z - 0.05), W(pB[0], pB[1], z - 0.45), W(pA[0], pA[1], z - 0.45), hex('#f2c200'));
        }
        void ei;
      });
      // supporting columns visible from the lower deck
      for (var cu = -1; cu <= 1; cu += 2) for (var cv = -2; cv <= 2; cv++) { var cp2 = L2(cu * (fl2.hw - 0.6), cv * fl2.hh * 0.45); G.walls.aabb(W(cp2[0], cp2[1], z / 2), 0.3, z / 2, 0.3, hex('#7a7a78')); }
      // parking bay lines on the deck
      for (var pb = -4; pb <= 4; pb++) { var pl0 = L2(-fl2.hw + 0.3, pb * 4.5), pl1 = L2(-fl2.hw + 4.5, pb * 4.5); G.decal.quad(W(pl0[0], pl0[1] - 0.06, z + 0.01), W(pl1[0], pl1[1] - 0.06, z + 0.01), W(pl1[0], pl1[1] + 0.06, z + 0.01), W(pl0[0], pl0[1] + 0.06, z + 0.01), hex('#e8e8e8')); }
    });

    /* ---- hazards */
    (def.hazards || []).forEach(function (hz, hi2) {
      if (hz.type === 'mud') {
        if (num(hz.grip, 1) > 1) G.decal.disc(W(hz.x, hz.y, 0.012), hz.r * 0.95, 20, [0.74, 0.78, 0.82, 1], 50 + hi2);
        else { G.decal.disc(W(hz.x, hz.y, 0.012), hz.r * 0.92, 22, hex('#2a1c10'), 40 + hi2); G.decal.disc(W(hz.x + hz.r * 0.15, hz.y - hz.r * 0.1, 0.016), hz.r * 0.5, 14, hex('#1a120a'), 60 + hi2); }
      } else if (hz.type === 'oil') {
        G.decal.disc(W(hz.x, hz.y, 0.014), hz.r, 18, hex('#05060a'), 70 + hi2);
      } else if (hz.type === 'pit') {
        G.decal.disc(W(hz.x, hz.y, 0.014), hz.r, 24, hex('#020202'), 80);
      } else if (hz.type === 'fire') {
        if (def.theme === 'colosseum') {
          for (var lg = 0; lg < 3; lg++) { var al = lg / 3 * TAU; G.deco.beam(W(hz.x + Math.cos(al) * 0.7, hz.y + Math.sin(al) * 0.7, 0), W(hz.x + Math.cos(al) * 0.3, hz.y + Math.sin(al) * 0.3, 1.4), 0.06, hex('#3a2a1a')); }
          G.deco.cyl(W(hz.x, hz.y, 1.3), W(hz.x, hz.y, 1.75), 0.45, hz.r * 0.8, 12, hex('#5a3a1a'), true);
          G.glow.disc(W(hz.x, hz.y, 1.76), hz.r * 0.7, 12, hex('#ff8a20', 3));
          dyn.fires.push({ pos: W(hz.x, hz.y, 1.8), size: 1.2, r: hz.r });
        } else {
          G.deco.cyl(W(hz.x, hz.y, 0), W(hz.x, hz.y, 1.0), 0.45, 0.45, 12, hex('#3a2a20'), false);
          G.glow.disc(W(hz.x, hz.y, 1.0), 0.42, 12, hex('#ff8a20', 3));
          dyn.fires.push({ pos: W(hz.x, hz.y, 1.05), size: 1.0, r: hz.r });
        }
        G.decal.disc(W(hz.x, hz.y, 0.012), hz.r * 1.25, 16, hex('#1a1410'), 90 + hi2);
      } else if (hz.type === 'turntable') {
        // static rim: hazard-striped ring around the rotating plate (the plate itself is dynamic)
        var nr = 36;
        for (var rk = 0; rk < nr; rk++) {
          var ra1 = rk / nr * TAU, ra2 = (rk + 1) / nr * TAU, r0t = hz.r, r1t = hz.r + 0.45;
          G.decal.quad(W(hz.x + Math.cos(ra1) * r0t, hz.y + Math.sin(ra1) * r0t, 0.02), W(hz.x + Math.cos(ra2) * r0t, hz.y + Math.sin(ra2) * r0t, 0.02),
            W(hz.x + Math.cos(ra2) * r1t, hz.y + Math.sin(ra2) * r1t, 0.02), W(hz.x + Math.cos(ra1) * r1t, hz.y + Math.sin(ra1) * r1t, 0.02), rk % 2 ? hex('#f2c200') : hex('#141414'), [0, 1, 0]);
        }
        if (hz.rIn) G.decal.disc(W(hz.x, hz.y, 0.022), hz.rIn + 0.3, 24, hex('#2a2620'));
        dyn.turntables.push({ h: hz });
      } else if (hz.type === 'pusher') {
        G.decal.disc(W(hz.x, hz.y, 0.014), hz.r + 0.5, 20, hex('#141414'));
        for (var pk = 0; pk < 16; pk++) {
          var pa1 = pk / 16 * TAU, pa2 = (pk + 0.5) / 16 * TAU, pr0 = hz.r + 0.05, pr1 = hz.r + 0.45;
          G.decal.quad(W(hz.x + Math.cos(pa1) * pr0, hz.y + Math.sin(pa1) * pr0, 0.018), W(hz.x + Math.cos(pa2) * pr0, hz.y + Math.sin(pa2) * pr0, 0.018),
            W(hz.x + Math.cos(pa2) * pr1, hz.y + Math.sin(pa2) * pr1, 0.018), W(hz.x + Math.cos(pa1) * pr1, hz.y + Math.sin(pa1) * pr1, 0.018), hex('#f2c200'), [0, 1, 0]);
        }
        dyn.pushers.push({ h: hz });
      } else if (hz.type === 'conveyor') {
        var c9 = Math.cos(hz.rot || 0), s9 = Math.sin(hz.rot || 0);
        var LB = function (u, v) { return [hz.x + c9 * u - s9 * v, hz.y + s9 * u + c9 * v]; };
        var b0 = LB(-hz.hw, -hz.hh), b1 = LB(hz.hw, -hz.hh), b2 = LB(hz.hw, hz.hh), b3 = LB(-hz.hw, hz.hh);
        G.decal.quad(W(b0[0], b0[1], 0.014), W(b1[0], b1[1], 0.014), W(b2[0], b2[1], 0.014), W(b3[0], b3[1], 0.014), hex('#1c1d20'), [0, 1, 0]);
        [-1, 1].forEach(function (sd) {
          var m0 = LB(0, sd * (hz.hh + 0.15));
          G.obstacles.ybox(W(m0[0], m0[1], 0.08), hz.rot || 0, hz.hw, 0.08, 0.15, hex('#f2c200'));
        });
        dyn.conveyors.push({ h: hz });
      } else if (hz.type === 'crusher') {
        var c8 = Math.cos(hz.rot || 0), s8 = Math.sin(hz.rot || 0), ht2 = 4.2;
        function L3(u, v) { return [hz.x + c8 * u - s8 * v, hz.y + s8 * u + c8 * v]; }
        // base plate (hazard stripes), two side walls, top beam
        for (var stp = 0; stp < 8; stp++) {
          var u2 = -hz.hw + stp * (2 * hz.hw / 8), u3 = u2 + hz.hw / 8;
          var e0 = L3(u2, -hz.hh), e1b = L3(u3, -hz.hh), e2b = L3(u3 + 1, hz.hh), e3 = L3(u2 + 1, hz.hh);
          G.decal.quad(W(e0[0], e0[1], 0.012), W(e1b[0], e1b[1], 0.012), W(e2b[0], e2b[1], 0.012), W(e3[0], e3[1], 0.012), hex('#f2c200'));
        }
        [-1, 1].forEach(function (sd) {
          var cw = L3(0, sd * (hz.hh + 0.4));
          G.walls.ybox(W(cw[0], cw[1], ht2 / 2), hz.rot || 0, hz.hw + 0.4, ht2 / 2, 0.35, hex('#4a4e56'));
        });
        var cb = L3(0, 0);
        G.walls.ybox(W(cb[0], cb[1], ht2 + 0.4), hz.rot || 0, hz.hw + 0.5, 0.4, hz.hh + 0.8, hex('#d8a020'));
        G.glow.ybox(W(cb[0], cb[1], ht2 + 0.85), hz.rot || 0, 0.3, 0.08, 0.3, hex('#ff3020', 3));
        dyn.crushers.push({ h: hz, pos: W(cb[0], cb[1], 0), rot: hz.rot || 0, hw: hz.hw, hh: hz.hh, top: ht2 });
      }
    });

    var stats = { triangles: 0, groups: {} };
    Object.keys(G).forEach(function (k5) { var n5 = G[k5].tris(); stats.groups[k5] = n5; stats.triangles += n5; });
    return { groups: G, dynamic: dyn, stats: stats, theme: th, outline: o };
  }

  /* ------------------------------------------------------------------ GL wrap */
  function build(ctx, def, opts) {
    opts = opts || {};
    var GL = CB.gl, res = buildGeometry(def, opts), items = [], meshes = [];
    function mk(geo) { var m = GL.createMesh(ctx, geo); meshes.push(m); return m; }
    var ice = def.surface && def.surface.kind === 'ice', wet = def.weather === 'wet';
    var MAT = {
      ground: { name: 'derby-ground', color: [1, 1, 1, 1], roughness: ice ? 0.28 : wet ? 0.6 : 0.92, clearcoat: ice ? 0.35 : 0, clearcoatRoughness: 0.1, envIntensity: ice ? 1 : 0.4, castShadow: false },
      outer: { name: 'derby-outer', color: [1, 1, 1, 1], roughness: 0.95, castShadow: false, envIntensity: 0.3 },
      walls: { name: 'derby-walls', color: [1, 1, 1, 1], roughness: 0.75, envIntensity: 0.5 },
      obstacles: { name: 'derby-obstacles', color: [1, 1, 1, 1], roughness: 0.6, metallic: 0.1, clearcoat: 0.1 },
      deco: { name: 'derby-deco', color: [1, 1, 1, 1], roughness: 0.75, envIntensity: 0.4 },
      crowd: { name: 'derby-crowd', color: [1, 1, 1, 1], roughness: 0.85, castShadow: false, envIntensity: 0.3 },
      glow: { name: 'derby-glow', color: [1, 1, 1, 1], unlit: true, castShadow: false },
      decal: { name: 'derby-decal', color: [1, 1, 1, 1], roughness: ice ? 0.2 : 0.7, castShadow: false, polygonOffset: [-1, -3] },
      glass: { name: 'derby-glass', color: [1, 1, 1, 1], unlit: true, transparent: true, depthWrite: false, castShadow: false, doubleSided: true }
    };
    Object.keys(res.groups).forEach(function (k) {
      var g = res.groups[k];
      if (!g.tris()) return;
      items.push({ mesh: mk(g.out()), material: MAT[k], kind: 'derby-' + k, castShadow: k === 'walls' || k === 'obstacles' || k === 'deco', transparent: k === 'glass' });
    });
    var Geo = P().Geo;
    var plate = new Geo();
    plate.aabb([0, 0, 0], 1, 0.5, 1, hex('#5a5e66'));
    plate.aabb([0, -0.52, 0], 0.98, 0.02, 0.98, hex('#f2c200'));
    var dynMeshes = { crusherPlate: mk(plate.out()) };
    var DI = createDynamic(ctx, def, res, opts, mk, function (m) { var ix = meshes.indexOf(m); if (ix >= 0) meshes.splice(ix, 1); try { m.destroy(); } catch (e) { /* ignore */ } });
    return {
      items: items, dyn: res.dynamic, stats: res.stats, meshes: dynMeshes, groundMaterial: MAT.ground, MAT: MAT, outline: res.outline,
      /** per-frame moving arena items (turntables, pusher pads, conveyor chevrons, pickups, sudden-death fire ring):
          the renderer appends them to its draw list each frame. snap = session snapshot (pickups from snap.entities,
          the ring from snap.suddenDeath), t = sim time (s), cam = camera (optional, for culling). */
      dynamicItems: DI.items,
      destroy: function () { meshes.forEach(function (m) { try { m.destroy(); } catch (e) { /* ignore */ } }); meshes = []; }
    };
  }

  /* ------------------------------------------------------------------ dynamic arena items */
  var PICKUP_COL = { repair: '#3fd17a', boost: '#3aa0ff', ammo: '#ff9a1a', armor: '#d8dde4', bomb: '#ff3030' };
  /** PURE: what moves this frame -> [{type, x, y, z, yaw, s, ...}] (sim coords). Node-testable. */
  function dynamicSpec(def, snap, t) {
    var A = AR(), out = [];
    t = num(t, snap && snap.t || 0);
    (def.hazards || []).forEach(function (h) {
      if (h.type === 'turntable') out.push({ type: 'turntable', id: h.id, x: h.x, y: h.y, z: 0.03, yaw: A && A.turntableAngle ? A.turntableAngle(h, t) : (h.omega || 0) * t, s: h.r, rIn: h.rIn || 0 });
      else if (h.type === 'pusher') {
        var pa = A && A.pusherActive ? A.pusherActive(h, t) : { on: false, phase: 0 };
        out.push({ type: 'pusher', id: h.id, x: h.x, y: h.y, z: pa.on ? 0.28 : 0.04 + 0.04 * pa.phase, s: h.r, on: pa.on, charge: pa.phase });
      } else if (h.type === 'conveyor') { var pitch = h.hw * 2 * 0.92 / 8; out.push({ type: 'conveyor', id: h.id, x: h.x, y: h.y, z: 0.02, yaw: h.rot || 0, phase: ((t * h.speed) % pitch + pitch) % pitch, hw: h.hw, hh: h.hh, len: h.hw * 2 * 0.92 }); }
    });
    ((snap && snap.entities) || []).forEach(function (e) {
      if (e.type !== 'pickup' || !e.active) return;
      out.push({ type: 'pickup', id: e.id, kind: e.kind, x: e.x, y: e.y, z: num(e.z, 0) + 1.0 + Math.sin(t * 2.4 + e.x) * 0.18, yaw: t * 1.8 + e.y, s: 0.55 });
    });
    var sd = snap && snap.suddenDeath;
    if (sd && sd.on) out.push({ type: 'ring', s: clamp(num(sd.safeScale, 1), 0.2, 1), level: num(sd.level, 0), pulse: 0.75 + 0.25 * Math.sin(t * 7) });
    return out;
  }

  function createDynamic(ctx, def, res, opts, mk, drop) {
    var Geo = P().Geo, GL = CB.gl, q = (opts && opts.quality) || 'high', low = q === 'low';
    var UP = [0, 1, 0];
    // turntable plate: alternating sectors so the rotation reads, unit radius
    var tt = new Geo(), ns = 16;
    for (var k = 0; k < ns; k++) {
      var a1 = k / ns * TAU, a2 = (k + 1) / ns * TAU;
      tt.tri([0, 0, 0], [Math.cos(a2), 0, Math.sin(a2)], [Math.cos(a1), 0, Math.sin(a1)], k % 2 ? hex('#3c3f46') : hex('#a83a1a'), UP);
    }
    for (k = 0; k < ns; k++) {   // white arrows near the rim
      var am = (k + 0.5) / ns * TAU;
      if (k % 4) continue;
      tt.tri([Math.cos(am - 0.08) * 0.78, 0.004, Math.sin(am - 0.08) * 0.78], [Math.cos(am + 0.09) * 0.86, 0.004, Math.sin(am + 0.09) * 0.86], [Math.cos(am - 0.08) * 0.94, 0.004, Math.sin(am - 0.08) * 0.94], hex('#f0f0f0'), UP);
    }
    var pad = new Geo();
    pad.disc([0, 0, 0], 1, 20, [1, 1, 1, 1]);
    for (k = 0; k < 3; k++) pad.disc([0, 0.01 + k * 0.004, 0], 0.8 - k * 0.22, 20, k % 2 ? [0.15, 0.15, 0.15, 1] : [1, 1, 1, 1]);
    var chev = new Geo();
    for (var ci = 0; ci < 8; ci++) {
      var u0 = -0.5 + ci * 0.125;
      chev.quad([u0, 0, -1], [u0 + 0.035, 0, -1], [u0 + 0.085, 0, 0], [u0 + 0.05, 0, 0], [1, 1, 1, 1], UP);
      chev.quad([u0 + 0.05, 0, 0], [u0 + 0.085, 0, 0], [u0 + 0.035, 0, 1], [u0, 0, 1], [1, 1, 1, 1], UP);
    }
    var box = new Geo();
    box.aabb([0, 0, 0], 1, 1, 1, [1, 1, 1, 1]);
    box.aabb([0, 0, 0], 1.04, 0.22, 1.04, [0.15, 0.15, 0.16, 1]);
    var ring = new Geo();
    for (k = 0; k < 28; k++) { var b1 = k / 28 * TAU, b2 = (k + 1) / 28 * TAU; ring.quad([Math.cos(b1) * 0.8, 0, Math.sin(b1) * 0.8], [Math.cos(b2) * 0.8, 0, Math.sin(b2) * 0.8], [Math.cos(b2), 0, Math.sin(b2)], [Math.cos(b1), 0, Math.sin(b1)], [1, 1, 1, 1], UP); }
    var beam = new Geo();
    beam.cyl([0, 0, 0], [0, 1, 0], 0.16, 0.02, 8, [1, 1, 1, 1], false);
    // sudden-death fire ring along the boundary (unit scale; scaled about the centre by safeScale). Arenas with raised
    // decks / ramps get a ring rebuilt per scale that sits ON the surface (heightAt) instead of cutting through it.
    var o = outline(def, low ? 3 : 1.6), lava = new Geo();
    var terrain = !!((def.floors && def.floors.length) || (def.ramps && def.ramps.length));
    function hAt(x, y) { var A = AR(); try { return A && A.heightAt ? num(A.heightAt(def, x, y).z, 0) : 0; } catch (e) { return 0; } }
    function fireGeo(sc, lift) {
      var fire = new Geo();
      for (var oi = 0; oi < o.length; oi++) {
        var A0 = o[oi], B0 = o[(oi + 1) % o.length];
        if (A0.open) continue;
        // flame tongues: bright base, transparent ragged top (vertex alpha), two layers offset for depth
        for (var fl = 0; fl < 2; fl++) {
          var hA = 1.1 + noise2(A0.x * 0.7 + fl * 9, A0.y * 0.7) * 1.4, hB = 1.1 + noise2(B0.x * 0.7 + fl * 9, B0.y * 0.7) * 1.4;
          var nA = vtxOut(o, oi), nB = vtxOut(o, (oi + 1) % o.length), off = fl * 0.35;
          var ax = (A0.x - nA[0] * off) * sc, ay = (A0.y - nA[1] * off) * sc, bx = (B0.x - nB[0] * off) * sc, by = (B0.y - nB[1] * off) * sc;
          var za = lift ? hAt(ax, ay) : 0, zb = lift ? hAt(bx, by) : 0;
          var a0 = W(ax, ay, za + 0.05), b0 = W(bx, by, zb + 0.05);
          var a1 = W(ax, ay, za + hA * (1 - fl * 0.3)), b1 = W(bx, by, zb + hB * (1 - fl * 0.3));
          var bc = fl ? [1, 0.75, 0.35, 1] : [1, 0.5, 0.15, 1], tc = [1, 0.25, 0.05, 0];
          var i0f = fire.v(a0, UP, bc), i1f = fire.v(b0, UP, bc), i2f = fire.v(b1, UP, tc), i3f = fire.v(a1, UP, tc);
          fire.i.push(i0f, i1f, i2f, i0f, i2f, i3f);
        }
      }
      return fire;
    }
    var fire = fireGeo(1, false);
    // the lava band (from the ring outward to the wall) is rebuilt only when the scale changes noticeably
    var meshes = {
      tt: mk(tt.out()), pad: mk(pad.out()), chev: mk(chev.out()), box: mk(box.out()), ring: mk(ring.out()), beam: mk(beam.out()),
      fire: fire.tris() ? mk(fire.out()) : null, lava: null
    };
    var lavaScale = -1;
    function lavaMesh(sc) {
      sc = Math.round(sc * 40) / 40;   // rebuilt at most every 2.5 % of shrink (~20 times per match)
      if (meshes.lava && sc === lavaScale) return meshes.lava;
      lavaScale = sc;
      var g = new Geo();
      for (var li = 0; li < o.length; li++) {
        var A1 = o[li], B1 = o[(li + 1) % o.length];
        // glowing edge just outside the ring, scorched dark beyond
        var ea = 1 + 2.2 / Math.max(10, Math.hypot(A1.x, A1.y)), eb = 1 + 2.2 / Math.max(10, Math.hypot(B1.x, B1.y));
        var hot = [0.9, 0.28, 0.05, 0.9], dark = [0.09, 0.015, 0.005, 0.82];
        var L = function (x, y) { return W(x, y, (terrain ? hAt(x, y) : 0) + 0.03); };
        var j0 = g.v(L(A1.x * sc, A1.y * sc), UP, hot), j1 = g.v(L(B1.x * sc, B1.y * sc), UP, hot);
        var j2 = g.v(L(B1.x * sc * eb, B1.y * sc * eb), UP, dark), j3 = g.v(L(A1.x * sc * ea, A1.y * sc * ea), UP, dark);
        var j4 = g.v(L(B1.x, B1.y), UP, dark), j5 = g.v(L(A1.x, A1.y), UP, dark);
        g.i.push(j0, j1, j2, j0, j2, j3, j3, j2, j4, j3, j4, j5);
      }
      if (meshes.lava && drop) drop(meshes.lava);
      meshes.lava = mk(g.out());
      return meshes.lava;
    }
    var fireScale = -1;
    function fireMesh(sc) {
      if (!terrain) return meshes.fire;
      sc = Math.round(sc * 40) / 40;
      if (meshes.fireT && sc === fireScale) return meshes.fireT;
      fireScale = sc;
      if (meshes.fireT && drop) drop(meshes.fireT);
      var fg = fireGeo(sc, true);
      meshes.fireT = fg.tris() ? mk(fg.out()) : null;
      return meshes.fireT;
    }
    function glowMat(c, extra) { return Object.assign({ color: c, unlit: true, castShadow: false, doubleSided: true }, extra || {}); }
    var MAT = {
      tt: { color: [1, 1, 1, 1], roughness: 0.6, metallic: 0.3, castShadow: false, doubleSided: true, polygonOffset: [-2, -4] },
      padIdle: glowMat([0.9, 0.7, 0.12, 1], { polygonOffset: [-2, -4] }), padFire: glowMat([4, 0.8, 0.3, 1], { polygonOffset: [-2, -4] }),
      chev: glowMat([1.6, 1.3, 0.2, 1], { polygonOffset: [-3, -6] }),
      fire: glowMat([3, 3, 3, 1], { transparent: true, additive: true, depthWrite: false }),
      lava: glowMat([1, 1, 1, 1], { transparent: true, depthWrite: false, polygonOffset: [-2, -4] }),
      pk: {}, ring: {}, beam: {}
    };
    function pkMats(kind) {
      if (!MAT.pk[kind]) {
        var c = hex(PICKUP_COL[kind] || '#ffffff');
        MAT.pk[kind] = { color: [c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, 1], unlit: true, castShadow: false };
        MAT.ring[kind] = glowMat([c[0] * 1.1, c[1] * 1.1, c[2] * 1.1, 0.6], { transparent: true, additive: true, depthWrite: false, polygonOffset: [-2, -4] });
        MAT.beam[kind] = glowMat([c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, 0.08], { transparent: true, additive: true, depthWrite: false });
      }
      return MAT.pk[kind];
    }
    var pool = [], list = [];
    function item(mesh, mat) {
      var it = pool[list.length] || (pool[list.length] = { model: GL.mat4 ? GL.mat4.create() : new Float32Array(16) });
      it.mesh = mesh; it.material = mat; it.castShadow = false; it.transparent = !!mat.transparent; it.kind = 'derby-arena-dyn';
      list.push(it);
      return it;
    }
    /** model matrix: sim position + yaw (CCW about up), scales sx (local x), sy (up), sz (local z = -sim y) */
    function trs(m, x, y, z, yaw, sx, sy, sz) {
      var c = Math.cos(yaw), s = Math.sin(yaw);
      m[0] = c * sx; m[1] = 0; m[2] = -s * sx; m[3] = 0;
      m[4] = 0; m[5] = sy; m[6] = 0; m[7] = 0;
      m[8] = s * sz; m[9] = 0; m[10] = c * sz; m[11] = 0;
      m[12] = x; m[13] = z; m[14] = -y; m[15] = 1;
    }
    function items(snap, t, cam) {
      list.length = 0;
      var spec = dynamicSpec(def, snap, t);
      for (var i = 0; i < spec.length; i++) {
        var d = spec[i];
        if (d.type === 'turntable') { trs(item(meshes.tt, MAT.tt).model, d.x, d.y, d.z, d.yaw, d.s, 1, d.s); }
        else if (d.type === 'pusher') {
          var pm = d.on ? MAT.padFire : MAT.padIdle;
          if (!d.on) { var k2 = 0.45 + d.charge * d.charge * 0.9; pm.color[0] = 0.9 * k2; pm.color[1] = 0.7 * k2; pm.color[2] = 0.12 * k2; }
          trs(item(meshes.pad, pm).model, d.x, d.y, d.z, 0, d.s, 1, d.s);
        } else if (d.type === 'conveyor') {
          // 8 chevrons over the belt, scrolled by up to one pitch toward the belt direction
          var c3 = Math.cos(d.yaw), s3 = Math.sin(d.yaw), u = d.phase - d.len / 16;
          trs(item(meshes.chev, MAT.chev).model, d.x + c3 * u, d.y + s3 * u, d.z + 0.012, d.yaw, d.len, 1, d.hh * 0.8);
        } else if (d.type === 'pickup') {
          var pmat = pkMats(d.kind);
          var bx = item(meshes.box, pmat); trs(bx.model, d.x, d.y, d.z, d.yaw, d.s, d.s, d.s);
          trs(item(meshes.ring, MAT.ring[d.kind]).model, d.x, d.y, num(d.z, 1) - 0.95, -d.yaw, 2.2, 1, 2.2);
          // the locator beam only for far pickups (it would bloom over the screen up close)
          var cp = cam && (cam.pos || cam.eye || cam.position), far = !cp || Math.hypot(cp[0] - d.x, cp[2] + d.y) > 22;
          if (!low && far) trs(item(meshes.beam, MAT.beam[d.kind]).model, d.x, d.y, 0.05, 0, 1, 7, 1);
        } else if (d.type === 'ring') {
          var pf = d.pulse * (1 + 0.5 * clamp(d.level, 0, 3));
          MAT.fire.color[0] = MAT.fire.color[1] = MAT.fire.color[2] = 2.4 * pf;
          MAT.lava.color[0] = MAT.lava.color[1] = MAT.lava.color[2] = 0.7 + 0.3 * d.pulse;
          var fm = fireMesh(d.s);
          if (fm && terrain) trs(item(fm, MAT.fire).model, 0, 0, 0, 0, 1, 1, 1);
          else if (fm) trs(item(fm, MAT.fire).model, 0, 0, 0, 0, d.s, 0.8 + 0.4 * d.pulse, d.s);
          if (d.s < 0.99) trs(item(lavaMesh(d.s), MAT.lava).model, 0, 0, 0, 0, 1, 1, 1);
        }
      }
      return list;
    }
    return { items: items, meshes: meshes, MAT: MAT };
  }

  CB.gl.derbyArena = { outline: outline, buildGeometry: buildGeometry, build: build, dynamicSpec: dynamicSpec, PICKUP_COL: PICKUP_COL, THEME: THEME, _: { segOut: segOut, vtxOut: vtxOut, noise2: noise2 } };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.gl.derbyArena;
})();

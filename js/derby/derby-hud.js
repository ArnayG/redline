/* ==========================================================================
   Redline — js/derby/derby-hud.js
   CB.derby.hud : canvas HUD for Demolition Derby (docs/DERBY-SPEC.md §10).

     layout(w, h, {compact, touch, safe {l, r, t, b}}) -> PURE rects {health, diagram, count, timer, minimap, feed, acc[], banner}
     touchLayout(w, h, safe) -> PURE rects for the on-screen controls {steer, brake, gas, action1, action2, handbrake, pause, camera}
     create() -> hud { draw(ctx, snap, view), reset() }
        view {width, height, followId, spectating, compact, touch, safe, keys {a1, a2}, fps?}
     zoneColor(d) -> css colour (0 green .. 1 black-red)     drawMinimap(ctx, arena, cars, rect, opts)   drawCarDiagram(ctx, car, rect)
   Classic script; the pure helpers load in Node (tests/derby-ui.test.js).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  var FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

  /* ------------------------------------------------------------------ pure layout */
  function layout(w, h, o) {
    o = o || {};
    var s = o.safe || {}, L = num(s.l, 0), R = num(s.r, 0), T = num(s.t, 0);
    var compact = !!o.compact || h < 520 || w < 700;
    var out = { compact: compact };
    if (!compact) {
      out.health = { x: 16 + L, y: 16 + T, w: 300, h: 50 };
      out.diagram = { x: 16 + L, y: 76 + T, w: 104, h: 168 };
      out.count = { x: w / 2 - 95, y: 14 + T, w: 190, h: 42 };
      out.timer = { x: w / 2 - 50, y: 60 + T, w: 100, h: 24 };
      out.minimap = { x: w - 212 - R, y: 16 + T, w: 196, h: 140 };
      out.feed = { x: w - 372 - R, y: 168 + T, w: 356, h: 6 * 24 };
      var n = 4, cw = 172, gap = 10, tw = n * cw + (n - 1) * gap;
      out.acc = [];
      if (!o.touch) for (var i = 0; i < n; i++) out.acc.push({ x: w / 2 - tw / 2 + i * (cw + gap), y: h - 72, w: cw, h: 56 });
    } else {
      out.health = { x: 8 + L, y: 6 + T, w: Math.min(200, w * 0.26), h: 32 };
      out.diagram = { x: 8 + L, y: 42 + T, w: 50, h: 82 };
      out.count = { x: w / 2 - 58, y: 4 + T, w: 116, h: 30 };
      out.timer = { x: w / 2 - 36, y: 36 + T, w: 72, h: 18 };
      out.minimap = { x: w - 120 - R, y: 6 + T, w: 112, h: 78 };
      out.feed = { x: w / 2 - 150, y: (o.touch ? 58 : 58) + T, w: 300, h: 3 * 18 };
      out.acc = [];
      if (!o.touch) { for (var j = 0; j < 4; j++) out.acc.push({ x: w / 2 - 2 * 104 + j * 104, y: h - 50, w: 98, h: 40 }); }
    }
    out.banner = { x: w * 0.15, y: h * 0.28, w: w * 0.7, h: compact ? 70 : 110 };
    return out;
  }
  function touchLayout(w, h, safe) {
    safe = safe || {};
    var L = num(safe.l, 0), R = num(safe.r, 0), B = num(safe.b, 0), T = num(safe.t, 0);
    var ph = Math.round(clamp(h * 0.33, 96, 150)), pw = Math.round(clamp(w * 0.28, 170, 280));
    var steer = { x: 12 + L, y: h - B - 12 - ph, w: pw, h: ph };
    var gw = 78;
    var gas = { x: w - R - 12 - gw, y: h - B - 12 - ph, w: gw, h: ph };
    var brake = { x: gas.x - 10 - gw, y: gas.y, w: gw, h: ph };
    var ab = Math.round(clamp(h * 0.17, 56, 72));
    var action1 = { x: gas.x + (gw - ab) / 2, y: gas.y - 12 - ab, w: ab, h: ab };
    var action2 = { x: brake.x + (gw - ab) / 2, y: brake.y - 12 - ab, w: ab, h: ab };
    var handbrake = { x: steer.x + steer.w - 70, y: steer.y - 10 - 46, w: 70, h: 46 };
    // RAM BOOST: a big round button between the steering pad and the pedals (thumb reach of the right hand)
    var bb = Math.round(clamp(h * 0.2, 64, 84));
    var boost = { x: brake.x - 14 - bb, y: h - B - 12 - bb, w: bb, h: bb };
    if (boost.x < steer.x + steer.w + 8) { boost.x = steer.x + steer.w + 8; }
    var off = h < 520 || w < 700 ? 66 : 104;   // clear of the opponents counter (compact / full HUD)
    var pause = { x: w / 2 + off, y: 4 + T, w: 46, h: 40 };
    var camera = { x: w / 2 - off - 46, y: 4 + T, w: 46, h: 40 };
    return { steer: steer, gas: gas, brake: brake, action1: action1, action2: action2, handbrake: handbrake, boost: boost, pause: pause, camera: camera };
  }
  function overlap(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

  /* ------------------------------------------------------------------ drawing helpers */
  function zoneColor(d) {
    d = clamp(num(d, 0), 0, 1);
    if (d >= 0.999) return '#3a0d0d';
    var stops = [[0, [64, 200, 110]], [0.35, [226, 210, 60]], [0.7, [238, 120, 40]], [0.95, [220, 40, 40]]];
    for (var i = 1; i < stops.length; i++) {
      if (d <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i], t = (d - a[0]) / (b[0] - a[0]);
        return 'rgb(' + [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * t); }).join(',') + ')';
      }
    }
    return 'rgb(220,40,40)';
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function panel(ctx, r, alpha) {
    rr(ctx, r.x, r.y, r.w, r.h, 9);
    ctx.fillStyle = 'rgba(10,10,14,' + (alpha == null ? 0.62 : alpha) + ')'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1; ctx.stroke();
  }
  function text(ctx, s, x, y, size, color, align, weight) {
    ctx.font = (weight || 700) + ' ' + size + 'px ' + FONT;
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = color || '#fff';
    ctx.fillText(s, x, y);
  }
  function fit(ctx, s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  /** top-down car diagram (nose up): zones + wheels + fire / smoke / temperature */
  function drawCarDiagram(ctx, c, r, t) {
    var cx = r.x + r.w / 2, small = r.w < 80;
    var bw = r.w * (small ? 0.5 : 0.46), bh = r.h * (small ? 0.78 : 0.7), bx = cx - bw / 2, by = r.y + (small ? 4 : 10);
    var z = c.zones || {}, seg = Math.max(3, bw * 0.2);
    // body base
    rr(ctx, bx, by, bw, bh, bw * 0.28); ctx.fillStyle = '#20232a'; ctx.fill();
    // zones
    ctx.save(); rr(ctx, bx, by, bw, bh, bw * 0.28); ctx.clip();
    ctx.fillStyle = zoneColor(z.front); ctx.fillRect(bx, by, bw, bh * 0.27);
    ctx.fillStyle = zoneColor(z.rear); ctx.fillRect(bx, by + bh * 0.73, bw, bh * 0.27);
    ctx.fillStyle = zoneColor(z.left); ctx.fillRect(bx, by + bh * 0.27, seg, bh * 0.46);
    ctx.fillStyle = zoneColor(z.right); ctx.fillRect(bx + bw - seg, by + bh * 0.27, seg, bh * 0.46);
    // cabin glass
    ctx.fillStyle = 'rgba(20,24,32,.9)'; ctx.fillRect(bx + seg + 1, by + bh * 0.32, bw - 2 * seg - 2, bh * 0.36);
    ctx.restore();
    // wheels (FL FR RL RR)
    var ww = Math.max(4, bw * 0.2), wh = Math.max(7, bh * 0.17);
    var pos = [[bx - ww * 0.75, by + bh * 0.12], [bx + bw - ww * 0.25, by + bh * 0.12], [bx - ww * 0.75, by + bh * 0.71], [bx + bw - ww * 0.25, by + bh * 0.71]];
    for (var i = 0; i < 4; i++) {
      var lost = c.wheelLost && c.wheelLost[i], d = c.wheels ? c.wheels[i] : 0;
      if (lost) {
        ctx.strokeStyle = '#ff4a3a'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(pos[i][0], pos[i][1]); ctx.lineTo(pos[i][0] + ww, pos[i][1] + wh); ctx.moveTo(pos[i][0] + ww, pos[i][1]); ctx.lineTo(pos[i][0], pos[i][1] + wh); ctx.stroke();
      } else {
        rr(ctx, pos[i][0], pos[i][1], ww, wh, 2); ctx.fillStyle = zoneColor(d); ctx.fill();
        if (c.punct && c.punct[i]) { ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(pos[i][0] + ww / 2, pos[i][1] + wh / 2, Math.max(1.5, ww * 0.22), 0, Math.PI * 2); ctx.fill(); }
      }
    }
    // fire / smoke markers on the engine end
    var eng = c.engine || {}, front = !(c.spec && (c.spec.enginePos === 'mid' || c.spec.enginePos === 'rear'));
    var ey = front ? by + bh * 0.12 : by + bh * 0.86;
    if (c.onFire > 0.05 || eng.fire > 0.05) {
      var fl = 0.7 + 0.3 * Math.sin((t || 0) * 18);
      ctx.fillStyle = 'rgba(255,' + Math.round(120 + 80 * fl) + ',30,.95)';
      ctx.beginPath(); ctx.moveTo(cx, ey - 9 * fl); ctx.quadraticCurveTo(cx + 6, ey, cx, ey + 5); ctx.quadraticCurveTo(cx - 6, ey, cx, ey - 9 * fl); ctx.fill();
    } else if (eng.smoke > 0.15) {
      var g = Math.round(220 - 170 * num(eng.black, 0));
      ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',.8)';
      ctx.beginPath(); ctx.arc(cx, ey, 3 + 3 * eng.smoke, 0, Math.PI * 2); ctx.fill();
    }
    if (small) return;
    // engine temperature bar under the car
    var ty = by + bh + 10, tw = r.w - 16;
    text(ctx, 'TEMP', r.x + 8, ty, 9, 'rgba(255,255,255,.55)', 'left', 700);
    var tx0 = r.x + 40, tw2 = tw - 32;
    rr(ctx, tx0, ty - 3, tw2, 6, 3); ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fill();
    var tp = clamp(num(eng.temp, 0), 0, 1);
    if (tp > 0.01) { rr(ctx, tx0, ty - 3, Math.max(4, tw2 * tp), 6, 3); ctx.fillStyle = tp > 0.8 ? '#ff4a3a' : tp > 0.5 ? '#f0a030' : '#6ac0ff'; ctx.fill(); }
    if (eng.stalled) text(ctx, 'ENGINE DEAD', cx, ty + 14, 9, '#ff6a5a', 'center', 800);
  }

  function arenaPath(ctx, a, tx) {
    var b = a.boundary;
    ctx.beginPath();
    if (b.type === 'ellipse') {
      for (var i = 0; i <= 48; i++) { var t = i / 48 * Math.PI * 2, p = tx(Math.cos(t) * b.rx, Math.sin(t) * b.ry); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
    } else if (b.type === 'roundrect') {
      var r = b.r, hw = b.hw, hh = b.hh, pts = [];
      [[hw - r, hh - r, 0], [-hw + r, hh - r, 1], [-hw + r, -hh + r, 2], [hw - r, -hh + r, 3]].forEach(function (c) {
        for (var k = 0; k <= 8; k++) { var aa = (c[2] + k / 8) * Math.PI / 2; pts.push([c[0] + Math.cos(aa) * r, c[1] + Math.sin(aa) * r]); }
      });
      pts.forEach(function (q, j) { var p = tx(q[0], q[1]); if (j) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    } else {
      b.pts.forEach(function (q, j) { var p = tx(q[0], q[1]); if (j) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    }
    ctx.closePath();
  }
  function boxPts(o) {
    var c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
    return [[o.hw, o.hh], [-o.hw, o.hh], [-o.hw, -o.hh], [o.hw, -o.hh]].map(function (q) { return [o.x + q[0] * c - q[1] * s, o.y + q[0] * s + q[1] * c]; });
  }
  /** minimap: arena outline, obstacles, hazards, ramps, cars (arrows) */
  function drawMinimap(ctx, a, cars, r, o) {
    o = o || {};
    var B = a.bounds, aw = B.maxX - B.minX, ah = B.maxY - B.minY;
    var sc = Math.min((r.w - 12) / aw, (r.h - 12) / ah), cx = r.x + r.w / 2, cy = r.y + r.h / 2, mx = (B.minX + B.maxX) / 2, my = (B.minY + B.maxY) / 2;
    function tx(x, y) { return [cx + (x - mx) * sc, cy - (y - my) * sc]; }
    if (!o.noPanel) panel(ctx, r, 0.55);
    arenaPath(ctx, a, tx);
    ctx.fillStyle = o.ground || 'rgba(255,255,255,.08)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.5; ctx.stroke();
    // open edges (rooftop) in red dashes
    if (a.boundary.type === 'poly' && a.boundary.open && a.boundary.open.length) {
      ctx.save(); ctx.strokeStyle = '#ff5040'; ctx.lineWidth = 2.5; ctx.setLineDash([4, 3]);
      a.boundary.open.forEach(function (ei) {
        var p0 = a.boundary.pts[ei], p1 = a.boundary.pts[(ei + 1) % a.boundary.pts.length], q0 = tx(p0[0], p0[1]), q1 = tx(p1[0], p1[1]);
        ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.stroke();
      });
      ctx.restore();
    }
    (a.hazards || []).forEach(function (h) {
      var col = h.type === 'fire' ? 'rgba(255,120,30,.75)' : h.type === 'crusher' ? 'rgba(255,60,60,.45)' : h.type === 'oil' ? 'rgba(0,0,0,.55)' : h.type === 'pit' ? 'rgba(0,0,0,.8)' : 'rgba(120,85,50,.55)';
      ctx.fillStyle = col;
      if (h.type === 'crusher') { var bp = boxPts(h); ctx.beginPath(); bp.forEach(function (q, j) { var p = tx(q[0], q[1]); if (j) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.fill(); }
      else { var p = tx(h.x, h.y); ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(1.5, h.r * sc), 0, Math.PI * 2); ctx.fill(); }
    });
    (a.floors || []).concat(a.ramps || []).forEach(function (f) {
      var bp = boxPts(f); ctx.beginPath(); bp.forEach(function (q, j) { var p = tx(q[0], q[1]); if (j) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath();
      ctx.fillStyle = f.z != null ? 'rgba(255,255,255,.14)' : 'rgba(255,220,120,.3)'; ctx.fill();
    });
    ctx.fillStyle = 'rgba(200,200,210,.7)';
    (a.obstacles || []).forEach(function (ob) {
      if (ob.type === 'circle') { var p = tx(ob.x, ob.y); ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(1.2, ob.r * sc), 0, Math.PI * 2); ctx.fill(); }
      else { var bp = boxPts(ob); ctx.beginPath(); bp.forEach(function (q, j) { var pp = tx(q[0], q[1]); if (j) ctx.lineTo(pp[0], pp[1]); else ctx.moveTo(pp[0], pp[1]); }); ctx.closePath(); ctx.fill(); }
    });
    // sudden-death safe ring (the outline scaled about the centre)
    if (o.safeScale && o.safeScale < 0.999) {
      var ss = o.safeScale;
      ctx.save(); arenaPath(ctx, a, function (x, y) { return tx(x * ss, y * ss); });
      ctx.strokeStyle = 'rgba(255,70,40,.95)'; ctx.lineWidth = 1.8; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.restore();
    }
    // pickups (repair / boost / ammo / armour / bomb)
    (o.entities || []).forEach(function (e) {
      if (e.type !== 'pickup') return;
      var p = tx(e.x, e.y), col = PICKUP_COL[e.kind] || '#fff';
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(p[0], p[1] - 3.5); ctx.lineTo(p[0] + 3.5, p[1]); ctx.lineTo(p[0], p[1] + 3.5); ctx.lineTo(p[0] - 3.5, p[1]); ctx.closePath(); ctx.fill();
    });
    var size = Math.max(3, Math.min(6, r.w / 30));
    (cars || []).forEach(function (c) {
      var p = tx(c.x, c.y);
      if (c.out) {
        ctx.strokeStyle = 'rgba(160,160,160,.7)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(p[0] - 2.5, p[1] - 2.5); ctx.lineTo(p[0] + 2.5, p[1] + 2.5); ctx.moveTo(p[0] + 2.5, p[1] - 2.5); ctx.lineTo(p[0] - 2.5, p[1] + 2.5); ctx.stroke();
        return;
      }
      var me = c.id === o.followId || (o.followId == null && c.isPlayer);
      var hunting = o.playerId && c.target === o.playerId && !c.isPlayer;
      ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(-c.heading);
      ctx.beginPath(); var s2 = me ? size * 1.35 : size;
      ctx.moveTo(s2 * 1.3, 0); ctx.lineTo(-s2, s2 * 0.85); ctx.lineTo(-s2 * 0.5, 0); ctx.lineTo(-s2, -s2 * 0.85); ctx.closePath();
      ctx.fillStyle = me ? '#ffffff' : hunting ? '#ff4636' : (c.color || '#ccc');
      ctx.fill();
      if (me) { ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.restore();
    });
  }

  var PICKUP_COL = { repair: '#5fd18b', boost: '#3aa0ff', ammo: '#ffb13a', armor: '#c0c6d0', armour: '#c0c6d0', bomb: '#ff4a3a' };
  function accLabel(a) { return a.name ? a.name.replace('Generator', '').replace('Electro-', '').trim() : a.id; }

  /* ------------------------------------------------------------------ JUICE (pure): scoring popups, combos, announcer,
     hit-stop / shake / kick / flash / rumble / replay triggers from the snapshot events.
     Uses the session's 'score' events when present ({carId, otherId, label, points, combo}); otherwise scores the
     player's impacts itself (FALLBACK table) so the HUD is juicy with either sim version. */
  var FALLBACK = {
    tbone: { label: 'T-BONE!', pts: 250 }, headon: { label: 'HEAD-ON', pts: 150 }, rear: { label: 'REAR-ENDER', pts: 180 }, reverse: { label: 'REVERSE RAM', pts: 200 },
    hit: { label: 'SMASH', pts: 100 }, side: { label: 'SIDESWIPE', pts: 120 }, launch: { label: 'LAUNCHED!', pts: 300 }, hammer: { label: 'HAMMER TIME', pts: 200 },
    kill: { label: 'TAKEDOWN', pts: 500 }, revenge: { label: 'REVENGE!', pts: 150 }, airborne: { label: 'AIRBORNE HIT', pts: 220 }, ball: { label: 'WRECKING BALL', pts: 180 }
  };
  var STREAK = { 2: 'DOUBLE TAKEDOWN', 3: 'TRIPLE TAKEDOWN', 4: 'RAMPAGE', 5: 'UNSTOPPABLE', 6: 'WRECKING MACHINE' };
  var COMBO_CALL = { 3: 'x3 COMBO!', 5: 'DEMOLITION!', 8: 'CARNAGE!', 12: 'ABSOLUTE MAYHEM!' };
  function createJuice() {
    var J = { score: 0, breakdown: {}, popups: [], announce: null, combo: 0, comboT: -99, kills: [], totalKills: 0, firstBlood: false, sawScore: false,
      lastHitBy: null, lastHitByT: -99, bestHit: 0, hits: 0, bigHits: 0, firstHitT: null, lastActionT: 0, longestGap: 0, pickups: [], seen: {} };
    function carOf(snap, id) { for (var i = 0; i < snap.cars.length; i++) if (snap.cars[i].id === id) return snap.cars[i]; return null; }
    function popup(t, x, y, z, text, sub, color, big) {
      var slot = 0; J.popups.forEach(function (q) { if (t - q.t < 0.9) slot = Math.max(slot, q.slot + 1); });
      var m = /^(.*?)\s*(\+\d+)$/.exec(text);
      J.popups.push({ t: t, x: x, y: y, z: num(z, 1) + 1.6, text: m ? m[1] : text, pts: m ? m[2] : '', sub: sub || '', color: color || '#ffd84a', big: !!big, slot: slot % 4 });
      if (J.popups.length > 8) J.popups.shift();
    }
    function say(t, text, color, sting) { J.announce = { t: t, text: text, color: color || '#ffb13a', sting: sting || 'combo' }; }
    function addPoints(label, pts) { J.score += pts; J.breakdown[label] = (J.breakdown[label] || 0) + pts; }
    function action(t) { if (J.firstHitT == null) J.firstHitT = t; J.longestGap = Math.max(J.longestGap, t - J.lastActionT); J.lastActionT = t; }
    function comboUp(t) {
      J.combo = t - J.comboT < 3.2 ? J.combo + 1 : 1; J.comboT = t;
      if (COMBO_CALL[J.combo]) say(t, COMBO_CALL[J.combo], '#ffd84a', 'combo');
      return J.combo;
    }
    /**
     * ingest(snap, {followId, playerId}) -> fx {hitstop s, shake, kick {x, y, amount} (world dir), flash {color, a}, rumble 0..1,
     *   replay {t, targetId, x, y, title}|null, stings [names], pickups [toast text]}
     */
    function ingest(snap, o) {
      o = o || {};
      var fx = { hitstop: 0, shake: 0, kick: null, flash: null, rumble: 0, replay: null, stings: [], toasts: [] };
      if (!snap || !snap.events) return fx;
      var pid = o.playerId || 'player', fid = o.followId || pid, t = snap.t;
      if (snap.phase === 'countdown') { J.lastActionT = t; return fx; }
      var pc = carOf(snap, pid);
      if (!J.sawScore && pc && pc.stats && typeof pc.stats.score === 'number') J.sawScore = true;   // the session scores itself
      if (!J.sawScore) for (var q = 0; q < snap.events.length; q++) if (snap.events[q].type === 'score') { J.sawScore = true; break; }
      snap.events.forEach(function (e) {
        if (e.id != null) { if (J.seen[e.id]) return; J.seen[e.id] = 1; }
        var mine = e.carId === pid, onMe = e.otherId === pid;
        var followed = e.carId === fid || e.otherId === fid;
        var en = num(e.energy, 0), vn = num(e.vn, 0);
        // ---- impact feel (any big hit involving the followed car)
        if ((e.type === 'impact' || e.type === 'hammer' || e.type === 'wall' || e.type === 'launch' || e.type === 'explode') && followed && (e.big || vn > 9)) {
          var k = clamp(Math.max(en / 90000, vn / 22), 0.25, 1.4);
          fx.hitstop = Math.max(fx.hitstop, e.type === 'wall' ? 0 : clamp(0.05 + 0.03 * k, 0.06, 0.09));
          fx.shake = Math.max(fx.shake, k);
          var me = carOf(snap, fid);
          if (me && e.x != null) { var dx = me.x - e.x, dy = me.y - e.y, l = Math.hypot(dx, dy) || 1; fx.kick = { x: dx / l, y: dy / l, amount: k }; }
          fx.flash = { color: e.carId === fid ? '255,255,255' : '255,40,30', a: clamp(0.25 + 0.35 * k, 0.25, 0.7) };
          fx.rumble = Math.max(fx.rumble, clamp(k, 0.2, 1));
        }
        if ((e.type === 'impact' || e.type === 'hammer') && (mine || onMe)) action(t);
        if (e.type === 'impact' && onMe && !e.ball) { J.lastHitBy = e.carId; J.lastHitByT = t; }
        if (e.type === 'impact' && (mine || onMe)) J.bestHit = Math.max(J.bestHit, vn);
        if (e.type === 'impact' && mine) { J.hits++; if (e.big) J.bigHits++; }
        // ---- scoring
        var victim = e.otherId != null ? carOf(snap, e.otherId) : null;
        var px = victim ? victim.x : e.x, py = victim ? victim.y : e.y, pz = victim ? victim.z : e.z;
        if (e.type === 'score' && mine) {
          var c = num(e.combo, 0) || comboUp(t);
          if (e.combo) { J.combo = e.combo; J.comboT = t; if (COMBO_CALL[e.combo]) say(t, COMBO_CALL[e.combo], '#ffd84a', 'combo'); }
          addPoints(e.label || 'HIT', num(e.points, 0));
          popup(t, e.x != null ? e.x : px, e.y != null ? e.y : py, e.z != null ? e.z - 1.6 : pz, String(e.label || 'HIT') + ' +' + Math.round(num(e.points, 0)), c > 1 ? 'x' + c + ' COMBO' : '', /T-BONE|TAKEDOWN|SANDWICH/.test(e.label) ? '#ffd84a' : '#fff', num(e.points, 0) >= 250);
          if (/REVENGE/.test(e.label || '')) fx.stings.push('revenge');
        } else if (!J.sawScore && mine && (e.type === 'impact' || e.type === 'hammer' || e.type === 'launch') && !e.miss && (e.big || vn > 7 || e.type !== 'impact')) {
          var key = e.type === 'launch' ? 'launch' : e.type === 'hammer' ? 'hammer' : e.ball ? 'ball' : e.kind === 'tbone' ? 'tbone' : e.kind === 'headon' ? 'headon' : e.kind === 'reverse' ? 'reverse' : e.kind === 'rear' ? 'rear' : (e.zone === 'left' || e.zone === 'right') ? 'side' : 'hit';
          var me2 = carOf(snap, pid); if (key === 'hit' && me2 && me2.airborne) key = 'airborne';
          var F = FALLBACK[key], cc = comboUp(t);
          var pts = Math.round(F.pts * clamp(0.6 + vn / 20, 0.6, 1.8) * (1 + 0.25 * (cc - 1)) / 10) * 10;
          addPoints(F.label, pts);
          popup(t, px, py, pz, F.label + ' +' + pts, cc > 1 ? 'x' + cc + ' COMBO' : '', key === 'tbone' || key === 'launch' ? '#ffd84a' : '#fff', pts >= 250);
        }
        // ---- takedowns, streaks, revenge
        if (e.type === 'eliminated') {
          if (e.otherId === pid && e.carId !== pid) {
            J.kills.push(t); J.totalKills++;
            J.kills = J.kills.filter(function (x) { return t - x < 8; });
            if (!J.sawScore) {
              addPoints('TAKEDOWN', 500); popup(t, e.x, e.y, e.z, 'TAKEDOWN +500', '', '#ff5a48', true);
              if (J.lastHitBy === e.carId && t - J.lastHitByT < 10) { addPoints('REVENGE!', 150); popup(t, e.x, e.y, num(e.z, 1) + 1.2, 'REVENGE! +150', '', '#7ad7ff', true); fx.stings.push('revenge'); }
            }
            var n = J.kills.length, call = STREAK[Math.min(6, Math.max(n, J.totalKills >= 4 ? J.totalKills : 0))] || null;
            if (!J.firstBlood) { J.firstBlood = true; call = call || 'FIRST BLOOD'; }
            if (n >= 2) call = STREAK[Math.min(6, n)];
            say(t, call || 'TAKEDOWN!', '#ff5a48', 'takedown');
            fx.stings.push('takedown');
            fx.replay = { t: t, targetId: e.carId, x: e.x, y: e.y, title: call || 'TAKEDOWN!' };
          } else if (e.carId === pid) {
            fx.replay = { t: t, targetId: pid, x: e.x, y: e.y, title: e.otherId ? 'WRECKED!' : 'ELIMINATED' };
          } else if (followed) fx.shake = Math.max(fx.shake, 0.6);
          if (!J.firstBlood && e.otherId && e.otherId !== pid) J.firstBlood = true;
        }
        if (e.type === 'win' && e.carId) { fx.replay = fx.replay || { t: t, targetId: e.carId, x: null, y: null, title: e.carId === pid ? 'YOU WIN!' : 'FINAL KILL', final: true }; fx.stings.push(e.carId === pid ? 'win' : 'lose'); }
        if (e.type === 'pickup' && (mine || e.carId === fid)) fx.toasts.push(String(e.kind || e.label || 'PICKUP').toUpperCase());
        if (e.type === 'sudden-death') fx.stings.push('sudden');   // the HUD banner shows it
      });
      J.popups = J.popups.filter(function (p) { return t - p.t < 1.6; });
      if (J.announce && t - J.announce.t > 2.2) J.announce = null;
      if (snap.phase === 'fight' && pc && !pc.out) J.longestGap = Math.max(J.longestGap, t - J.lastActionT);
      else J.lastActionT = t;   // the gap clock only runs while the player is alive and fighting
      return fx;
    }
    return { ingest: ingest, state: J, reset: function () { var n = createJuice(); for (var k in n.state) J[k] = n.state[k]; } };
  }
  /** is (x, y) outside the sudden-death safe zone? (the arena outline scaled by safeScale about the centre) */
  function outsideSafe(arena, sd, x, y) {
    if (!sd || typeof sd !== 'object' || !(num(sd.safeScale, 1) < 0.999) || !CB.derby.arenas) return false;
    var s = Math.max(0.05, sd.safeScale);
    return CB.derby.arenas.sdBoundary(arena, x / s, y / s).d < 0;
  }
  function sdInfo(sd) {
    if (sd == null) return { on: false, level: 0, safeScale: 1 };
    if (typeof sd === 'number') return { on: sd > 1.001, level: sd, safeScale: 1 };
    return { on: !!sd.on, level: num(sd.level, 1), safeScale: num(sd.safeScale, 1), ringFire: !!sd.ringFire };
  }

  /* ------------------------------------------------------------------ HUD instance */
  function create() {
    var H = { banner: null, flash: 0, lastAlive: null, lastPhase: null, lastT: 0, goT: -9, outT: null, hitT: -9 };
    function setBanner(textMain, sub, color, dur, t) { H.banner = { text: textMain, sub: sub || '', color: color || '#fff', until: t + (dur || 2), t0: t }; }
    function draw(ctx, snap, view) {
      if (!snap || !snap.cars) return;
      view = view || {};
      var W = view.width, Hh = view.height, t = snap.t;
      var L = layout(W, Hh, { compact: view.compact, touch: view.touch, safe: view.safe });
      var follow = null, player = null;
      snap.cars.forEach(function (c) { if (c.isPlayer) player = c; if (c.id === view.followId) follow = c; });
      follow = follow || player || snap.cars[0];
      var me = player || follow;
      // ---- events -> flashes / banners
      (snap.events || []).forEach(function (e) {
        if ((e.type === 'impact' || e.type === 'wall' || e.type === 'hammer') && (e.otherId === me.id || (e.type === 'wall' && e.carId === me.id)) && e.big) { H.flash = Math.min(1, H.flash + 0.6); H.hitT = t; }
        if (e.type === 'go') { H.goT = t; }
      });
      if (H.lastPhase !== snap.phase) {
        if (snap.phase === 'over') {
          var win = snap.cars.filter(function (c) { return c.id === snap.winnerId; })[0];
          if (win && win.isPlayer) setBanner('YOU WIN!', 'Last car standing', '#ffd84a', 99, t);
          else setBanner(win ? (win.short || win.name) + ' WINS' : 'DERBY OVER', snap.endReason === 'time' ? 'Time is up' : 'Last car standing', '#fff', 99, t);
        }
        H.lastPhase = snap.phase;
      }
      if (me && me.out && H.outT == null && snap.phase !== 'over') {
        H.outT = t;
        var why = { wrecked: 'Wrecked', fell: 'You fell off the edge', engine: 'Engine dead', immobile: 'Stuck', fire: 'Burned out' }[me.elimReason] || 'Out';
        setBanner(me.lives > 0 ? 'WRECKED' : 'ELIMINATED', why + (me.lives > 0 ? ' — respawning…' : ''), '#ff5a48', 2.6, t);
      }
      if (me && !me.out) H.outT = null;
      if (snap.phase === 'fight' && H.lastAlive != null && snap.aliveCount < H.lastAlive && snap.aliveCount === 2 && !(me && me.out)) setBanner('LAST 2!', 'Finish it', '#ffb13a', 2, t);
      H.lastAlive = snap.aliveCount;
      var dt = clamp(t - H.lastT, 0, 0.1); H.lastT = t;
      H.flash = Math.max(0, H.flash - dt * 1.8);
      // ---- hit vignette
      if (H.flash > 0.01) {
        var gr = ctx.createRadialGradient(W / 2, Hh / 2, Math.min(W, Hh) * 0.35, W / 2, Hh / 2, Math.max(W, Hh) * 0.7);
        gr.addColorStop(0, 'rgba(255,0,0,0)'); gr.addColorStop(1, 'rgba(200,10,10,' + (0.5 * H.flash).toFixed(3) + ')');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, W, Hh);
      }
      // ---- impact flash (white = you hit them, red = they hit you)
      var JS = view.juice || null, fl = view.flash;
      if (fl && fl.a > 0.01) { ctx.fillStyle = 'rgba(' + fl.color + ',' + (fl.a * 0.55).toFixed(3) + ')'; ctx.fillRect(0, 0, W, Hh);
        // chromatic punch: offset red / cyan edge bands
        var cw2 = fl.a > 0.3 ? Math.max(2, W * 0.008 * fl.a) : 0;
        ctx.fillStyle = 'rgba(255,0,60,' + (fl.a * 0.5).toFixed(3) + ')'; ctx.fillRect(0, 0, cw2, Hh); ctx.fillRect(W - cw2 * 2, 0, cw2, Hh);
        ctx.fillStyle = 'rgba(0,220,255,' + (fl.a * 0.45).toFixed(3) + ')'; ctx.fillRect(cw2, 0, cw2, Hh); ctx.fillRect(W - cw2, 0, cw2, Hh); }
      // ---- boost speed lines
      var boostOn = !!(follow && ((follow.ram && follow.ram.active) || follow.boosting));
      H.boostK = num(H.boostK, 0) + ((boostOn ? 1 : 0) - num(H.boostK, 0)) * clamp((t - num(H.lastT2, t)) * 6, 0, 1); H.lastT2 = t;
      if (H.boostK > 0.03 && !view.noSpeedLines) {
        var nL = view.compact ? 22 : 36, cxs = W / 2, cys = Hh * 0.5, R0 = Math.max(W, Hh) * 0.5;
        ctx.strokeStyle = 'rgba(255,240,220,' + (0.32 * H.boostK).toFixed(3) + ')'; ctx.lineWidth = view.compact ? 1.5 : 2.2; ctx.beginPath();
        for (var li = 0; li < nL; li++) {
          var an = li / nL * Math.PI * 2 + ((li * 7919) % 13) * 0.05, ph = (t * 3.2 + ((li * 31) % 17) / 17) % 1;
          var r0 = R0 * (0.5 + ph * 0.55), r1 = r0 + R0 * (0.12 + 0.16 * H.boostK);
          ctx.moveTo(cxs + Math.cos(an) * r0, cys + Math.sin(an) * r0 * 0.75); ctx.lineTo(cxs + Math.cos(an) * r1, cys + Math.sin(an) * r1 * 0.75);
        }
        ctx.stroke();
        var gB = ctx.createRadialGradient(cxs, cys, R0 * 0.55, cxs, cys, R0 * 1.2);
        gB.addColorStop(0, 'rgba(60,140,255,0)'); gB.addColorStop(1, 'rgba(60,140,255,' + (0.28 * H.boostK).toFixed(3) + ')');
        ctx.fillStyle = gB; ctx.fillRect(0, 0, W, Hh);
      }
      // ---- sudden death: pulsing red edge when outside the safe ring
      var SD = sdInfo(snap.suddenDeath);
      if (SD.on && !H.sdOn) { H.sdOn = true; setBanner('SUDDEN DEATH', SD.safeScale < 0.999 ? 'The arena is closing in — stay inside the ring' : 'Every hit hurts more', '#ff3b2f', 2.4, t); }
      var outside = follow && !follow.out && (follow.ringOut || outsideSafe(snap.arena, snap.suddenDeath, follow.x, follow.y));
      if (outside || (SD.on && follow && follow.onFire > 0.3)) {
        var pk = 0.5 + 0.5 * Math.sin(t * 9);
        var gE = ctx.createRadialGradient(W / 2, Hh / 2, Math.min(W, Hh) * 0.3, W / 2, Hh / 2, Math.max(W, Hh) * 0.65);
        gE.addColorStop(0, 'rgba(255,40,0,0)'); gE.addColorStop(1, 'rgba(255,40,0,' + ((outside ? 0.35 : 0.18) + 0.25 * pk).toFixed(3) + ')');
        ctx.fillStyle = gE; ctx.fillRect(0, 0, W, Hh);
        if (outside) text(ctx, 'OUTSIDE THE RING — GET BACK IN!', W / 2, Hh * 0.2, L.compact ? 13 : 18, '#ffd0c0', 'center', 900);
      }
      // ---- health
      var hr = L.health, c = follow;
      panel(ctx, hr);
      var nameS = view.spectating ? 'SPECTATING · ' + (c.short || c.name) : (c.isPlayer ? 'YOU' : c.short || c.name) + (c.lives > 1 ? '  ×' + c.lives : '');
      var small = L.compact;
      ctx.font = '800 ' + (small ? 10 : 12) + 'px ' + FONT;
      text(ctx, fit(ctx, nameS, hr.w - 70), hr.x + 10, hr.y + (small ? 9 : 13), small ? 10 : 12, 'rgba(255,255,255,.8)', 'left', 800);
      var hp = clamp(num(c.health, 0), 0, 1);
      text(ctx, Math.round(hp * 100) + '%', hr.x + hr.w - 10, hr.y + (small ? 9 : 13), small ? 11 : 14, hp < 0.25 ? '#ff6a5a' : '#fff', 'right', 800);
      var bx = hr.x + 10, by = hr.y + (small ? 18 : 25), bw = hr.w - 20, bh = small ? 8 : 12;
      rr(ctx, bx, by, bw, bh, bh / 2); ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fill();
      if (hp > 0) { rr(ctx, bx, by, Math.max(bh, bw * hp), bh, bh / 2); ctx.fillStyle = hp > 0.6 ? '#4ccf7a' : hp > 0.3 ? '#f0b030' : '#ff4a3a'; ctx.fill(); }
      if (!small) text(ctx, Math.round(num(c.speed, 0) * 3.6) + ' km/h' + (c.gear < 0 ? ' · R' : '') + (c.boosting ? ' · NITRO' : '') + (c.shield > 0 ? ' · SHIELD' : ''), bx, hr.y + hr.h - 6, 10, 'rgba(255,255,255,.55)', 'left', 600);
      // ---- damage diagram
      panel(ctx, L.diagram);
      drawCarDiagram(ctx, c, L.diagram, t);
      // ---- counter + timer
      var cr = L.count;
      panel(ctx, cr);
      text(ctx, snap.aliveCount + ' / ' + snap.total, cr.x + cr.w / 2, cr.y + cr.h * (small ? 0.42 : 0.4), small ? 15 : 20, '#fff', 'center', 900);
      text(ctx, 'LEFT', cr.x + cr.w / 2, cr.y + cr.h * 0.82, small ? 7 : 9, 'rgba(255,255,255,.55)', 'center', 800);
      if (snap.timeLeft_s != null) {
        var tl = Math.ceil(snap.timeLeft_s), mm = Math.floor(tl / 60), ss = tl % 60;
        text(ctx, mm + ':' + (ss < 10 ? '0' : '') + ss, L.timer.x + L.timer.w / 2, L.timer.y + L.timer.h / 2, small ? 12 : 15, tl <= 10 ? '#ff6a5a' : '#fff', 'center', 800);
      }
      // ---- minimap
      if (snap.arena) drawMinimap(ctx, snap.arena, snap.cars, L.minimap, { followId: c.id, playerId: player ? player.id : null, safeScale: SD.safeScale, entities: snap.entities });
      // ---- score + combo (under the cars-left counter) and the RAM BOOST gauge (under health)
      if (JS && !view.spectating) {
        var scX = small ? L.minimap.x + L.minimap.w / 2 : W / 2;
        var scY = small ? L.minimap.y + L.minimap.h + 13 : L.timer.y + (snap.timeLeft_s != null ? L.timer.h + 4 : 0) + 12;
        var scoreV = c.isPlayer && c.stats && num(c.stats.score, 0) > 0 ? c.stats.score : JS.score;
        rr(ctx, scX - (small ? 44 : 64), scY - (small ? 10 : 14), small ? 88 : 128, small ? 28 : 38, 8); ctx.fillStyle = 'rgba(10,10,14,.55)'; ctx.fill();
        text(ctx, String(Math.round(scoreV)).replace(/\B(?=(\d{3})+(?!\d))/g, ','), scX, scY, small ? 15 : 22, '#ffd84a', 'center', 900);
        text(ctx, 'SCORE', scX, scY + (small ? 11 : 15), small ? 7 : 9, 'rgba(255,216,74,.65)', 'center', 800);
        var comboLive = JS.combo > 1 && t - JS.comboT < 3.2;
        if (comboLive) {
          var ck = clamp(1 - (t - JS.comboT) / 3.2, 0, 1);
          text(ctx, 'x' + JS.combo + ' COMBO', scX, scY + (small ? 24 : 34), small ? 12 : 16, '#ff9d3a', 'center', 900);
          rr(ctx, scX - 40, scY + (small ? 31 : 44), 80 * ck, 3, 1.5); ctx.fillStyle = '#ff9d3a'; ctx.fill();
        }
      }
      if (c.ram && !view.spectating && !c.out) {
        var rg = small ? { x: L.diagram.x + L.diagram.w + 6, y: L.diagram.y, w: Math.max(80, hr.w - L.diagram.w - 6), h: 14 } : { x: hr.x, y: L.diagram.y + L.diagram.h + 8, w: hr.w, h: 16 };
        var rch = clamp(num(c.ram.charge, 0), 0, 1);
        rr(ctx, rg.x, rg.y, rg.w, rg.h, rg.h / 2); ctx.fillStyle = 'rgba(10,10,14,.6)'; ctx.fill();
        rr(ctx, rg.x + 2, rg.y + 2, Math.max(rg.h - 4, (rg.w - 4) * rch), rg.h - 4, (rg.h - 4) / 2);
        ctx.fillStyle = c.ram.active ? '#ffffff' : rch >= 0.999 ? '#3aa0ff' : 'rgba(58,160,255,.65)'; ctx.fill();
        var bk = view.keys && view.keys.boost ? view.keys.boost : 'SHIFT';
        text(ctx, (c.ram.active ? 'RAMMING!' : rch >= 0.999 ? 'RAM BOOST READY · ' + bk : 'RAM BOOST'), rg.x + rg.w / 2, rg.y + rg.h / 2 + 0.5, small ? 8 : 10, c.ram.active ? '#0b2a52' : '#fff', 'center', 900);
      }
      if (c.idle && !c.out && !view.spectating) {
        var ip = 0.6 + 0.4 * Math.sin(t * 8), iy = small ? L.diagram.y + L.diagram.h + 6 : L.diagram.y + L.diagram.h + 32;
        ctx.globalAlpha = ip; rr(ctx, hr.x, iy, small ? 150 : 210, small ? 18 : 24, 6); ctx.fillStyle = 'rgba(255,60,30,.85)'; ctx.fill();
        text(ctx, 'CAMPING! Get in there', hr.x + 8, iy + (small ? 9 : 12), small ? 10 : 12, '#fff', 'left', 900); ctx.globalAlpha = 1;
      }
      // ---- kill feed
      var feed = (snap.feed || []).filter(function (f) { return t - f.t < 6; });
      var maxLines = Math.floor(L.feed.h / (small ? 18 : 24));
      feed = feed.slice(-maxLines);
      feed.forEach(function (f, i) {
        var y = L.feed.y + i * (small ? 18 : 24) + (small ? 9 : 12), age = t - f.t, a = clamp(1 - (age - 4.5) / 1.5, 0, 1);
        var col = f.kind === 'kill' ? '255,90,72' : f.kind === 'hit' ? '255,200,80' : f.kind === 'taunt' ? '205,160,255' : f.kind === 'score' ? '255,216,74' : '220,225,235';
        var involved = player && (f.carId === player.id || f.otherId === player.id);
        ctx.globalAlpha = a;
        var ftxt = f.text;
        ctx.font = (f.kind === 'taunt' ? 'italic 700 ' : '700 ') + (small ? 11 : 13) + 'px ' + FONT;
        var tw = Math.min(L.feed.w, ctx.measureText(ftxt).width + 16);
        var x0 = small ? L.feed.x + (L.feed.w - tw) / 2 : L.feed.x + L.feed.w - tw;
        rr(ctx, x0, y - (small ? 8 : 10), tw, small ? 16 : 20, 5); ctx.fillStyle = involved ? 'rgba(14,12,10,.82)' : 'rgba(10,10,14,.62)'; ctx.fill();
        if (involved) { ctx.fillStyle = 'rgb(' + col + ')'; ctx.fillRect(x0, y - (small ? 6 : 8), 3, small ? 12 : 16); }
        var ft = fit(ctx, ftxt, tw - 12);
        ctx.fillStyle = 'rgb(' + col + ')'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(ft, x0 + 8, y);
        ctx.globalAlpha = 1;
      });
      // ---- accessories (desktop / non-touch)
      var acc = (c.acc || []).slice().sort(function (a2, b2) { return (b2.button ? 3 - b2.button : 0) - (a2.button ? 3 - a2.button : 0); });
      var keys = view.keys || { a1: 'F', a2: 'G' };
      for (var k = 0; k < acc.length && k < L.acc.length && !view.spectating; k++) {
        var a3 = acc[k], r3 = L.acc[k];
        panel(ctx, r3, a3.button && a3.ready ? 0.7 : 0.5);
        if (a3.active) { rr(ctx, r3.x, r3.y, r3.w, r3.h, 9); ctx.strokeStyle = '#ffb13a'; ctx.lineWidth = 2; ctx.stroke(); }
        var key = a3.button === 1 ? keys.a1 : a3.button === 2 ? keys.a2 : null;
        var lx = r3.x + 10;
        if (key) {
          rr(ctx, lx, r3.y + 8, small ? 18 : 24, small ? 16 : 20, 4); ctx.fillStyle = a3.ready ? '#ffb13a' : 'rgba(255,255,255,.2)'; ctx.fill();
          text(ctx, key, lx + (small ? 9 : 12), r3.y + (small ? 16 : 18), small ? 9 : 11, '#111', 'center', 900);
          lx += small ? 22 : 30;
        }
        ctx.font = '800 ' + (small ? 9 : 12) + 'px ' + FONT;
        text(ctx, fit(ctx, accLabel(a3).toUpperCase(), r3.x + r3.w - lx - 8), lx, r3.y + (small ? 16 : 18), small ? 9 : 12, '#fff', 'left', 800);
        var info = a3.kind === 'passive' ? 'PASSIVE' : a3.ammo != null && (a3.id === 'oil' || a3.id === 'caltrops' || a3.id === 'repair') ? '×' + a3.ammo : a3.cooldown > 0 ? a3.cooldown.toFixed(1) + 's' : a3.ready ? 'READY' : '';
        if (!small) text(ctx, info, r3.x + r3.w - 10, r3.y + 38, 10, a3.ready && a3.kind !== 'passive' ? '#9be8a8' : 'rgba(255,255,255,.5)', 'right', 700);
        if (a3.kind !== 'passive') {
          var cy0 = r3.y + r3.h - (small ? 9 : 12), cw0 = r3.w - 20;
          rr(ctx, r3.x + 10, cy0, cw0, 4, 2); ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fill();
          var ch = clamp(num(a3.charge, 1), 0, 1);
          if (ch > 0) { rr(ctx, r3.x + 10, cy0, Math.max(4, cw0 * ch), 4, 2); ctx.fillStyle = a3.active ? '#ffb13a' : '#6ac0ff'; ctx.fill(); }
        }
      }
      // ---- countdown / go
      if (snap.phase === 'countdown') {
        var n = Math.ceil(snap.countdown_s), fr = snap.countdown_s - Math.floor(snap.countdown_s);
        var sz = (small ? 70 : 120) * (0.8 + 0.4 * fr);
        ctx.globalAlpha = 0.35 + 0.65 * fr;
        text(ctx, String(Math.max(1, n)), W / 2, Hh * 0.42, sz, '#fff', 'center', 900);
        ctx.globalAlpha = 1;
        text(ctx, 'GET READY', W / 2, Hh * 0.42 + sz * 0.62, small ? 13 : 18, 'rgba(255,255,255,.8)', 'center', 800);
      } else if (t - H.goT < 1.1) {
        var gk = (t - H.goT) / 1.1;
        ctx.globalAlpha = 1 - gk;
        text(ctx, "WRECK 'EM!", W / 2, Hh * 0.42, (small ? 48 : 86) * (1 + gk * 0.3), '#ffb13a', 'center', 900);
        ctx.globalAlpha = 1;
      }
      // ---- banner
      var bn = H.banner;
      if (bn && t < bn.until) {
        var ba = clamp((t - bn.t0) / 0.2, 0, 1) * clamp((bn.until - t) / 0.4, 0, 1);
        ctx.globalAlpha = ba;
        var R = L.banner;
        var g2 = ctx.createLinearGradient(R.x, 0, R.x + R.w, 0);
        g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(0.2, 'rgba(0,0,0,.6)'); g2.addColorStop(0.8, 'rgba(0,0,0,.6)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g2; ctx.fillRect(R.x, R.y, R.w, R.h);
        text(ctx, bn.text, W / 2, R.y + R.h * 0.42, small ? 32 : 56, bn.color, 'center', 900);
        if (bn.sub) text(ctx, bn.sub, W / 2, R.y + R.h * 0.82, small ? 12 : 16, 'rgba(255,255,255,.85)', 'center', 700);
        ctx.globalAlpha = 1;
      }
      if (view.spectating && snap.phase !== 'over' && !(bn && t < bn.until)) {
        var sy = Hh - (view.touch ? 30 : 100);
        ctx.font = '800 13px ' + FONT;
        var stxt = '◀  Spectating ' + (c.short || c.name) + '  ▶' + (view.touch ? '' : '   ·   Enter: results');
        var sw = ctx.measureText(stxt).width + 28;
        rr(ctx, W / 2 - sw / 2, sy - 15, sw, 30, 8); ctx.fillStyle = 'rgba(10,10,14,.7)'; ctx.fill();
        text(ctx, stxt, W / 2, sy, 13, '#fff', 'center', 800);
      }
      if (JS) drawJuice(ctx, JS, snap, view, L, t);
      if (view.fps) text(ctx, Math.round(view.fps) + ' fps', W - 8, Hh - 8, 10, 'rgba(255,255,255,.45)', 'right', 600);
    }
    /** world-space points popups, the announcer, pickup toasts */
    function drawJuice(ctx, J, snap, view, L, t) {
      var small = L.compact;
      // phones: only the newest two popups (a pile of 5 overlapping labels is unreadable), kept below the announcer
      var live = J.popups.filter(function (p) { var a0 = t - p.t; return a0 >= 0 && a0 <= 1.6; });
      if (small && live.length > 2) live = live.slice(-2);
      live.forEach(function (p, i) {
        var age = t - p.t; if (age < 0 || age > 1.6) return;
        var s = view.project ? view.project(p.x, p.y, p.z + age * 1.2) : null;
        var x = s && s.visible ? s.x : view.width / 2, y = s && s.visible ? s.y : view.height * 0.36;
        x = clamp(x, view.width * 0.27, view.width * 0.73); y = clamp(y, view.height * 0.3, view.height * 0.72);
        var pop = age < 0.12 ? 0.6 + age / 0.12 * 0.7 : age < 0.22 ? 1.3 - (age - 0.12) / 0.1 * 0.3 : 1;
        var a = clamp((1.6 - age) / 0.45, 0, 1);
        var sz = (p.big ? (small ? 24 : 42) : (small ? 18 : 30)) * pop;
        y -= (small ? (live.length - 1 - i) * 46 : p.slot * 58) + age * 18;
        if (small) y = Math.max(y, view.height * 0.46);
        ctx.globalAlpha = a;
        ctx.save(); ctx.translate(x, y); ctx.rotate(p.slot % 2 ? 0.035 : -0.035);
        ctx.font = 'italic 900 ' + sz + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, sz * 0.18); ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(p.text, 0, 0);
        ctx.fillStyle = p.color; ctx.fillText(p.text, 0, 0);
        var ly = sz * 0.85;
        if (p.pts || p.sub) {
          var line = (p.pts || '') + (p.pts && p.sub ? '  ' : '') + (p.sub || '');
          ctx.font = '900 ' + Math.round(sz * 0.62) + 'px ' + FONT; ctx.lineWidth = Math.max(2.5, sz * 0.12); ctx.strokeText(line, 0, ly);
          ctx.fillStyle = p.sub ? '#ff9d3a' : '#ffd84a'; ctx.fillText(line, 0, ly);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      });
      var A = J.announce;
      if (A) {
        var age2 = t - A.t;
        if (age2 >= 0 && age2 < 2.2) {
          var sc2 = age2 < 0.15 ? 1.8 - age2 / 0.15 * 0.8 : 1 + Math.max(0, age2 - 1.6) * 0.3;
          var a2 = clamp((2.2 - age2) / 0.5, 0, 1) * clamp(age2 / 0.06, 0, 1);
          var big = (small ? 30 : 64) * sc2, yA = view.height * (small ? 0.34 : 0.27);
          ctx.globalAlpha = a2;
          ctx.save(); ctx.translate(view.width / 2, yA); ctx.rotate(-0.04);
          ctx.font = 'italic 900 ' + big + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = big * 0.14; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(A.text, 0, 0);
          var gA = ctx.createLinearGradient(0, -big / 2, 0, big / 2); gA.addColorStop(0, '#fff6c8'); gA.addColorStop(0.5, A.color); gA.addColorStop(1, '#a8260f');
          ctx.fillStyle = gA; ctx.fillText(A.text, 0, 0);
          ctx.restore(); ctx.globalAlpha = 1;
        }
      }
      (view.toasts || []).forEach(function (q, i) {
        var age3 = t - q.t; if (age3 < 0 || age3 > 1.8) return;
        ctx.globalAlpha = clamp((1.8 - age3) / 0.4, 0, 1);
        var ty = view.height * 0.62 - i * 30 - age3 * 12, tw = Math.max(120, q.text.length * 11 + 30);
        rr(ctx, view.width / 2 - tw / 2, ty - 14, tw, 28, 14); ctx.fillStyle = 'rgba(10,30,20,.8)'; ctx.fill();
        text(ctx, q.text, view.width / 2, ty, small ? 12 : 15, '#9be8a8', 'center', 900);
        ctx.globalAlpha = 1;
      });
    }
    return { draw: draw, reset: function () { H.banner = null; H.flash = 0; H.lastAlive = null; H.lastPhase = null; H.outT = null; H.goT = -9; }, _state: H };
  }

  CB.derby.hud = { layout: layout, touchLayout: touchLayout, overlap: overlap, create: create, createJuice: createJuice, FALLBACK: FALLBACK, STREAK: STREAK, COMBO_CALL: COMBO_CALL, outsideSafe: outsideSafe, sdInfo: sdInfo, PICKUP_COL: PICKUP_COL, zoneColor: zoneColor, drawMinimap: drawMinimap, drawCarDiagram: drawCarDiagram, arenaPath: arenaPath, boxPts: boxPts, roundRect: rr };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.hud;
})();

/* ==========================================================================
   Redline — js/arcade/stunt-features.js
   CB.arcade.stunt.features : runtime of the SPECIAL stunt features (moving hazards, pinball bumpers / flippers, speed belts,
   booster tunnels, hop springs, collectible stars, rings of fire, drift zones) + the stunt callouts ("BARREL ROLL!",
   "WARP!", "SHORTCUT!" …). Pure logic, Node-loadable, deterministic: every hazard phase is a pure function of the car's
   race clock (session time − car.clockOffset, so a remote player's delayed copy on the multiplayer host meets the hazards
   exactly as the player's own prediction did); per-car state lives in plain JSON on the car (car.feat).

   Feature records (stunt-track.js builds them from the map's piece `features`, s absolute, lat + = left):
     {type:'hazard', kind:'pendulum'|'hammer'|'windmill'|'piston'|'boulder', s, lat, period?, phase? (0..1), amp?, w?, r?,
       side? (+1 left / -1 right: piston wall, boulder start side), ext?, h?}
     {type:'bumper', s, lat, r?}            {type:'flipper', s, side, len?, period?, phase?}
     {type:'belt', s, len, lat?, w?, push?, top?}   {type:'tunnel', s, len, push?, top?, r?}   {type:'spring', s, lat, len?, w?, vy?}
     {type:'star', s, lat, z?}              {type:'ring', fire:true, s, lat, z?, r?}    {type:'driftZone', s, len}
     {type:'split', s, len, div, inner, dw?, nose?}  (physics in stunt-physics.js; callout here)

   API
     hazardState(f, t, halfWidth) -> { kind, active, lat0, lat1 (blocked lateral interval), sHalf, latC, dir (shove +left/-1),
                                       ph (0..1), angle (rad, renderer), ext (m, piston), h (m, body height), visible }
     flipperState(f, t) -> { ph, angle (0 rest .. 1 flipped), active }
     index(track) -> per-track cached lists (sorted by s) + piece crossings for callouts
     step(car, ctx {track, t, dt, input, gp, emit(kind, data), immune}) — one fixed substep after the physics step
     onPhysicsEvent(car, ev, ctx) — converts physics events (cannon take-off, long flights) into callouts
     hazardsNear(track, s, range, t) -> [{f, d (m ahead), state}] (AI planning)
     CALLOUTS {kind: [text, colour]}  (HUD; arcade-hud.js maps 'stuntFx' events)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};
CB.arcade.stunt = CB.arcade.stunt || {};

(function (S) {
  'use strict';

  var TAU = Math.PI * 2;
  var V = S._vec, clamp = V.clamp, num = V.num, wrapS = V.wrapS, wrapD = V.wrapD;
  var CAR_HW = 0.95, CAR_HL = 2.1;
  function frac(x) { return x - Math.floor(x); }
  function sgn(x) { return x < 0 ? -1 : 1; }
  function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }

  var DEF_PERIOD = { pendulum: 3.2, hammer: 2.6, windmill: 4.0, piston: 2.4, boulder: 4.2 };

  /* ------------------------------------------------------------------ hazard kinematics (pure functions of t) */
  function hazardState(f, t, hw) {
    hw = num(hw, 6.5);
    var kind = f.kind || 'pendulum', T = Math.max(0.6, num(f.period, DEF_PERIOD[kind] || 3)), ph = frac(t / T + num(f.phase, 0));
    var o = { kind: kind, ph: ph, active: false, lat0: 0, lat1: 0, latC: f.lat, sHalf: 1.4, dir: 1, angle: 0, ext: 0, h: 0, visible: true };
    if (kind === 'pendulum') {
      // a wrecking ball on a gantry swinging across the road; ball radius r, swing amplitude amp (centre lateral)
      var amp = num(f.amp, Math.max(1, hw - 1.6)), r = num(f.r, 1.45), H = num(f.h, 13);
      var a = Math.sin(TAU * ph), lat = f.lat + amp * a;
      o.latC = lat; o.lat0 = lat - r; o.lat1 = lat + r; o.sHalf = r; o.active = true;
      o.dir = Math.cos(TAU * ph) >= 0 ? 1 : -1;            // swing direction (+ left)
      o.angle = Math.asin(clamp(amp * a / H, -0.95, 0.95)); o.h = H; o.r = r;
    } else if (kind === 'hammer') {
      // a giant mallet hinged at the side rail slamming down onto a lane: raised .55, slam .55-.66, down .66-.82, rise
      var w = num(f.w, 2.8), down;
      if (ph < 0.55) down = 0;
      else if (ph < 0.66) { var u = (ph - 0.55) / 0.11; down = u * u; }
      else if (ph < 0.82) down = 1;
      else down = 1 - smooth((ph - 0.82) / 0.18);
      o.angle = (1 - down) * Math.PI * 0.45;               // 0 = flat on the road, ~81° = raised
      o.active = down > 0.82; o.lat0 = f.lat - w; o.lat1 = f.lat + w; o.sHalf = 1.7; o.dir = f.lat >= 0 ? -1 : 1;
      o.warn = ph > 0.4 && ph < 0.66;                      // telegraph (flash) just before the slam
    } else if (kind === 'windmill') {
      // four blades turning in the cross-section plane; hub above the lane at R + 0.6 m
      var R = num(f.r, Math.max(3, hw * 0.9)), Hh = R + 0.6, th = TAU * ph * (f.dir < 0 ? -1 : 1);
      o.angle = th; o.h = Hh; o.r = R;
      for (var i = 0; i < 4; i++) {
        var b = th + i * Math.PI / 2, cb = Math.cos(b), sb = Math.sin(b);
        if (cb < (Hh - 1.6) / R) continue;                 // blade not reaching down to car height
        var rIn = (Hh - 1.6) / cb, l0 = f.lat + rIn * sb, l1 = f.lat + R * sb;
        o.active = true; o.lat0 = Math.min(l0, l1) - 0.45; o.lat1 = Math.max(l0, l1) + 0.45; o.sHalf = 0.9;
        o.dir = (f.dir < 0 ? -1 : 1) * (cb > 0 ? 1 : -1);  // tip motion direction at the bottom
        break;
      }
    } else if (kind === 'piston') {
      // a crusher block pushing out of the side wall (side +1 left / -1 right) by ext metres
      var side = f.side < 0 ? -1 : 1, emax = num(f.ext, hw * 0.55), e;
      if (ph < 0.3) e = 0; else if (ph < 0.4) e = smooth((ph - 0.3) / 0.1); else if (ph < 0.65) e = 1; else if (ph < 0.85) e = 1 - smooth((ph - 0.65) / 0.2); else e = 0;
      o.ext = e * emax; o.active = o.ext > 0.4;
      var inner = side * (hw - o.ext);
      o.lat0 = Math.min(inner, side * (hw + 1)); o.lat1 = Math.max(inner, side * (hw + 1)); o.sHalf = num(f.len, 5) / 2; o.dir = -side; o.side = side;
      o.warn = ph > 0.18 && ph < 0.3;
    } else if (kind === 'boulder') {
      // a boulder rolling across the road from side `side`, then lifted back out of sight
      var sd = f.side < 0 ? -1 : 1, rr = num(f.r, 2.1), span = hw + rr + 1.5, uu = ph / 0.62;
      if (uu <= 1) {
        var lt = f.lat + sd * span * (1 - 2 * uu);
        o.latC = lt; o.lat0 = lt - rr; o.lat1 = lt + rr; o.sHalf = rr; o.active = Math.abs(lt - f.lat) < hw + rr; o.dir = -sd;
        o.angle = -sd * (span * 2 * uu) / rr;               // rolling angle
        o.r = rr;
      } else { o.visible = false; o.latC = f.lat + sd * span; o.r = rr; o.warn = uu > 1.45; }
    }
    return o;
  }
  function flipperState(f, t) {
    var T = Math.max(0.6, num(f.period, 1.8)), ph = frac(t / T + num(f.phase, 0)), a;
    if (ph < 0.08) a = smooth(ph / 0.08); else if (ph < 0.22) a = 1; else if (ph < 0.4) a = 1 - smooth((ph - 0.22) / 0.18); else a = 0;
    return { ph: ph, angle: a, active: ph < 0.24 };
  }

  /* ------------------------------------------------------------------ per-track index */
  var IDX = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function index(track) {
    var c = IDX && IDX.get(track);
    if (c) return c;
    var by = { hazard: [], bumper: [], flipper: [], belt: [], tunnel: [], spring: [], star: [], fire: [], driftZone: [], split: [] };
    track.features.forEach(function (f) {
      if (f.type === 'ring' && f.fire) by.fire.push(f);
      else if (by[f.type]) by[f.type].push(f);
    });
    // callout crossings: {s, kind, data}
    var cross = [];
    track.pieces.forEach(function (p) {
      if (p.type === 'tube') cross.push({ s: p.s1, kind: p.turns >= 2 ? 'barrelRoll2' : 'barrelRoll', ground: true });
      else if (p.type === 'zerog') cross.push({ s: wrapS(p.s0 + Math.PI * num(p.radius, 14), track.length), kind: 'zeroG', ground: true });
      else if (p.type === 'halfpipe') cross.push({ s: wrapS(p.s0 + 4, track.length), kind: 'halfpipe', ground: true });
      else if (p.type === 'loop' && num(p.radius, 0) >= 19) cross.push({ s: p.s1, kind: 'megaLoop', ground: true });
      else if (p.type === 'corkscrew') cross.push({ s: p.s1, kind: 'corkscrew', ground: true });
    });
    (track.warps || []).forEach(function (w) { cross.push({ s: w.s, kind: 'warp', any: true }); });
    (track.tunnels || []).forEach(function (q) { cross.push({ s: wrapS(q.s0 + 1, track.length), kind: 'tunnel', ground: true }); });
    (track.splits || []).forEach(function (q) { cross.push({ s: wrapS(q.s0 + 2, track.length), kind: 'split', split: q, ground: true }); });
    by.driftZone.forEach(function (q) { cross.push({ s: wrapS(q.s + 1, track.length), kind: 'driftZoneEnter', ground: true, zone: q }); });
    cross.sort(function (a, b) { return a.s - b.s; });
    c = { by: by, cross: cross, starTotal: by.star.length };
    if (IDX) IDX.set(track, c);
    return c;
  }

  /* ------------------------------------------------------------------ helpers */
  function feat(c) {
    var F = c.feat;
    if (!F || typeof F !== 'object') F = c.feat = { ps: null, cool: {}, st: {}, stars: 0, hz: 0, bumps: 0, flips: 0, fire: 0, warps: 0, zone: null, belt: null, drift: 0, cuts: 0 };
    return F;
  }
  function crossed(ps, s, x, L) {
    if (ps === null || ps === undefined) return false;
    var a = wrapD(x - ps, L), b = wrapD(s - x, L);
    return a > 0 && b >= 0 && wrapD(s - ps, L) < 40;
  }
  function cool(F, id, t, secs) { var k = F.cool[id]; if (k != null && k > t) return false; F.cool[id] = t + secs; return true; }
  function lapOf(c, L) { return Math.max(0, Math.floor(num(c.dist, 0) / L)); }
  function nitro(ctx, c, amount, src) {
    if (ctx.gp && typeof ctx.gp.addNitro === 'function') { try { ctx.gp.addNitro(c.id, amount, src); return; } catch (e) { /* fall back */ } }
    c.nitro = clamp(num(c.nitro, 0) + amount, 0, 1);
  }
  function immune(c, ctx) {
    if (c.ghostT > 0 || ctx.immune) return true;
    var fx = c.arcadeFx;
    return !!(fx && (fx.shielded || fx.ghost || fx.noCollide));
  }
  var _pp = null;
  function carWorld(track, c) {
    var P = S.physics;
    _pp = P.pose(track, c, _pp || undefined);
    var u = _pp.up;
    return [_pp.pos[0] + u[0] * 0.7, _pp.pos[1] + u[1] * 0.7, _pp.pos[2] + u[2] * 0.7];
  }

  /* ------------------------------------------------------------------ per-car step */
  function step(c, ctx) {
    var track = ctx.track, L = track.length, t = num(ctx.t, 0), dt = ctx.dt, P = S.physics, X = index(track), F = feat(c), by = X.by;
    var emit = ctx.emit || function () {};
    if (c.mode === 'respawn') { F.ps = null; F.zone = null; F.belt = null; return; }
    var ps = F.ps, s = c.s, ground = c.mode === 'ground';
    // ---- callout crossings
    if (ps !== null) {
      for (var i = 0; i < X.cross.length; i++) {
        var q = X.cross[i];
        if (!crossed(ps, s, q.s, L)) continue;
        if (q.ground && !ground) continue;
        if (q.kind === 'warp') { F.warps++; emit('warp', { s: q.s }); }
        else if (q.kind === 'split') {
          if (c.lane && q.split.shortcut) { var sc = c.lane === q.split.inner; if (sc) F.cuts++; emit(sc ? 'shortcut' : 'mainLine', { split: q.split.id }); }
        } else if (q.kind === 'driftZoneEnter') { F.zone = q.zone.id; emit('driftZone', { zone: q.zone.id }); }
        else emit(q.kind, {});
      }
    }
    var hwHere = track.sample(s).halfWidth, lap = lapOf(c, L), k, f, d;
    // ---- ground-only interactions
    if (ground) {
      var imm = immune(c, ctx);
      // hazards
      for (k = 0; k < by.hazard.length; k++) {
        f = by.hazard[k]; d = wrapD(c.s - f.s, L);
        if (Math.abs(d) > 9) continue;
        var hs = hazardState(f, t, hwHere);
        if (!hs.active || Math.abs(d) > hs.sHalf + CAR_HL) continue;
        if (c.lat + CAR_HW < hs.lat0 || c.lat - CAR_HW > hs.lat1) continue;
        if (imm) { if (cool(F, f.id + 'b', t, 1.0)) emit('hazardBlocked', { hazard: f.id, hz: hs.kind }); continue; }
        if (!cool(F, f.id, t, 1.4)) continue;
        var dir = hs.dir;
        if (hs.kind === 'pendulum' || hs.kind === 'boulder') dir = Math.abs(c.lat - hs.latC) > 0.3 ? sgn(c.lat - hs.latC) : hs.dir;
        if (hs.kind === 'piston') {
          // pushed out of the crusher's footprint, no spin
          var lim = hs.side * Math.max(0, hwHere - hs.ext - P.HALF_W - 0.05);
          if ((c.lat - lim) * hs.side > 0) c.lat = lim;
          P.bump(c, { latV: dir * 9, keep: 0.88, floor: 10 });
        } else if (hs.kind === 'hammer') P.bump(c, { latV: dir * 4, keep: 0.6, floor: 9, spin: 0.9, dir: dir });
        else P.bump(c, { latV: dir * (hs.kind === 'windmill' ? 9 : 8), keep: hs.kind === 'boulder' ? 0.66 : 0.72, floor: 9, spin: hs.kind === 'windmill' ? 0.75 : 0.8, dir: dir });
        F.hz++;
        emit('hazard', { hazard: f.id, hz: hs.kind, dir: dir });
      }
      // pinball bumpers: elastic bounce + a pinch of nitro
      for (k = 0; k < by.bumper.length; k++) {
        f = by.bumper[k]; d = wrapD(c.s - f.s, L);
        var br = num(f.r, 1.2);
        if (Math.abs(d) > br + CAR_HL) continue;
        var dl = c.lat - f.lat, ex = d / (br + CAR_HL), ey = dl / (br + CAR_HW);
        if (ex * ex + ey * ey >= 1) continue;
        var bs = Math.abs(dl) > 0.05 ? sgn(dl) : (f.lat >= 0 ? -1 : 1);
        c.lat = clamp(f.lat + bs * (br + CAR_HW) * Math.sqrt(Math.max(0, 1 - ex * ex)), -(hwHere - P.HALF_W), hwHere - P.HALF_W);
        if (!cool(F, f.id, t, 0.35)) continue;
        P.bump(c, { latV: bs * 10, keep: 0.93, floor: 12, psi: c.psi * -0.4 });
        F.bumps++;
        nitro(ctx, c, 0.04, 'bumper');
        emit('bumper', { bumper: f.id, dir: bs });
      }
      // flippers: kick forward + toward the centre while flipping
      for (k = 0; k < by.flipper.length; k++) {
        f = by.flipper[k]; d = wrapD(c.s - f.s, L);
        var fl = num(f.len, 6);
        if (Math.abs(d) > fl / 2 + CAR_HL) continue;
        var side = f.side < 0 ? -1 : 1, rel = c.lat * side;
        if (rel < hwHere - fl * 0.85 - CAR_HW) continue;
        var fs = flipperState(f, t);
        if (!fs.active || !cool(F, f.id, t, 1.0)) continue;
        P.boost(c, 0.9, 1.25, 18);
        c.latV = -side * 7;
        F.flips++;
        emit('flipper', { flipper: f.id });
      }
      // speed belts + booster tunnels: continuous push while on them
      var onBelt = null;
      for (k = 0; k < by.belt.length; k++) {
        f = by.belt[k]; d = wrapD(c.s - f.s, L);
        if (d < 0 || d > num(f.len, 40)) continue;
        var bw = num(f.w, 2 * hwHere);
        if (Math.abs(c.lat - f.lat) > bw / 2) continue;
        P.boost(c, 0.12, num(f.top, 1.12), num(f.push, 9));
        onBelt = f.id;
      }
      if (onBelt && F.belt !== onBelt) emit('belt', { belt: onBelt });
      F.belt = onBelt;
      for (k = 0; k < (track.tunnels || []).length; k++) {
        var tq = track.tunnels[k]; d = wrapD(c.s - tq.s0, L);
        if (d >= 0 && d <= tq.len) P.boost(c, 0.15, tq.top, tq.push);
      }
      // springs (hop pads)
      for (k = 0; k < by.spring.length; k++) {
        f = by.spring[k]; d = wrapD(c.s - f.s, L);
        var sl = num(f.len, 4);
        if (d < -sl / 2 || d > sl / 2 || Math.abs(c.lat - f.lat) > num(f.w, 4) / 2 + 0.3) continue;
        if (!cool(F, f.id, t, 1.0)) continue;
        P.hop(c, { track: track }, num(f.vy, 7.5));
        emit('spring', { spring: f.id });
        break;
      }
      // drift zones: powerslide inside = nitro
      if (F.zone) {
        var zf = null;
        for (k = 0; k < by.driftZone.length; k++) if (by.driftZone[k].id === F.zone) zf = by.driftZone[k];
        d = zf ? wrapD(c.s - zf.s, L) : -1;
        if (!zf || d < 0 || d > num(zf.len, 120)) F.zone = null;
        else {
          var inp = ctx.input || {};
          if ((inp.handbrake || inp.drift || c.powerslide) && Math.abs(num(inp.steer, 0)) > 0.2 && Math.abs(c.v) > 12) {
            F.drift += dt; nitro(ctx, c, 0.16 * dt, 'driftZone');
            if (F.drift > 0.6 && cool(F, zf.id, t, 4)) emit('driftZoneBonus', { zone: zf.id });
          }
        }
      }
    }
    // ---- stars + rings of fire (ground or air): crossing their s near their centre
    if (ps !== null && (by.star.length || by.fire.length)) {
      var W = null;
      for (k = 0; k < by.star.length; k++) {
        f = by.star[k];
        if (F.st[f.id] === lap || !crossed(ps, s, f.s, L)) continue;
        W = W || carWorld(track, c);
        var sp = track.pointAt(f.s, f.lat, num(f.z, 1.3)), dx = W[0] - sp[0], dy = W[1] - sp[1], dz = W[2] - sp[2];
        if (dx * dx + dy * dy + dz * dz > 2.4 * 2.4) continue;
        F.st[f.id] = lap; F.stars++;
        nitro(ctx, c, 0.15, 'star');
        emit('star', { star: f.id, count: F.stars, total: X.starTotal });
      }
      for (k = 0; k < by.fire.length; k++) {
        f = by.fire[k];
        if (!crossed(ps, s, f.s, L)) continue;
        W = W || carWorld(track, c);
        var rr = num(f.r, 2.8), cp = track.pointAt(f.s, f.lat, num(f.z, 0.5) + rr), ex2 = W[0] - cp[0], ey2 = W[1] - cp[1], ez2 = W[2] - cp[2];
        if (ex2 * ex2 + ey2 * ey2 + ez2 * ez2 > (rr + 0.6) * (rr + 0.6)) continue;
        if (!cool(F, f.id, t, 1.0)) continue;
        F.fire++;
        nitro(ctx, c, 0.22, 'fireRing');
        P.boost(c, 1.0, 1.22, 16);
        emit('fireRing', { ring: f.id });
      }
    }
    F.ps = s;
  }

  /** physics event -> extra callouts (cannon shots, monster jumps) */
  function onPhysicsEvent(c, ev, ctx) {
    var emit = ctx.emit || function () {};
    if (ev.type === 'takeoff' && ev.cannon) { emit('cannon', { speed: ev.speed }); c.feat = c.feat || feat(c); c.feat.flight = { s: ev.s, d: c.dist }; }
    else if (ev.type === 'takeoff' && ev.gap) { feat(c).flight = { s: ev.s, d: c.dist }; }
    else if (ev.type === 'land') {
      var F = feat(c), fl = F.flight;
      F.flight = null;
      if (fl) {
        var dist = c.dist - fl.d;
        if (dist >= 70) emit('bigJump', { dist: Math.round(dist), air: ev.air });
      }
    }
  }

  /** hazards ahead of s (AI): [{f, d, state}] — the state is evaluated at the car's arrival time t + d / v */
  function hazardsNear(track, s, range, t, v) {
    var X = index(track), out = [], L = track.length;
    for (var k = 0; k < X.by.hazard.length; k++) {
      var f = X.by.hazard[k], d = wrapD(f.s - s, L);
      if (d < -3 || d > range) continue;
      var ta = t + Math.max(0, d) / Math.max(5, num(v, 20));
      out.push({ f: f, d: d, state: hazardState(f, ta, track.sample(f.s).halfWidth) });
    }
    return out;
  }

  var CALLOUTS = {
    barrelRoll: ['BARREL ROLL!', '#ffd84a'], barrelRoll2: ['DOUBLE BARREL ROLL!', '#ffb21f'], zeroG: ['ZERO-G!', '#b9a8ff'],
    warp: ['WARP!', '#d77bff'], cannon: ['CANNON!', '#ff6b1a'], tunnel: ['BOOST TUNNEL!', '#7fe3ff'], shortcut: ['SHORTCUT!', '#62f0b5'],
    halfpipe: ['HALF-PIPE!', '#7ae0ff'], megaLoop: ['MEGA LOOP!', '#ffd84a'], corkscrew: ['CORKSCREW!', '#ffd84a'],
    hazard: ['BONK!', '#ff5a5a'], hazardBlocked: ['SHIELDED', '#62f0b5'], bumper: ['BOING!', '#ff2fd6'], flipper: ['FLIPPER!', '#ffe14a'],
    belt: ['SPEED BELT', '#7fe3ff'], spring: ['BOING-G!', '#9bff3a'], star: ['STAR!', '#ffe14a'], fireRing: ['RING OF FIRE!', '#ff8a1f'],
    driftZone: ['DRIFT ZONE', '#ff7ad9'], driftZoneBonus: ['DRIFT BONUS', '#ff7ad9'], bigJump: ['MONSTER JUMP!', '#ffd84a']
  };

  S.features = {
    hazardState: hazardState, flipperState: flipperState, index: index, step: step, onPhysicsEvent: onPhysicsEvent,
    hazardsNear: hazardsNear, CALLOUTS: CALLOUTS, DEF_PERIOD: DEF_PERIOD, CAR_HW: CAR_HW, CAR_HL: CAR_HL
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = S.features;
})(CB.arcade.stunt);

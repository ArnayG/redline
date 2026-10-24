/* ==========================================================================
   Redline — js/arcade/arcade-hud.js
   CB.arcade.hud : Canvas-2D HUD widgets for the Arcade gameplay layer (drawn on top of CB.race.hud).

     var h = CB.arcade.hud.create({ units })
     h.draw(ctx, state, W, H, dt)     state = gameplay.state() (snap.arcade.ext.gameplay); ctx in CSS px
     h.events(list, playerId)         feed gameplay events -> announcer text ("NITRO!", "BONK!", "SHIELDED"), flashes
     h.announce(text, color?, sub?)   push a callout manually
     h.reset()
     CB.arcade.hud.drawIcon(ctx, itemId, cx, cy, size)   procedural item icons (shared with the FX + touch buttons)

   Layout (stays clear of CB.race.hud's tower top-left, timing top-right, cluster bottom-right / bottom-centre):
     item slot + roulette top-centre, active power-up chips under it, announcer upper-centre, nitro gauge bottom-centre
     (above the cluster on compact screens), rev gauge for the rocket start under the countdown lights.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.arcade = CB.arcade || {};

(function () {
  'use strict';

  var FONT = "'Barlow Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif";   // --hud-font (synced in create)

  /* Shared HUD tokens (css/styles.css § 01 --hud-*, --mode-arcade): every mode's HUD — race, drift, arcade, derby,
     Formula 1, drag — draws with the same display + numeral fonts, panel fill / edge, ink and status colours, and
     its own mode accent. The literals are the token values (Node tests, first frame); syncHud() reads the live
     tokens once. HUDs stay dark over the 3D view in both themes, so the light theme's darkened accents are skipped. */
  var HUD = {
    font: "'Barlow Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif",
    num: "ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace",
    panel: 'rgba(8,10,14,0.78)', panelSoft: 'rgba(8,10,14,0.55)', line: 'rgba(255,255,255,0.16)',
    ink: '#f4f5f7', dim: 'rgba(244,245,247,0.62)', faint: 'rgba(244,245,247,0.3)',
    accent: '#e7cd9a', good: '#3fdc8a', warn: '#ffb13a', bad: '#ff5a4d', mode: '#5b8cff', radius: 10, radiusSm: 6
  };
  var HUD_VARS = { font: '--hud-font', num: '--hud-num', panel: '--hud-panel', panelSoft: '--hud-panel-soft', line: '--hud-line', ink: '--hud-ink',
    dim: '--hud-dim', faint: '--hud-faint', accent: '--hud-accent', good: '--hud-good', warn: '--hud-warn', bad: '--hud-bad', mode: '--mode-arcade',
    radius: '--hud-radius', radiusSm: '--hud-radius-sm' };
  var hudSynced = false;
  function syncHud() {
    if (hudSynced || typeof window === 'undefined' || typeof document === 'undefined' || !window.getComputedStyle || !document.documentElement) return HUD;
    hudSynced = true;
    try {
      var root = document.documentElement, cs = window.getComputedStyle(root), light = root.getAttribute('data-theme') === 'light';
      Object.keys(HUD_VARS).forEach(function (k) {
        if (k === 'mode' && light) return;
        var v = String(cs.getPropertyValue(HUD_VARS[k]) || '').trim();
        if (!v) return;
        if (k === 'radius' || k === 'radiusSm') { var n = parseFloat(v); if (n >= 0) HUD[k] = n; } else HUD[k] = v;
      });
    } catch (e) { /* keep the literals */ }
    return HUD;
  }
  /** A HUD panel fill at a given opacity (same tint as --hud-panel). */
  function hudFill(a) { var m = /rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(HUD.panel); return 'rgba(' + (m ? m[1] + ',' + m[2] + ',' + m[3] : '8,10,14') + ',' + a + ')'; }
  var NITRO_BLUE = '#2f8bff', NITRO_CYAN = '#7fe3ff';
  var SLOT_Y = 30;   // px: race-ui draws the ARCADE badge at the top centre (y 8..28)
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function itemDef(id) { var I = CB.arcade.items; return I && I.get ? I.get(id) : null; }
  function font(ctx, w, px, italic) { ctx.font = (italic ? 'italic ' : '') + w + ' ' + Math.round(px) + 'px ' + FONT; }

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* ---------------- procedural icons (unit box -1..1, scaled by s/2) ---------------- */
  function drawIcon(ctx, id, cx, cy, size) {
    var d = itemDef(id) || { color: '#fff' }, s = size / 2;
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(s, s);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.fillStyle = d.color; ctx.strokeStyle = '#0b0d12'; ctx.lineWidth = 0.09;
    switch (id) {
      case 'turbo':   // turbocharger snail + speed chevrons
        ctx.beginPath(); ctx.arc(-0.12, 0.05, 0.62, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ffe2b8'; ctx.beginPath(); ctx.arc(-0.12, 0.05, 0.28, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.16;
        ctx.beginPath(); ctx.moveTo(0.55, -0.5); ctx.lineTo(0.85, -0.1); ctx.lineTo(0.55, 0.3); ctx.stroke();
        break;
      case 'oil':
        ctx.beginPath(); ctx.moveTo(0, -0.85); ctx.bezierCurveTo(0.45, -0.25, 0.62, 0.05, 0.62, 0.3);
        ctx.arc(0, 0.3, 0.62, 0, Math.PI); ctx.bezierCurveTo(-0.62, 0.05, -0.45, -0.25, 0, -0.85); ctx.closePath();
        var g = ctx.createLinearGradient(-0.6, -0.6, 0.6, 0.8); g.addColorStop(0, '#6a55c9'); g.addColorStop(0.5, '#1d1830'); g.addColorStop(1, '#3fb6a6');
        ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.07; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.beginPath(); ctx.ellipse(-0.2, 0.15, 0.1, 0.18, -0.4, 0, Math.PI * 2); ctx.fill();
        break;
      case 'emp':
        ctx.strokeStyle = d.color; ctx.lineWidth = 0.12;
        ctx.beginPath(); ctx.arc(0, 0, 0.78, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.arc(0, 0, 0.52, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
        bolt(ctx, '#fff', 0.55);
        break;
      case 'rocket':
        ctx.rotate(-Math.PI / 4);
        ctx.fillStyle = '#ffb02e'; ctx.beginPath(); ctx.moveTo(-0.62, -0.16); ctx.lineTo(-0.98, 0); ctx.lineTo(-0.62, 0.16); ctx.fill();
        ctx.fillStyle = d.color; ctx.beginPath(); ctx.moveTo(0.85, 0); ctx.quadraticCurveTo(0.5, -0.32, -0.6, -0.26); ctx.lineTo(-0.6, 0.26); ctx.quadraticCurveTo(0.5, 0.32, 0.85, 0); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(-0.3, -0.26); ctx.lineTo(-0.62, -0.58); ctx.lineTo(-0.6, -0.26); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-0.3, 0.26); ctx.lineTo(-0.62, 0.58); ctx.lineTo(-0.6, 0.26); ctx.fill();
        ctx.beginPath(); ctx.arc(0.25, 0, 0.11, 0, Math.PI * 2); ctx.fillStyle = '#9be7ff'; ctx.fill();
        break;
      case 'shield':
        ctx.beginPath(); ctx.moveTo(0, -0.85); ctx.lineTo(0.72, -0.55); ctx.quadraticCurveTo(0.7, 0.45, 0, 0.88); ctx.quadraticCurveTo(-0.7, 0.45, -0.72, -0.55); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 0.1; ctx.beginPath(); ctx.moveTo(-0.3, 0); ctx.lineTo(-0.05, 0.25); ctx.lineTo(0.35, -0.25); ctx.stroke();
        break;
      case 'magnet':
        ctx.lineWidth = 0.38; ctx.strokeStyle = '#e8434f';
        ctx.beginPath(); ctx.arc(0, -0.05, 0.5, Math.PI, 0); ctx.stroke();
        ctx.strokeStyle = '#d0d6e2'; ctx.beginPath(); ctx.moveTo(-0.5, -0.05); ctx.lineTo(-0.5, 0.6); ctx.moveTo(0.5, -0.05); ctx.lineTo(0.5, 0.6); ctx.stroke();
        break;
      case 'ghost':
        ctx.beginPath(); ctx.moveTo(-0.6, 0.75); ctx.lineTo(-0.6, -0.1); ctx.arc(0, -0.1, 0.6, Math.PI, 0); ctx.lineTo(0.6, 0.75);
        for (var k = 0; k < 3; k++) ctx.quadraticCurveTo(0.6 - k * 0.4 - 0.2, 0.45, 0.6 - (k + 1) * 0.4, 0.75);
        ctx.closePath(); ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
        ctx.fillStyle = '#16122a'; ctx.beginPath(); ctx.ellipse(-0.22, -0.1, 0.1, 0.16, 0, 0, Math.PI * 2); ctx.ellipse(0.22, -0.1, 0.1, 0.16, 0, 0, Math.PI * 2); ctx.fill();
        break;
      case 'mega':   // nitrous bottle
        ctx.beginPath(); rrPath(ctx, -0.36, -0.55, 0.72, 1.4, 0.3); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#d6dbe6'; ctx.fillRect(-0.14, -0.85, 0.28, 0.32); ctx.strokeRect(-0.14, -0.85, 0.28, 0.32);
        ctx.fillStyle = '#fff'; font(ctx, 900, 0.62); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', 0, 0.2);
        break;
      case 'lightning':
        bolt(ctx, d.color, 1); ctx.stroke();
        break;
      default:
        ctx.fillStyle = '#fff'; font(ctx, 900, 1.3); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', 0, 0.06);
    }
    ctx.restore();
  }
  function rrPath(ctx, x, y, w, h, r) { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function bolt(ctx, color, k) {
    ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(0.18 * k, -0.95 * k); ctx.lineTo(-0.5 * k, 0.12 * k); ctx.lineTo(-0.04 * k, 0.12 * k); ctx.lineTo(-0.2 * k, 0.95 * k);
    ctx.lineTo(0.52 * k, -0.18 * k); ctx.lineTo(0.06 * k, -0.18 * k); ctx.closePath(); ctx.fill();
  }

  /* ---------------- announcer text for events ---------------- */
  var TIER_COL = ['#fff', '#3aa8ff', '#ff9a2a', '#c45bff'];
  var HAZ_SUB = { pendulum: 'WRECKING BALL', hammer: 'SQUASHED!', windmill: 'WINDMILLED!', piston: 'CRUSHER!', boulder: 'BOULDER!' };
  /** stunt special-feature callouts (stunt-features.js 'stuntFx' events, kind) -> [text, colour, sub, small] for the own car */
  function stuntCallout(e) {
    switch (e.kind) {
      case 'barrelRoll': return ['BARREL ROLL!', '#ffd84a'];
      case 'barrelRoll2': return ['DOUBLE BARREL ROLL!', '#ffb21f'];
      case 'zeroG': return ['ZERO-G!', '#b9a8ff', 'UPSIDE DOWN'];
      case 'warp': return ['WARP!', '#d77bff'];
      case 'cannon': return ['CANNON!', '#ff6b1a', 'FIRE IN THE HOLE'];
      case 'tunnel': return ['BOOST TUNNEL!', '#7fe3ff', null, true];
      case 'shortcut': return ['SHORTCUT!', '#62f0b5'];
      case 'halfpipe': return ['HALF-PIPE!', '#7ae0ff', null, true];
      case 'megaLoop': return ['MEGA LOOP!', '#ffd84a'];
      case 'corkscrew': return ['CORKSCREW!', '#ffd84a', null, true];
      case 'hazard': return ['BONK!', '#ff5a5a', HAZ_SUB[e.hz] || null];
      case 'hazardBlocked': return ['SHIELDED', '#62f0b5', null, true];
      case 'bumper': return ['BOING!', '#ff2fd6', '+NITRO', true];
      case 'flipper': return ['FLIPPER!', '#ffe14a', 'BOOST'];
      case 'belt': return ['SPEED BELT', '#7fe3ff', null, true];
      case 'spring': return ['SPRING!', '#9bff3a', null, true];
      case 'star': return ['STAR!', '#ffe14a', e.total ? '★ ' + (e.count || 0) : null];
      case 'fireRing': return ['RING OF FIRE!', '#ff8a1f', '+NITRO'];
      case 'driftZone': return ['DRIFT ZONE', '#ff7ad9', 'POWERSLIDE FOR NITRO', true];
      case 'driftZoneBonus': return ['DRIFT BONUS', '#ff7ad9', '+NITRO', true];
      case 'bigJump': return ['MONSTER JUMP!', '#ffd84a', e.dist ? e.dist + ' m' : null];
      default: return null;
    }
  }
  function calloutFor(e, me) {
    var mine = e.carId === me;
    switch (e.type) {
      case 'nitroStart': return mine ? ['NITRO!', NITRO_CYAN] : null;
      case 'start':
        if (!mine) return null;
        return e.grade === 'perfect' ? ['ROCKET START!', '#ffd84a', 'PERFECT LAUNCH'] : e.grade === 'good' ? ['GOOD START', '#9cf27a'] : e.grade === 'over' ? ['OVER-REV!', '#ff5a4e', 'Bogged down'] : null;
      case 'hit':
        if (mine) return [e.kind === 'oil' ? 'SPUN OUT!' : e.kind === 'rocket' ? 'BONKED!' : e.kind === 'emp' ? 'ZAPPED!' : 'STRUCK!', '#ff5a4e', e.coinsLost ? '−' + e.coinsLost + ' coins' : null];
        if (e.by === me) return [e.kind === 'rocket' ? 'BONK!' : e.kind === 'oil' ? 'SLICKED!' : e.kind === 'emp' ? 'ZAP!' : 'HIT!', '#ffd84a', null];
        return null;
      case 'blocked': return mine ? ['SHIELDED', '#62f0b5'] : (e.by === me ? ['BLOCKED', '#c9ccd6'] : null);
      case 'immune': return mine ? ['PHASED', '#b9a8ff'] : null;
      case 'driftTier': return mine && e.tier ? [(CB.arcade.nitro.DRIFT_TIERS[e.tier - 1] || {}).name || 'TURBO', TIER_COL[e.tier], null, true] : null;
      case 'slipstream': return mine ? ['SLIPSTREAM', '#bfe9ff'] : null;
      case 'nearMiss': return mine ? ['NEAR MISS', '#ffffff', '+NITRO', true] : null;
      case 'landing': return mine && e.big ? ['BIG AIR!', '#ffd84a', '+NITRO'] : null;
      case 'overtake': return mine ? ['OVERTAKE', '#ffffff', 'P' + e.pos, true] : null;
      case 'lightning': return mine ? ['LIGHTNING!', '#ffe14a'] : ['⚡ LIGHTNING', '#ffe14a'];
      case 'itemUse':
        if (!mine) return null;
        if (e.item === 'mega') return ['MEGA NITRO!', NITRO_CYAN];
        if (e.item === 'turbo') return ['TURBO!', '#ff9a2a', null, true];
        if (e.item === 'shield') return ['SHIELD UP', '#62f0b5', null, true];
        if (e.item === 'ghost') return ['GHOST', '#b9a8ff', null, true];
        if (e.item === 'magnet') return ['MAGNET', '#d0d6e2', null, true];
        if (e.item === 'emp') return ['SHOCKWAVE!', '#33d6ff'];
        return null;
      case 'canister': return mine ? ['+NITRO', NITRO_CYAN, null, true] : null;
      case 'stuntFx': return mine ? stuntCallout(e) : null;
      default: return null;
    }
  }

  function create(opts) {
    opts = opts || {};
    syncHud(); FONT = HUD.font;
    var S = { calls: [], flash: 0, flashCol: '#ff3b3b', time: 0, nitroDisp: 0, itemPop: 0, lastItem: null, coinPop: 0, lastCoins: 0, revSeen: false,
      combo: {}, stars: 0, starsTotal: 0, starPop: 0 };

    function announce(text, color, sub, small) {
      // replace a callout of the same text instead of stacking duplicates (keeps the newest sub line, e.g. a combo counter)
      for (var i = 0; i < S.calls.length; i++) if (S.calls[i].text === text) { S.calls[i].t = 0.12; if (sub) S.calls[i].sub = sub; return; }
      S.calls.push({ text: text, color: color || '#fff', sub: sub || null, t: 0, small: !!small, life: small ? 1.0 : 1.5 });
      if (S.calls.length > 3) S.calls.shift();
    }
    function events(list, me) {
      (list || []).forEach(function (e) {
        var c = calloutFor(e, me);
        if (c && e.type === 'stuntFx') {
          // repeated feature hits (bumpers, hazards) merge into one callout with a counter instead of spamming the screen
          var cb = S.combo[e.kind];
          if (cb && S.time - cb.t < 1.6 && e.kind !== 'star') { cb.n++; cb.t = S.time; c = [c[0], c[1], '×' + cb.n + (c[2] ? '  ' + c[2] : ''), c[3]]; }
          else S.combo[e.kind] = { n: 1, t: S.time };
          if (e.kind === 'star') { S.stars = Math.max(S.stars, e.count || S.stars + 1); S.starPop = 1; if (e.total && !S.starsTotal) S.starsTotal = e.total; }
          if (e.kind === 'hazard' && e.carId === me) { S.flash = 0.6; S.flashCol = '#ff7a3b'; }
          if (e.kind === 'warp' && e.carId === me) { S.flash = 0.8; S.flashCol = '#c06bff'; }
        }
        if (c) announce(c[0], c[1], c[2], c[3]);
        if (e.type === 'hit' && e.carId === me) { S.flash = 1; S.flashCol = '#ff3b3b'; }
        if (e.type === 'blocked' && e.carId === me) { S.flash = 0.7; S.flashCol = '#62f0b5'; }
        if (e.type === 'lightning') { S.flash = 0.9; S.flashCol = '#fff6b0'; }
        if (e.type === 'itemGot' && e.carId === me) S.itemPop = 1;
        if (e.type === 'coin' && e.carId === me) S.coinPop = 1;
      });
    }

    function draw(ctx, st, W, H, dt) {
      if (!ctx || !st || !st.player) return;
      dt = clamp(num(dt, 0.016), 0, 0.1);
      S.time += dt;
      var P = st.player, compact = W < 760 || H < 480;
      var k = compact ? clamp(Math.min(W / 420, H / 420), 0.62, 1.05) : clamp(Math.min(W / 1366, H / 800) * 1.06, 0.72, 1.6);
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // full-screen hit / lightning flash
      if (S.flash > 0) {
        var g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, S.flashCol);
        ctx.globalAlpha = S.flash * 0.55; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
        S.flash = Math.max(0, S.flash - dt * 2.2);
      }
      if (st.options && st.options.items !== false || P.item || P.roulette) drawItemSlot(ctx, st, P, W, H, k, compact, dt);
      drawChips(ctx, P, W, H, k, compact);
      if (st.options && st.options.nitro !== false) drawNitro(ctx, st, P, W, H, k, compact, dt);
      if (!st.started && (st.phase === 'countdown' || st.phase === 'grid')) drawRev(ctx, P, W, H, k);
      if (S.starsTotal > 0) drawStars(ctx, W, H, k, compact, dt);
      drawCallouts(ctx, W, H, k, compact, dt);
      ctx.restore();
    }
    /** ★ n / total collected this race (maps with collectible stars) — right of the item slot */
    function drawStars(ctx, W, H, k, compact, dt) {
      S.starPop = Math.max(0, S.starPop - dt * 3);
      var sz = (compact ? 62 : 78) * k, x = W / 2 + sz / 2 + 12 * k, y = SLOT_Y + (compact ? 4 : 8) * k + sz / 2, r = 11 * k * (1 + S.starPop * 0.4);
      ctx.save();
      ctx.beginPath();
      for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr2 = i % 2 ? r * 0.45 : r; ctx.lineTo(x + r + Math.cos(a) * rr2, y + Math.sin(a) * rr2); }
      ctx.closePath(); ctx.fillStyle = '#ffd84a'; ctx.fill(); ctx.lineWidth = 2 * k; ctx.strokeStyle = 'rgba(8,10,16,.8)'; ctx.stroke();
      font(ctx, 800, (compact ? 13 : 15) * k); ctx.textAlign = 'left'; ctx.lineWidth = 3 * k;
      var txt = S.stars + ' / ' + S.starsTotal;
      ctx.strokeText(txt, x + 2 * r + 6 * k, y + 1); ctx.fillStyle = HUD.ink; ctx.fillText(txt, x + 2 * r + 6 * k, y + 1);
      ctx.restore();
    }

    function drawItemSlot(ctx, st, P, W, H, k, compact, dt) {
      var sz = (compact ? 62 : 78) * k, x = W / 2 - sz / 2, y = SLOT_Y + (compact ? 4 : 8) * k;   // below race-ui's ARCADE badge
      S.itemPop = Math.max(0, S.itemPop - dt * 3);
      var pop = 1 + S.itemPop * 0.18;
      ctx.save();
      ctx.translate(W / 2, y + sz / 2); ctx.scale(pop, pop); ctx.translate(-W / 2, -(y + sz / 2));
      rr(ctx, x, y, sz, sz, 14 * k);
      ctx.fillStyle = hudFill(.62); ctx.fill();
      ctx.lineWidth = 3 * k;
      var rg = ctx.createLinearGradient(x, y, x + sz, y + sz);
      var hue = (S.time * 90) % 360;
      rg.addColorStop(0, 'hsl(' + hue + ',90%,62%)'); rg.addColorStop(0.5, 'hsl(' + ((hue + 120) % 360) + ',90%,62%)'); rg.addColorStop(1, 'hsl(' + ((hue + 240) % 360) + ',90%,62%)');
      ctx.strokeStyle = P.roulette || P.item ? rg : 'rgba(255,255,255,.25)';
      ctx.stroke();
      ctx.save(); rr(ctx, x, y, sz, sz, 14 * k); ctx.clip();
      if (P.roulette && P.roulette.strip) {
        var R = P.roulette, p = clamp(R.t / R.dur, 0, 1);
        var eased = 1 - Math.pow(1 - p, 3), n = R.strip.length;
        var pos = eased * (n - 1), i0 = Math.floor(pos), fr = pos - i0;
        for (var j = -1; j <= 1; j++) {
          var id = R.strip[clamp(i0 + j, 0, n - 1)];
          drawIcon(ctx, id, W / 2, y + sz / 2 + (j - fr) * sz * 0.95, sz * 0.62);
        }
      } else if (P.item) {
        drawIcon(ctx, P.item.id, W / 2, y + sz / 2, sz * 0.66);
        if (P.item.uses > 1) {
          font(ctx, 800, 16 * k); ctx.fillStyle = HUD.ink; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 3 * k;
          ctx.strokeText('×' + P.item.uses, x + sz - 14 * k, y + sz - 12 * k); ctx.fillText('×' + P.item.uses, x + sz - 14 * k, y + sz - 12 * k);
        }
      } else {
        ctx.globalAlpha = 0.25; drawIcon(ctx, '?', W / 2, y + sz / 2, sz * 0.5); ctx.globalAlpha = 1;
      }
      ctx.restore();
      ctx.restore();
      if (P.item && !P.roulette) {
        var d = itemDef(P.item.id);
        font(ctx, 700, 12 * k); ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.fillText((d ? d.name.toUpperCase() : P.item.id) + (compact ? '' : '  ·  F / X' + (P.item.id === 'rocket' ? '  (+S = back)' : '')), W / 2, y + sz + 11 * k);
      }
    }

    function drawChips(ctx, P, W, H, k, compact) {
      var chips = [];
      if (P.shield > 0) chips.push(['shield', P.shield, 9]);
      if (P.ghost > 0) chips.push(['ghost', P.ghost, 4.2]);
      if (P.magnet > 0) chips.push(['magnet', P.magnet, 3.6]);
      if (!chips.length) return;
      var sz = 30 * k, gap = 8 * k, tot = chips.length * sz + (chips.length - 1) * gap;
      var y = SLOT_Y + ((compact ? 4 : 8) + (compact ? 62 : 78) + 24) * k, x = W / 2 - tot / 2;
      chips.forEach(function (c, i) {
        var cx = x + i * (sz + gap) + sz / 2, cy = y + sz / 2;
        ctx.beginPath(); ctx.arc(cx, cy, sz / 2, 0, Math.PI * 2); ctx.fillStyle = hudFill(.6); ctx.fill();
        ctx.beginPath(); ctx.arc(cx, cy, sz / 2 - 1.5 * k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(c[1] / c[2], 0, 1));
        ctx.strokeStyle = (itemDef(c[0]) || {}).color || '#fff'; ctx.lineWidth = 3 * k; ctx.stroke();
        drawIcon(ctx, c[0], cx, cy, sz * 0.6);
      });
    }

    function drawNitro(ctx, st, P, W, H, k, compact, dt) {
      S.nitroDisp += (P.nitro - S.nitroDisp) * clamp(dt * 12, 0, 1);
      var w = (compact ? Math.min(W * 0.5, 210) : 300 * k), h = (compact ? 12 : 16) * k;
      var x = W / 2 - w / 2;
      var y = compact ? H - clamp(Math.min(W, H) * 0.16, 46, 90) * 2.25 - 26 * k : H - 30 * k - h;
      if (compact && y < H * 0.45) y = H * 0.45;
      // short phone landscape: CB.race.hud draws a slim cluster bar at the bottom centre -> the gauge sits right on top of
      // it (same width, room for the coin counter on the left), below the car in the chase view
      var SB = CB.race && CB.race.hud && CB.race.hud.strip;
      if (compact && SB && SB.w > 0) {
        var coins = !(st.options && st.options.coins === false);
        w = Math.min(SB.w - (coins ? 40 * k : 0), 210); h = 9 * k;
        x = SB.x + SB.w - w; y = SB.y - 7 * k - h;
      }
      // label + coins
      font(ctx, 800, (compact ? 12 : 14) * k, true);
      ctx.textAlign = 'left'; ctx.fillStyle = P.nitroOn ? NITRO_CYAN : 'rgba(255,255,255,.88)';
      ctx.fillText('NITRO', x, y - 10 * k);
      ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,.6)';
      if (!compact) ctx.fillText(P.nitro >= 0.06 ? 'HOLD N / SHIFT' : 'DRIFT · DRAFT · JUMP · NEAR-MISS TO FILL', x + w, y - 10 * k);
      // coins
      if (st.options && st.options.coins !== false) {
        S.coinPop = Math.max(0, S.coinPop - dt * 3);
        var cx = x - 34 * k, cy = y + h / 2, cr = 9 * k * (1 + S.coinPop * 0.35);
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fillStyle = '#ffcc33'; ctx.fill();
        ctx.lineWidth = 2 * k; ctx.strokeStyle = '#a87400'; ctx.stroke();
        font(ctx, 800, 13 * k); ctx.textAlign = 'left'; ctx.fillStyle = HUD.ink;
        ctx.fillText(String(P.coins), cx + 13 * k, cy + 1);
      }
      // bar
      rr(ctx, x, y, w, h, h / 2); ctx.fillStyle = hudFill(.62); ctx.fill();
      ctx.lineWidth = 1.5 * k; ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.stroke();
      var f = clamp(S.nitroDisp, 0, 1);
      if (f > 0.002) {
        ctx.save(); rr(ctx, x, y, w, h, h / 2); ctx.clip();
        var g = ctx.createLinearGradient(x, 0, x + w, 0);
        g.addColorStop(0, '#1446d8'); g.addColorStop(0.6, NITRO_BLUE); g.addColorStop(1, NITRO_CYAN);
        ctx.fillStyle = g; ctx.fillRect(x, y, w * f, h);
        // flowing shimmer while burning
        if (P.nitroOn) {
          for (var i = 0; i < 6; i++) {
            var sx = x + ((S.time * 420 * k + i * w / 6) % (w * f));
            ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(sx, y, 10 * k, h);
          }
        }
        ctx.restore();
      }
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 2 * k;
      for (var q = 1; q < 3; q++) { ctx.beginPath(); ctx.moveTo(x + w * q / 3, y + 2); ctx.lineTo(x + w * q / 3, y + h - 2); ctx.stroke(); }
      if (P.nitro >= 0.999) {
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(S.time * 8);
        rr(ctx, x - 2 * k, y - 2 * k, w + 4 * k, h + 4 * k, h / 2 + 2 * k); ctx.strokeStyle = NITRO_CYAN; ctx.lineWidth = 2 * k; ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // powerslide tier pips / slipstream meter just above the bar on the right
      var D = P.drift;
      if (D) {
        var tc = TIER_COL[D.tier] || '#fff';
        font(ctx, 900, 13 * k, true); ctx.textAlign = 'center'; ctx.fillStyle = tc;
        ctx.fillText(D.tier ? ((CB.arcade.nitro.DRIFT_TIERS[D.tier - 1] || {}).name || '') : 'DRIFT', W / 2, y - 26 * k);
      } else if (P.slip > 0.05) {
        var sw = 90 * k, sh = 4 * k;
        ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(W / 2 - sw / 2, y - 24 * k, sw, sh);
        ctx.fillStyle = '#bfe9ff'; ctx.fillRect(W / 2 - sw / 2, y - 24 * k, sw * clamp(P.slip, 0, 1), sh);
        font(ctx, 700, 10 * k); ctx.textAlign = 'center'; ctx.fillStyle = '#bfe9ff'; ctx.fillText('DRAFT', W / 2, y - 32 * k);
      }
      ctx.textAlign = 'center';
    }

    function drawRev(ctx, P, W, H, k) {
      var Rv = CB.arcade.nitro.REV, w = 260 * k, h = 14 * k, x = W / 2 - w / 2, y = H * 0.66;
      rr(ctx, x, y, w, h, h / 2); ctx.fillStyle = hudFill(.66); ctx.fill();
      ctx.fillStyle = 'rgba(120,230,120,.38)'; ctx.fillRect(x + w * Rv.sweetLo, y, w * (Rv.sweetHi - Rv.sweetLo), h);
      ctx.fillStyle = 'rgba(255,216,74,.65)'; ctx.fillRect(x + w * Rv.perfectLo, y, w * (Rv.perfectHi - Rv.perfectLo), h);
      ctx.fillStyle = 'rgba(255,70,60,.5)'; ctx.fillRect(x + w * Rv.over, y, w * (1 - Rv.over), h);
      var nx = x + w * clamp(P.rev, 0, 1);
      ctx.fillStyle = P.flooded ? HUD.bad : HUD.ink;
      ctx.beginPath(); ctx.moveTo(nx, y - 5 * k); ctx.lineTo(nx - 6 * k, y - 13 * k); ctx.lineTo(nx + 6 * k, y - 13 * k); ctx.closePath(); ctx.fill();
      ctx.fillRect(nx - 1.5 * k, y, 3 * k, h);
      font(ctx, 800, 13 * k, true); ctx.fillStyle = P.flooded ? '#ff5a4e' : 'rgba(255,255,255,.9)';
      ctx.fillText(P.flooded ? 'OVER-REV — LIFT OFF!' : 'TAP THROTTLE · HOLD THE NEEDLE IN THE GOLD FOR A ROCKET START', W / 2, y + h + 14 * k);
    }

    function drawCallouts(ctx, W, H, k, compact, dt) {
      var baseY = H * (compact ? 0.3 : 0.27), yAcc = 0;
      for (var i = S.calls.length - 1; i >= 0; i--) {
        var c = S.calls[i];
        c.t += dt;
        if (c.t > c.life) { S.calls.splice(i, 1); continue; }
        var p = c.t / c.life;
        var sc = c.t < 0.12 ? 0.6 + 0.5 * (c.t / 0.12) * (2 - c.t / 0.12) : 1;
        var a = p > 0.75 ? 1 - (p - 0.75) / 0.25 : 1;
        var px = (c.small ? 26 : 46) * k * (compact ? 0.8 : 1);
        var y = baseY + yAcc - (p > 0.75 ? (p - 0.75) * 40 * k : 0);
        yAcc += px * 1.12 + (c.sub ? px * 0.5 : 0);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(W / 2, y); ctx.scale(sc, sc); ctx.transform(1, 0, -0.18, 1, 0, 0);
        font(ctx, 900, px);
        ctx.lineWidth = Math.max(3, px * 0.14); ctx.strokeStyle = 'rgba(8,10,16,.85)'; ctx.lineJoin = 'round';
        ctx.strokeText(c.text, 0, 0);
        ctx.fillStyle = c.color; ctx.fillText(c.text, 0, 0);
        if (c.sub) { font(ctx, 800, px * 0.38); ctx.lineWidth = 3; ctx.strokeText(c.sub, 0, px * 0.62); ctx.fillStyle = HUD.ink; ctx.fillText(c.sub, 0, px * 0.62); }
        ctx.restore();
      }
    }

    return {
      draw: function (ctx, st, W, H, dt) { try { draw(ctx, st, W, H, dt); } catch (e) { if (!S.err && typeof console !== 'undefined') { S.err = 1; console.warn('[arcade.hud]', e); } } },
      events: events, announce: announce,
      /** maps with collectible stars: total per race (0 hides the counter) and the count already collected */
      setStars: function (n, total) { S.stars = Math.max(0, n | 0); S.starsTotal = Math.max(0, total | 0); },
      reset: function () { S.calls = []; S.flash = 0; S.nitroDisp = 0; S.combo = {}; S.stars = 0; },
      _state: S
    };
  }

  CB.arcade.hud = { create: create, drawIcon: drawIcon, calloutFor: calloutFor, stuntCallout: stuntCallout };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.arcade.hud;

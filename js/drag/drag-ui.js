/* ==========================================================================
   Redline — js/drag/drag-ui.js
   CB.drag.ui : the #/drag route (docs/DRAG-SPEC.md) — setup (car: stock Auto-config / presets / My Cars, opponent:
   rival ladder / quick AI / friend's ghost / 4–8 car elimination tournament / solo, strip, tree, surface, bracket +
   dial-in, class + N2O, assists, quick tune), the play loop (CB.drag.session + CB.drag.renderer or a 2D fallback,
   CB.drag.hud, CB.drag.sfx, keyboard / gamepad / touch / phone wheel / webcam / mouse via CB.input.hub), pause, the
   timeslip results (PBs, copy / PNG / ghost code, payout, achievements), the ladder and the tournament bracket.
   Registers itself on CB.router ('drag'). Test hooks: window.drag { state, start, session, setInput, step, ... }.

     CB.drag.ui.enter(layer, params) / leave()     CB.drag.ui.state()
     CB.drag.ui._ : PURE helpers (Node): DEFAULTS, sanitizeSettings, createInput, KEYS, payout, dialFor, entryFor,
                    sessionConfig, ghostTrace, achievementEvent, stockList
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.drag = CB.drag || {};

(function () {
  'use strict';
  var hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined' && typeof document.createElement === 'function';
  var LS_KEY = 'forge.drag.settings.v1';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ST() { return CB.drag.strip; }

  /* ================================================================== settings (pure) */
  var DIFFS = ['rookie', 'amateur', 'pro', 'alien'];
  var OPPS = ['ladder', 'ai', 'ghost', 'tournament', 'solo', 'practice'];
  var SHOTS = [50, 100, 150, 250];
  var DEFAULTS = {
    source: 'stock', stockId: 'chevrolet-camaro-zl1-2019', presetId: 'muscle', savedId: null,
    distanceId: 'quarter', opponent: 'ladder', rivalId: null, aiModel: 'dodge-challenger-srt-hellcat', difficulty: 'amateur', tSize: 4, ghostCode: '',
    treeType: 'pro', venue: 'strip', night: false, surface: 'prepped', bracket: false, dial: null, cls: 'street', nitrous_hp: 100,
    autoShift: false, launchControl: true, tc: 'car', autoStage: false, deep: false, skipBurnout: false,
    tuneFD: null, tuneSpread: 1, camera: 'cockpit', camV: 2, quality: 'auto', units: 'imperial', muted: false, touch: 'auto', showFps: false
  };
  function sanitizeSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (['stock', 'preset', 'current', 'saved'].indexOf(s.source) >= 0) o.source = s.source;
    ['stockId', 'presetId', 'aiModel', 'ghostCode', 'camera'].forEach(function (key) { if (typeof s[key] === 'string' && s[key].length < 4000) o[key] = s[key]; });
    if (typeof s.savedId === 'string') o.savedId = s.savedId;
    if (typeof s.rivalId === 'string') o.rivalId = s.rivalId;
    var dists = ST() ? ST().DISTANCES.map(function (d) { return d.id; }) : ['eighth', 'quarter', 'half', 'km', 'dig', 'roll'];
    if (dists.indexOf(s.distanceId) >= 0) o.distanceId = s.distanceId;
    if (OPPS.indexOf(s.opponent) >= 0) o.opponent = s.opponent;
    if (DIFFS.indexOf(s.difficulty) >= 0) o.difficulty = s.difficulty;
    if (+s.tSize === 8) o.tSize = 8;
    if (s.treeType === 'pro' || s.treeType === 'sportsman') o.treeType = s.treeType;
    if (s.venue === 'strip' || s.venue === 'street') o.venue = s.venue;
    if (['prepped', 'street', 'wet'].indexOf(s.surface) >= 0) o.surface = s.surface;
    if (s.cls === 'street' || s.cls === 'pro-mod') o.cls = s.cls;
    if (SHOTS.indexOf(+s.nitrous_hp) >= 0) o.nitrous_hp = +s.nitrous_hp;
    if (s.dial != null && isFinite(+s.dial) && +s.dial > 2 && +s.dial < 60) o.dial = Math.round(+s.dial * 100) / 100;
    if (s.tc === 'car' || [0, 1, 2, 3].indexOf(+s.tc) >= 0) o.tc = s.tc === 'car' ? 'car' : +s.tc;
    if (s.tuneFD != null && isFinite(+s.tuneFD)) o.tuneFD = clamp(+s.tuneFD, 2.5, 5.5);
    if (isFinite(+s.tuneSpread)) o.tuneSpread = clamp(+s.tuneSpread, 0.85, 1.15);
    if (['auto', 'low', 'medium', 'high'].indexOf(s.quality) >= 0) o.quality = s.quality;
    if (s.units === 'metric' || s.units === 'imperial') o.units = s.units;
    if (s.touch === 'auto' || s.touch === 'on' || s.touch === 'off') o.touch = s.touch;
    ['night', 'bracket', 'autoShift', 'autoStage', 'deep', 'skipBurnout', 'muted', 'showFps'].forEach(function (key) { o[key] = !!s[key]; });
    o.launchControl = s.launchControl !== false;
    // v2: first person is the default drag camera (older saves defaulted to the chase cam)
    if (!(+s.camV >= 2)) o.camera = 'cockpit';
    return o;
  }
  function storage() { return CB.device && CB.device.storage ? CB.device.storage : null; }
  function loadSettings() {
    var raw = null;
    try { raw = storage() ? storage().get(LS_KEY) : (hasDOM && window.localStorage ? window.localStorage.getItem(LS_KEY) : null); } catch (e) { raw = null; }
    var o = null; try { o = raw ? JSON.parse(raw) : null; } catch (e2) { o = null; }
    return sanitizeSettings(o);
  }
  function saveSettings(s) {
    var v = JSON.stringify(sanitizeSettings(s));
    try { if (storage()) storage().set(LS_KEY, v); else if (hasDOM && window.localStorage) window.localStorage.setItem(LS_KEY, v); } catch (e) { /* blocked */ }
  }

  /* ================================================================== input (keys / pad / touch / hub) */
  var KEYS = {
    held: { KeyW: 'thr', ArrowUp: 'thr', KeyS: 'brk', ArrowDown: 'brk', KeyN: 'n2o' },
    edge: { KeyE: 'up', Space: 'up', ArrowRight: 'up', KeyQ: 'down', ArrowLeft: 'down' },
    action: { KeyC: 'camera', Escape: 'pause', KeyP: 'pause', KeyM: 'mute', KeyR: 'restart', Enter: 'confirm' }
  };
  /** One input manager: digital keys pass 0/1 (the session revs a held engine while the key is down: feather it),
   *  gamepad / touch / hub are analog. Shift edges are latched until the next sample(). Hub sources (phone wheel,
   *  webcam fist, mouse, tilt) get a line-lock assist: staged, the brake is held for you and the revs sit in the band;
   *  closing the fist / flooring it releases (before the green = red light). */
  function createInput(opts) {
    opts = opts || {};
    var I = {
      held: {}, up: 0, down: 0, touch: { active: false, throttle: 0, brake: 0, n2o: false, up: 0, down: 0 },
      gp: { active: false, throttle: 0, brake: 0, n2o: false, prev: [] }, hub: { active: false, throttle: 0, brake: 0, prevThr: 0, armed: false, released: false },
      phone: { n2o: false }, forced: null, onAction: opts.onAction || function () {}, lastDevice: 'keyboard', enabled: true
    };
    I.handleKey = function (code, down, repeat) {
      if (!I.enabled) return false;
      var k = KEYS.held[code];
      if (k) { I.held[k] = !!down; if (down) I.lastDevice = 'keyboard'; return true; }
      var e = KEYS.edge[code];
      if (e) { if (down && !repeat) { I[e]++; I.lastDevice = 'keyboard'; } return true; }
      var a = KEYS.action[code];
      if (a) { if (down && !repeat) I.onAction(a); return true; }
      return false;
    };
    I.clear = function () { I.held = {}; I.up = I.down = 0; I.touch.throttle = I.touch.brake = 0; I.touch.n2o = false; I.phone.n2o = false; };
    I.pollPad = function () {
      var nav = typeof navigator !== 'undefined' ? navigator : null, pads = null;
      if (!nav || typeof nav.getGamepads !== 'function') return;
      try { pads = nav.getGamepads(); } catch (e) { return; }
      var gp = null; if (pads) for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) { gp = pads[i]; break; }
      if (!gp) { I.gp.active = false; return; }
      function b(n) { var x = gp.buttons && gp.buttons[n]; return x ? (typeof x === 'object' ? (x.value || (x.pressed ? 1 : 0)) : (x ? 1 : 0)) : 0; }
      I.gp.throttle = b(7); I.gp.brake = b(6); I.gp.n2o = b(1) > 0.5;
      var pr = []; for (var k = 0; k < 17; k++) pr[k] = b(k) > 0.5;
      var pv = I.gp.prev;
      if ((pr[0] && !pv[0]) || (pr[5] && !pv[5])) I.up++;
      if ((pr[2] && !pv[2]) || (pr[4] && !pv[4])) I.down++;
      if (pr[3] && !pv[3]) I.onAction('camera');
      if (pr[9] && !pv[9]) I.onAction('pause');
      if (pr[8] && !pv[8]) I.onAction('restart');
      I.gp.anyEdge = pr.some(function (x, k2) { return x && !pv[k2]; });
      I.gp.prev = pr; I.gp.active = true;
      if (I.gp.throttle > 0.05 || I.gp.brake > 0.05 || I.gp.anyEdge) I.lastDevice = 'gamepad';
    };
    I.pollHub = function () {
      var hub = CB.input && CB.input.hub, r = null;
      if (hub && typeof hub.read === 'function') { try { r = hub.read(); } catch (e) { r = null; } }
      I.hub.active = !!(r && r.active);
      I.hub.throttle = I.hub.active ? clamp(num(r.throttle, 0), 0, 1) : 0;
      I.hub.brake = I.hub.active ? clamp(num(r.brake, 0), 0, 1) : 0;
      if (I.hub.active && (I.hub.throttle > 0.1 || I.hub.brake > 0.1)) I.lastDevice = 'hub';
      if (hub && typeof hub.takeEvents === 'function') {
        var evs = []; try { evs = hub.takeEvents() || []; } catch (e2) { evs = []; }
        evs.forEach(function (e) {
          if (!e) return;
          if (e.type === 'shiftUp') I.up++; else if (e.type === 'shiftDown') I.down++;
          else if (e.type === 'pause' || e.type === 'camera' || e.type === 'confirm') I.onAction(e.type);
          else if (e.type === 'reset') I.onAction('restart');
        });
      }
    };
    I.phoneEvent = function (type) {
      if (type === 'item') I.up++; else if (type === 'itemBack') I.down++;
      else if (type === 'nitroOn') I.phone.n2o = true; else if (type === 'nitroOff') I.phone.n2o = false;
    };
    /** lane = the player's snapshot lane (for the hub line-lock), phase = snap.phase */
    I.sample = function (dt, lane, phase) {
      if (I.forced) { var f = Object.assign({ throttle: 0, brake: 0, shiftUp: false, shiftDown: false, nitrous: false }, I.forced); if (I.forced.shiftUp) I.forced.shiftUp = false; if (I.forced.shiftDown) I.forced.shiftDown = false; return f; }
      I.pollPad(); I.pollHub();
      var h = I.held, T = I.touch, analog = false;
      var thr = h.thr ? 1 : 0, brk = h.brk ? 1 : 0;
      if (I.gp.active && (I.gp.throttle > 0.02 || I.gp.brake > 0.02)) { thr = Math.max(thr, I.gp.throttle); brk = Math.max(brk, I.gp.brake); analog = analog || I.gp.throttle > 0.02 && I.gp.throttle < 0.98; }
      if (T.active && (T.throttle > 0 || T.brake > 0)) { thr = Math.max(thr, T.throttle); brk = Math.max(brk, T.brake); analog = true; }
      // hub sources: line-lock assist while staged before the run
      var hubOnly = I.hub.active && !h.thr && !h.brk && !(T.throttle > 0 || T.brake > 0) && !(I.gp.throttle > 0.02 || I.gp.brake > 0.02);
      if (I.hub.active) {
        if (hubOnly && lane && lane.staged && !lane.left && (phase === 'staging' || phase === 'tree' || phase === 'burnout')) {
          var lc = lane.launch || {}, ht = I.hub.throttle;
          if (!I.hub.armed) { I.hub.armed = true; I.hub.released = false; I.hub.prevThr = ht; }
          if (!I.hub.released && ht > 0.9 && I.hub.prevThr <= 0.9 && phase === 'tree') I.hub.released = true;
          I.hub.prevThr = ht;
          if (!I.hub.released) {
            brk = 1;
            var tgt = lc.best || (lc.lo + lc.hi) / 2 || num(lane.redline, 7000) * 0.6;
            thr = lc.ev || lc.lc ? 1 : clamp((tgt - num(lane.idle, 900)) / Math.max(1, num(lane.redline, 7000) * 1.02 - num(lane.idle, 900)), 0.05, 1);
            analog = true;
          } else { thr = 1; brk = 0; }
        } else {
          if (!lane || !lane.staged) I.hub.armed = false;
          thr = Math.max(thr, I.hub.throttle); brk = Math.max(brk, I.hub.brake); analog = analog || (I.hub.throttle > 0.02 && I.hub.throttle < 0.98);
        }
      }
      var out = { throttle: clamp(thr, 0, 1), brake: clamp(brk, 0, 1), shiftUp: I.up > 0, shiftDown: I.down > 0,
        nitrous: !!(h.n2o || I.gp.n2o || T.n2o || I.phone.n2o), analog: analog };
      I.up = 0; I.down = 0;
      return out;
    };
    return I;
  }

  /* ================================================================== cars */
  var specs = {};
  function stockList() {
    var K = CB.stock, out = [];
    if (!K || !K.SPECS) return out;
    var models = CB.shapes && CB.shapes.list ? CB.shapes.list() : [];
    models.forEach(function (m) {
      var sp = K.SPECS[m.id]; if (!sp) return;
      out.push({ id: m.id, name: [m.make, m.name, sp.t].filter(Boolean).join(' '), make: m.make || '', hp: sp.hp, kg: sp.kg, s100: sp.s, drive: String(sp.d || '').split(' ')[0], cls: sp.c || '' });
    });
    out.sort(function (a, b) { return b.hp / b.kg - a.hp / a.kg; });
    return out;
  }
  function stockBuild(id) {
    if (specs['s:' + id]) return specs['s:' + id];
    var b = null;
    try { var x = CB.stock && CB.stock.build(id); b = x ? x.build : null; } catch (e) { b = null; }
    if (b) specs['s:' + id] = b;
    return b;
  }
  function stockName(id) { try { return CB.stock && CB.stock.title ? CB.stock.title(id) || id : id; } catch (e) { return id; } }
  function presetList() { return CB.data && Array.isArray(CB.data.presets) ? CB.data.presets : []; }
  function presetBuild(id) { try { return CB.data.presetBuild(id); } catch (e) { return CB.data && CB.data.defaultBuild ? CB.data.defaultBuild() : null; } }
  function savedBuilds() { try { return CB.state && typeof CB.state.listLocal === 'function' ? CB.state.listLocal().slice(0, 16) : []; } catch (e) { return []; } }
  function currentBuild() { try { return CB.state && typeof CB.state.get === 'function' ? CB.state.get() : null; } catch (e) { return null; } }
  function buildName(b, fb) { return (b && b.meta && b.meta.name) || (b && b.name) || fb || 'My build'; }
  function paintOf(b) { return (b && b.exterior && b.exterior.paint) || '#c0392b'; }
  function hasLaunchControl(b) { return !!(b && b.transmission && b.transmission.launchControl); }
  /** the player's car for the settings: { build (tuned copy), base (untuned), name, key, modelId } */
  function playerCar(S) {
    var base = null, name = '', key = '', modelId = null;
    if (S.source === 'current') { base = currentBuild(); name = buildName(base, 'Garage build'); key = 'current'; }
    else if (S.source === 'saved' && S.savedId) {
      var e = savedBuilds().filter(function (x) { return x.id === S.savedId; })[0];
      if (e && e.build) { base = CB.state && CB.state.normalize ? CB.state.normalize(e.build) : e.build; name = e.name || buildName(e.build); key = 'saved:' + e.id; }
    } else if (S.source === 'preset') {
      var p = presetList().filter(function (x) { return x.id === S.presetId; })[0] || presetList()[0];
      if (p) { base = presetBuild(p.id); name = p.name; key = 'preset:' + p.id; }
    }
    if (!base) { var sid = S.stockId || DEFAULTS.stockId; base = stockBuild(sid); name = stockName(sid); key = 'stock:' + sid; modelId = sid; }
    if (base && base.body && base.body.model && !modelId) modelId = base.body.model;
    var build = base;
    var fd0 = base && base.transmission ? num(base.transmission.finalDrive, null) : null;
    if (base && CB.drag.launch && (S.tuneFD != null && fd0 != null && Math.abs(S.tuneFD - fd0) > 0.005 || Math.abs(num(S.tuneSpread, 1) - 1) > 0.005)) {
      try { build = CB.drag.launch.tuneBuild(base, { finalDrive: S.tuneFD != null ? S.tuneFD : fd0, gearSpread: S.tuneSpread }); } catch (e3) { build = base; }
    }
    return { build: build, base: base, name: name, key: key, modelId: modelId, tuned: build !== base };
  }

  /* ================================================================== session config (pure) */
  function assistsOf(S, build) {
    return { autoShift: !!S.autoShift, launchControl: hasLaunchControl(build) ? S.launchControl !== false : false, tc: S.tc, autoStage: !!S.autoStage, deep: !!S.deep };
  }
  /** an opponent session entry from a rival / stock model / ghost */
  function entryFor(o, S) {
    o = o || {};
    if (o.ghost) return { kind: 'ghost', name: 'Ghost · ' + (o.ghost.name || 'friend'), carName: o.ghost.carName || '', color: o.ghost.color || '#9bb7ff', modelId: o.ghost.modelId || null, ghost: o.ghost, build: o.ghost.modelId ? stockBuild(o.ghost.modelId) : null };
    var model = o.model || o.modelId, build = o.build || (model ? stockBuild(model) : null);
    return { kind: 'ai', name: o.name || 'Rival', carName: o.carName || (model ? stockName(model) : buildName(build, 'Car')), color: o.color || paintOf(build), modelId: model || null,
      build: build, difficulty: o.difficulty || (S && S.difficulty) || 'amateur', assists: { autoShift: o.autoShift != null ? o.autoShift : false, tc: 'car', launchControl: true, autoStage: true },
      nitrous_hp: S && S.cls === 'pro-mod' ? S.nitrous_hp : 0, dial: o.dial != null ? o.dial : null };
  }
  /** dial-in: explicit, else the PB / predicted ET rounded up to 0.05 s with a small cushion */
  function dialFor(explicit, pb, predicted) {
    if (explicit != null && isFinite(explicit)) return Math.round(explicit * 100) / 100;
    var b = pb != null && isFinite(pb) ? pb : predicted;
    if (b == null || !isFinite(b)) return null;
    return Math.ceil((b + 0.05) * 20) / 20;
  }
  function sessionConfig(S, me, opp, o) {
    o = o || {};
    var venue = S.venue, cfg = {
      seed: num(o.seed, 1), distanceId: S.distanceId, venue: venue, surface: S.surface, night: !!S.night, treeType: venue === 'street' ? 'flag' : S.treeType,
      bracket: !!S.bracket && !!opp, class: S.cls, playerLane: 0, skipBurnout: !!S.skipBurnout || venue === 'street',
      lanes: [{ kind: 'player', name: o.playerName || 'You', build: me.build, carName: me.name, color: paintOf(me.build), modelId: me.modelId,
        assists: assistsOf(S, me.build), nitrous_hp: S.cls === 'pro-mod' ? S.nitrous_hp : 0, dial: S.bracket ? o.dial != null ? o.dial : null : null }, opp || { kind: 'none' }]
    };
    if (cfg.bracket && opp && opp.dial == null && o.oppDial != null) cfg.lanes[1].dial = o.oppDial;
    return cfg;
  }
  /** 10 Hz trace (m from the line, from the green) from per-frame samples [{t, x}] */
  function ghostTrace(samples, greenT, maxN) {
    var out = [], n = samples.length;
    if (!n || greenT == null) return out;
    var j = 0, end = samples[n - 1].t;
    for (var tt = greenT; tt <= end + 1e-6 && out.length < (maxN || 1200); tt += 0.1) {
      while (j < n - 2 && samples[j + 1].t < tt) j++;
      var a = samples[j], b = samples[Math.min(n - 1, j + 1)];
      var x = tt <= a.t ? a.x : b.t === a.t ? b.x : a.x + (b.x - a.x) * clamp((tt - a.t) / (b.t - a.t), 0, 1);
      out.push(Math.max(0, x));
    }
    return out;
  }
  function isVs(o) { return !!o && ['solo', 'practice', 'tutorial', 'none'].indexOf(o) < 0; }

  /* ================================================================== coach (pure): the first-run tutorial */
  var COACH = [
    { id: 'intro', title: 'Welcome to the strip', body: 'A drag race is a straight-line sprint: hot tyres, a perfect launch and clean shifts. This practice run walks you through it — no opponent, a slow-motion tree.', hint: 'Press {brk} to begin', hl: null },
    { id: 'burnout', title: 'Burnout: heat the tyres', body: 'Hold {brk} + {thr} together. Watch the tyre meter: stop when the needle is in the green window — too long and they overheat.', hint: 'Hold {brk} + {thr}', hl: 'heat' },
    { id: 'roll', title: 'Roll to the line', body: 'Let go, then tap {thr} to creep forward. The top bulbs on the tree light when your front tyres reach the pre-stage beam.', hint: 'Tap {thr} · {brk} to stop', hl: 'tree' },
    { id: 'stage', title: 'Stage the car', body: 'Pre-staged! Now tap {thr} gently — tiny taps — until the second row of bulbs lights. Roll through it and you are out.', hint: 'Tiny taps of {thr}', hl: 'tree' },
    { id: 'revs', title: 'Revs in the green band', body: 'Hold {brk} and press {thr}: keep the needle inside the green band — too few revs bogs, too many spins the tyres.', hint: 'Hold {brk}, feather {thr}', hl: 'launch' },
    { id: 'green', title: 'Watch the ambers', body: 'When the three ambers light, the green follows. Release {brk} on GREEN — don’t jump it, a red light loses the race.', hint: 'Release {brk} on green', hl: 'tree' },
    { id: 'shift', title: 'Shift at the top', body: 'Keep {thr} pinned. When the shift lights flash at the top, hit {up} — that is the perfect window.', hint: '{up} when the lights flash', hl: 'lights' },
    { id: 'finish', title: 'Pin it to the finish', body: 'Hold it flat through the finish line — the timeslip shows your reaction, 60 ft, splits, ET and trap speed.', hint: 'Keep {thr} down', hl: 'progress' },
    { id: 'done', title: 'That’s a pass!', body: 'Nicely done. Next: race a rival on the ladder, or keep practising.', hint: '', hl: null }
  ];
  function coachStep(i) { return COACH[clamp(i | 0, 0, COACH.length - 1)]; }
  /** next coach step index from the current one, the player's lane, the snapshot and the input (pure) */
  function coachNext(i, lane, snap, inp, ctx) {
    ctx = ctx || {};
    var id = coachStep(i).id;
    if (!lane || !snap) return i;
    if (id === 'intro') return inp && inp.brake > 0.5 ? i + 1 : i;
    if (id === 'burnout') return num(lane.tyreTemp, 0) >= 68 || lane.preStaged || lane.x > -14 && !lane.burnout ? i + 1 : i;
    if (id === 'roll') return lane.staged ? i + 2 : lane.preStaged ? i + 1 : i;
    if (id === 'stage') return lane.staged ? i + 1 : i;
    if (id === 'revs') {
      var L = lane.launch || {}, rpm = num(L.rpm, 0), ok = L.held && (L.ev || L.lc || !(L.hi > L.lo) || (rpm >= L.lo && rpm <= L.hi));
      ctx.bandT = ok ? num(ctx.bandT, 0) + num(ctx.dt, 1 / 60) : 0;
      var am = snap.tree && snap.tree.lanes && snap.tree.lanes[snap.playerLane || 0] ? snap.tree.lanes[snap.playerLane || 0].amber || [] : [];
      return ctx.bandT > 0.8 || am.some(Boolean) || lane.left ? i + 1 : i;
    }
    if (id === 'green') return lane.left ? (lane.autoShift ? i + 2 : i + 1) : i;
    if (id === 'shift') return num(ctx.shifts, 0) >= 2 || lane.finished || num(lane.gear, 1) >= num(lane.maxGear, 6) ? i + 1 : i;
    if (id === 'finish') return lane.finished ? i + 1 : i;
    return i;
  }
  /** coaching notes for a finished run (pure): what went wrong and how to fix it */
  function tipsFor(me) {
    var t = [];
    if (!me) return t;
    if (me.red) t.push({ kind: 'bad', text: me.rt != null && me.rt < 0 ? 'Red light: you left ' + Math.abs(me.rt).toFixed(3) + ' s before the green. Wait for it — on a Pro tree release just as the ambers go out.' : 'Red light: you left before the green.' });
    else if (me.rt != null && me.rt > 0.5) t.push({ kind: 'warn', text: 'Slow light (' + me.rt.toFixed(3) + ' s). Have the revs up and release the brake the moment the green shows.' });
    else if (me.rt != null && me.rt <= 0.02) t.push({ kind: 'good', text: 'Great light — a ' + me.rt.toFixed(3) + ' s reaction.' });
    var L = me.launch || {};
    if (L.bog) t.push({ kind: 'warn', text: 'Bogged off the line: rev higher (into the green band) before you let go.' });
    if (L.spin) t.push({ kind: 'warn', text: 'Wheelspin: launch with fewer revs, or do a longer burnout for hotter tyres.' });
    if (me.burnout && num(me.burnout.temp, 99) < 55) t.push({ kind: 'info', text: 'Cold tyres (' + Math.round(me.burnout.temp) + ' °C): hold brake + gas in the box until the tyre meter is green.' });
    if (me.burnout && num(me.burnout.temp, 0) > 112) t.push({ kind: 'warn', text: 'Overheated tyres (' + Math.round(me.burnout.temp) + ' °C): a shorter burnout grips better.' });
    var sh = me.shifts || {};
    if (num(sh.early, 0) >= 2) t.push({ kind: 'info', text: num(sh.early, 0) + ' early shifts: wait until the shift lights flash.' });
    if (num(sh.late, 0) >= 2) t.push({ kind: 'info', text: num(sh.late, 0) + ' late shifts: bouncing the limiter costs time — shift as the lights flash.' });
    return t;
  }
  function distId(res) { var d = res && res.distance; return d == null ? null : typeof d === 'string' ? d : d.id; }
  var DIFF_MULT = { rookie: 0.7, amateur: 1, pro: 1.35, alien: 1.8 };
  /** credits for a pass (free-mode pattern: small for a solo pass, a win pays by difficulty, bonuses for skill) */
  function payout(res, ctx) {
    ctx = ctx || {};
    var me = res && res.lanes ? res.lanes[ctx.lane || 0] : null;
    if (!me) return { total: 0, items: [] };
    var items = [], m = DIFF_MULT[ctx.difficulty] || 1;
    function add(label, n) { n = Math.round(n); if (n > 0) items.push({ label: label, n: n }); }
    var vs = isVs(ctx.opponent);
    if (me.red) add('Pass (red light)', 10);
    else {
      add('Pass', vs ? 30 : 25);
      if (vs && me.won) add('Win light', 120 * m);
      if (me.won && res.holeshot) add('Holeshot', 60);
      if (me.rt != null && me.rt >= 0 && me.rt <= 0.010) add('Perfect light', 75);
      else if (me.rt != null && me.rt >= 0 && me.rt <= 0.05) add('Great light', 25);
      var sh = me.shifts || {}, tot = num(sh.perfect, 0) + num(sh.good, 0) + num(sh.early, 0) + num(sh.late, 0);
      if (tot >= 2 && sh.perfect === tot) add('Money shifts', 50);
      if (ctx.pb) add('Personal best', 60);
      if (ctx.ladderFirst) add('Rival beaten', 150 + 50 * num(ctx.ladderIndex, 0));
      if (ctx.tournamentWon) add('Tournament win', 400 * m);
    }
    return { total: items.reduce(function (s, x) { return s + x.n; }, 0), items: items };
  }
  function achievementEvent(res, ctx) {
    ctx = ctx || {};
    var me = res.lanes[ctx.lane || 0] || {}, sh = me.shifts || {}, MPH = 2.2369363;
    var q = (me.splits || []).filter(function (s) { return s.id === 'quarter'; })[0], did = distId(res);
    return { type: 'drag', won: !!me.won && isVs(ctx.opponent), et: me.red ? null : num(did === 'quarter' ? me.et : q ? q.t : null, null),
      trap_mph: me.trap ? me.trap * MPH : 0, rt: me.rt, red: !!me.red, holeshot: !!(me.won && res.holeshot), distanceId: q ? 'quarter' : did,
      shifts: { perfect: num(sh.perfect, 0), total: num(sh.perfect, 0) + num(sh.good, 0) + num(sh.early, 0) + num(sh.late, 0) },
      burnoutBonus: me.burnout ? num(me.burnout.bonus, 0) : 0, ladderChampion: !!ctx.ladderChampion, tournamentWon: !!ctx.tournamentWon,
      bracket: !!res.bracket && !me.breakout, opponent: ctx.opponent || 'solo' };
  }

  CB.drag.ui = CB.drag.ui || {};
  CB.drag.ui._ = { DEFAULTS: DEFAULTS, sanitizeSettings: sanitizeSettings, createInput: createInput, KEYS: KEYS, LS_KEY: LS_KEY, payout: payout, dialFor: dialFor,
    entryFor: entryFor, sessionConfig: sessionConfig, ghostTrace: ghostTrace, achievementEvent: achievementEvent, stockList: stockList, playerCar: playerCar, assistsOf: assistsOf, distId: distId,
    isVs: isVs, COACH: COACH, coachStep: coachStep, coachNext: coachNext, tipsFor: tipsFor };
  CB.drag.ui._parts = { clamp: clamp, num: num, esc: esc, hasDOM: hasDOM, loadSettings: loadSettings, saveSettings: saveSettings, stockBuild: stockBuild, stockName: stockName,
    presetList: presetList, presetBuild: presetBuild, savedBuilds: savedBuilds, currentBuild: currentBuild, buildName: buildName, paintOf: paintOf, hasLaunchControl: hasLaunchControl, DIFFS: DIFFS };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.drag.ui;
})();

/* ---------------------------------------------------------------------------------------------------------------
   CB.drag.ui (browser part): setup, play loop, results, ladder, tournament, route registration, test hooks.
   --------------------------------------------------------------------------------------------------------------- */
(function () {
  'use strict';
  var P = CB.drag.ui._parts, X = CB.drag.ui._;
  if (!P || !P.hasDOM) return;
  var clamp = P.clamp, num = P.num, esc = P.esc;
  var U = { layer: null, root: null, screen: null, S: null, R: null, params: {}, predict: {}, tour: null, lastResults: null, carTab: null };
  var MPH = 2.2369363;

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null || c === false) continue; if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); }); else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
  }
  function safe(fn) { try { return fn(); } catch (e) { if (typeof console !== 'undefined') console.warn('[drag-ui]', e); return null; } }
  function persist() { P.saveSettings(U.S); }
  function router() { return CB.router || null; }
  function setDriving(on) { var r = router(); if (r && r.setDriving) r.setDriving(on); }
  function toast(msg, kind) { if (CB.ui && typeof CB.ui.toast === 'function') CB.ui.toast(msg, kind || 'info'); }
  var ICON = {
    play: '<path d="M7 4l13 8-13 8z"/>', back: '<path d="M15 18l-6-6 6-6"/>', bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', cam: '<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>',
    pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', ghost: '<path d="M5 20V10a7 7 0 0 1 14 0v10l-2.5-2-2.3 2-2.2-2-2.2 2-2.3-2z"/><circle cx="9.5" cy="10" r="1"/><circle cx="14.5" cy="10" r="1"/>',
    trophy: '<path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M9 20h6M12 13v7"/>', next: '<path d="M9 18l6-6-6-6"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    check: '<path d="M5 12l5 5 9-10"/>', tree: '<path d="M12 3v15M8 21h8"/><circle cx="12" cy="6" r="1.6"/><circle cx="12" cy="10" r="1.6"/><circle cx="12" cy="14" r="1.6"/>'
  };
  function icon(n, size) { return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[n] || ICON.bolt) + '</svg>'; }
  function seg(opts, val, onPick, label) {
    var w = h('div', { class: 'cb-tab-list dg-seg', role: 'group', 'aria-label': label || null });
    opts.forEach(function (o) {
      var on = o.v === val;
      w.appendChild(h('button', { type: 'button', class: 'cb-tab' + (on ? ' is-active' : ''), 'aria-pressed': on ? 'true' : 'false', disabled: o.disabled ? true : null, title: o.title || null, text: o.t,
        onclick: function () { onPick(o.v); } }));
    });
    return w;
  }
  function sec(step, title, hint) {
    var s = h('section', { class: 'dg-sec', 'aria-label': title });
    s.appendChild(h('h3', null, h('span', { class: 't', html: '<span class="dg-step">' + step + '</span>' + esc(title) }), hint ? h('span', { class: 'dg-hint', text: hint }) : null));
    return s;
  }
  function row(rows, label, ctl) { rows.appendChild(h('label', { class: 'dg-lbl', text: label })); rows.appendChild(ctl); }
  function fmtET(t) { return t == null || !isFinite(t) ? '—' : t.toFixed(3); }
  function fmtV(v, units) { return v == null || !isFinite(v) ? '—' : units === 'metric' ? (v * 3.6).toFixed(1) + ' km/h' : (v * MPH).toFixed(1) + ' mph'; }

  /* ================================================================== prediction (headless sim, cached) */
  function predictKey(me, S) { return [me.key, S.tuneFD, S.tuneSpread, S.distanceId, S.surface, S.cls, S.nitrous_hp].join('|'); }
  function predict(me, S, cb) {
    var k = predictKey(me, S);
    if (U.predict[k] !== undefined) { if (cb) cb(U.predict[k]); return U.predict[k]; }
    U.predict[k] = null;
    setTimeout(function () {
      var res = safe(function () {
        if (!CB.drag.session || !CB.drag.session.simulate || !me.build) return null;
        return CB.drag.session.simulate({ seed: 5, distanceId: S.distanceId, venue: 'strip', surface: S.surface, treeType: 'pro', skipBurnout: true, class: S.cls,
          lanes: [{ kind: 'ai', name: 'Predict', build: me.build, difficulty: 'alien', assists: { autoShift: true, tc: 'car', launchControl: true, autoStage: true }, nitrous_hp: S.cls === 'pro-mod' ? S.nitrous_hp : 0 }, { kind: 'none' }] });
      });
      var l = res && res.lanes && res.lanes[0];
      U.predict[k] = l && l.et != null ? { et: l.et, trap: l.trap, sixty: ((l.splits || []).filter(function (x) { return x.id === 'ft60'; })[0] || {}).t || null } : false;
      if (cb) cb(U.predict[k]);
    }, 30);
    return null;
  }

  /* ================================================================== SETUP */
  function showSetup() {
    teardown();
    U.screen = 'setup'; setDriving(false);
    var root = U.root; root.innerHTML = '';
    var wrap = h('div', { class: 'dg-setup' });
    root.appendChild(wrap);
    wrap.appendChild(h('div', { class: 'dg-head' },
      h('div', null, h('div', { class: 'dg-kicker', text: 'Drag Racing · heads-up on the strip' }), h('h1', { class: 'dg-title', text: 'Light the tree' }),
        h('div', { class: 'dg-sub', text: 'Burnout, stage, launch on green, nail your shifts. Every horsepower, kilo and gear ratio from the Garage shows up on the timeslip.' })),
      h('div', { class: 'dg-headbar' },
        h('button', { class: 'cb-btn ghost', type: 'button', 'data-dg': 'howto', html: icon('tree', 14) + ' How to drag race', onclick: function () { startRun({ tutorial: true }); } }),
        (CB.input && CB.input.ui && typeof CB.input.ui.openPairing === 'function') ? h('button', { class: 'cb-btn ghost', type: 'button', html: icon('cam', 14) + ' Controls', onclick: function () { safe(function () { CB.input.ui.openPairing(); }); } }) : null,
        h('button', { class: 'cb-btn ghost dg-back', type: 'button', 'aria-label': 'Main menu', html: icon('back', 16) + '<span class="lbl">Main menu</span>', onclick: function () { var r = router(); if (r) r.go('menu'); } }))));
    var main = h('div', { class: 'dg-main' }), side = h('aside', { class: 'dg-side' });
    wrap.appendChild(main); wrap.appendChild(side);
    U.mainEl = main; U.sideEl = side;
    fillMain(); fillSide();
    root.appendChild(footer());
  }
  function rerender() {
    if (U.screen !== 'setup' || !U.mainEl) return;
    var sc = U.layer ? U.layer.scrollTop : 0;
    fillMain(); fillSide(); updateFoot();
    if (U.layer) U.layer.scrollTop = sc;
  }
  function fillMain() {
    var m = U.mainEl; m.innerHTML = '';
    if (!tutorialDone()) m.appendChild(h('div', { class: 'dg-first' }, h('div', null, h('b', { text: 'New to drag racing?' }), h('span', { text: ' A two-minute guided pass teaches the burnout, staging, the launch and shifting.' })),
      h('button', { class: 'cb-btn primary', type: 'button', 'data-dg': 'tut-banner', html: icon('play', 14) + ' How to drag race', onclick: function () { startRun({ tutorial: true }); } })));
    m.appendChild(carSection()); m.appendChild(oppSection()); m.appendChild(stripSection()); m.appendChild(rulesSection()); m.appendChild(assistSection()); m.appendChild(displaySection());
  }
  function carCard(o) {
    return h('button', { type: 'button', class: 'dg-card' + (o.on ? ' is-on' : ''), 'aria-pressed': o.on ? 'true' : 'false', onclick: o.pick, title: o.title || null },
      h('span', { class: 'n' }, o.color ? h('span', { class: 'dg-sw', style: { background: o.color } }) : null, o.name),
      h('span', { class: 'm', text: o.meta || '' }));
  }
  function carSection() {
    var S = U.S, s = sec(1, 'Car', 'Power-to-weight · traction · gearing');
    var tab = U.carTab || (S.source === 'current' || S.source === 'saved' ? 'mine' : S.source === 'preset' ? 'preset' : 'stock');
    var tl = h('div', { class: 'cb-tab-list dg-tabs', role: 'tablist' });
    [['stock', 'Stock cars'], ['preset', 'Presets'], ['mine', 'My Cars']].forEach(function (t) {
      tl.appendChild(h('button', { type: 'button', role: 'tab', class: 'cb-tab' + (tab === t[0] ? ' is-active' : ''), 'aria-selected': tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { U.carTab = t[0]; rerender(); } }));
    });
    s.appendChild(tl);
    var grid = h('div', { class: 'dg-grid' });
    if (tab === 'stock') {
      X.stockList().forEach(function (c) {
        grid.appendChild(carCard({ name: c.name, meta: c.hp + ' hp · ' + c.kg + ' kg · ' + c.drive.toUpperCase() + ' · 0–100 ' + c.s100 + ' s', on: S.source === 'stock' && S.stockId === c.id,
          title: 'Auto-config: the factory spec', pick: function () { S.source = 'stock'; S.stockId = c.id; S.tuneFD = null; S.tuneSpread = 1; persist(); rerender(); } }));
      });
      if (!grid.children.length) grid.appendChild(h('div', { class: 'dg-sub', text: 'Stock specs are not available in this build.' }));
    } else if (tab === 'preset') {
      P.presetList().forEach(function (p) {
        grid.appendChild(carCard({ name: p.name, meta: p.desc || p.tagline || '', color: P.paintOf(P.presetBuild(p.id)), on: S.source === 'preset' && S.presetId === p.id,
          pick: function () { S.source = 'preset'; S.presetId = p.id; S.tuneFD = null; S.tuneSpread = 1; persist(); rerender(); } }));
      });
    } else {
      var cur = P.currentBuild();
      if (cur) grid.appendChild(carCard({ name: P.buildName(cur, 'Garage build') + ' (current)', meta: 'Your Garage build, as tuned', color: P.paintOf(cur), on: S.source === 'current', pick: function () { S.source = 'current'; S.tuneFD = null; S.tuneSpread = 1; persist(); rerender(); } }));
      P.savedBuilds().forEach(function (e) {
        grid.appendChild(carCard({ name: e.name || P.buildName(e.build), meta: 'Saved build', color: P.paintOf(e.build), on: S.source === 'saved' && S.savedId === e.id, pick: function () { S.source = 'saved'; S.savedId = e.id; S.tuneFD = null; S.tuneSpread = 1; persist(); rerender(); } }));
      });
      if (!grid.children.length) grid.appendChild(h('div', { class: 'dg-sub', text: 'No saved builds yet — build one in the Garage, or pick a stock car.' }));
    }
    s.appendChild(grid);
    return s;
  }
  function oppSection() {
    var S = U.S, s = sec(2, 'Opponent');
    s.appendChild(seg([{ v: 'ladder', t: 'Rival ladder' }, { v: 'ai', t: 'Quick race' }, { v: 'tournament', t: 'Tournament' }, { v: 'ghost', t: 'Friend’s ghost' }, { v: 'solo', t: 'Solo pass' }, { v: 'practice', t: 'Practice' }], S.opponent,
      function (v) { S.opponent = v; persist(); rerender(); }, 'Opponent'));
    var body = h('div', { class: 'dg-opp' });
    var AI = CB.drag.ai;
    if (S.opponent === 'ladder' && AI) {
      var L = AI.ladder.load(), nx = AI.ladder.next(L);
      var cur = S.rivalId && AI.ladder.unlocked(L, S.rivalId) ? S.rivalId : (AI.RIVALS[Math.min(nx, AI.RIVALS.length - 1)] || {}).id;
      var list = h('ol', { class: 'dg-ladder' });
      AI.RIVALS.forEach(function (r, i) {
        var beaten = L.beaten.indexOf(r.id) >= 0, open = i <= nx, on = r.id === cur;
        list.appendChild(h('li', null, h('button', { type: 'button', class: 'dg-rival' + (on ? ' is-on' : '') + (beaten ? ' is-beaten' : '') + (!open ? ' is-locked' : ''), disabled: open ? null : true, 'aria-pressed': on ? 'true' : 'false',
          onclick: function () { S.rivalId = r.id; persist(); rerender(); } },
          h('span', { class: 'dg-ava', style: { '--ava': r.color || '#888' }, 'aria-hidden': 'true' }, h('b', { text: (r.name.match(/["“]([^"”]+)["”]/) || [0, r.name])[1].slice(0, 2).toUpperCase() }), h('i', { text: String(AI.RIVALS.length - i) })),
          h('span', { class: 'who' }, h('b', { text: r.name }), h('small', { text: P.stockName(r.model) + ' · ' + r.difficulty })),
          h('span', { class: 'st', html: beaten ? icon('check', 16) : !open ? icon('lock', 15) : '' }))));
      });
      body.appendChild(list);
      var rv = AI.ladder.get(cur);
      if (rv) body.appendChild(h('div', { class: 'dg-sub', html: '<b>' + esc(rv.name) + '</b> — ' + esc(rv.bio || '') }));
      if (nx >= AI.RIVALS.length) body.appendChild(h('div', { class: 'dg-sub', html: 'Ladder complete — you are the King of the Strip. ' }));
    } else if (S.opponent === 'ai') {
      var sel = h('select', { class: 'cb-select dg-select', 'aria-label': 'Opponent car', onchange: function (e) { S.aiModel = e.target.value; persist(); updateFoot(); } });
      X.stockList().forEach(function (c) { sel.appendChild(h('option', { value: c.id, selected: c.id === S.aiModel ? true : null, text: c.name + ' (' + c.hp + ' hp)' })); });
      var rows = h('div', { class: 'dg-rows' });
      row(rows, 'Opponent car', sel);
      row(rows, 'Driver', seg(P.DIFFS.map(function (d) { return { v: d, t: d[0].toUpperCase() + d.slice(1) }; }), S.difficulty, function (v) { S.difficulty = v; persist(); rerender(); }));
      body.appendChild(rows);
    } else if (S.opponent === 'tournament') {
      var rows2 = h('div', { class: 'dg-rows' });
      row(rows2, 'Bracket', seg([{ v: 4, t: '4 cars' }, { v: 8, t: '8 cars' }], S.tSize, function (v) { S.tSize = v; persist(); rerender(); }));
      body.appendChild(rows2);
      body.appendChild(h('div', { class: 'dg-sub', text: 'Single elimination against the rival ladder. Lose once and you are out; the other heats are run by the AI.' }));
      if (U.tour && !U.tour.done) body.appendChild(h('button', { class: 'cb-btn ghost', type: 'button', html: icon('trophy', 15) + ' Resume tournament', onclick: showBracket }));
    } else if (S.opponent === 'ghost') {
      var g = CB.drag.timing ? CB.drag.timing.decodeGhost(S.ghostCode) : null;
      var ta = h('textarea', { class: 'cb-input dg-code', rows: 3, placeholder: 'Paste a ghost code (RLD1…) a friend copied from their timeslip', 'aria-label': 'Ghost code',
        oninput: function (e) { S.ghostCode = e.target.value.trim(); persist(); var gg = CB.drag.timing.decodeGhost(S.ghostCode); st.textContent = gg ? '✓ ' + gg.name + ' · ' + gg.carName + ' · ' + gg.et.toFixed(3) + ' s over ' + (ST().get(gg.distanceId).name) : S.ghostCode ? 'Not a valid ghost code' : ''; st.className = 'dg-sub ' + (gg ? 'ok' : 'bad'); if (gg) { S.distanceId = gg.distanceId; persist(); } updateFoot(); } });
      ta.value = S.ghostCode || '';
      var st = h('div', { class: 'dg-sub ' + (g ? 'ok' : S.ghostCode ? 'bad' : ''), text: g ? '✓ ' + g.name + ' · ' + g.carName + ' · ' + g.et.toFixed(3) + ' s over ' + ST().get(g.distanceId).name : S.ghostCode ? 'Not a valid ghost code' : '' });
      body.appendChild(ta); body.appendChild(st);
    } else if (S.opponent === 'practice') body.appendChild(h('div', { class: 'dg-sub', text: 'No opponent and a slow-motion tree, with coaching tips when something goes wrong. Great for finding your launch rpm.' }));
    else body.appendChild(h('div', { class: 'dg-sub', text: 'Just you and the clock: a test-and-tune pass for your timeslip and personal bests.' }));
    s.appendChild(body);
    return s;
  }
  function ST() { return CB.drag.strip; }
  function stripSection() {
    var S = U.S, s = sec(3, 'Strip'), rows = h('div', { class: 'dg-rows' });
    var dg = h('div', { class: 'dg-dists', role: 'group', 'aria-label': 'Distance' });
    ST().DISTANCES.forEach(function (d) {
      var on = d.id === S.distanceId, frac = d.m ? clamp(d.m / 1000, 0.12, 1) : 1;
      var art = d.speed ? '<svg viewBox="0 0 60 24" aria-hidden="true"><path d="M8 20a22 22 0 0 1 44 0" fill="none" stroke="currentColor" stroke-width="2.4" opacity=".35"/><path d="M8 20a22 22 0 0 1 ' + (d.roll ? 30 : 44) + ' -' + (d.roll ? 18 : 0) + '" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="30" cy="20" r="2.4" fill="currentColor"/></svg>'
        : '<span class="dg-strip"><i style="width:' + Math.round(frac * 100) + '%"></i></span>';
      dg.appendChild(h('button', { type: 'button', class: 'dg-dist' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', title: d.name, onclick: function () { S.distanceId = d.id; persist(); rerender(); } },
        h('b', { text: d.short || d.name }), h('span', { class: 'dg-dist-art', html: art }), h('small', { text: d.m ? (d.m < 999 ? Math.round(d.m) + ' m' : '1 km') : d.roll ? 'rolling start' : 'standing start' })));
    });
    row(rows, 'Distance', dg);
    row(rows, 'Venue', seg([{ v: 'strip', t: 'Drag strip' }, { v: 'street', t: 'Street (flag start)' }], S.venue, function (v) { S.venue = v; if (v === 'street' && S.surface === 'prepped') S.surface = 'street'; persist(); rerender(); }));
    row(rows, 'Tree', seg([{ v: 'pro', t: 'Pro 0.4', disabled: S.venue === 'street' }, { v: 'sportsman', t: 'Sportsman 0.5', disabled: S.venue === 'street' }], S.venue === 'street' ? null : S.treeType, function (v) { S.treeType = v; persist(); rerender(); }));
    row(rows, 'Surface', seg(['prepped', 'street', 'wet'].map(function (k) { var d = ST().SURFACES[k]; return { v: k, t: d.name, title: d.desc }; }), S.surface, function (v) { S.surface = v; persist(); rerender(); }));
    row(rows, 'Time', seg([{ v: false, t: 'Day' }, { v: true, t: 'Night (lights)' }], S.night, function (v) { S.night = v; persist(); rerender(); }));
    s.appendChild(rows);
    return s;
  }
  function rulesSection() {
    var S = U.S, s = sec(4, 'Rules & class'), rows = h('div', { class: 'dg-rows' });
    row(rows, 'Bracket racing', seg([{ v: false, t: 'Heads-up' }, { v: true, t: 'Bracket (dial-in)' }], S.bracket, function (v) { S.bracket = v; persist(); rerender(); }));
    if (S.bracket) {
      var me = X.playerCar(S), pr = U.predict[predictKey(me, S)], auto = X.dialFor(null, bestEt(me, S), pr ? pr.et : null);
      var inp = h('input', { type: 'number', class: 'cb-input dg-dial', step: '0.01', min: '3', max: '40', placeholder: auto ? auto.toFixed(2) + ' (auto)' : 'auto', 'aria-label': 'Dial-in (s)',
        onchange: function (e) { var v = parseFloat(e.target.value); S.dial = isFinite(v) && v > 2 ? Math.round(v * 100) / 100 : null; persist(); updateFoot(); } });
      if (S.dial != null) inp.value = S.dial.toFixed(2);
      row(rows, 'Your dial-in (s)', h('div', { class: 'dg-inline' }, inp, h('span', { class: 'dg-hint', text: 'Closest to your dial without going under wins. Slower dial leaves first.' })));
    }
    row(rows, 'Class', seg([{ v: 'street', t: 'Street' }, { v: 'pro-mod', t: 'Pro Mod (N2O legal)' }], S.cls, function (v) { S.cls = v; persist(); rerender(); }));
    if (S.cls === 'pro-mod') row(rows, 'N2O shot', seg([50, 100, 150, 250].map(function (n) { return { v: n, t: n + ' hp' }; }), S.nitrous_hp, function (v) { S.nitrous_hp = v; persist(); rerender(); }));
    s.appendChild(rows);
    return s;
  }
  function assistSection() {
    var S = U.S, me = X.playerCar(S), s = sec(5, 'Assists & quick tune', 'Tune stays in Drag — the Garage build is untouched'), rows = h('div', { class: 'dg-rows' });
    row(rows, 'Gearbox', seg([{ v: false, t: 'Manual shifts' }, { v: true, t: 'Auto-shift' }], S.autoShift, function (v) { S.autoShift = v; persist(); rerender(); }));
    var lc = P.hasLaunchControl(me.build);
    row(rows, 'Launch control', seg([{ v: true, t: 'On', disabled: !lc }, { v: false, t: 'Off', disabled: !lc }], lc ? S.launchControl : null, function (v) { S.launchControl = v; persist(); rerender(); }));
    if (!lc) rows.lastChild.title = 'This build has no launch control (Garage › Transmission)';
    row(rows, 'Traction control', seg([{ v: 'car', t: 'As built' }, { v: 0, t: 'Off' }, { v: 1, t: '1' }, { v: 2, t: '2' }, { v: 3, t: '3' }], S.tc, function (v) { S.tc = v; persist(); rerender(); }));
    row(rows, 'Staging', seg([{ v: false, t: 'Manual creep' }, { v: true, t: 'Auto-stage' }], S.autoStage, function (v) { S.autoStage = v; persist(); rerender(); }));
    row(rows, 'Stage depth', seg([{ v: false, t: 'Shallow' }, { v: true, t: 'Deep' }], S.deep, function (v) { S.deep = v; persist(); rerender(); }));
    row(rows, 'Burnout box', seg([{ v: false, t: 'Do a burnout' }, { v: true, t: 'Skip' }], S.skipBurnout, function (v) { S.skipBurnout = v; persist(); rerender(); }));
    var tr = me.base && me.base.transmission || {}, fd0 = num(tr.finalDrive, 3.5), single = tr.type === 'single-speed' || tr.type === 'cvt';
    var fd = S.tuneFD != null ? S.tuneFD : fd0;
    var fdVal = h('b', { class: 'dg-val', text: fd.toFixed(2) });
    var fdIn = h('input', { type: 'range', min: (Math.max(2.5, fd0 * 0.75)).toFixed(2), max: (Math.min(5.5, fd0 * 1.25)).toFixed(2), step: '0.01', value: fd.toFixed(2), 'aria-label': 'Final drive',
      oninput: function (e) { fdVal.textContent = (+e.target.value).toFixed(2); }, onchange: function (e) { S.tuneFD = +e.target.value; persist(); rerender(); } });
    row(rows, 'Final drive', h('div', { class: 'dg-range' }, fdIn, fdVal, h('span', { class: 'dg-hint', text: 'stock ' + fd0.toFixed(2) + ' · higher = harder launch, lower trap' })));
    if (!single) {
      var spVal = h('b', { class: 'dg-val', text: num(S.tuneSpread, 1).toFixed(2) });
      var spIn = h('input', { type: 'range', min: '0.85', max: '1.15', step: '0.01', value: num(S.tuneSpread, 1).toFixed(2), 'aria-label': 'Gear spread',
        oninput: function (e) { spVal.textContent = (+e.target.value).toFixed(2); }, onchange: function (e) { S.tuneSpread = +e.target.value; persist(); rerender(); } });
      row(rows, 'Gear spread', h('div', { class: 'dg-range' }, spIn, spVal, h('span', { class: 'dg-hint', text: '< 1 closer ratios · > 1 shorter low gears' })));
    }
    if (me.tuned) row(rows, '', h('button', { class: 'cb-btn ghost small', type: 'button', text: 'Reset to the car’s gearing', onclick: function () { S.tuneFD = null; S.tuneSpread = 1; persist(); rerender(); } }));
    s.appendChild(rows);
    return s;
  }
  function displaySection() {
    var S = U.S, s = sec(6, 'Display & sound'), rows = h('div', { class: 'dg-rows' });
    row(rows, 'Camera', seg([{ v: 'chase', t: 'Chase' }, { v: 'low', t: 'Low chase' }, { v: 'side', t: 'Side track' }, { v: 'bumper', t: 'Bumper' }, { v: 'cockpit', t: 'Cockpit' }], S.camera, function (v) { S.camera = v; persist(); rerender(); }));
    row(rows, 'Units', seg([{ v: 'imperial', t: 'mph / ft' }, { v: 'metric', t: 'km/h' }], S.units, function (v) { S.units = v; persist(); rerender(); }));
    row(rows, 'Graphics', seg([{ v: 'auto', t: 'Auto' }, { v: 'low', t: 'Low' }, { v: 'medium', t: 'Medium' }, { v: 'high', t: 'High' }], S.quality, function (v) { S.quality = v; persist(); rerender(); }));
    row(rows, 'Sound', seg([{ v: false, t: 'On' }, { v: true, t: 'Muted' }], S.muted, function (v) { S.muted = v; persist(); rerender(); }));
    row(rows, 'Touch controls', seg([{ v: 'auto', t: 'Auto' }, { v: 'on', t: 'On' }, { v: 'off', t: 'Off' }], S.touch, function (v) { S.touch = v; persist(); rerender(); }));
    row(rows, 'FPS counter', seg([{ v: false, t: 'Off' }, { v: true, t: 'On' }], S.showFps, function (v) { S.showFps = v; persist(); rerender(); }));
    s.appendChild(rows);
    s.appendChild(h('div', { class: 'dg-keys', html: '<b>W / ↑</b> throttle · <b>S / ↓</b> brake · <b>E / Space</b> shift up · <b>Q</b> shift down · <b>N</b> nitrous · <b>C</b> camera · <b>R</b> restart · <b>Esc</b> pause · pad RT / LT, A / RB up, X / LB down · phone wheel / webcam: fist to go' }));
    return s;
  }
  function bestEt(me, S) { var T = CB.drag.timing; var b = T ? safe(function () { return T.records.best(T.records.carKey(me.build, me.key), S.distanceId); }) : null; return b && b.et != null ? b.et : null; }
  function fillSide() {
    var S = U.S, side = U.sideEl; if (!side) return; side.innerHTML = '';
    var me = X.playerCar(S), d = ST().get(S.distanceId);
    var card = h('div', { class: 'dg-sum' });
    var M = safe(function () { return CB.physics && me.build ? CB.physics.compute(me.build) : null; }) || {};
    card.appendChild(h('div', { class: 'dg-kicker', text: 'Your car' }));
    card.appendChild(h('h4', { text: me.name || 'Car' }));
    card.appendChild(h('div', { class: 'dg-stats', html:
      '<div><span>Power</span><b>' + (M.power_hp ? Math.round(M.power_hp) + ' hp' : '—') + '</b></div>' +
      '<div><span>Weight</span><b>' + (M.weight_kg ? Math.round(M.weight_kg) + ' kg' : '—') + '</b></div>' +
      '<div><span>Drive</span><b>' + esc(((me.build && me.build.drivetrain && me.build.drivetrain.layout) || '').toUpperCase() || '—') + '</b></div>' +
      '<div><span>Gearbox</span><b>' + esc(((me.build && me.build.transmission && me.build.transmission.type) || '—') + (me.build && me.build.transmission && me.build.transmission.gears ? ' ' + me.build.transmission.gears : '')) + '</b></div>' +
      '<div><span>Tyres</span><b>' + esc((me.build && me.build.tires && me.build.tires.compound) || '—') + '</b></div>' +
      '<div><span>0–100</span><b>' + (M.zeroTo100_s ? M.zeroTo100_s.toFixed(1) + ' s' : '—') + '</b></div>' }));
    var pred = h('div', { class: 'dg-pred', html: '<span>Predicted ' + esc(d.short || d.name) + '</span><b>…</b>' });
    var p60 = h('div', { class: 'dg-pred', html: '<span>60 ft estimate</span><b>…</b>' });
    card.appendChild(pred); card.appendChild(p60);
    var pb = bestEt(me, S);
    card.appendChild(h('div', { class: 'dg-pred', html: '<span>Your best</span><b>' + (pb != null ? pb.toFixed(3) + ' s' : '—') + '</b>' }));
    side.appendChild(card);
    predict(me, S, function (p) {
      if (!pred.isConnected) return;
      pred.querySelector('b').textContent = p ? p.et.toFixed(2) + ' s' + (p.trap ? ' @ ' + fmtV(p.trap, S.units) : '') : p === false ? 'n/a' : '…';
      p60.querySelector('b').textContent = p && p.sixty ? p.sixty.toFixed(2) + ' s' : p === false ? 'n/a' : '…';
      pred.title = 'Headless run: auto-shift, perfect light and launch, ' + ST().SURFACES[S.surface].name.toLowerCase();
    });
    side.appendChild(h('div', { class: 'dg-tip', html: '<b>How to launch</b><ol><li>Hold <b>brake + throttle</b> in the box for a burnout (hot tyres = grip).</li><li>Creep forward until the <b>stage</b> bulbs light.</li><li>Hold the brake and rev into the <b>green band</b>.</li><li>Release on <b>green</b> (Pro tree: anticipate the ambers).</li><li>Shift when the lights flash.</li></ol>' }));
  }
  function oppSummary(S) {
    var AI = CB.drag.ai;
    if (S.opponent === 'ladder' && AI) { var L = AI.ladder.load(), r = S.rivalId && AI.ladder.unlocked(L, S.rivalId) ? AI.ladder.get(S.rivalId) : AI.RIVALS[Math.min(AI.ladder.next(L), AI.RIVALS.length - 1)]; return r ? 'vs ' + r.name + ' (' + P.stockName(r.model) + ')' : ''; }
    if (S.opponent === 'ai') return 'vs ' + P.stockName(S.aiModel) + ' · ' + S.difficulty;
    if (S.opponent === 'tournament') return S.tSize + '-car elimination';
    if (S.opponent === 'ghost') { var g = CB.drag.timing && CB.drag.timing.decodeGhost(S.ghostCode); return g ? 'vs ghost of ' + g.name : 'paste a ghost code'; }
    return S.opponent === 'practice' ? 'practice (slow-motion tree)' : 'solo pass';
  }
  function footer() {
    var f = h('div', { class: 'dg-foot' });
    f.appendChild(h('div', { class: 'dg-foot-sum' }, h('b', { 'data-dg': 'sum1' }), h('span', { 'data-dg': 'sum2' })));
    f.appendChild(h('div', { class: 'dg-cta' },
      h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'start', html: icon('play', 16) + ' <span>Race</span>', onclick: function () { startFromSetup(); } })));
    setTimeout(updateFoot, 0);
    return f;
  }
  function updateFoot() {
    if (!U.root) return;
    var S = U.S, me = X.playerCar(S), d = ST().get(S.distanceId);
    var a = U.root.querySelector('[data-dg="sum1"]'), b = U.root.querySelector('[data-dg="sum2"]'), go = U.root.querySelector('[data-dg="start"]');
    if (a) a.textContent = (me.name || 'Car') + (me.tuned ? ' (tuned)' : '') + ' · ' + oppSummary(S);
    if (b) b.textContent = [d.name, S.venue === 'street' ? 'street · flag' : (S.treeType === 'pro' ? 'Pro tree' : 'Sportsman tree'), ST().SURFACES[S.surface].name, S.night ? 'night' : null, S.bracket ? 'bracket' : null, S.cls === 'pro-mod' ? 'Pro Mod · N2O ' + S.nitrous_hp : null, S.autoShift ? 'auto-shift' : 'manual'].filter(Boolean).join(' · ');
    var ghostBad = S.opponent === 'ghost' && !(CB.drag.timing && CB.drag.timing.decodeGhost(S.ghostCode));
    if (go) { go.disabled = !me.build || ghostBad || !CB.drag.session ? true : false; var sp = go.querySelector('span'); if (sp) sp.textContent = S.opponent === 'tournament' ? (U.tour && !U.tour.done ? 'Next heat' : 'Start tournament') : S.opponent === 'solo' ? 'Make a pass' : S.opponent === 'practice' ? 'Practice' : 'Race'; }
  }

  function offerTutorial() {
    var ov = h('div', { class: 'dg-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'First time on the strip?' });
    var card = h('div', { class: 'dg-modal-card' },
      h('div', { class: 'dg-kicker', text: 'First time on the strip?' }),
      h('h2', { text: 'Learn to drag race in two minutes' }),
      h('p', { class: 'dg-sub', text: 'A guided practice pass: burnout, staging, revs in the band, leaving on green and shifting at the top. No opponent, slow-motion tree.' }),
      h('div', { class: 'dg-actions' },
        h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'tut-go', html: icon('play', 16) + ' Start the tutorial', onclick: function () { close(); startRun({ tutorial: true }); } }),
        h('button', { class: 'cb-btn ghost big', type: 'button', 'data-dg': 'tut-skip', text: 'Skip — race now', onclick: function () { close(); markTutorial(true); startFromSetup(); } })));
    ov.appendChild(card);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    U.root.appendChild(ov);
    var b = card.querySelector('button'); if (b) b.focus();
  }

  /* ================================================================== START */
  function startFromSetup() {
    var S = U.S;
    if (!tutorialDone() && !U.offered && S.opponent !== 'practice') { U.offered = true; offerTutorial(); return; }
    if (S.opponent === 'tournament') { if (!U.tour || U.tour.done) newTournament(); showBracket(); return; }
    startRun({});
  }
  /** o: { opp (entry), ladderRival, tourMatch, seed } */
  function startRun(o) {
    o = o || {};
    teardown();
    var S = U.S, me = X.playerCar(S);
    if (!me.build) { toast('No car selected', 'warning'); return; }
    var AI = CB.drag.ai, opp = o.opp || null, ctx = { opponent: S.opponent, difficulty: S.difficulty };
    if (!opp) {
      if (S.opponent === 'ladder' && AI) {
        var L = AI.ladder.load(), r = S.rivalId && AI.ladder.unlocked(L, S.rivalId) ? AI.ladder.get(S.rivalId) : AI.RIVALS[Math.min(AI.ladder.next(L), AI.RIVALS.length - 1)];
        if (r) { opp = X.entryFor({ name: r.name, model: r.model, color: r.color, difficulty: r.difficulty }, S); ctx.rival = r; ctx.difficulty = r.difficulty; }
      } else if (S.opponent === 'ai') opp = X.entryFor({ name: 'Rival', model: S.aiModel, difficulty: S.difficulty }, S);
      else if (S.opponent === 'ghost') { var g = CB.drag.timing.decodeGhost(S.ghostCode); if (g) opp = X.entryFor({ ghost: g }, S); }
    }
    if (o.tour) { ctx.opponent = 'tournament'; ctx.tour = o.tour; ctx.difficulty = opp && opp.difficulty || S.difficulty; }
    if (o.tutorial || S.opponent === 'practice') { opp = null; ctx.opponent = o.tutorial ? 'tutorial' : 'practice'; ctx.practice = true; ctx.tutorial = !!o.tutorial; ctx.rival = null; ctx.tour = null; }
    var pr = U.predict[predictKey(me, S)];
    var dial = S.bracket ? X.dialFor(S.dial, bestEt(me, S), pr ? pr.et : null) : null;
    var oppDial = null;
    if (S.bracket && opp && opp.kind === 'ai') oppDial = predictOpp(opp, S);
    if (S.bracket && opp && opp.kind === 'ghost') oppDial = X.dialFor(null, opp.ghost.et, null);
    var seed = num(o.seed, (Date.now() & 0x7fffffff) || 1);
    var cfg = X.sessionConfig(S, me, opp, { seed: seed, dial: dial, oppDial: oppDial, playerName: profileName() });
    if (ctx.tutorial) { cfg.skipBurnout = false; cfg.venue = 'strip'; cfg.treeType = 'sportsman'; cfg.lanes[0].assists = Object.assign({}, cfg.lanes[0].assists, { autoStage: false }); }
    runPlay(cfg, ctx, me, null, o);
  }
  /** the play loop on a session (own, or a provided one: openNet) */
  function runPlay(cfg, ctx, me, session, o) {
    o = o || {};
    var S = U.S;
    U.screen = 'play'; setDriving(true);
    var root = U.root; root.innerHTML = '';
    var play = h('div', { class: 'dg-play' }), cv = h('canvas', { class: 'dg-hud' });
    var load = h('div', { class: 'dg-load', text: 'TO THE STAGING LANES…' });
    play.appendChild(cv); play.appendChild(load); root.appendChild(play);
    var R = U.R = { cfg: cfg, ctx: ctx, me: me, play: play, canvas: cv, c2d: null, session: null, renderer: null, hud: CB.drag.hud ? CB.drag.hud.create() : null, sfx: null, raf: 0, last: 0,
      paused: false, ended: false, frames: 0, fpsEma: 60, msEma: 16.7, lastSnap: null, offs: [], touch: false, tb: {}, samples: [], greenT: null, overT: null, fpsLog: [] };
    R.input = X.createInput({ onAction: onAction });
    R.coach = ctx.tutorial ? { i: 0, shifts: 0, c: {}, shown: -1 } : null;
    R.slowT = 0;
    try { R.session = session || CB.drag.session.create(cfg); } catch (e) { load.textContent = 'Could not start: ' + (e && e.message); console.error(e); return; }
    R.net = o.net || null;
    R.sfx = CB.drag.sfx ? CB.drag.sfx.create({ muted: S.muted }) : null;
    if (R.sfx) R.sfx.start();
    bindInput(R);
    setTimeout(function () {
      if (U.R !== R) return;
      var DR = CB.drag.renderer;
      if (DR && typeof DR.create === 'function' && (!DR.isSupported || DR.isSupported()) && !o.force2d) {
        R.renderer = safe(function () { return DR.create(cv, R.session, { quality: quality(), camera: S.camera, night: !!cfg.night, venue: cfg.venue, distance: cfg.distanceId, seed: cfg.seed }); });
      }
      R.c2d = cv.getContext('2d');
      if (load.parentNode) load.parentNode.removeChild(load);
      R.touch = touchOn();
      if (R.touch) buildTouch(R);
      if (R.coach || ctx.practice) buildCoach(R);
      R.last = 0; R.raf = requestAnimationFrame(frame);
    }, 30);
  }
  function profileName() { var Pf = CB.game && CB.game.profile; var p = Pf && Pf.get ? safe(function () { return Pf.get(); }) : null; var n = p && (p.name || p.driverName); return n && n !== 'Driver' ? n : 'You'; }
  function predictOpp(opp, S) {
    var res = safe(function () {
      return CB.drag.session.simulate({ seed: 9, distanceId: S.distanceId, venue: 'strip', surface: S.surface, treeType: 'pro', skipBurnout: true, class: S.cls,
        lanes: [{ kind: 'ai', name: opp.name, build: opp.build, difficulty: 'alien', assists: { autoShift: true, autoStage: true } }, { kind: 'none' }] });
    });
    var l = res && res.lanes && res.lanes[0];
    return l && l.et != null ? X.dialFor(null, null, l.et + 0.08) : null;
  }
  function quality() {
    var q = U.S.quality;
    if (q === 'auto') q = CB.device && typeof CB.device.resolveQuality === 'function' ? safe(function () { return CB.device.resolveQuality('auto'); }) || 'high' : 'high';
    return ['low', 'medium', 'high', 'ultra'].indexOf(q) >= 0 ? q : 'high';
  }
  function coarse() { try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } }
  function touchOn() { return U.S.touch === 'on' || (U.S.touch === 'auto' && coarse()); }
  function safeInsets() {
    var p = document.createElement('div');
    p.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(p);
    var cs = getComputedStyle(p), o = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    p.parentNode.removeChild(p);
    return o;
  }

  /* ================================================================== input binding */
  function bindInput(R) {
    function kd(e) {
      if (U.R !== R || U.screen !== 'play') return;
      if (R.paused) { if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); resume(); } return; }
      if (R.input.handleKey(e.code, true, e.repeat)) e.preventDefault();
    }
    function ku(e) { if (U.R !== R) return; if (R.input.handleKey(e.code, false, false)) e.preventDefault(); }
    function blur() { R.input.clear(); }
    function vis() { if (document.hidden && U.R === R && !R.paused && !R.ended) pause(); }
    function rs() { if (R.renderer && R.renderer.resize) safe(function () { R.renderer.resize(); }); if (R.touchEl) layoutTouch(R); R.safe = null; }
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', vis); window.addEventListener('resize', rs);
    R.offs.push(function () { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', vis); window.removeEventListener('resize', rs); });
    var hub = CB.input && CB.input.hub;
    if (hub && typeof hub.onEvent === 'function') { var off = safe(function () { return hub.onEvent(function (e) { if (U.R === R && e) R.input.phoneEvent(e.type); }); }); if (typeof off === 'function') R.offs.push(off); }
  }
  function onAction(a) {
    var R = U.R; if (!R) return;
    if (a === 'pause') { if (R.ended) return; if (R.paused) resume(); else pause(); }
    else if (a === 'camera') { if (R.renderer && R.renderer.cycleCamera) { var m = R.renderer.cycleCamera(); if (typeof m === 'string') { U.S.camera = m; persist(); } } }
    else if (a === 'mute') { U.S.muted = !U.S.muted; persist(); if (R.sfx) R.sfx.setMuted(U.S.muted); }
    else if (a === 'restart') { if (!R.ended && !R.net) startRun(R.ctx.tour ? { opp: R.cfg.lanes[1], tour: R.ctx.tour } : R.ctx.tutorial ? { tutorial: true } : {}); }
    else if (a === 'confirm') {
      var sn = R.lastSnap;
      if (sn && (sn.phase === 'done' || sn.phase === 'shutdown') && sn.lanes[sn.playerLane || 0].finished) finish();
      else if (sn && sn.phase === 'burnout' && R.session.skipBurnout) safe(function () { R.session.skipBurnout(); });
    }
  }

  /* ================================================================== touch controls */
  function buildTouch(R) {
    var T = R.input.touch; T.active = true;
    var el = h('div', { class: 'dg-touch' });
    function btn(cls, label) { var b = h('div', { class: 'dg-t ' + cls, role: 'button', 'aria-label': label.replace(/<[^>]+>/g, '') || cls }); b.innerHTML = label; el.appendChild(b); return b; }
    function pedal(cls, label, key) {
      var b = btn(cls, '<span class="fill"></span><span class="lb">' + label + '</span>'), fill = b.querySelector('.fill'), id = null;
      function at(e) { var r = b.getBoundingClientRect(); var v = clamp(0.35 + 0.65 * (1 - (e.clientY - r.top) / r.height) * 1.25, 0.25, 1); T[key] = v; fill.style.height = Math.round(v * 100) + '%'; }
      b.addEventListener('pointerdown', function (e) { id = e.pointerId; try { b.setPointerCapture(id); } catch (x) { /* ignore */ } b.classList.add('is-down'); at(e); e.preventDefault(); if (R.sfx) R.sfx.start(); });
      b.addEventListener('pointermove', function (e) { if (e.pointerId === id) at(e); });
      function end(e) { if (e.pointerId !== id) return; id = null; T[key] = 0; fill.style.height = '0'; b.classList.remove('is-down'); }
      b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
      return b;
    }
    function tap(cls, label, fn, up) {
      var b = btn(cls, label);
      b.addEventListener('pointerdown', function (e) { b.classList.add('is-down'); try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } fn(); e.preventDefault(); });
      function end() { b.classList.remove('is-down'); if (up) up(); }
      b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
      return b;
    }
    R.tb.throttle = pedal('pedal thr', 'THROTTLE', 'throttle');
    R.tb.brake = pedal('pedal brk', 'BRAKE', 'brake');
    R.tb.up = tap('shift up', '▲<small>SHIFT</small>', function () { R.input.up++; });
    R.tb.down = tap('shift down', '▼', function () { R.input.down++; });
    R.tb.n2o = tap('n2o', 'N2O', function () { T.n2o = true; }, function () { T.n2o = false; });
    R.tb.pause = tap('sq', icon('pause', 18), function () { onAction('pause'); });
    R.tb.camera = tap('sq', icon('cam', 18), function () { onAction('camera'); });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    R.play.appendChild(el); R.touchEl = el;
    layoutTouch(R);
  }
  function layoutTouch(R) {
    var L = CB.drag.hud.touchLayout(window.innerWidth, window.innerHeight, R.safe || (R.safe = safeInsets()));
    R.touchLayout = L;
    Object.keys(R.tb).forEach(function (k) { var r = L[k], b = R.tb[k]; if (!r || !b) return; b.style.left = r.x + 'px'; b.style.top = r.y + 'px'; b.style.width = r.w + 'px'; b.style.height = r.h + 'px'; });
  }
  function updateTouch(R, me) {
    if (!R.touchEl || !me) return;
    var n = R.tb.n2o; if (n) n.style.display = me.nitrous && me.nitrous.shot_hp > 0 ? '' : 'none';
    var sh = !me.autoShift; if (R.tb.up) R.tb.up.style.display = sh ? '' : 'none'; if (R.tb.down) R.tb.down.style.display = sh ? '' : 'none';
    if (R.tb.up && me.shiftLight) R.tb.up.classList.toggle('is-flash', !!me.shiftLight.flash);
  }

  /* ================================================================== frame loop */
  function frame(ts) {
    var R = U.R; if (!R || U.screen !== 'play') return;
    R.raf = requestAnimationFrame(frame);
    var dt = R.last ? clamp((ts - R.last) / 1000, 0, 0.1) : 1 / 60; R.last = ts;
    R.msEma += (dt * 1000 - R.msEma) * 0.05; R.fpsEma = 1000 / Math.max(1, R.msEma); R.frames++;
    if (R.paused && !R.net) { draw(R, R.lastSnap); return; }
    var prev = R.lastSnap, pl = R.cfg.playerLane || 0;
    var inp = R.input.sample(dt, prev ? prev.lanes[pl] : null, prev ? prev.phase : null);
    // time scale: the practice tree runs in slow motion; the finish line gets a short slow-mo moment
    var scale = 1;
    if (R.ctx.practice && prev && prev.phase === 'tree') scale = 0.45;
    if (R.slowT > 0) { R.slowT -= dt; scale = Math.min(scale, 0.3); }
    var frozen = R.coach && X.coachStep(R.coach.i).id === 'intro';
    if (!frozen) R.session.update(dt * scale, inp);
    var snap = R.session.snapshot();
    if (!snap || snap.waiting || !snap.lanes || !snap.lanes.length) { drawWaiting(R); return; }
    if (snap.playerLane != null) { pl = snap.playerLane; R.cfg.playerLane = pl; }
    R.lastSnap = snap;
    var me = snap.lanes[pl];
    if (R.net && !R.me.build && me && me.build) { R.me.build = me.build; R.me.name = me.carName || R.me.name; }
    // ghost trace samples (10 Hz from the green, for the share code)
    var gT = snap.tree && snap.tree.greenT ? snap.tree.greenT[pl] : null;
    if (gT != null && R.greenT == null) R.greenT = gT;
    if (R.greenT != null && me && (!R.samples.length || R.samples[R.samples.length - 1].t < snap.t) && !(me.finished && snap.t - num(me.finishT, snap.t) > 1)) R.samples.push({ t: snap.t, x: num(me.xFront, 0) });
    (snap.events || []).forEach(function (e) {
      if (!e) return;
      if (e.type === 'win' && !R.net) R.slowT = Math.max(R.slowT, 1.2);
      if (e.lane !== pl) return;
      if (e.type === 'launch' || e.type === 'shift' && e.grade === 'late' || e.type === 'red') rumble(R, e.type === 'launch' ? 0.7 : 0.35);
      if (e.type === 'finish' && !R.net) R.slowT = Math.max(R.slowT, 1.3);
      if (e.type === 'shift' && R.coach) R.coach.shifts++;
      if (R.coachEl && !R.coach) { if (e.type === 'bog') coachTip(R, 'Bogged — rev higher before you let go.'); else if (e.type === 'wheelspin') coachTip(R, 'Wheelspin — fewer revs, or a longer burnout.'); }
    });
    if (R.coach) {
      R.coach.c.dt = dt;
      var ni = X.coachNext(R.coach.i, me, snap, inp, Object.assign(R.coach.c, { shifts: R.coach.shifts }));
      if (ni !== R.coach.i) R.coach.i = Math.min(ni, X.COACH.length - 1);
      if (me && me.red && !R.coach.red) { R.coach.red = true; coachRed(R, me); }
      else if (R.coach.shown !== R.coach.i && !R.coach.red) updateCoach(R);
      if (R.coachEl) R.coachEl.classList.toggle('is-low', snap.phase === 'run' || snap.phase === 'shutdown');
    }
    if (R.sfx) R.sfx.frame(snap, dt);
    draw(R, snap);
    if (R.frames % 6 === 0) updateTouch(R, me);
    if (R.frames % 30 === 0) R.fpsLog.push(Math.round(R.fpsEma));
    var hubF = CB.input && CB.input.hub;
    if (hubF && typeof hubF.frame === 'function') safe(function () { hubF.frame({ screen: 'drag', driving: true, paused: false, speed: num(me && me.speed, 0), gear: me ? me.gear : 1, rpmFrac: me ? num(me.rpm, 0) / num(me.redline, 7000) : 0, surface: 'asphalt', events: [] }); });
    var done = snap.phase === 'done' || (me && me.finished && snap.phase === 'shutdown' && R.overT == null && false);
    if (done) { if (R.overT == null) R.overT = snap.t; if (snap.t - R.overT > 0.6 || R.frames % 1 === 0 && snap.t - R.overT > 0.6) finish(); }
    else if (me && (me.red || me.dq) && snap.phase !== 'run' && snap.phase !== 'shutdown' && !R.coach) { if (R.overT == null) R.overT = snap.t; if (snap.t - R.overT > 2.5) finish(); }
  }
  function drawWaiting(R) {
    var cv = R.canvas, w = cv.clientWidth || window.innerWidth, hh = cv.clientHeight || window.innerHeight, dpr = Math.min(2, window.devicePixelRatio || 1), c = R.c2d;
    if (!c) return;
    if (!R.renderer) { if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); } c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#0b0b0d'; c.fillRect(0, 0, w, hh); }
    else { c.setTransform(cv.width / Math.max(1, w), 0, 0, cv.width / Math.max(1, w), 0, 0); c.clearRect(0, 0, w, hh); c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(0, 0, w, hh); }
    c.fillStyle = '#fff'; c.font = '800 20px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('Waiting for the host…', w / 2, hh / 2);
  }
  /* ================================================================== coach overlay (tutorial / practice tips) */
  function keysFor(R) { return view(R).keys; }
  function fillKeys(str, k) { return String(str || '').replace(/\{(thr|brk|up|down)\}/g, function (m, n) { return '<kbd>' + esc(k[n]) + '</kbd>'; }); }
  function buildCoach(R) {
    var el = h('div', { class: 'dg-coach' + (R.coach ? '' : ' is-tip'), role: 'status', 'aria-live': 'polite' });
    el.innerHTML = '<div class="dg-coach-k"></div><div class="dg-coach-t"></div><div class="dg-coach-b"></div><div class="dg-coach-h"></div><div class="dg-coach-a"></div>';
    R.play.appendChild(el); R.coachEl = el;
    if (!R.coach) { el.hidden = true; return; }
    var acts = el.querySelector('.dg-coach-a');
    acts.appendChild(h('button', { type: 'button', class: 'cb-btn ghost small', text: 'Skip tutorial', onclick: function () { markTutorial(true); R.coach = null; el.hidden = true; } }));
    updateCoach(R);
  }
  function updateCoach(R) {
    var el = R.coachEl, C = R.coach; if (!el || !C) return;
    C.shown = C.i;
    var st = X.coachStep(C.i), k = keysFor(R), n = X.COACH.length - 1;
    el.hidden = false; el.classList.remove('is-bad'); el.classList.add('is-in');
    setTimeout(function () { if (el) el.classList.remove('is-in'); }, 400);
    el.querySelector('.dg-coach-k').textContent = st.id === 'done' ? 'Tutorial complete' : 'How to drag race · step ' + Math.min(C.i + 1, n) + ' of ' + n;
    el.querySelector('.dg-coach-t').textContent = st.title;
    el.querySelector('.dg-coach-b').innerHTML = fillKeys(esc(st.body).replace(/\{(\w+)\}/g, '{$1}'), k);
    el.querySelector('.dg-coach-h').innerHTML = st.hint ? fillKeys(st.hint, k) : '';
    if (st.id === 'intro' && R.touch) el.querySelector('.dg-coach-h').innerHTML = 'Press <kbd>BRAKE</kbd> to begin';
  }
  function coachRed(R, me) {
    var el = R.coachEl; if (!el) return;
    el.hidden = false; el.classList.add('is-bad');
    el.querySelector('.dg-coach-k').textContent = 'Red light';
    el.querySelector('.dg-coach-t').textContent = 'Too early!';
    el.querySelector('.dg-coach-b').textContent = (me.rt != null && me.rt < 0 ? 'You left ' + Math.abs(me.rt).toFixed(3) + ' s before the green. ' : '') + 'Wait for the green bulb — the ambers only warn you it is coming.';
    var a = el.querySelector('.dg-coach-a'); a.innerHTML = '';
    a.appendChild(h('button', { type: 'button', class: 'cb-btn primary small', text: 'Try again', onclick: function () { startRun({ tutorial: true }); } }));
    a.appendChild(h('button', { type: 'button', class: 'cb-btn ghost small', text: 'Skip tutorial', onclick: function () { markTutorial(true); finish(); } }));
    el.querySelector('.dg-coach-h').innerHTML = 'or press <kbd>R</kbd>';
  }
  function coachTip(R, text) {
    var el = R.coachEl; if (!el) return;
    el.hidden = false; el.classList.add('is-tip');
    el.querySelector('.dg-coach-k').textContent = 'Coach'; el.querySelector('.dg-coach-t').textContent = text;
    el.querySelector('.dg-coach-b').textContent = ''; el.querySelector('.dg-coach-h').textContent = '';
    clearTimeout(R.tipTimer); R.tipTimer = setTimeout(function () { if (R.coachEl) R.coachEl.hidden = true; }, 2600);
  }
  var TUT_KEY = 'forge.drag.tutorial.v1';
  function tutorialDone() { try { var v = JSON.parse((window.localStorage && window.localStorage.getItem(TUT_KEY)) || 'null'); return !!(v && v.done); } catch (e) { return false; } }
  function markTutorial(skipped) { try { window.localStorage.setItem(TUT_KEY, JSON.stringify({ done: true, skipped: !!skipped, at: Date.now() })); } catch (e) { /* blocked */ } }
  function rumble(R, k) {
    var gp = R.input.gp.active && navigator.getGamepads ? safe(function () { var ps = navigator.getGamepads(); for (var i = 0; i < ps.length; i++) if (ps[i]) return ps[i]; return null; }) : null;
    var va = gp && gp.vibrationActuator;
    if (va && typeof va.playEffect === 'function') safe(function () { va.playEffect('dual-rumble', { duration: Math.round(80 + 160 * k), strongMagnitude: clamp(k, 0, 1), weakMagnitude: clamp(k * 0.7, 0, 1) }); });
    if (R.touch && navigator.vibrate) safe(function () { navigator.vibrate(Math.round(20 + 40 * k)); });
  }
  function view(R) {
    var w = R.canvas.clientWidth || window.innerWidth, hh = R.canvas.clientHeight || window.innerHeight;
    var dev = R.input.lastDevice;
    var cam = R.renderer && R.renderer.getCamera ? safe(function () { return R.renderer.getCamera(); }) : null, hl = R.coach && !R.coach.red ? X.coachStep(R.coach.i).hl : null;
    return { width: w, height: hh, compact: hh < 520 || w < 700, touch: R.touch, safe: R.safe || (R.safe = safeInsets()), units: U.S.units, fps: U.S.showFps ? R.fpsEma : 0,
      cockpit: cam === 'cockpit', highlight: hl, showTree: !!R.coach || !!R.ctx.practice, noPrompt: !!(R.coach && !R.coach.red && X.coachStep(R.coach.i).id !== 'done'),
      keys: R.touch ? { thr: 'THROTTLE', brk: 'BRAKE', up: '▲', down: '▼' } : dev === 'gamepad' ? { thr: 'RT', brk: 'LT', up: 'A', down: 'X' } : dev === 'hub' ? { thr: 'FIST', brk: 'OPEN HAND', up: 'SHIFT', down: 'SHIFT −' } : { thr: 'W', brk: 'S', up: 'E', down: 'Q' } };
  }
  function draw(R, snap) {
    if (!snap) return;
    var cv = R.canvas, v = view(R), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (R.renderer) safe(function () { R.renderer.render(snap, 1); });
    var c = R.c2d; if (!c) return;
    if (!R.renderer) {
      var W = Math.round(v.width * dpr), H = Math.round(v.height * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw2D(R, c, snap, v);
    } else {
      // the renderer sizes the (transparent) HUD canvas; draw in CSS px
      var sx = cv.width / Math.max(1, v.width);
      c.setTransform(sx, 0, 0, sx, 0, 0);
    }
    if (R.hud) safe(function () { R.hud.draw(c, snap, v); });
  }
  /** 2D fallback: a top-down strip that follows the player */
  function draw2D(R, c, snap, v) {
    var W = v.width, H = v.height, pl = snap.playerLane || 0, me = snap.lanes[pl];
    c.fillStyle = '#1f2a1a'; c.fillRect(0, 0, W, H);
    var sc = clamp(Math.min(W / 60, H / 22), 6, 22), cx = W * 0.35, cy = H / 2, x0 = num(me.x, 0), G = ST().GEO;
    function X(x) { return cx + (x - x0) * sc; } function Y(y) { return cy - y * sc; }
    c.fillStyle = '#2b2d31'; c.fillRect(0, Y(G.WALL_Y), W, (2 * G.WALL_Y) * sc);
    c.fillStyle = '#3a3c40'; c.fillRect(X(G.BURNOUT_X0), Y(G.WALL_Y), (G.BURNOUT_X1 - G.BURNOUT_X0) * sc, 2 * G.WALL_Y * sc);
    c.strokeStyle = '#e8d33a'; c.setLineDash([sc * 2, sc * 2]); c.lineWidth = 2; c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(W, Y(0)); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#ddd'; c.fillRect(X(0) - 1, Y(G.WALL_Y), 3, 2 * G.WALL_Y * sc);
    var d = snap.distance || {}; if (d.m) { c.fillStyle = '#fff'; for (var k = 0; k < 8; k++) { c.fillStyle = k % 2 ? '#111' : '#fff'; c.fillRect(X(d.m), Y(G.WALL_Y) + k * (2 * G.WALL_Y * sc / 8), sc * 0.8, 2 * G.WALL_Y * sc / 8); } }
    for (var m = Math.floor((x0 - 40) / 20) * 20; m < x0 + 80; m += 20) { c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(X(m), Y(G.WALL_Y), 1, 2 * G.WALL_Y * sc); }
    snap.lanes.forEach(function (l) {
      if (!l || l.kind === 'none') return;
      c.save(); c.translate(X(l.x), Y(l.y)); c.rotate(-num(l.heading, 0));
      if (l.smoke > 0.05) { c.fillStyle = 'rgba(230,230,230,' + (0.35 * l.smoke).toFixed(2) + ')'; c.beginPath(); c.arc(-2.6 * sc, 0, (1.5 + l.smoke * 2) * sc, 0, Math.PI * 2); c.fill(); }
      c.fillStyle = l.color || '#c33'; c.fillRect(-2.3 * sc, -0.95 * sc, 4.6 * sc, 1.9 * sc);
      c.fillStyle = 'rgba(15,20,28,.8)'; c.fillRect(-0.6 * sc, -0.75 * sc, 1.6 * sc, 1.5 * sc);
      c.restore();
    });
  }

  /* ================================================================== pause */
  function pause() {
    var R = U.R; if (!R || R.paused || R.ended) return;
    R.paused = true; R.input.clear();
    var S = U.S;
    var ov = h('div', { class: 'dg-ovl' }), m = h('div', { class: 'dg-menu', role: 'dialog', 'aria-label': 'Paused' },
      h('h2', { text: 'Paused' }),
      h('button', { class: 'cb-btn primary', type: 'button', text: 'Resume', onclick: resume }),
      R.net ? null : h('button', { class: 'cb-btn ghost', type: 'button', text: 'Restart run', onclick: function () { onAction('restart'); } }),
      R.renderer && R.renderer.cycleCamera ? h('button', { class: 'cb-btn ghost', type: 'button', text: 'Camera', onclick: function () { onAction('camera'); } }) : null,
      h('button', { class: 'cb-btn ghost', type: 'button', text: 'Sound: ' + (S.muted ? 'off' : 'on'), onclick: function (e) { onAction('mute'); e.target.textContent = 'Sound: ' + (S.muted ? 'off' : 'on'); } }),
      (CB.input && CB.input.sources && CB.input.sources.menuItems) ? null : null,
      R.net ? h('button', { class: 'cb-btn ghost', type: 'button', text: 'Leave race', onclick: function () { var nt = R.net; teardown(); U.screen = null; safe(function () { if (nt.onClose) nt.onClose(null); }); } })
        : h('button', { class: 'cb-btn ghost', type: 'button', text: 'Quit to setup', onclick: function () { showSetup(); } }),
      h('button', { class: 'cb-btn ghost', type: 'button', text: 'Main menu', onclick: function () { var r = router(); if (r) r.go('menu'); } }));
    ov.appendChild(m); R.play.appendChild(ov); R.pauseEl = ov;
    var first = m.querySelector('button'); if (first) first.focus();
  }
  function resume() { var R = U.R; if (!R || !R.paused) return; R.paused = false; R.last = 0; if (R.pauseEl && R.pauseEl.parentNode) R.pauseEl.parentNode.removeChild(R.pauseEl); R.pauseEl = null; }

  /* ================================================================== finish / results */
  function finish() {
    var R = U.R; if (!R || R.ended) return;
    R.ended = true;
    var res = safe(function () { return R.session.results(); });
    if (!res) { showSetup(); return; }
    var pl = R.cfg.playerLane || 0, meR = res.lanes[pl], ctx = R.ctx;
    var did = X.distId(res) || U.S.distanceId;
    res.distanceName = res.distanceName || (ST().get(did) || {}).name || '';
    var T = CB.drag.timing, extra = { lane: pl, opponent: ctx.opponent, difficulty: ctx.difficulty };
    // ghost of this run
    var gr = R.session.ghostRun ? safe(function () { return R.session.ghostRun(pl); }) : null;
    var trace = gr && gr.trace && gr.trace.length > 1 ? gr.trace : X.ghostTrace(R.samples, R.greenT);
    if (!meR.red && meR.et != null && trace.length > 1 && T) R.ghostCode = safe(function () { return T.encodeGhost(Object.assign({ name: profileName(), carName: R.me.name, modelId: R.me.modelId, color: P.paintOf(R.me.build), distanceId: did, rt: meR.rt, et: meR.et, trap: meR.trap }, gr || {}, { name: profileName(), trace: trace })); });
    res.ghostCode = R.ghostCode || null;
    // personal best
    var key = T ? T.records.carKey(R.me.build, R.me.key) : null, rec = null;
    if (T && key && R.ctx.opponent !== 'net') rec = safe(function () { return T.records.submit(key, did, Object.assign({}, meR, { carName: R.me.name })); });
    extra.pb = !!(rec && rec.pb && rec.prev);
    res.pb = rec;
    // ladder / tournament progress
    var AI = CB.drag.ai;
    if (ctx.rival && meR.won && AI) {
      var before = AI.ladder.load().beaten.indexOf(ctx.rival.id) >= 0;
      var L = AI.ladder.beat(ctx.rival.id);
      extra.ladderFirst = !before; extra.ladderIndex = AI.RIVALS.findIndex(function (r) { return r.id === ctx.rival.id; });
      extra.ladderChampion = AI.ladder.next(L) >= AI.RIVALS.length;
      res.ladder = { rival: ctx.rival, first: !before, champion: extra.ladderChampion, next: AI.ladder.next(L) < AI.RIVALS.length ? AI.RIVALS[AI.ladder.next(L)] : null };
    }
    if (ctx.tour && U.tour) {
      var tp = ctx.tour, side = U.tour.t.entrants[tp.a].isPlayer ? 0 : 1, won = !!meR.won;
      AI.tournament.record(U.tour.t, tp.round, tp.match, won ? side : 1 - side, (fmtET(meR.et)) + ' vs ' + fmtET((res.lanes[1] || {}).et));
      simAiHeats();
      var champ = AI.tournament.champion(U.tour.t);
      if (champ) { U.tour.done = true; extra.tournamentWon = !!champ.isPlayer; }
      else if (AI.tournament.playerOut(U.tour.t)) { finishTournamentAi(); U.tour.done = true; }
      res.tournament = { won: !!extra.tournamentWon, out: AI.tournament.playerOut(U.tour.t), done: !!U.tour.done };
    }
    res.playerLane = pl;
    if (ctx.tutorial && !meR.red) { markTutorial(false); res.tutorial = true; }
    res.tips = X.tipsFor(meR);
    res.payout = R.net ? null : X.payout(res, extra);
    if (!R.net) report(res, extra);
    var net = R.net;
    teardown();
    if (net) res.net = true;
    showResults(res, net);
  }
  function report(res, extra) {
    var Pf = CB.game && CB.game.profile, me = res.lanes[extra.lane] || {};
    if (Pf && typeof Pf.incStat === 'function') safe(function () {
      Pf.incStat('drag_runs', 1);
      if (me.won && X.isVs(extra.opponent)) Pf.incStat('drag_wins', 1);
      if (!me.red && me.et != null && X.distId(res) === 'quarter') Pf.recordStat('drag_best_quarter_s', Math.round(me.et * 1000) / 1000, 'min');
      if (me.trap) Pf.recordStat('drag_best_trap_mph', Math.round(me.trap * MPH * 10) / 10, 'max');
      if (me.rt != null && me.rt >= 0) Pf.recordStat('drag_best_rt_s', Math.round(me.rt * 1000) / 1000, 'min');
      if (me.red) Pf.incStat('drag_red_lights', 1);
    });
    if (res.payout && res.payout.total > 0 && Pf && typeof Pf.addCredits === 'function') safe(function () { Pf.addCredits(res.payout.total, 'Drag Racing — ' + (res.distanceName || 'pass'), 'drag'); res.payout.credited = true; });
    var A = CB.game && CB.game.achievements;
    if (A && typeof A.check === 'function') safe(function () {
      A.check(null, X.achievementEvent(res, extra));
      var pr = Pf && Pf.get ? Pf.get() : null; if (pr && pr.stats) A.check(null, { type: 'stat', stats: pr.stats });
    });
    safe(function () { document.dispatchEvent(new CustomEvent('cb:drag-finished', { detail: { results: res } })); });
  }
  function slipFor(res) {
    var T = CB.drag.timing, def = ST().get(X.distId(res) || U.S.distanceId);
    // the slip prints trap speeds under splits that carry their distance (m)
    (res.lanes || []).forEach(function (l) { (l.splits || []).forEach(function (sp) { if (sp.m == null) { var d = def.splits.filter(function (x) { return x.id === sp.id; })[0]; if (d && d.m != null) sp.m = d.m; } }); });
    return T ? safe(function () { return T.slipText(res, null, { units: U.S.units, date: new Date().toLocaleDateString(), title: U.S.venue === 'street' ? 'REDLINE STREET NIGHTS' : 'REDLINE DRAGWAY' }); }) || '' : ''; }
  function showResults(res, net) {
    U.screen = 'results'; U.lastResults = res; setDriving(false);
    var root = U.root; root.innerHTML = '';
    var S = U.S, pl = res.playerLane || 0, me = res.lanes[pl] || {}, op = res.lanes[1 - pl] && res.lanes[1 - pl].kind !== 'none' ? res.lanes[1 - pl] : null;
    var title = me.red ? 'Red light' : me.dq ? 'Disqualified' : !op ? 'Pass complete' : me.won ? (res.holeshot ? 'Holeshot win!' : 'Win light!') : me.breakout ? 'Broke out' : 'Beaten';
    var wrap = h('div', { class: 'dg-res' });
    var units = S.units;
    wrap.appendChild(h('div', { class: 'dg-kicker', text: 'Timeslip · ' + (res.distanceName || '') + (res.bracket ? ' · bracket' : '') + (op ? ' · vs ' + op.name : '') }));
    wrap.appendChild(h('h1', { class: me.won || !op && !me.red ? 'win' : '', text: title }));
    var sub = [];
    if (me.et != null) sub.push('ET ' + fmtET(me.et) + ' s' + (me.trap ? ' @ ' + fmtV(me.trap, units) : ''));
    if (op && res.margin_s != null && isFinite(res.margin_s)) sub.push('margin ' + Math.abs(res.margin_s).toFixed(3) + ' s');
    if (res.pb && res.pb.pb && res.pb.prev) sub.push('NEW PERSONAL BEST (was ' + fmtET(res.pb.prev.et) + ')');
    else if (res.pb && res.pb.pb) sub.push('first timed pass in this car');
    wrap.appendChild(h('div', { class: 'dg-sub', text: sub.join(' · ') }));
    var grid = h('div', { class: 'dg-res-grid' });
    var slip = h('pre', { class: 'dg-slip', 'aria-label': 'Timeslip', text: slipFor(res) });
    grid.appendChild(h('div', { class: 'dg-printer' }, h('div', { class: 'dg-printer-slot' }), h('div', { class: 'dg-slip-wrap' }, slip)));
    var info = h('div', { class: 'dg-res-info' });
    var sh = me.shifts || {};
    var hl = [];
    if (me.rt != null) hl.push('Reaction <b>' + (me.red ? 'RED ' : '') + fmtET(me.rt) + '</b>');
    var s60 = (me.splits || []).filter(function (s) { return s.id === 'ft60'; })[0]; if (s60 && s60.t != null) hl.push('60 ft <b>' + fmtET(s60.t) + '</b>');
    if (me.launch && me.launch.rpm) hl.push('Launch <b>' + Math.round(me.launch.rpm) + ' rpm</b>' + (me.launch.hi > me.launch.lo ? (me.launch.rpm >= me.launch.lo && me.launch.rpm <= me.launch.hi ? ' · in the band' : ' · band ' + Math.round(me.launch.lo) + '–' + Math.round(me.launch.hi)) : ''));
    if (me.burnout && me.burnout.temp) hl.push('Tyres <b>' + Math.round(me.burnout.temp) + ' °C</b>' + (me.burnout.bonus ? ' (' + (me.burnout.bonus > 0 ? '+' : '') + Math.round(me.burnout.bonus * 100) + '% grip)' : ''));
    var tot = num(sh.perfect, 0) + num(sh.good, 0) + num(sh.early, 0) + num(sh.late, 0);
    if (tot) hl.push('Shifts <b>' + num(sh.perfect, 0) + ' perfect · ' + num(sh.good, 0) + ' good · ' + num(sh.early, 0) + ' early · ' + num(sh.late, 0) + ' late</b>');
    if (res.bracket) hl.push('Dial <b>' + fmtET(me.dial) + '</b>' + (me.breakout ? ' · broke out' : ''));
    info.appendChild(h('div', { class: 'dg-hl', html: hl.map(function (x) { return '<span>' + x + '</span>'; }).join('') }));
    if (res.payout) info.appendChild(h('div', { class: 'dg-pay', html: '<div class="dg-kicker">Payout</div>' + res.payout.items.map(function (i) { return '<div><span>' + esc(i.label) + '</span><b>+' + i.n + '</b></div>'; }).join('') + '<div class="tot"><span>Total</span><b>+' + res.payout.total + ' cr</b></div>' }));
    if (res.tutorial) info.appendChild(h('div', { class: 'dg-note', html: '<b>Tutorial complete!</b> You know the routine: burnout, stage, revs in the band, go on green, shift at the top. Time to race a rival.' }));
    if (res.tips && res.tips.length) info.appendChild(h('div', { class: 'dg-tips', html: '<div class="dg-kicker">Coach’s notes</div>' + res.tips.map(function (t) { return '<div class="' + t.kind + '">' + esc(t.text) + '</div>'; }).join('') }));
    if (res.ladder) info.appendChild(h('div', { class: 'dg-note', html: res.ladder.champion ? '<b>King of the Strip!</b> Every rival on the ladder is beaten.' : res.ladder.first ? '<b>' + esc(res.ladder.rival.name) + '</b> is beaten. ' + (res.ladder.next ? 'Next up: <b>' + esc(res.ladder.next.name) + '</b>.' : '') : 'Rival beaten again.' }));
    if (res.tournament) info.appendChild(h('div', { class: 'dg-note', html: res.tournament.won ? '<b>Tournament champion!</b>' : res.tournament.out ? 'Eliminated from the tournament.' : 'Through to the next round.' }));
    grid.appendChild(info);
    wrap.appendChild(grid);
    var AI = CB.drag.ai;
    var acts = h('div', { class: 'dg-actions' });
    if (res.tutorial) acts.appendChild(h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'again', html: icon('next', 16) + ' Race a rival', onclick: function () { S.opponent = 'ladder'; persist(); startRun({}); } }));
    if (res.tutorial) { /* the CTA above */ } else if (net) acts.appendChild(h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'again', html: icon('back', 16) + ' Back to lobby', onclick: function () { if (net.onClose) safe(function () { net.onClose(res); }); else if (net.onBack) safe(net.onBack); else { var rt = router(); if (rt) rt.go('multiplayer'); } } }));
    else if (res.tournament && !res.tournament.done) acts.appendChild(h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'again', html: icon('trophy', 16) + ' Bracket & next heat', onclick: showBracket }));
    else if (res.tournament) acts.appendChild(h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'again', html: icon('trophy', 16) + ' Final bracket', onclick: showBracket }));
    else if (res.ladder && res.ladder.next && me.won) acts.appendChild(h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'again', html: icon('next', 16) + ' Next rival', onclick: function () { S.rivalId = res.ladder.next.id; persist(); startRun({}); } }));
    else acts.appendChild(h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'again', html: icon('play', 16) + ' Run again', onclick: function () { startRun({}); } }));
    if (!net && (res.ladder || S.opponent === 'ladder')) acts.appendChild(h('button', { class: 'cb-btn ghost big', type: 'button', text: 'Rematch', onclick: function () { startRun({}); } }));
    acts.appendChild(h('button', { class: 'cb-btn ghost big', type: 'button', html: icon('copy', 15) + ' Copy slip', onclick: function () { copyText(slipFor(res), 'Timeslip copied'); } }));
    acts.appendChild(h('button', { class: 'cb-btn ghost big', type: 'button', html: icon('dl', 15) + ' Slip image', onclick: function () { downloadSlip(slipFor(res), me.won); } }));
    if (U.R == null && U.lastGhost !== undefined) { /* noop */ }
    var gcode = res.ghostCode || (U.lastRun && U.lastRun.ghostCode);
    if (gcode) acts.appendChild(h('button', { class: 'cb-btn ghost big', type: 'button', html: icon('ghost', 15) + ' Share ghost code', title: 'A friend pastes it under Opponent › Friend’s ghost', onclick: function () { copyText(gcode, 'Ghost code copied — send it to a friend'); } }));
    if (!net) acts.appendChild(h('button', { class: 'cb-btn ghost big', type: 'button', text: 'Setup', onclick: showSetup }));
    if (!net) acts.appendChild(h('button', { class: 'cb-btn ghost big', type: 'button', text: 'Main menu', onclick: function () { var r = router(); if (r) r.go('menu'); } }));
    wrap.appendChild(acts);
    root.appendChild(wrap);
    if (U.layer) U.layer.scrollTop = 0;
    var first = acts.querySelector('button'); if (first) safe(function () { first.focus({ preventScroll: true }); });
    function key(e) { if (U.screen !== 'results') { document.removeEventListener('keydown', key); return; } if (e.code === 'Enter' && document.activeElement === document.body) { e.preventDefault(); acts.querySelector('button').click(); } }
    document.addEventListener('keydown', key);
  }
  function copyText(t, ok) {
    var done = function () { toast(ok, 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () { fallback(); });
    else fallback();
    function fallback() { var ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = t; document.body.appendChild(ta); ta.select(); safe(function () { document.execCommand('copy'); }); ta.parentNode.removeChild(ta); done(); }
  }
  function slipCanvas(text, won) {
    var lines = String(text).split('\n'), fs = 22, lh = 30, pad = 40;
    var cv = document.createElement('canvas'); var c = cv.getContext('2d');
    c.font = '600 ' + fs + 'px ui-monospace,Menlo,Consolas,monospace';
    var w = Math.max.apply(null, lines.map(function (l) { return c.measureText(l).width; })) + pad * 2;
    cv.width = Math.ceil(w); cv.height = lines.length * lh + pad * 2 + 30;
    c.fillStyle = '#f4efe2'; c.fillRect(0, 0, cv.width, cv.height);
    c.fillStyle = 'rgba(0,0,0,.05)'; for (var y = 0; y < cv.height; y += 4) c.fillRect(0, y, cv.width, 1);
    c.fillStyle = won ? '#2f6d10' : '#8b1a12'; c.fillRect(0, 0, cv.width, 10);
    c.font = '600 ' + fs + 'px ui-monospace,Menlo,Consolas,monospace'; c.fillStyle = '#1d1b16'; c.textBaseline = 'top';
    lines.forEach(function (l, i) { c.fillText(l, pad, pad + 10 + i * lh); });
    return cv;
  }
  function downloadSlip(text, won) {
    safe(function () {
      var cv = slipCanvas(text, won), a = document.createElement('a');
      a.href = cv.toDataURL('image/png'); a.download = 'redline-timeslip-' + Date.now() + '.png';
      document.body.appendChild(a); a.click(); a.parentNode.removeChild(a);
    });
  }

  /* ================================================================== tournament */
  function newTournament() {
    var AI = CB.drag.ai, S = U.S, me = X.playerCar(S);
    var t = AI.tournament.create({ size: S.tSize, seed: (Date.now() & 0xffff) + 3, entrants: [{ id: 'player', name: profileName(), isPlayer: true, carName: me.name }] });
    U.tour = { t: t, done: false };
    simAiHeats();
  }
  function simHeat(a, b, seed) {
    var S = U.S, ea = a.isPlayer ? null : X.entryFor(a, S), eb = b.isPlayer ? null : X.entryFor(b, S);
    var res = safe(function () { return CB.drag.session.simulate({ seed: seed, distanceId: S.distanceId, venue: S.venue, surface: S.surface, treeType: S.venue === 'street' ? 'flag' : S.treeType, skipBurnout: true, class: S.cls, lanes: [ea, eb] }); });
    if (!res) return { winner: seed % 2, summary: '—' };
    return { winner: res.winner === 1 ? 1 : 0, summary: fmtET(res.lanes[0].et) + ' vs ' + fmtET(res.lanes[1].et) };
  }
  function simAiHeats() { if (U.tour) CB.drag.ai.tournament.playAi(U.tour.t, simHeat); }
  function finishTournamentAi() { var g = 0; while (!CB.drag.ai.tournament.champion(U.tour.t) && g++ < 8) simAiHeats(); }
  function showBracket() {
    teardown();
    if (!U.tour) newTournament();
    U.screen = 'bracket'; setDriving(false);
    var AI = CB.drag.ai, t = U.tour.t, root = U.root; root.innerHTML = '';
    var wrap = h('div', { class: 'dg-res' });
    var champ = AI.tournament.champion(t), pend = AI.tournament.pending(t);
    wrap.appendChild(h('div', { class: 'dg-kicker', text: 'Elimination · ' + t.size + ' cars · ' + ST().get(U.S.distanceId).name }));
    wrap.appendChild(h('h1', { class: champ && champ.isPlayer ? 'win' : '', text: champ ? (champ.isPlayer ? 'Tournament champion!' : champ.name + ' wins the tournament') : AI.tournament.playerOut(t) ? 'Eliminated' : 'Tournament bracket' }));
    var br = h('div', { class: 'dg-bracket' });
    var rnames = t.rounds.length === 3 ? ['Quarter-finals', 'Semi-finals', 'Final'] : ['Semi-finals', 'Final'];
    t.rounds.forEach(function (rd, ri) {
      var col = h('div', { class: 'dg-round' }, h('div', { class: 'dg-kicker', text: rnames[ri] || 'Round ' + (ri + 1) }));
      rd.forEach(function (m) {
        function ent(i) { if (i == null) return h('div', { class: 'e tbd', text: 'TBD' }); var e = t.entrants[i]; return h('div', { class: 'e' + (m.winner === i ? ' w' : m.winner != null ? ' l' : '') + (e.isPlayer ? ' me' : '') }, h('b', { text: e.isPlayer ? 'You' : e.name }), h('small', { text: e.isPlayer ? (e.carName || '') : P.stockName(e.model) })); }
        col.appendChild(h('div', { class: 'dg-match' }, ent(m.a), ent(m.b), m.summary ? h('div', { class: 'sum', text: m.summary }) : null));
      });
      br.appendChild(col);
    });
    wrap.appendChild(br);
    var acts = h('div', { class: 'dg-actions' });
    if (pend && pend.player) {
      var opp = pend.a.isPlayer ? pend.b : pend.a;
      acts.appendChild(h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'heat', html: icon('play', 16) + ' Race ' + esc(opp.name.split(' ')[0]) + ' (' + esc(P.stockName(opp.model)) + ')',
        onclick: function () { var mm = t.rounds[pend.round][pend.match]; startRun({ opp: X.entryFor(opp, U.S), tour: { round: pend.round, match: pend.match, a: mm.a, b: mm.b } }); } }));
    } else {
      acts.appendChild(h('button', { class: 'cb-btn primary rx-btn big', type: 'button', 'data-dg': 'heat', html: icon('trophy', 16) + ' New tournament', onclick: function () { U.tour = null; newTournament(); showBracket(); } }));
    }
    acts.appendChild(h('button', { class: 'cb-btn ghost big', type: 'button', text: 'Setup', onclick: showSetup }));
    acts.appendChild(h('button', { class: 'cb-btn ghost big', type: 'button', text: 'Main menu', onclick: function () { var r = router(); if (r) r.go('menu'); } }));
    wrap.appendChild(acts);
    root.appendChild(wrap);
    if (U.layer) U.layer.scrollTop = 0;
  }

  /* ================================================================== teardown, route */
  function teardown() {
    var R = U.R; if (!R) return;
    U.R = null;
    if (R.ghostCode && U.lastResults == null) U.lastRun = { ghostCode: R.ghostCode };
    U.lastRun = { ghostCode: R.ghostCode || null };
    cancelAnimationFrame(R.raf);
    R.offs.forEach(function (f) { safe(f); }); R.offs = [];
    if (R.renderer) safe(function () { R.renderer.destroy(); });
    if (R.sfx) safe(function () { R.sfx.destroy(); });
    if (R.session && R.session.destroy) safe(function () { R.session.destroy(); });
    R.renderer = null; R.session = null;
  }
  function enter(layer, params) {
    U.layer = layer; U.params = params || {};
    U.S = P.loadSettings();
    if (!U.root || U.root.parentNode !== layer) { layer.innerHTML = ''; U.root = h('div', { class: 'dg-root' }); layer.appendChild(U.root); }
    var q = U.params;
    if (q.car && CB.stock && CB.stock.SPECS && CB.stock.SPECS[q.car]) { U.S.source = 'stock'; U.S.stockId = q.car; U.S.tuneFD = null; U.S.tuneSpread = 1; }
    if (q.dist && ST().DISTANCES.some(function (d) { return d.id === q.dist; })) U.S.distanceId = q.dist;
    if (q.opp && ['ladder', 'ai', 'solo', 'tournament', 'ghost'].indexOf(q.opp) >= 0) U.S.opponent = q.opp;
    if (q.ghost) { U.S.ghostCode = String(q.ghost); U.S.opponent = 'ghost'; }
    if (q.quick === '1' || q.quick === 1 || q.quick === true) { startRun({}); return; }
    if (U.screen === 'play' && U.R) return;
    showSetup();
  }
  function leave() {
    teardown();
    setDriving(false);
    U.screen = null;
    if (U.root) U.root.innerHTML = '';
  }
  function register() {
    var r = CB.router;
    if (!r || typeof r.on !== 'function' || U.registered) return;
    U.registered = true;
    r.on('drag', enter, leave);
  }
  if (CB.router && CB.router.on) register();
  document.addEventListener('cb:router-ready', register);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(register, 0); }); else setTimeout(register, 0);

  /* ================================================================== public + test hooks */
  function state() {
    var R = U.R, sn = R && R.lastSnap, me = sn ? sn.lanes[sn.playerLane || 0] : null, lr = U.lastResults;
    return {
      screen: U.screen, paused: !!(R && R.paused), phase: sn ? sn.phase : null, t: sn ? sn.t : 0, renderer: R ? (R.renderer ? '3d' : '2d') : null, quality: R ? quality() : null,
      fps: R ? Math.round(R.fpsEma) : null, fpsLog: R ? R.fpsLog.slice(-20) : null, touch: !!(R && R.touch), touchLayout: R ? R.touchLayout || null : null,
      player: me ? { x: me.x, xFront: me.xFront, speed_mph: num(me.speed, 0) * MPH, rpm: me.rpm, gear: me.gear, staged: me.staged, preStaged: me.preStaged, red: me.red, rt: me.rt, et: me.et, burnout: me.burnout, tyreTemp: me.tyreTemp, launch: me.launch, shiftLight: me.shiftLight, lastShift: me.lastShift, finished: me.finished } : null,
      tree: sn ? sn.tree : null, winner: sn ? sn.winner : null,
      results: U.screen === 'results' && lr ? { won: !!lr.lanes[0].won, et: lr.lanes[0].et, rt: lr.lanes[0].rt, trap: lr.lanes[0].trap, red: lr.lanes[0].red, payout: lr.payout ? lr.payout.total : 0, ghost: !!(U.lastRun && U.lastRun.ghostCode) } : null,
      tournament: U.tour ? { size: U.tour.t.size, done: U.tour.done, champion: CB.drag.ai.tournament.champion(U.tour.t) ? CB.drag.ai.tournament.champion(U.tour.t).name : null } : null
    };
  }
  var hooks = {
    start: function (o) {
      o = o || {};
      var r = CB.router;
      if (r && r.current && r.current().route !== 'drag') r.go('drag');
      if (!U.S) U.S = P.loadSettings();
      if (!U.root) { var L = r && r.layer ? r.layer('drag') : document.body; U.root = h('div', { class: 'dg-root' }); L.appendChild(U.root); U.layer = L; }
      ['stockId', 'distanceId', 'opponent', 'difficulty', 'treeType', 'venue', 'surface', 'cls', 'nitrous_hp', 'tc', 'quality', 'touch', 'camera', 'aiModel', 'rivalId', 'units', 'tSize'].forEach(function (k) { if (o[k] != null) U.S[k] = o[k]; });
      ['autoShift', 'autoStage', 'deep', 'skipBurnout', 'night', 'bracket', 'muted', 'showFps', 'launchControl'].forEach(function (k) { if (o[k] != null) U.S[k] = !!o[k]; });
      if (o.stockId) U.S.source = 'stock';
      if (o.persist) persist();
      if (o.opponent === 'tournament') { U.tour = null; newTournament(); showBracket(); return state(); }
      startRun({ seed: o.seed, force2d: o.force2d });
      return state();
    },
    state: state,
    setInput: function (o) { var R = U.R; if (R) R.input.forced = o ? Object.assign({}, o) : null; return !!R; },
    step: function (n) { var R = U.R; if (!R || !R.session) return state(); for (var i = 0; i < (n || 1); i++) R.session.step(); R.lastSnap = R.session.snapshot(); return state(); },
    pause: pause, resume: resume, setup: function () { showSetup(); return state(); }, finish: function () { finish(); return state(); },
    session: function () { return U.R ? U.R.session : null; }, renderer: function () { return U.R ? U.R.renderer : null; },
    lastResults: function () { return U.lastResults || null; }, ghostCode: function () { return U.lastRun ? U.lastRun.ghostCode : null; },
    bracket: function () { showBracket(); return state(); }, settings: function () { return U.S; }
  };
  /** Run the play loop on a provided session (2-player lobby, js/net/netdrag.js): same update / snapshot / results /
   *  destroy surface as CB.drag.session.create. o = { lanes [{name, build, carName, color, modelId}], distanceId, venue, surface,
   *  night, treeType, selfLane, onClose(results|null), onBack() }. Setup is locked; restart is disabled. */
  function openNet(ns, o) {
    o = o || {};
    var r = CB.router;
    if (!U.S) U.S = P.loadSettings();
    var L = U.layer || (r && r.layer ? r.layer('drag') : null) || document.body;
    if (!U.root || !U.root.parentNode) { U.root = h('div', { class: 'dg-root' }); L.appendChild(U.root); U.layer = L; }
    var self = o.selfLane === 1 ? 1 : 0, lanes = o.lanes || [], mine = lanes[self] || {};
    var cfg = { playerLane: self, distanceId: o.distanceId || 'quarter', venue: o.venue || 'strip', surface: o.surface || 'prepped', night: !!o.night, treeType: o.treeType || 'pro', lanes: lanes };
    var me = { build: mine.build, base: mine.build, name: mine.carName || 'Car', key: 'net', modelId: mine.modelId || null, tuned: false };
    runPlay(cfg, { opponent: 'net', difficulty: 'pro' }, me, ns, { net: o });
    return { close: function () { teardown(); }, state: state };
  }
  CB.drag.ui.openNet = openNet;
  CB.drag.ui.enter = enter; CB.drag.ui.leave = leave; CB.drag.ui.state = state; CB.drag.ui.start = hooks.start; CB.drag.ui.hooks = hooks;
  window.drag = hooks;
})();

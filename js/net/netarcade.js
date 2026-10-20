/* ==========================================================================
   Redline — js/net/netarcade.js
   CB.net.arcade : ARCADE MULTIPLAYER — host-authoritative arcade races (stunt tracks + circuits) with nitro and
   Mario-Kart style items over CB.net.transport (WebRTC, or any transport with the same Host / Client API, e.g. the
   signalling relay). Pure logic (no DOM). Classic <script> in browsers, require()-able in Node. docs/ARCADE-SPEC.md §6.

   Model
     HOST  runs THE race: one CB.arcade.mode session with every car (host = player, remote players + AI fill as
           grid cars). The gameplay layer is authoritative there: item boxes, rolls, item use, hits (oil / rockets /
           EMP / lightning), shields, nitro canisters, coins, positions, laps, finish and results.
           Remote players' cars are driven by their INPUT STREAM (steer / throttle / brake / handbrake / nitro /
           item presses / aim-back, quantised, tick-stamped), replayed with a per-player input delay D (adaptive,
           covers latency + jitter): host tick n applies the client's input of tick n − D, and the car is held on
           the grid until GO + D. So the host's copy of a player's car is that player's own trajectory shifted by D,
           exactly, unless something interacts with it (another car, an item).
           Sends: snapshots on 'fast' (snapHz, default 20 Hz; every car's pose, quantised arrays) with the gameplay
           pack every 2nd snapshot (power-ups, moving entities, respawning pickups) and per-player input acks;
           standings (5 Hz), gameplay events (~15 Hz batches: hits, item use, boxes ...) and results on 'rel'.
     CLIENT runs a mirror of the same session (same seed / grid / track) in which only its own car is simulated
           (predicted with local input, zero input lag); every other car is a puppet posed from the host snapshots
           (interpolated ~2 snapshots behind). Its gameplay layer runs as a FOLLOWER (CB.arcade.gameplay setNet
           {role:'follower'}): no rolls, no hits — the host's pack / events bring those in; only the own car's
           self-caused effects are predicted (nitro burn, powerslide turbo, landings, pads / rings).
           Reconciliation: the host reports the car's state after tick N and its D; the client compares it with its
           own history at tick N − E and blends the difference into the car. Stunt: in track space on the road,
           world space in the air, phase mismatches (launch / landing a few ticks apart) deferred, rare snaps
           re-predicted to now and drawn through a decaying visual offset; puppets interpolated in track space
           (ballistic in the air, warps as teleports). docs/ARCADE-SPEC.md §6 Reconciliation.
     Disconnects: a player who leaves is turned into an AI car (the host's AI drives it to the flag, marked AI).
     Bandwidth (8 cars): ~0.6 KB per snapshot -> ~12 KB/s down per client at 20 Hz; inputs ~1.5 KB/s up.

   API
     CB.net.arcade.createHostSession(host, cfg)   host = CB.net.transport Host
       cfg { trackId, laps, ai (fill count), difficulty, weather, timeOfDay, arcade { options {items, itemFrequency,
             nitro, speedClass, coins} }, build, name, seed, players [{peerId, name, build}],
             leadIn_s 3, snapHz 20, hooks (race-ui netHooks), finishWait_s, autopilot }
     CB.net.arcade.createClientSession(client, cfg)  cfg { start (the host's start message, optional), build, name,
             hooks, autopilot }   (no steering assist: every car drives the one arcade handling model)
     CB.net.arcade.isArcadeStart(msg)  CB.net.arcade.waitForStart(client, fn)
     Session: the CB.net.race surface (update, snapshot, results, netState, onResults, onEnd, end, destroy, time,
       alpha, getPhase, isFinished, geom, track, trackDef, config, mode 'race', playerState ...) plus arcade (the
       session.arcade aggregation for race-ui's HUD / FX), isArcadeNet true, arcadeKind 'stunt'|'circuit',
       setButtons({nitro, item, aimBack}) (tests / bots), _debug().
   Messages: start{v, arcade:true, seed, t0, cfg, grid, you} · na.s (fast snapshot) · na.in (fast inputs) ·
     na.st (standings) · na.ev (events) · results{…} · na.leave{id} · na.end{reason, message} · na.quit{}
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.net = CB.net || {};

(function () {
  'use strict';

  var VERSION = 'redline-net-arcade/1';
  var STEP = 1 / 120;
  var DEFAULTS = { snapHz: 20, standingsHz: 5, eventHz: 15, inputHz: 40, leadIn_s: 3, maxPlayers: 8, maxGrid: 12,
                   hostTimeout_s: 12, finishWait_s: 30, minD: 3, maxD: 42,
                   // server-relay links (transport relay:true, peer.mode 'relay'; ~6 requests/s, newest 'fast' packet wins):
                   // fewer, self-contained snapshots, a longer interpolation window and a larger input delay budget
                   relaySnapHz: 5, relayInputHz: 10, relayMaxD: 96, relayInterp: [0.3, 1.0] };
  var PHASES = ['grid', 'countdown', 'racing', 'finished'];
  var MAX_EXTRAP = 0.35;   // s a puppet may run on past the newest host snapshot
  var MAX_EXTRAP_RELAY = 0.7;   // server relay (bursty, ~5 Hz): stunt puppets carry on along the road / their flight
  var GRADES = [0, 'none', 'good', 'perfect', 'over'];
  // gameplay events the client already predicts for its own car (never doubled from the host)
  var OWN_PREDICTED = { nitroStart: 1, nitroEnd: 1, driftStart: 1, driftTier: 1, driftEnd: 1, landing: 1, start: 1 };
  var OWN_BOOSTS = { pad: 1, ring: 1, drift1: 1, drift2: 1, drift3: 1, trick: 1, start: 1, nitro: 1 };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wrapAngle(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }
  function wrapS(s, L) { s = s % L; return s < 0 ? s + L : s; }
  function wrapD(d, L) { d = wrapS(d, L); return d > L / 2 ? d - L : d; }
  function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; } return t; }
  function jclone(o) { if (o == null) return o; try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; } }
  function safe(fn, d) { try { var v = fn(); return v === undefined ? d : v; } catch (e) { return d; } }
  function q(v, k) { return Math.round(num(v, 0) * k); }
  function r3(v) { return isNum(v) ? Math.round(v * 1000) / 1000 : v; }
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fmtTime(s) {
    if (!isNum(s)) return '—';
    var m = Math.floor(s / 60), rr = s - m * 60;
    return (m ? m + ':' + (rr < 10 ? '0' : '') : '') + rr.toFixed(3);
  }
  function carIdOf(peerId) { return String(peerId == null ? '' : peerId).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24) || 'p'; }
  function memStorage() {
    var m = {};
    return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
             setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  }
  function defaultBuild() { var D = CB.data; return D && typeof D.defaultBuild === 'function' ? safe(function () { return D.defaultBuild(); }, null) : null; }
  function isStuntTrack(id) { var M = CB.arcade && CB.arcade.mode; return !!(M && typeof M.isStunt === 'function' && safe(function () { return M.isStunt(id); }, false)); }
  function circuitDef(id) { var T = CB.race && CB.race.tracks; return T && typeof T.get === 'function' ? safe(function () { return T.get(id); }, null) : null; }
  /** Arcade handling has no steering assist: every human (local or remote) drives the one arcade model with the stunt
      'player' safety helpers (stunt-physics.js help levels). Kept as a function for older callers. */
  function stuntAssist() { return 'player'; }
  var RANK = { off: 0, light: 1, medium: 2, heavy: 3, auto: 4 };
  function capAssist(want, max) {
    var w = RANK[want] != null ? want : 'heavy';
    if (RANK[max] == null) return w;
    return RANK[w] <= RANK[max] ? w : max;
  }

  /* ---------------------------------------------------------------- transport adapters (as netrace.js) */
  function onOf(obj, type, fn) {
    if (obj && typeof obj.on === 'function') { var off = obj.on(type, fn); return typeof off === 'function' ? off : function () { if (typeof obj.off === 'function') obj.off(type, fn); }; }
    return function () {};
  }
  function hostLink(H) {
    if (!H || typeof H.on !== 'function') throw new Error('CB.net.arcade: host transport required');
    var offs = [], L = { role: 'host', id: H.id || 'host' };
    L.now = function () { return (typeof H.now === 'function' ? H.now() : Date.now()) / 1000; };
    L.send = function (id, ch, d) { try { return H.send(id, ch, d); } catch (e) { return false; } };
    L.broadcast = function (ch, d, ex) { try { return H.broadcast(ch, d, ex); } catch (e) { return 0; } };
    L.peers = function () { return (typeof H.list === 'function' ? H.list() : []).filter(function (p) { return p && p.state !== 'closed'; }).map(function (p) { return p.id; }); };
    L.modeOf = function (id) { var p = typeof H.get === 'function' ? H.get(id) : null; return p && (p.mode === 'relay' || p.mode === 'turn') ? p.mode : 'direct'; };
    L.rttOf = function (id) { var p = typeof H.get === 'function' ? H.get(id) : null; return p && isNum(p.rtt) && p.rtt > 0 ? p.rtt / 1000 : null; };
    L.onMessage = function (fn) { offs.push(onOf(H, 'message', function (peer, ch, data) { fn(peer && peer.id != null ? peer.id : peer, ch, data); })); };
    L.onLeave = function (fn) { offs.push(onOf(H, 'peer-leave', function (peer, why) { fn(peer && peer.id != null ? peer.id : peer, why); })); };
    L.close = function () { offs.forEach(function (o) { try { o(); } catch (e) { /* ignore */ } }); offs = []; };
    return L;
  }
  function clientLink(C) {
    if (!C || typeof C.on !== 'function' || typeof C.send !== 'function') throw new Error('CB.net.arcade: client transport required');
    var offs = [], L = { role: 'peer', id: C.selfId || C.id || null };
    L.now = function () { return (typeof C.now === 'function' ? C.now() : Date.now()) / 1000; };
    L.offsetReady = function () { return isNum(C.rtt) && C.rtt > 0 && isNum(C.clockOffset); };
    L.offset = function () { return num(C.clockOffset, 0) / 1000; };
    L.rtt = function () { return isNum(C.rtt) ? C.rtt / 1000 : 0; };
    L.state = function () { return C.state || 'open'; };
    L.mode = function () { return C.mode === 'relay' || C.mode === 'turn' ? C.mode : 'direct'; };
    L.send = function (ch, d) { try { return C.send(ch, d); } catch (e) { return false; } };
    L.onMessage = function (fn) { offs.push(onOf(C, 'message', function (ch, data) { fn('host', ch, data); })); };
    L.onClose = function (fn) { offs.push(onOf(C, 'close', fn)); };
    L.close = function () { offs.forEach(function (o) { try { o(); } catch (e) { /* ignore */ } }); offs = []; };
    return L;
  }

  /* ---------------------------------------------------------------- input quantisation (shared) */
  var FB = { handbrake: 1, nitro: 2, aimBack: 4 };
  /** input -> [steer ±127, throttle 0..255, brake 0..255, flags] (the exact values the car drives with) */
  function quantInput(inp, btn) {
    inp = inp || {};
    var f = 0;
    if (inp.handbrake) f |= FB.handbrake;
    if (btn && btn.nitro) f |= FB.nitro;
    if (btn && btn.aimBack) f |= FB.aimBack;
    return [Math.round(clamp(num(inp.steer, 0), -1, 1) * 127), Math.round(clamp01(num(inp.throttle, 0)) * 255), Math.round(clamp01(num(inp.brake, 0)) * 255), f];
  }
  function inputOf(qv) { return { steer: qv[0] / 127, throttle: qv[1] / 255, brake: qv[2] / 255, handbrake: !!(qv[3] & FB.handbrake) }; }

  /** Host-side input buffer of one remote player: tick-stamped changes, replayed at tick n − D. */
  function InputBuffer() { this.maxD = DEFAULTS.maxD; this.inHz = DEFAULTS.inputHz; this.ch = []; this.known = -1; this.late = null; this.jit = 0; this.D = 8; this.E = null; this.lastAdj = 0; this.target = 8; this.starved = 0; this.received = 0; this.lastArrival = -1e9; }
  /** a: [[tick, steer, thr, brk, flags, itemSeq, grade], ...]; n: newest tick the client recorded; nowTick: host tick */
  InputBuffer.prototype.push = function (a, n, nowTick, nowS) {
    if (!isNum(n) || n <= this.known) return false;
    var last = this.ch.length ? this.ch[this.ch.length - 1][0] : -1;
    for (var i = 0; i < a.length; i++) { var c = a[i]; if (Array.isArray(c) && isNum(c[0]) && c[0] > last) { this.ch.push(c.slice(0, 7)); last = c[0]; } }
    this.known = n; this.received++; this.lastArrival = nowS;
    if (this.ch.length > 600) this.ch.splice(0, this.ch.length - 400);
    var late = nowTick - n;
    if (this.late === null) this.late = late;
    else this.late += (late - this.late) * (late > this.late ? 0.25 : 0.03);
    this.jit += (Math.abs(late - this.late) - this.jit) * 0.08;
    this.target = clamp(Math.ceil(this.late + 2.5 * this.jit + 120 / this.inHz) + 2, DEFAULTS.minD, this.maxD);   // + one send interval (10 Hz on the relay)
    return true;
  };
  /** Adaptive D: fast up (no starving), slow down (one tick per 0.25 s). Call once per host tick. */
  InputBuffer.prototype.adapt = function (tick) {
    if (this.target > this.D) this.D = this.target;
    else if (this.target < this.D && tick % 30 === 0) this.D--;
  };
  InputBuffer.prototype.at = function (m) {
    var c = this.ch, lo = 0, hi = c.length - 1, best = null;
    if (m > this.known) this.starved++;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (c[mid][0] <= m) { best = c[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  };
  InputBuffer.prototype.gradeUpTo = function (m) {
    for (var i = 0; i < this.ch.length && this.ch[i][0] <= m; i++) if (this.ch[i][6]) return GRADES[this.ch[i][6]] || 'none';
    return null;
  };

  /* ---------------------------------------------------------------- pose packing (host snapshot rows) */
  // stunt: [idx, mode 0 ground|1 air|2 respawn, s cm, dist cm, lat cm, psi mrad, v cm/s, rpm/10, gear, steer mrad, thr %, flags,
  //         fade %, (air|respawn-in-air) px py pz cm, vx vy vz cm/s, fx fy fz ux uy uz e4, airT ms, takeoffS cm]
  // circuit: [idx, x cm, y cm, heading mrad, wvx cm/s, wvy cm/s, yawRate mrad/s, rpm/10, gear, steer mrad, thr %, brk %, flags]
  var MODE_C = { ground: 0, air: 1, respawn: 2 }, MODE_N = ['ground', 'air', 'respawn'];
  function packStunt(idx, c) {
    var f = (c.finished ? 1 : 0) | (c.nitroOn ? 2 : 0) | (c.boostT > 0 || c.extBoost ? 4 : 0) | (c._air ? 8 : 0) | (c.spinT > 0 ? 16 : 0);
    var row = [idx, MODE_C[c.mode] || 0, q(c.s, 100), q(c.dist, 100), q(c.lat, 100), q(c.psi, 1000), q(c.v, 100), q(c.rpm, 0.1), c.gear | 0,
               q(c.steerAngle, 1000), q(c.throttle, 100), f, q(c.fade, 100)];
    if (c.mode === 'air' || (c.mode === 'respawn' && c._air)) {
      row.push(q(c.px, 100), q(c.py, 100), q(c.pz, 100), q(c.vx, 100), q(c.vy, 100), q(c.vz, 100),
               q(c.fx, 1e4), q(c.fy, 1e4), q(c.fz, 1e4), q(c.ux, 1e4), q(c.uy, 1e4), q(c.uz, 1e4), q(c.airT, 1000), q(c.takeoffS, 100));
    }
    return row;
  }
  function unpackStunt(a) {
    var o = { mode: MODE_N[a[1]] || 'ground', s: a[2] / 100, dist: a[3] / 100, lat: a[4] / 100, psi: a[5] / 1000, v: a[6] / 100, rpm: a[7] * 10, gear: a[8],
              steerAngle: a[9] / 1000, throttle: a[10] / 100, finished: !!(a[11] & 1), nitroOn: !!(a[11] & 2), boosting: !!(a[11] & 4), inAir: !!(a[11] & 8), spinning: !!(a[11] & 16), fade: a[12] / 100 };
    if (a.length > 13) {
      o.air = { px: a[13] / 100, py: a[14] / 100, pz: a[15] / 100, vx: a[16] / 100, vy: a[17] / 100, vz: a[18] / 100,
                fx: a[19] / 1e4, fy: a[20] / 1e4, fz: a[21] / 1e4, ux: a[22] / 1e4, uy: a[23] / 1e4, uz: a[24] / 1e4, airT: a[25] / 1000, takeoffS: a[26] / 100 };
    }
    return o;
  }
  function packCircuit(idx, car) {
    var st = car.state || {}, inp = car.input || {};
    var f = (car.finished ? 1 : 0) | (inp.handbrake ? 2 : 0) | (num(st.skidding, 0) > 0.35 ? 4 : 0) | (car.offTrack ? 8 : 0);
    return [idx, q(st.x, 100), q(st.y, 100), q(st.heading, 1000), q(car.wvx, 100), q(car.wvy, 100), q(st.yawRate, 1000), q(st.rpm, 0.1),
            Math.round(num(st.gearDisplay, num(st.gear, 1))), q(st.steerAngle, 1000), q(inp.throttle, 100), q(inp.brake, 100), f];
  }
  function unpackCircuit(a) {
    return { x: a[1] / 100, y: a[2] / 100, h: a[3] / 1000, vx: a[4] / 100, vy: a[5] / 100, w: a[6] / 1000, rpm: a[7] * 10, gear: a[8],
             steer: a[9] / 1000, thr: a[10] / 100, brk: a[11] / 100, finished: !!(a[12] & 1), handbrake: !!(a[12] & 2), skid: !!(a[12] & 4) };
  }
  /* ---- stunt puppets: interpolation in TRACK space (loops / tubes / inversions follow the road, no chords or flips),
          ballistic Hermite in the air, warps / respawn swaps as discontinuities (the car is shown on one side or the
          other, never slid across the world) ---- */
  function SP() { return CB.arcade && CB.arcade.stunt && CB.arcade.stunt.physics; }
  function gAir() { var P = SP(); return P && isNum(P.G_AIR) ? P.G_AIR : 14.2; }
  function herm(p0, m0, p1, m1, u) { var u2 = u * u, u3 = u2 * u; return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1; }
  function isAirRow(o) { return !!(o && o.air && (o.mode === 'air' || o.mode === 'respawn')); }
  /** rate of s (m/s) of a ground row: v·cos ψ / (1 − κ·lat), as stunt-physics integrates it */
  function sdotOf(o, tr) {
    var k = 0;
    if (tr && typeof tr.sample === 'function') { var sm = tr.sample(o.s); k = num(sm && sm.kLeft, 0); }
    return o.v * Math.cos(o.psi) / Math.max(0.35, 1 - k * o.lat);
  }
  /** world pose + velocity of an unpacked row (air: its flight state, ground: the road frame at s / lat / ψ) */
  function worldOf(o, tr) {
    if (isAirRow(o)) { var A = o.air; return { pos: [A.px, A.py, A.pz], vel: [A.vx, A.vy, A.vz], fwd: [A.fx, A.fy, A.fz], up: [A.ux, A.uy, A.uz], air: true }; }
    var P = SP();
    var ps = P ? P.pose(tr, { mode: 'ground', s: o.s, lat: o.lat, psi: o.psi }) : { pos: [0, 0, 0], fwd: [1, 0, 0], up: [0, 1, 0] };
    return { pos: ps.pos.slice(), vel: [ps.fwd[0] * o.v, ps.fwd[1] * o.v, ps.fwd[2] * o.v], fwd: ps.fwd.slice(), up: ps.up.slice(), air: false };
  }
  function nrm3(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function nlerp3(a, b, u) { return nrm3([lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)]); }
  function airFrom(w, takeoffS, airT) {
    return { px: w.pos[0], py: w.pos[1], pz: w.pos[2], vx: w.vel[0], vy: w.vel[1], vz: w.vel[2], fx: w.fwd[0], fy: w.fwd[1], fz: w.fwd[2],
             ux: w.up[0], uy: w.up[1], uz: w.up[2], airT: airT, takeoffS: takeoffS };
  }
  /** carry a row `tau` s forwards (tau < 0: backwards) along its own motion: ground in track space, air ballistic */
  function carryRow(o, tau, L, tr) {
    var r = assign({}, o);
    if (isAirRow(o)) {
      var A = assign({}, o.air), g = gAir();
      A.px += A.vx * tau; A.pz += A.vz * tau; A.py += A.vy * tau - 0.5 * g * tau * tau; A.vy -= g * tau;
      r.air = A;
      return r;
    }
    var ds = (tr ? sdotOf(o, tr) : o.v * Math.cos(o.psi)) * tau;
    r.s = wrapS(o.s + ds, L); r.dist = o.dist + ds; r.lat = o.lat + o.v * Math.sin(o.psi) * tau;
    return r;
  }
  /** a: older row, b: newer row, u 0..1, L track length; dt (s between the rows) + tr (built track) enable the
      Hermite / track-space / air paths (without them: plain linear ground interpolation, as before) */
  function interpStunt(a, b, u, L, dt, tr) {
    var smooth = isNum(dt) && dt > 0 && dt < 1.5 && tr && typeof tr.sample === 'function';
    var aAir = isAirRow(a), bAir = isAirRow(b);
    if (!aAir && !bAir) {
      var o = assign({}, u < 0.5 ? a : b), ds = wrapD(b.s - a.s, L);
      o.dist = lerp(a.dist, b.dist, u); o.s = wrapS(a.s + ds * u, L); o.lat = lerp(a.lat, b.lat, u);
      if (smooth) {
        var sa = sdotOf(a, tr), sb = sdotOf(b, tr), exp = 0.5 * (sa + sb) * dt;
        // a respawn swap (s jumps back to a checkpoint) is a discontinuity: show one side, never slide along the road
        if (Math.abs(ds - exp) > Math.max(20, 0.6 * Math.abs(exp))) return assign({}, u < 0.5 ? a : b);
        if (Math.abs(ds - exp) < Math.max(2, 0.15 * Math.abs(ds))) {
          var dS = herm(0, sa * dt, ds, sb * dt, u);
          o.s = wrapS(a.s + dS, L); o.dist = a.dist + dS;
          o.lat = herm(a.lat, a.v * Math.sin(a.psi) * dt, b.lat, b.v * Math.sin(b.psi) * dt, u);
        }
      }
      o.psi = a.psi + wrapAngle(b.psi - a.psi) * u; o.v = lerp(a.v, b.v, u); o.rpm = lerp(a.rpm, b.rpm, u);
      o.steerAngle = lerp(a.steerAngle, b.steerAngle, u); o.throttle = lerp(a.throttle, b.throttle, u); o.fade = lerp(a.fade, b.fade, u);
      return o;
    }
    if (!smooth) return u < 0.5 ? a : b;
    // at least one end in the air: world space (free flight), ground ends converted through the road frame
    var wa = worldOf(a, tr), wb = worldOf(b, tr);
    var miss = Math.hypot(wb.pos[0] - wa.pos[0] - 0.5 * (wa.vel[0] + wb.vel[0]) * dt, wb.pos[1] - wa.pos[1] - 0.5 * (wa.vel[1] + wb.vel[1]) * dt,
                          wb.pos[2] - wa.pos[2] - 0.5 * (wa.vel[2] + wb.vel[2]) * dt);
    if (miss > 20) {   // warp portal (or respawn) between the rows: the car is shown on one side, carried along its own motion
      var uw = 0.5, dsAB = wrapD(b.s - a.s, L), W = tr.warps || [];
      for (var i = 0; i < W.length; i++) { var dw = wrapD(W[i].s - a.s, L); if (dsAB > 0.5 && dw >= 0 && dw <= dsAB) { uw = clamp(dw / dsAB, 0, 1); break; } }
      return u < uw ? carryRow(a, u * dt, L, tr) : carryRow(b, -(1 - u) * dt, L, tr);
    }
    var pos = [0, 1, 2].map(function (k) { return herm(wa.pos[k], wa.vel[k] * dt, wb.pos[k], wb.vel[k] * dt, u); });
    var vel = [0, 1, 2].map(function (k) { return lerp(wa.vel[k], wb.vel[k], u); });
    var r = assign({}, u < 0.5 ? a : b);
    var src = aAir ? a.air : b.air;
    r.mode = 'air'; r.inAir = true;
    r.air = airFrom({ pos: pos, vel: vel, fwd: nlerp3(wa.fwd, wb.fwd, u), up: nlerp3(wa.up, wb.up, u) }, src.takeoffS, lerp(aAir ? a.air.airT : 0, bAir ? b.air.airT : src.airT, u));
    var ds2 = wrapD(b.s - a.s, L);
    r.s = wrapS(a.s + ds2 * u, L); r.dist = lerp(a.dist, b.dist, u); r.lat = lerp(a.lat, b.lat, u);
    r.v = Math.hypot(vel[0], vel[1], vel[2]); r.rpm = lerp(a.rpm, b.rpm, u); r.throttle = lerp(a.throttle, b.throttle, u); r.fade = lerp(a.fade, b.fade, u);
    return r;
  }
  function interpCircuit(a, b, u, dt) {
    var o = assign({}, b), dh = wrapAngle(b.h - a.h);
    if (dt > 0 && dt < 0.6) {
      var u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      o.x = h00 * a.x + h10 * dt * a.vx + h01 * b.x + h11 * dt * b.vx;
      o.y = h00 * a.y + h10 * dt * a.vy + h01 * b.y + h11 * dt * b.vy;
    } else { o.x = lerp(a.x, b.x, u); o.y = lerp(a.y, b.y, u); }
    o.h = wrapAngle(a.h + dh * u);
    o.vx = lerp(a.vx, b.vx, u); o.vy = lerp(a.vy, b.vy, u); o.w = lerp(a.w, b.w, u); o.rpm = lerp(a.rpm, b.rpm, u);
    o.steer = lerp(a.steer, b.steer, u); o.thr = lerp(a.thr, b.thr, u); o.brk = lerp(a.brk, b.brk, u);
    return o;
  }

  /* ======================================================================
     Shared session core
     ====================================================================== */
  function createSession(tp, cfgIn, role) {
    var cfg = assign({}, DEFAULTS, cfgIn || {});
    var isHost = role === 'host';
    var link = isHost ? hostLink(tp) : clientLink(tp);
    var start = null, sim = null, kind = 'circuit', L = 1000, gp = null, layer = null;
    var grid = [], gridById = {}, peerToCar = {}, myCarId = null, myIdx = -1;
    var carsByLocal = {}, destroyed = false, ended = null, finalResults = null, standings = null;
    var resultsFns = [], endFns = [], pending = [], stats = { snapIn: 0, snapOut: 0, inputIn: 0, inputOut: 0, corrections: 0, snaps: 0, maxErr: 0, relOut: 0 };
    var clockOff = null, roughOff = null, lastHostMsg = 0, goTick = null, curTick = 0, autopilot = !!cfg.autopilot;
    var buttons = null;     // test / bot override of the arcade buttons
    // host
    var inbufs = {}, gone = {}, evQueue = [], lastSnapT = -1e9, lastStT = -1e9, lastEvT = -1e9, snapCount = 0, firstFinishT = null;
    // client
    var snaps = [], snapLate = null, snapJit = 0, snapDry = 0, interpDelay = 0.12, interpTarget = null, hist = {}, histKeys = [], changes = [], lastQ = null, itemSeq = 0, prevItem = false;
    var myGrade = 0, ackTick = -1, lastInSendT = -1e9, pendingCorr = null, lastAckN = -1, lastSnapN = -1;

    /* ---------------- clocks ---------------- */
    function hostNow() { if (isHost) return link.now(); return link.now() + (clockOff !== null ? clockOff : (roughOff !== null ? roughOff : 0)); }
    function raceNow() { return start ? hostNow() - start.t0 : 0; }
    function updateClock() {
      if (isHost || !link.offsetReady()) return;
      var o = link.offset();
      if (clockOff === null || Math.abs(o - clockOff) > 0.25) clockOff = o; else clockOff += (o - clockOff) * 0.1;
    }
    function sendRel(msg, to) { stats.relOut++; if (isHost) return to ? link.send(to, 'rel', msg) : link.broadcast('rel', msg); return link.send('rel', msg); }
    function sendFast(msg) { if (isHost) return link.broadcast('fast', msg); return link.send('fast', msg); }
    function note(type, text, carId) { pending.push({ type: type, carId: carId == null ? null : localId(carId), text: text, intensity: 0.6, x: 0, y: 0, t: sim ? r3(sim.time()) : 0 }); if (pending.length > 64) pending.shift(); }

    /* ---------------- ids ---------------- */
    function localId(carId) { return carId === myCarId ? 'player' : carId; }
    function netIdOf(local) { return local === 'player' ? myCarId : local; }
    function entryOfLocal(local) { return gridById[netIdOf(local)] || null; }
    function isRemoteHuman(local) { var e = entryOfLocal(local); return !!(e && e.kind === 'human' && local !== 'player' && !gone[e.carId]); }

    /* ---------------- the local session ---------------- */
    function buildSim() {
      var sc = start.cfg, entrants = [];
      grid.forEach(function (e, i) {
        if (e.carId === myCarId) return;
        entrants.push({ id: e.carId, name: e.name, team: e.team || '', number: e.number, color: e.color, accent: e.accent, build: e.build || undefined,
                        skill: num(e.skill, 0.8), aggression: num(e.aggression, 0.3), consistency: num(e.consistency, 0.9), livery: e.livery, bodyStyle: e.build && e.build.body ? e.build.body.style : undefined });
      });
      var me = gridById[myCarId] || {};
      var build = cfg.build || me.build || defaultBuild();
      var storage = memStorage();
      var hooks = [].concat(Array.isArray(cfg.hooks) ? cfg.hooks : (cfg.hooks ? [cfg.hooks] : []));
      hooks.push(netHook);
      var c = {
        trackId: sc.trackId, track: kind === 'circuit' ? (circuitDef(sc.trackId) || undefined) : undefined, laps: sc.laps, mode: 'race',
        opponents: entrants, opponentCount: entrants.length, gridOrder: 'given', startPosition: myIdx + 1,
        playerBuild: build, build: build, playerName: cfg.name || me.name || 'You', playerColor: me.color, playerNumber: me.number,
        weather: sc.weather, timeOfDay: sc.timeOfDay, seed: start.seed, difficulty: sc.difficulty,
        assists: { abs: true, tc: true, autoShift: true, racingLine: false, steeringAssist: false },
        steerAssist: 'off', arcade: jclone(sc.arcade) || {},   // one arcade handling model for everyone (no assist layer)
        hooks: hooks, persistGhost: false, storage: storage, stuckDnf_s: 0, finishTimeout_s: 1e7, rubberBanding: false, field: 'mixed',
        lightsOutDelay_s: sc.lightsOutDelay_s, trackLimitsWarnings: 99, playerAutopilot: autopilot, netPlayer: !isHost
      };
      var M = CB.arcade && CB.arcade.mode;
      if (!M || typeof M.createSession !== 'function') throw new Error('CB.net.arcade: CB.arcade.mode is not loaded');
      var s = M.createSession(c);
      var inst = s.arcade && s.arcade.instances ? s.arcade.instances.filter(function (i) { return i && i.gameplay; })[0] : null;
      layer = inst || null;
      gp = inst ? inst.gameplay : null;
      if (gp && typeof gp.setNet === 'function') {
        if (isHost) gp.setNet({ role: 'host', humans: grid.filter(function (e) { return e.kind === 'human' && e.carId !== myCarId; }).map(function (e) { return e.carId; }), externalLaunch: true, onEvent: onHostEvent });
        else gp.setNet({ role: 'follower' });
      }
      return s;
    }
    function innerOf(s) { var d = safe(function () { return s._debug(); }, null); return d; }
    function trackLength() {
      if (kind === 'stunt') return num(sim && sim.track && sim.track.length, 1000);
      var g = sim && sim.geom;
      var Lg = g && (g.length || g.totalLength || g.length_m || g.L);
      if (isNum(Lg) && Lg > 0) return Lg;
      var d = innerOf(sim), A = d && d.A;
      return A && A.L > 0 ? A.L : 1000;
    }
    /** read-only view of a car for standings: {dist, lap, fin, ft, best, last, pos, laps[]} */
    function carView(car) {
      if (!car) return null;
      if (kind === 'stunt') {
        return { dist: car.dist, lap: clamp(Math.floor(car.dist / L), 0, start.cfg.laps), fin: !!car.finished, ft: car.finishT, best: car.bestLap, last: car.lastLap,
                 pos: car.position, laps: (car.lapTimes || []).map(function (l) { return l.time; }), speed: Math.abs(num(car.v, 0)) };
      }
      return { dist: car.raceDist, lap: car.tracker ? car.tracker.lap : 0, fin: !!car.finished, ft: car.finishRaceT, best: car.bestLap, last: car.lastLap,
               pos: car.position, laps: (car.lapTimes || []).map(function (l) { return l && isNum(l.time) ? l.time : l; }), speed: Math.abs(num(car.state && car.state.speed, 0)) };
    }

    /* ---------------- the network engine hook ---------------- */
    function tickOf(car) { var c = car && car.ctx; return c && isNum(c.t) ? Math.round(c.t / STEP) : curTick; }
    function myButtons() {
      if (buttons) return buttons;
      var K = gp && typeof gp.kart === 'function' ? gp.kart('player') : null;
      return K && K.input ? K.input : (layer && layer._input) || {};
    }
    var netHook = {
      name: 'net-arcade',
      carCreated: function (car) {
        if (!car) return;
        carsByLocal[car.id] = car;
        if (car.isPlayer) return;
        var e = entryOfLocal(car.id);
        if (isHost) { if (e && e.kind === 'human') car.humanAssist = 'player'; return; }   // remote human: player helpers, no AI pace / grip
        // client: every other car is a puppet
        if (kind === 'stunt') car.external = true;
        else { car._net = true; car.frozenUntil = 1e9; car._hold = { x: car.state.x, y: car.state.y, heading: car.state.heading }; }
      },
      preStep: function (car, inp) {
        var tick = tickOf(car), ph = car.ctx && car.ctx.phase;
        if (car.isPlayer) curTick = tick;
        if (goTick === null && ph === 'racing') goTick = tick;
        if (!isHost && car.isPlayer) return clientRecord(car, inp, tick, ph);
        if (isHost && !car.isPlayer && isRemoteHuman(car.id)) return hostReplay(car, inp, tick, ph);
        return inp;
      },
      postStep: function (car) {
        if (!isHost && car._net) posePuppetCircuit(car);
      },
      externalStep: function (car) { if (!isHost) posePuppetStunt(car); }
    };

    /* ---------------- host: replay remote input ---------------- */
    function holdInput(car) {
      var moving = Math.abs(num(car.state && car.state.speed, num(car.v, 0))) > 0.6;
      return kind === 'stunt' ? { throttle: 0, brake: 0, steer: 0, handbrake: false } : { throttle: 0, brake: moving ? 1 : 0, steer: 0, handbrake: true, shiftUp: false, shiftDown: false, reverse: false, requestReset: false, pit: false };
    }
    function hostReplay(car, inp, tick, ph) {
      if (car.finished) return inp;                 // over the line: the AI brings it home
      var buf = inbufs[netIdOf(car.id)];
      if (!buf) return inp;
      if (car.isPlayer === false && car.ctx && car === carsByLocal[car.id]) buf.adapt(tick);
      // stunt hazards (stunt-features.js) run on the car's own race clock: this copy drives the player's input of tick
      // n − D, so it meets every pendulum / piston phase exactly as the player's own prediction did at tick n − D
      var m;
      if (kind === 'stunt') {
        // stunt: ONE recorded input per physics step, always (E = tick - input index). D only steers E: a car that needs a
        // larger delay skips its step for one tick (E + 1), one that may have a smaller delay steps twice in a tick (E − 1,
        // stunt-session car.netSteps). So the host's copy is EXACTLY the player's own prediction shifted by E — no
        // dropped / doubled input ticks at every D change (those were 1-tick = 0.4 m errors, corrected every 0.25 s,
        // and they nudged launches / landings at ramps a tick apart).
        if (car.netRep === 1 && buf.E !== null) buf.E--;
        var e0 = buf.E !== null ? buf.E : buf.D;
        car.clockOffset = e0 * STEP;
        if (ph === 'grid' || ph === 'countdown' || goTick === null) return inp;
        if (buf.E === null) { if (tick - buf.D < goTick) return holdInput(car); buf.E = buf.D; buf.lastAdj = tick; }
        m = tick - buf.E;
        car.clockOffset = buf.E * STEP;
        if (car.netRep !== 1 && tick - buf.lastAdj >= 3) {
          // (the drawn car on the host glides over the held / doubled step: visual offset of one step of travel)
          var step1 = car.mode === 'ground' ? [num(car.v, 0) * Math.cos(num(car.psi, 0)) * STEP, 0] : null;
          var step1w = car.mode === 'air' ? [num(car.vx, 0) * STEP, num(car.vy, 0) * STEP, num(car.vz, 0) * STEP] : null;
          if (buf.D > buf.E) {                                                                // next tick: hold
            car.netSteps = 0; buf.E++; buf.lastAdj = tick;
            visQueue.push({ tick: tick + 1, w: step1w, t: step1, id: car.id });
          } else if (buf.D < buf.E - 1 && tick - buf.lastAdj >= 60) {                         // next tick: catch up
            car.netSteps = 2; buf.lastAdj = tick;
            visQueue.push({ tick: tick + 1, w: step1w && [-step1w[0], -step1w[1], -step1w[2]], t: step1 && [-step1[0], 0], id: car.id });
          }
        }
      } else {
        car.clockOffset = buf.D * STEP;
        if (ph === 'grid' || ph === 'countdown' || goTick === null) return inp;
        m = tick - buf.D;
        if (m < goTick) return holdInput(car);        // held until GO + D: the same start the player saw
      }
      var rec = buf.at(m);
      if (!rec) return holdInput(car);
      if (gp) {
        gp.setInput(car.id, { nitro: !!(rec[4] & FB.nitro), aimBack: !!(rec[4] & FB.aimBack), itemSeq: rec[5] | 0 });
        var K = gp.kart(car.id);
        if (K && K.launchPending) { var g = buf.gradeUpTo(m); if (g) gp.launchKart(car.id, g); else if (m - goTick > 240) gp.launchKart(car.id, 'none'); }
      }
      var o = inputOf([rec[1], rec[2], rec[3], rec[4]]);
      if (kind !== 'stunt') { o.shiftUp = false; o.shiftDown = false; o.reverse = false; o.requestReset = false; o.pit = false; }
      return o;
    }

    /* ---------------- client: record + predict own input ---------------- */
    function stateRec(car) {
      if (kind === 'stunt') {
        var o = { mode: car.mode, s: car.s, dist: car.dist, lat: car.lat, psi: car.psi, v: car.v };
        if (car.mode === 'air' || (car.mode === 'respawn' && car._air)) { o.px = car.px; o.py = car.py; o.pz = car.pz; o.vx = car.vx; o.vy = car.vy; o.vz = car.vz; }
        return o;
      }
      var st = car.state;
      return { x: st.x, y: st.y, h: st.heading, vx: st.vx, vy: st.vy, w: st.yawRate };
    }
    function addCorr(o, c, k) {
      if (!c) return o;
      if (kind === 'stunt') { if (o.mode !== 'ground') return o; o.s = wrapS(o.s + c.s * k, L); o.dist += c.s * k; o.lat += c.lat * k; o.psi += c.psi * k; o.v += c.v * k; return o; }
      o.x += c.x * k; o.y += c.y * k; o.h += c.h * k; o.vx += c.vx * k; o.vy += c.vy * k; o.w += c.w * k; return o;
    }
    function clientRecord(car, inp, tick, ph) {
      // a ground correction still being blended when the car leaves the road: applied at once (world offset in the air),
      // the drawn car keeps its place through the visual offset
      if (kind === 'stunt' && pendingCorr && car.mode !== 'ground') foldPendingCorr(car);
      // the state at the start of this tick == the state after tick-1 (incl. the pending correction still being blended)
      var rec = addCorr(stateRec(car), pendingCorr, 1);
      hist[tick - 1] = rec; histKeys.push(tick - 1);
      if (histKeys.length > 360) delete hist[histKeys.shift()];
      applyPendingCorr(car);
      var btn = myButtons();
      var press = !!btn.item && !prevItem;
      prevItem = !!btn.item;
      if (press) itemSeq++;
      if (!myGrade && gp) { var K = gp.kart('player'); if (K && K.startGrade) myGrade = Math.max(1, GRADES.indexOf(K.startGrade)); }
      var qv = quantInput(inp, btn);
      rec.nin = qv;   // the input of tick `tick` (re-prediction after a snap)
      var chg = !lastQ || qv[0] !== lastQ[0] || qv[1] !== lastQ[1] || qv[2] !== lastQ[2] || qv[3] !== lastQ[3] || itemSeq !== lastQ[4] || myGrade !== lastQ[5];
      if (chg) { changes.push([tick, qv[0], qv[1], qv[2], qv[3], itemSeq, myGrade]); lastQ = [qv[0], qv[1], qv[2], qv[3], itemSeq, myGrade]; if (changes.length > 400) changes.splice(0, changes.length - 300); }
      if (ph === 'grid' || ph === 'countdown') return inp;   // the session holds the car; rev gauge reads the pedal
      var o = assign({}, inp, inputOf(qv));
      return o;
    }
    function applyPendingCorr(car) {
      if (!pendingCorr) return;
      var k = 1 - Math.exp(-STEP / pendTau), c = pendingCorr;
      if (kind === 'stunt') {
        if (car.mode !== 'ground') return;
        car.s = wrapS(car.s + c.s * k, L); car.dist += c.s * k; car.lat += c.lat * k; car.psi += c.psi * k; car.v += c.v * k;
        if (car.lane && c.lat) relatchLane(car);
      } else {
        var st = car.state;
        st.x += c.x * k; st.y += c.y * k; st.heading = wrapAngle(st.heading + c.h * k); st.vx += c.vx * k; st.vy += c.vy * k; st.yawRate += c.w * k;
        if ('speed' in st) st.speed = Math.sqrt(st.vx * st.vx + st.vy * st.vy) * (st.vx < -0.3 ? -1 : 1);
      }
      var done = true;
      for (var key in c) { c[key] *= 1 - k; if (Math.abs(c[key]) > 1e-4) done = false; }
      if (done) pendingCorr = null;
    }

    /* ---- stunt own-car corrections in track space + phase-aware (docs/ARCADE-SPEC.md §6) ----
       Errors are measured against the own history at the host's tick N − E (E = the delay the host's copy really runs at):
         ground/ground  (s, lat, ψ, v) blended into the car (τ grows with the error: never > ~0.3 m per frame)
         air/air        world position / velocity offset applied to the flight at once; the drawn car keeps its place
                        (visual offset, decays) — once landed, the same error projected on the road (s, lat)
         phase mismatch (one side launched / landed a few ticks earlier) is NOT corrected: the own sim converges within
                        ~0.1–0.2 s; only a mismatch lasting PHASE_WAIT_S (or > 25 m) snaps — to the host state RE-PREDICTED
                        forward to now with the recorded inputs, with the drawn car blended from where it was. */
    var PHASE_WAIT_S = 0.4, SNAP_M = 14, DEAD_M = 0.02, pendTau = 0.12, mismatchSince = null;
    var visQueue = [];   // host: offsets that start with a remote copy's held / doubled step (applied once that tick ran)
    var visBy = {};   // per local car id: visual offset {w:[x,y,z] world, s / lat track, tau} — decays on the race clock
    function TR() { return sim && sim.track; }
    function worldPosOf(c) { var P = SP(), tr = TR(); return P && tr ? P.pose(tr, c).pos.slice() : [0, 0, 0]; }
    function addVis(dw, track, id) {
      id = id || 'player';
      var vis = visBy[id] || (visBy[id] = { w: [0, 0, 0], s: 0, lat: 0, tau: 0.25, t: null });
      if (track) { vis.s += track[0]; vis.lat += track[1]; }
      if (dw) { vis.w[0] += dw[0]; vis.w[1] += dw[1]; vis.w[2] += dw[2]; }
      var m = Math.hypot(vis.w[0], vis.w[1], vis.w[2]) + Math.hypot(vis.s, vis.lat);
      if (m > 60) { delete visBy[id]; return; }   // a respawn / warp-sized jump: show it (the fade / portal covers it)
      vis.tau = clamp(m / 15, 0.15, 1.5);         // ≤ ~0.3 m of visual catch-up per 60 Hz frame
    }
    function setPend(e) {
      if (!pendingCorr) pendingCorr = {};
      for (var k in e) pendingCorr[k] = (pendingCorr[k] || 0) + e[k];
      pendTau = clamp(Math.hypot(pendingCorr.s || 0, pendingCorr.lat || 0) / 15, 0.12, 0.6);
    }
    function foldPendingCorr(car) {
      var c = pendingCorr, tr = TR(); pendingCorr = null;
      if (!c || !tr || car.mode !== 'air') return;
      var sm = tr.sample(car.s), d = [0, 1, 2].map(function (k) { return sm.tangent[k] * c.s + sm.left[k] * c.lat; });
      car.px += d[0]; car.py += d[1]; car.pz += d[2];
      addVis([-d[0], -d[1], -d[2]]);
    }
    /** host state of my car after tick N (my history key N − E) -> correction */
    function reconcile(hostRow, N, D) {
      var me = carsByLocal.player;
      if (!me || !hostRow || me.finished) return;
      var k0 = N - D, h = hist[k0];
      if (!h) return;
      var e, mag;
      if (kind === 'stunt') return reconcileStunt(me, unpackStunt(hostRow), h, k0);
      var hc = unpackCircuit(hostRow), c = Math.cos(hc.h), sn = Math.sin(hc.h);
      var bvx = c * hc.vx + sn * hc.vy, bvy = -sn * hc.vx + c * hc.vy;
      e = { x: hc.x - h.x, y: hc.y - h.y, h: wrapAngle(hc.h - h.h), vx: bvx - h.vx, vy: bvy - h.vy, w: hc.w - h.w };
      mag = Math.sqrt(e.x * e.x + e.y * e.y);
      if (mag > 14) { hardSnapCircuit(hc); return; }
      if (mag > stats.maxErr) stats.maxErr = mag;
      if (stats.errLog) stats.errLog.push([N, Math.round(mag * 1000) / 1000, 'c']);
      if (mag < 0.004 && Math.abs(e.vx) < 0.01) return;
      stats.corrections++;
      for (var i = 0; i < histKeys.length; i++) if (histKeys[i] > k0) addCorr(hist[histKeys[i]], e, 1);
      if (!pendingCorr) pendingCorr = {};
      for (var k in e) pendingCorr[k] = (pendingCorr[k] || 0) + e[k];
    }
    function reconcileStunt(me, hs, h, k0) {
      var hAir = hs.mode === 'air' || (hs.mode === 'respawn' && !!hs.air), mAir = !!(h.mode === 'air' || (h.mode === 'respawn' && isNum(h.px)));
      if (hs.mode !== h.mode) {
        // launch / landing / respawn timing differs: let the own sim converge, snap only if it does not
        stats.phaseMismatch = (stats.phaseMismatch || 0) + 1;
        if (mismatchSince === null) mismatchSince = k0;
        if ((k0 - mismatchSince) * STEP >= PHASE_WAIT_S || Math.abs(hs.dist - h.dist) > 25) snapStunt(me, hs, k0, 'phase');
        if (stats.errLog) stats.errLog.push([k0, -1, h.mode + '/' + hs.mode]);
        return;
      }
      mismatchSince = null;
      if (hs.mode === 'respawn') return;   // fading / swapping: nothing to blend
      var tr = TR();
      if (hAir && mAir && tr) {
        var A = hs.air, ew = [A.px - h.px, A.py - h.py, A.pz - h.pz], ev = [A.vx - h.vx, A.vy - h.vy, A.vz - h.vz];
        var em = Math.hypot(ew[0], ew[1], ew[2]);
        if (stats.errLog) stats.errLog.push([k0, r3(em), 'air']);
        if (em > stats.maxErr) stats.maxErr = em;
        if (em > SNAP_M) { snapStunt(me, hs, k0, 'air'); return; }
        if (em < DEAD_M && Math.hypot(ev[0], ev[1], ev[2]) < 0.05) return;
        stats.corrections++; stats.airCorrections = (stats.airCorrections || 0) + 1;
        for (var i = 0; i < histKeys.length; i++) {
          var r = hist[histKeys[i]];
          if (histKeys[i] <= k0 || !r) continue;
          if (isNum(r.px)) { r.px += ew[0]; r.py += ew[1]; r.pz += ew[2]; r.vx += ev[0]; r.vy += ev[1]; r.vz += ev[2]; }
          else if (r.mode === 'ground') { var sm0 = tr.sample(r.s); r.s = wrapS(r.s + dot3(ew, sm0.tangent), L); r.dist += dot3(ew, sm0.tangent); r.lat += dot3(ew, sm0.left); }
        }
        if (me.mode === 'air') {
          me.px += ew[0]; me.py += ew[1]; me.pz += ew[2]; me.vx += ev[0]; me.vy += ev[1]; me.vz += ev[2];
          addVis([-ew[0], -ew[1], -ew[2]]);
        } else if (me.mode === 'ground') {   // landed since: the same error along the road
          var sm = tr.sample(me.s);
          setPend({ s: dot3(ew, sm.tangent), lat: dot3(ew, sm.left), psi: 0, v: 0 });
        }
        return;
      }
      if (hAir || mAir) return;   // respawn-in-air rows etc.
      var e = { s: wrapD(hs.s - h.s, L), lat: hs.lat - h.lat, psi: wrapAngle(hs.psi - h.psi), v: hs.v - h.v };
      var mag = Math.sqrt(e.s * e.s + e.lat * e.lat);
      if (stats.errLog) stats.errLog.push([k0, r3(mag), 'g']);
      if (mag > stats.maxErr) stats.maxErr = mag;
      if (mag > SNAP_M) { snapStunt(me, hs, k0, 'far'); return; }
      // dead band (the snapshot is quantised to 1 cm): a guest that never perturbs its own prediction stays bit-identical
      // to the host's copy, so both meet every ramp lip / crest / landing on the same tick
      if (mag < DEAD_M && Math.abs(e.v) < 0.03 && Math.abs(e.psi) < 0.003) return;
      stats.corrections++;
      // the rest of the recorded trajectory moves with it (no double correction on the next snapshot)
      for (var j = 0; j < histKeys.length; j++) if (histKeys[j] > k0) addCorr(hist[histKeys[j]], e, 1);
      if (me.mode === 'ground') setPend(e);
      else if (me.mode === 'air' && tr) {   // took off since: shift the flight, keep the drawn car in place
        var sa = tr.sample(me.s), d = [0, 1, 2].map(function (k) { return sa.tangent[k] * e.s + sa.left[k] * e.lat; });
        me.px += d[0]; me.py += d[1]; me.pz += d[2];
        addVis([-d[0], -d[1], -d[2]]);
      }
    }
    function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    /** Snap the own car to the host's state at my tick k0 and RE-PREDICT it forward to now with my recorded inputs (the
        host state is E ticks old: setting it directly put the car up to ~40 m back on a relay link). The drawn car is
        blended from where it was (visual offset). */
    function snapStunt(me, hs, k0, why) {
      var tr = TR(), before = worldPosOf(me), beforeG = me.mode === 'ground' ? { s: me.s, lat: me.lat } : null;
      stats.snaps++; stats.snapWhy = stats.snapWhy || {}; stats.snapWhy[why] = (stats.snapWhy[why] || 0) + 1;
      pendingCorr = null; mismatchSince = null;
      me.lane = 0; me.latV = 0;
      me.mode = hs.mode; me.s = hs.s; me.dist = hs.dist; me.lat = hs.lat; me.psi = hs.psi; me.v = hs.v; me.fade = hs.fade;
      if (hs.air) { assign(me, hs.air); me._air = hs.inAir || hs.mode === 'air'; } else me._air = false;
      if (me.mode === 'respawn' && !(me.respawnT > 0)) me.respawnT = 0.5;
      if (hs.air) { me.airS = me.s; me.prevH = 1; me.airHd = null; me.takeoffDist = me.dist - wrapD(me.s - num(hs.air.takeoffS, me.s), L); }
      // re-predict k0+1 .. now
      var keys = histKeys.filter(function (k) { return k >= k0; }), n = 0;
      var canPredict = sim && typeof sim.netPredict === 'function';
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], r = hist[k];
        if (k > k0 && canPredict) {
          var prev = hist[k - 1];
          if (prev && prev.nin && me.mode !== 'respawn') { sim.netPredict(me, inputOf(prev.nin)); n++; }
          else if (me.mode === 'respawn') { me.respawnT += STEP; }
        }
        var nr = stateRec(me); nr.nin = r && r.nin; hist[k] = nr;
      }
      var after = worldPosOf(me);
      if (beforeG && me.mode === 'ground' && Math.abs(wrapD(beforeG.s - me.s, L)) < 30) addVis(null, [wrapD(beforeG.s - me.s, L), beforeG.lat - me.lat]);
      else addVis([before[0] - after[0], before[1] - after[1], before[2] - after[2]]);
      stats.repredicted = (stats.repredicted || 0) + n;
    }
    /** a car's visual offset applied to its snapshot entry (decays on the race clock): the own car after a correction /
        snap (client), a remote player's copy after a hold / double step (host) */
    function applyVis(c, id, car) {
      var vis = visBy[id];
      if (!vis) return;
      var now = sim ? sim.time() + (typeof sim.alpha === 'function' ? num(safe(function () { return sim.alpha(); }, 0), 0) * STEP : 0) : 0;
      var dt = vis.t === null ? 0 : clamp(now - vis.t, 0, 0.5); vis.t = now;
      var kd = Math.exp(-dt / vis.tau);
      vis.w[0] *= kd; vis.w[1] *= kd; vis.w[2] *= kd; vis.s *= kd; vis.lat *= kd;
      var dw = vis.w.slice(), P = SP(), tr = TR();
      if ((vis.s || vis.lat) && P && tr && car && car.mode === 'ground') {
        var base = P.pose(tr, { mode: 'ground', s: car.s, lat: car.lat, psi: 0 }).pos, moved = P.pose(tr, { mode: 'ground', s: car.s + vis.s, lat: car.lat + vis.lat, psi: 0 }).pos;
        dw[0] += moved[0] - base[0]; dw[1] += moved[1] - base[1]; dw[2] += moved[2] - base[2];
      } else if (vis.s || vis.lat) { vis.s = 0; vis.lat = 0; }
      if (Math.hypot(vis.w[0], vis.w[1], vis.w[2]) + Math.hypot(vis.s, vis.lat) < 1e-3) { delete visBy[id]; return; }
      if (c.pos) { c.pos = [c.pos[0] + dw[0], c.pos[1] + dw[1], c.pos[2] + dw[2]]; }
      if (c.prevPos) { c.prevPos = [c.prevPos[0] + dw[0], c.prevPos[1] + dw[1], c.prevPos[2] + dw[2]]; }
      if (isNum(c.x)) { c.x += dw[0]; c.y -= dw[2]; }
      if (isNum(c.prevX)) { c.prevX += dw[0]; c.prevY -= dw[2]; }
    }
    /** split lanes (stunt-features.js): a correction that moves the car across a divider re-latches its lane there
        (the lane is not part of the snapshot row; the physics latches it again from the corrected side) */
    function relatchLane(car) {
      var P = CB.arcade && CB.arcade.stunt && CB.arcade.stunt.physics, tr = sim && sim.track;
      if (!P || typeof P.splitInfo !== 'function' || !tr || !tr.splits || !tr.splits.length) return;
      var si = P.splitInfo(tr, car.s);
      if (!si || (car.lat - si.sp.div) * car.lane < 0) car.lane = 0;
    }
    function hardSnapCircuit(hc) {
      var me = carsByLocal.player; if (!me) return;
      stats.snaps++; pendingCorr = null; hist = {}; histKeys = [];
      var st = me.state, c = Math.cos(hc.h), s = Math.sin(hc.h);
      st.x = hc.x; st.y = hc.y; st.heading = hc.h; st.vx = c * hc.vx + s * hc.vy; st.vy = -s * hc.vx + c * hc.vy; st.yawRate = hc.w;
      if ('speed' in st) st.speed = Math.hypot(hc.vx, hc.vy);
    }

    /* ---------------- client: puppets from interpolated host snapshots ---------------- */
    function sampleRows(tRender) {
      var n = snaps.length;
      if (!n) return null;
      var i = n - 1;
      while (i > 0 && snaps[i].t > tRender) i--;
      var a = snaps[i], b = snaps[Math.min(n - 1, i + 1)];
      // the playhead ran past the newest snapshot (a late burst): carry the cars on along their velocity for a moment
      // instead of freezing them and jumping when the next snapshot lands
      if (a === b && tRender > a.t) return { a: a, b: a, u: 0, ext: Math.min(tRender - a.t, kind === 'stunt' && link.mode() === 'relay' ? MAX_EXTRAP_RELAY : MAX_EXTRAP) };
      if (tRender <= a.t || a === b) return { a: a, b: a, u: 0 };
      return { a: a, b: b, u: clamp((tRender - a.t) / Math.max(1e-6, b.t - a.t), 0, 1) };
    }
    var puppetCache = { t: null, smp: null };
    function puppetSample(car) {
      var t = car.ctx && isNum(car.ctx.t) ? car.ctx.t : (sim ? sim.time() : 0);
      if (puppetCache.t !== t) { puppetCache.t = t; puppetCache.smp = sampleRows(t - interpDelay); }
      var smp = puppetCache.smp, e = entryOfLocal(car.id);
      if (!smp || !e) return null;
      var idx = grid.indexOf(e), ra = smp.a.rows[idx], rb = smp.b.rows[idx];
      if (!ra && !rb) return null;
      ra = ra || rb; rb = rb || ra;
      return { a: ra, b: rb, u: smp.u, dt: smp.b.t - smp.a.t, ext: smp.ext || 0 };
    }
    function posePuppetStunt(c) {
      var p = puppetSample(c);
      if (!p) { c.v = 0; return; }
      var tr = sim && sim.track;
      var a = unpackStunt(p.a), b = unpackStunt(p.b), o = interpStunt(a, b, p.u, L, p.dt, tr);
      if (p.ext > 0) o = carryRow(o, p.ext, L, tr);   // ran past the newest snapshot: carry on along its motion (ballistic in the air)
      o = smoothPuppet(c, o, tr);
      c.mode = o.mode; c.s = o.s; c.dist = o.dist; c.lat = o.lat; c.psi = o.psi; c.v = o.v; c.rpm = o.rpm; c.gear = o.gear; c.steerAngle = o.steerAngle;
      c.throttle = o.throttle; c.fade = o.fade; c.nitroOn = o.nitroOn; c.boostT = o.boosting ? 0.05 : 0; c.finished = o.finished;
      // hazard bonks / spins (stunt-features.js): the puppet plays a local cartoon 360 while the host flags it spinning
      if (o.spinning) { if (!(c.spinT > 0)) { c.spinT = 0.8; c.spinDur = 0.8; } else c.spinT = Math.max(0.02, c.spinT - STEP); } else c.spinT = 0;
      if (o.air) { assign(c, o.air); c._air = o.inAir || o.mode === 'air'; } else c._air = false;
      // the own car never bumps a puppet here: puppets are drawn interpolation-delay + E behind the time the own car's
      // state stands for, so a local contact was with where that car WAS (and the real one, decided by the host, came
      // on top of it as a correction). Car-to-car contacts are the host's, they arrive as (blended) corrections.
      c.noCollide = true;
      c.inputState = { throttle: o.throttle, brake: 0, steer: 0 };
      c.state = { vx: c.v, vy: 0, speed: Math.abs(c.v), mode: c.mode, airborne: c.mode === 'air', s: c.s, lat: c.lat, dist: c.dist };
      c.airborne = c.mode === 'air';
      c.input = c.inputState;
      c.params = c.params || { handling: 'arcade', arcade: {}, capabilities: { topSpeed_mps: num(c.drive && c.drive.vmax, 55) } };
    }
    /** Error-decay smoothing of a stunt puppet: any step-to-step discontinuity of the interpolated target (a new snapshot
        replacing an extrapolation, a late burst, the playhead slewing) is absorbed into an offset that decays (PUP_TAU),
        so the drawn car never jumps. Track space (s, lat) on the road — a loop / tube / wall stays on its surface — world
        space in the air, converted at take-off / landing. A teleport (warp portal, respawn swap) is shown as one. */
    var PUP_TAU = 0.2, PUP_EPS = 0.03, PUP_JUMP = 0.1, PUP_CUT = 15;
    function smoothPuppet(c, o, tr) {
      if (!tr || typeof tr.sample !== 'function') return o;
      var S = c._pup || (c._pup = { offT: [0, 0], offW: [0, 0, 0] });
      var air = isAirRow(o);
      var w = air ? [o.air.px, o.air.py, o.air.pz] : tr.pointAt(o.s, o.lat, 0, [0, 0, 0]);
      var chW = S.w ? [w[0] - S.w[0], w[1] - S.w[1], w[2] - S.w[2]] : null, chT = null, cut = false, sm;
      if (!air) chT = S.mode === 'g' ? [wrapD(o.s - S.s, L), o.lat - S.lat] : null;
      if (S.mode === 'g' && !air && chT && S.chT) {
        var d0 = chT[0] - S.chT[0], d1 = chT[1] - S.chT[1], dm = Math.hypot(d0, d1);
        if (dm > PUP_CUT) cut = true;
        else if (dm > PUP_EPS) {
          S.offT[0] -= d0; S.offT[1] -= d1;
          // a position jump: keep the motion of before for ONE step (the next change is normal again); a lasting change
          // of motion is then accepted (else the offset would grow for as long as it lasts)
          if (dm > PUP_JUMP && !S.held) { chT = S.chT; chW = S.chW; S.held = true; } else S.held = false;
        } else S.held = false;
      } else if (chW && S.chW) {
        var e = [chW[0] - S.chW[0], chW[1] - S.chW[1], chW[2] - S.chW[2]], em = Math.hypot(e[0], e[1], e[2]);
        if (em > PUP_CUT) cut = true;
        else {
          if (air && S.mode === 'g') { sm = tr.sample(S.s); S.offW = [0, 1, 2].map(function (k) { return sm.tangent[k] * S.offT[0] + sm.left[k] * S.offT[1]; }); S.offT = [0, 0]; }
          if (air) {
            if (em > PUP_EPS) { for (var k = 0; k < 3; k++) S.offW[k] -= e[k]; if (em > PUP_JUMP && S.mode === 'a' && !S.held) { chW = S.chW; S.held = true; } else S.held = false; }
            else S.held = false;
          }
          else {
            var ow = S.mode === 'a' ? S.offW : [0, 0, 0];
            if (em > PUP_EPS) ow = [ow[0] - e[0], ow[1] - e[1], ow[2] - e[2]];
            if (S.mode === 'a') {
              sm = tr.sample(o.s);
              S.offT = [ow[0] * sm.tangent[0] + ow[1] * sm.tangent[1] + ow[2] * sm.tangent[2], ow[0] * sm.left[0] + ow[1] * sm.left[1] + ow[2] * sm.left[2]];
              S.offW = [0, 0, 0];
            }
          }
        }
      }
      if (cut) { S.offT = [0, 0]; S.offW = [0, 0, 0]; chW = null; chT = null; }
      S.mode = air ? 'a' : 'g'; S.s = o.s; S.lat = o.lat; S.w = w; S.chW = chW; S.chT = chT;
      // decay: a large offset (a long dry spell on a relay link) is caught up at ≤ ~0.25 m per 60 Hz frame
      var om = Math.hypot(S.offT[0], S.offT[1]) + Math.hypot(S.offW[0], S.offW[1], S.offW[2]);
      var kd = Math.exp(-STEP / clamp(om / 15, PUP_TAU, 0.6));
      S.offT[0] *= kd; S.offT[1] *= kd; S.offW[0] *= kd; S.offW[1] *= kd; S.offW[2] *= kd;
      if (Math.abs(S.offT[0]) + Math.abs(S.offT[1]) + Math.abs(S.offW[0]) + Math.abs(S.offW[1]) + Math.abs(S.offW[2]) < 1e-5) return o;
      var r = assign({}, o);
      if (air) { r.air = assign({}, o.air); r.air.px += S.offW[0]; r.air.py += S.offW[1]; r.air.pz += S.offW[2]; }
      else { r.s = wrapS(o.s + S.offT[0], L); r.dist = o.dist + S.offT[0]; r.lat = o.lat + S.offT[1]; }
      return r;
    }
    function posePuppetCircuit(car) {
      car.frozenUntil = 1e9; car.wrongT = 0; car.exc = null; car.progressT = car.ctx ? car.ctx.t : 0;
      var p = puppetSample(car), st = car.state;
      if (!p) { var hd = car._hold; st.x = hd.x; st.y = hd.y; st.heading = hd.heading; st.vx = 0; st.vy = 0; st.yawRate = 0; st.speed = 0; car.wvx = 0; car.wvy = 0; return; }
      var o = interpCircuit(unpackCircuit(p.a), unpackCircuit(p.b), p.u, p.dt);
      if (p.ext > 0) { o.x += o.vx * p.ext; o.y += o.vy * p.ext; o.h = wrapAngle(o.h + clamp(o.w, -2.5, 2.5) * p.ext); }
      st.x = o.x; st.y = o.y; st.heading = o.h;
      var c = Math.cos(o.h), s = Math.sin(o.h);
      st.vx = c * o.vx + s * o.vy; st.vy = -s * o.vx + c * o.vy;
      st.speed = Math.sqrt(o.vx * o.vx + o.vy * o.vy) * (st.vx < -0.3 ? -1 : 1);
      st.yawRate = o.w; if (isNum(o.rpm)) st.rpm = o.rpm;
      if (isNum(o.gear)) { st.gear = o.gear; if ('gearDisplay' in st) st.gearDisplay = o.gear; }
      st.steerAngle = num(o.steer, 0);
      st.skidding = o.skid ? 0.8 : 0;
      car.wvx = o.vx; car.wvy = o.vy;
      car.input = { throttle: num(o.thr, 0), brake: num(o.brk, 0), steer: 0, handbrake: !!o.handbrake };
    }

    /* ---------------- start ---------------- */
    function applyStart(st) {
      if (start) return;
      if (st.v !== VERSION || !st.arcade) { endSession('version', 'Version mismatch with the host (' + (st.v || '?') + ' vs ' + VERSION + ')'); return; }
      start = jclone(st) || st;
      grid = (start.grid || []).map(function (e) { return assign({}, e); });
      gridById = {}; peerToCar = {};
      grid.forEach(function (e) { gridById[e.carId] = e; if (e.peerId != null) peerToCar[e.peerId] = e.carId; });
      myCarId = start.you || null;
      myIdx = grid.map(function (e) { return e.carId; }).indexOf(myCarId);
      if (myIdx < 0) { endSession('spectator', 'This race started without you — you are in for the next one'); return; }
      kind = start.cfg.kind === 'stunt' || isStuntTrack(start.cfg.trackId) ? 'stunt' : 'circuit';
      if (!isHost && isNum(start.hn)) roughOff = start.hn - link.now() + 0.03;
      lastHostMsg = link.now();
      sim = buildSim();
      L = trackLength();
      if (isHost) grid.forEach(function (e) { if (e.kind === 'human' && e.carId !== myCarId) inbufs[e.carId] = new InputBuffer(); });
    }
    function humanEntry(peerId, name, build, idx) {
      var ext = (build && build.exterior) || {};
      return { carId: carIdOf(peerId), peerId: peerId, kind: 'human', name: name || 'Driver', team: '', build: build || null,
               number: String(ext.livery_number || idx + 1), color: ext.paint || '#b3121f', accent: ext.stripeColor || '#ffffff' };
    }
    function initHost() {
      var seed = isNum(cfg.seed) ? (cfg.seed >>> 0) : (Math.floor(Math.random() * 4294967296) >>> 0);
      var rng = mulberry32(seed);
      var hostBuild = cfg.build || cfg.playerBuild || defaultBuild();
      var humans = [humanEntry(link.id || 'host', cfg.name || 'Host', hostBuild, 0)];
      var players = Array.isArray(cfg.players) ? cfg.players : link.peers().map(function (id) { return { peerId: id }; });
      players.forEach(function (p) {
        if (!p || p.peerId == null || humans.length >= cfg.maxPlayers) return;
        if (humans.some(function (h) { return h.peerId === p.peerId; })) return;
        humans.push(humanEntry(p.peerId, p.name || ('Driver ' + (humans.length + 1)), p.build || null, humans.length));
      });
      var list = humans.slice();
      var aiCount = clamp(Math.round(num(cfg.ai, 0)), 0, Math.max(0, cfg.maxGrid - humans.length));
      if (aiCount > 0) {
        var A = CB.race && CB.race.ai, opps = null;
        if (A && typeof A.createGrid === 'function') {
          var orig = Math.random; Math.random = mulberry32((seed ^ 0x1234567) >>> 0);
          try { opps = A.createGrid(hostBuild, { count: aiCount, difficulty: cfg.difficulty || 'amateur', field: 'mixed', seed: seed }); } catch (e) { opps = null; }
          finally { Math.random = orig; }
        }
        var COLORS = ['#ff3b30', '#2f8bff', '#ffd23f', '#30e3a0', '#b64dff', '#ff8a1f', '#00c8ff', '#ff2fd6', '#9bff3a', '#ff5a7a'];
        for (var k = 0; k < aiCount; k++) {
          var o = (opps && opps[k]) || { name: 'AI ' + (k + 1), build: hostBuild, skill: 0.8 };
          list.push({ carId: 'ai' + (k + 1), peerId: null, kind: 'ai', name: o.name || 'AI ' + (k + 1), team: o.team || '', build: jclone(o.build) || hostBuild,
                      number: String(o.number != null ? o.number : humans.length + k + 1), color: o.color || (o.livery && (o.livery.primary || o.livery.color)) || COLORS[k % COLORS.length],
                      accent: o.accent || '#ffffff', skill: o.skill, aggression: o.aggression, consistency: o.consistency });
        }
      }
      // humans start at the back (classic arcade grid: AI ahead to chase), shuffled among themselves
      for (var i = humans.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = humans[i]; humans[i] = humans[j]; humans[j] = t; }
      list = list.filter(function (e) { return e.kind === 'ai'; }).concat(humans);
      var trackId = cfg.trackId || null;
      var kindS = isStuntTrack(trackId) ? 'stunt' : 'circuit';
      var arc = (CB.arcade && CB.arcade.mode && CB.arcade.mode.sanitize) ? CB.arcade.mode.sanitize(assign({}, cfg.arcade || {}, { trackId: trackId, mode: 'race', laps: cfg.laps, difficulty: cfg.difficulty || 'amateur' })) : (cfg.arcade || {});
      var scfg = {
        trackId: trackId, kind: kindS, laps: clamp(Math.round(num(cfg.laps, 3)), 1, 20), weather: cfg.weather || 'dry', timeOfDay: cfg.timeOfDay || 'day',
        difficulty: cfg.difficulty || 'amateur', arcade: arc, snapHz: clamp(num(cfg.snapHz, list.length > 5 ? 15 : 20), 5, 30),
        lightsOutDelay_s: isNum(cfg.lightsOutDelay_s) ? cfg.lightsOutDelay_s : Math.round((0.4 + rng() * 1.6) * 1000) / 1000
      };
      var st = { t: 'start', v: VERSION, arcade: true, seed: seed, t0: link.now() + num(cfg.leadIn_s, 3), cfg: scfg, grid: list };
      var hostEntry = list.filter(function (e) { return e.peerId === (link.id || 'host'); })[0];
      applyStart(assign({}, st, { you: hostEntry.carId }));
      list.forEach(function (e) { if (e.kind === 'human' && e.peerId !== hostEntry.peerId) link.send(e.peerId, 'rel', assign({}, st, { you: e.carId, hn: link.now() })); });
    }

    /* ---------------- host: events, snapshots, standings, race control ---------------- */
    function onHostEvent(e) {
      if (!e || e.type === 'spawn' || e.type === 'despawn') return;
      var o = {}; for (var k in e) if (k !== 'id') o[k] = e[k];
      o.carId = e.carId == null ? null : netIdOf(e.carId);
      ['by', 'other', 'target'].forEach(function (kk) { if (typeof o[kk] === 'string') o[kk] = netIdOf(o[kk]); });
      evQueue.push(o);
      if (evQueue.length > 200) evQueue.shift();
    }
    var lastRelayT = -1e9;
    function relayPeers() {
      var out = [];
      grid.forEach(function (e) { if (e.kind === 'human' && e.carId !== myCarId && e.peerId != null && !gone[e.carId] && link.modeOf(e.peerId) === 'relay') out.push(e.peerId); });
      return out;
    }
    /** the gameplay pack with net car ids (the host's own kart is 'player' locally) */
    function netPackOut() {
      var P = gp.netPack();
      (P.k || []).forEach(function (a) { a[0] = netIdOf(a[0]); });
      (P.d || []).forEach(function (a) { if (typeof a[7] === 'string') a[7] = netIdOf(a[7]); if (typeof a[10] === 'string') a[10] = netIdOf(a[10]); });
      return P;
    }
    function hostSnapshot(tRace, relayOnly) {
      var rows = [];
      grid.forEach(function (e, i) {
        var car = carsByLocal[localId(e.carId)];
        if (!car) { rows.push(0); return; }
        rows.push(kind === 'stunt' ? packStunt(i, car) : packCircuit(i, car));
      });
      var ack = {};
      Object.keys(inbufs).forEach(function (id) { var b = inbufs[id]; ack[id] = [b.known, b.E !== null ? b.E : b.D]; });   // the delay the host's copy really runs at
      var msg = { t: 'na.s', n: Math.round(sim.time() / STEP), rt: r3(tRace), ph: PHASES.indexOf(sim.getPhase ? sim.getPhase() : 'racing'), c: rows, a: ack };
      var relay = relayPeers();
      Object.keys(inbufs).forEach(function (id) { var e = gridById[id], rl = e && relay.indexOf(e.peerId) >= 0; inbufs[id].maxD = rl ? DEFAULTS.relayMaxD : DEFAULTS.maxD; inbufs[id].inHz = rl ? DEFAULTS.relayInputHz : DEFAULTS.inputHz; });
      stats.snapOut++;
      if (relayOnly) {   // relay links: every snapshot self-contained (pose + gameplay pack), at relaySnapHz
        if (gp) msg.g = netPackOut();
        relay.forEach(function (pid) { link.send(pid, 'fast', msg); });
        return;
      }
      if (gp && snapCount % 2 === 0) msg.g = netPackOut();
      snapCount++;
      if (!relay.length) { sendFast(msg); return; }
      grid.forEach(function (e) { if (e.kind === 'human' && e.carId !== myCarId && e.peerId != null && !gone[e.carId] && relay.indexOf(e.peerId) < 0) link.send(e.peerId, 'fast', msg); });
    }
    function standingsRows(tRace) {
      var rows = grid.map(function (e, i) {
        var v = carView(carsByLocal[localId(e.carId)]) || { dist: 0, lap: 0, fin: false };
        return { id: e.carId, i: i, lap: v.lap, dist: Math.round(num(v.dist, 0) * 10) / 10, fin: v.fin, ft: v.fin ? r3(v.ft) : null, best: r3(v.best), last: r3(v.last),
                 conn: !(gone[e.carId]), ai: e.kind === 'ai' || !!gone[e.carId], laps: v.laps || [], kind: e.kind };
      });
      rows.sort(function (a, b) {
        if (a.fin && b.fin) return a.ft - b.ft || a.i - b.i;
        if (a.fin !== b.fin) return a.fin ? -1 : 1;
        return b.dist - a.dist || a.i - b.i;
      });
      rows.forEach(function (rw, k) { rw.pos = k + 1; });
      return rows;
    }
    function hostTick(tRace) {
      var hz = start.cfg.snapHz || DEFAULTS.snapHz;
      if (tRace - lastSnapT >= 1 / hz - 1e-6) { lastSnapT = Math.max(lastSnapT + 1 / hz, tRace - 1 / hz); hostSnapshot(tRace, false); }
      if (tRace - lastRelayT >= 1 / DEFAULTS.relaySnapHz - 1e-6) { lastRelayT = tRace; if (relayPeers().length) hostSnapshot(tRace, true); }
      if (evQueue.length && tRace - lastEvT >= 1 / DEFAULTS.eventHz - 1e-6) { lastEvT = tRace; sendRel({ t: 'na.ev', ev: evQueue }); evQueue = []; }
      var rows = standingsRows(tRace);
      var phase = sim.getPhase ? sim.getPhase() : 'racing';
      standings = { t: 'na.st', rt: r3(tRace), phase: phase === 'finished' ? 'racing' : phase, goT: goTick !== null ? r3(goTick * STEP) : null, rows: rows };
      if (tRace - lastStT >= 1 / DEFAULTS.standingsHz - 1e-6) { lastStT = tRace; sendRel(standings); }
      // race control: done when every connected human is over the line, or finishWait_s after the first human finished
      var humans = rows.filter(function (rw) { return rw.kind === 'human' && rw.conn; });
      if (firstFinishT === null && rows.some(function (rw) { return rw.fin && rw.kind === 'human'; })) firstFinishT = tRace;
      var allIn = humans.length > 0 && humans.every(function (rw) { return rw.fin; });
      if (!finalResults && goTick !== null && (allIn || (firstFinishT !== null && tRace - firstFinishT > Math.max(cfg.finishWait_s, 0)))) finish(tRace);
    }
    function finish(tRace) {
      if (finalResults) return;
      var rows = standingsRows(tRace);
      standings = { t: 'na.st', rt: r3(tRace), phase: 'finished', rows: rows };
      finalResults = buildResults(rows, tRace);
      sendRel(standings);
      sendRel(finalResults);
      fireResults();
    }
    /** stunt special-feature stats of a host car (stunt-features.js car.feat) for the classification */
    function stuntStats(car) {
      if (!car) return null;
      var F = car.feat || {};
      return { stars: F.stars | 0, hazardHits: F.hz | 0, bumpers: F.bumps | 0, shortcuts: F.cuts | 0, fireRings: F.fire | 0, warps: F.warps | 0,
               falls: car.falls | 0, landings: car.landings | 0, airTime_s: r3(num(car.airTotal, 0)) };
    }
    function buildResults(rows, tRace) {
      var win = rows[0], st = {};
      if (gp) grid.forEach(function (e) { var s = gp.stats(localId(e.carId)); if (s) st[e.carId] = { hitsLanded: s.hitsLanded, hitsTaken: s.hitsTaken, itemsUsed: s.itemsUsed, coins: s.coins, boxes: s.boxes, blocked: s.blocked, nitroUsed_s: r3(s.nitroUsed_s), bestDrift: s.bestDrift, startGrade: s.startGrade || null }; });
      var fastest = null;
      rows.forEach(function (rw) { if (isNum(rw.best) && (!fastest || rw.best < fastest.time)) fastest = { carId: rw.id, time: rw.best, name: (gridById[rw.id] || {}).name }; });
      var cls = rows.map(function (rw, i) {
        var e = gridById[rw.id] || {}, status = rw.fin ? 'finished' : 'running', gap = null, gapText;   // not over the line when the race closed: classified by distance
        if (i === 0) gapText = rw.fin ? fmtTime(rw.ft) : 'Leader';
        else if (rw.fin && win.fin) { gap = rw.ft - win.ft; gapText = '+' + fmtTime(gap); }
        else { var down = Math.floor((num(win.dist, 0) - num(rw.dist, 0)) / L); gapText = down >= 1 ? '+' + down + (down === 1 ? ' Lap' : ' Laps') : '+' + Math.max(0, Math.round(win.dist - rw.dist)) + ' m'; }
        return { position: i + 1, id: rw.id, name: e.name + (gone[rw.id] ? ' (AI)' : ''), kind: gone[rw.id] ? 'ai' : e.kind, status: status, laps: rw.lap, raceTime_s: rw.fin ? rw.ft : null,
                 totalTime_s: rw.fin ? rw.ft : null, penalties_s: 0, gap_s: gap, gapText: gapText, bestLap_s: rw.best, lastLap_s: rw.last, lapTimes: rw.laps,
                 gridPosition: grid.indexOf(e) + 1, dnfReason: null, left: !!gone[rw.id], connected: rw.conn,
                 fastestLap: !!(fastest && fastest.carId === rw.id), arcade: st[rw.id] || null, stunt: kind === 'stunt' ? stuntStats(carsByLocal[localId(rw.id)]) : null };
      });
      return { t: 'results', v: VERSION, arcade: true, final: true, mode: 'race', lapsTotal: start.cfg.laps, trackLength_m: L, trackId: start.cfg.trackId, kind: kind,
               raceTime_s: goTick !== null ? Math.max(0, tRace - goTick * STEP) : 0, fastestLap: fastest, classification: cls, settings: start.cfg.arcade };
    }

    /* ---------------- inbound ---------------- */
    function onMessage(from, ch, m) {
      if (destroyed || !m || typeof m !== 'object' || typeof m.t !== 'string') return;
      if (!isHost) lastHostMsg = link.now();
      switch (m.t) {
        case 'start': if (!isHost && !start) applyStart(m); return;
        case 'na.in': {
          if (!isHost || !start) return;
          var id = peerToCar[from], b = id && inbufs[id];
          if (!b || gone[id] || !Array.isArray(m.a)) return;
          stats.inputIn++;
          b.push(m.a, m.n, Math.round(raceNow() / STEP), raceNow());
          return;
        }
        case 'na.s': if (!isHost && start) ingestSnapshot(m); return;
        case 'na.st': if (!isHost) standings = m; return;
        case 'na.ev': if (!isHost && start && Array.isArray(m.ev)) ingestEvents(m.ev); return;
        case 'results': if (!isHost && m.arcade && !finalResults) { finalResults = m; fireResults(); } return;
        case 'na.leave': if (!isHost && m.id && gridById[m.id] && !gone[m.id]) { gone[m.id] = { at: raceNow() }; note('net', (gridById[m.id].name || m.id) + ' left — AI takes the car', m.id); } return;
        case 'na.end': if (!isHost) endSession(m.reason || 'host-ended', m.message || 'The host ended the session'); return;
        case 'na.quit': case 'bye': if (isHost) peerLeft(from, 'left'); else if (m.t === 'bye') endSession('host-left', 'The host left — session ended'); return;
        default: return;
      }
    }
    function ingestSnapshot(m) {
      if (!isNum(m.n) || m.n <= lastSnapN) return;
      lastSnapN = m.n; stats.snapIn++;
      var t = m.n * STEP, now = raceNow(), late = now - t;
      if (snapLate === null) snapLate = late; else snapLate += (late - snapLate) * (late > snapLate ? 0.2 : 0.04);
      snapJit += (Math.abs(late - snapLate) - snapJit) * 0.08;
      var hz = start.cfg.snapHz || 20;
      var rl = link.mode() === 'relay', lo = rl ? DEFAULTS.relayInterp[0] : 0.06, hi = rl ? DEFAULTS.relayInterp[1] : 0.4;
      // how old the newest snapshot had become when this one arrived (fast attack, slow release): the playhead
      // must stay that far behind to never run past the newest snapshot (bursty server-relay links)
      if (snaps.length) { var dry = now - snaps[snaps.length - 1].t; snapDry = snapDry ? snapDry + (dry - snapDry) * (dry > snapDry ? 0.5 : 0.04) : dry; }
      var target = clamp(Math.max(snapLate + 2 * snapJit + 1.2 / (rl ? DEFAULTS.relaySnapHz : hz), snapDry + 0.02 + snapJit), lo, hi);
      interpTarget = target;   // update() slews interpDelay towards it every frame (a step here made the cars jump)
      snaps.push({ t: t, rows: m.c || [] });
      while (snaps.length > 3 && snaps[1].t < t - 1.5) snaps.shift();
      var a = m.a && m.a[myCarId];
      if (a) { ackTick = Math.max(ackTick, num(a[0], -1)); }
      var mine = m.c && m.c[myIdx];
      if (a && mine && isNum(a[1])) reconcile(mine, m.n, a[1]);
      if (m.g && gp && typeof gp.netApply === 'function') gp.netApply(m.g, { map: localId, self: 'player', age: Math.max(0, now - t) });
      if (isNum(m.ph) && PHASES[m.ph] === 'racing' && goTick === null) { /* our sim reaches GO on its own clock */ }
    }
    function ingestEvents(list) {
      var out = [];
      list.forEach(function (e) {
        if (!e || !e.type) return;
        var o = assign({}, e);
        o.carId = e.carId == null ? null : localId(e.carId);
        ['by', 'other', 'target'].forEach(function (k) { if (typeof o[k] === 'string') o[k] = localId(o[k]); });
        var mine = o.carId === 'player';
        if (mine && (OWN_PREDICTED[o.type] || (o.type === 'boost' && OWN_BOOSTS[o.kind]))) return;
        if (mine && o.type === 'hit' && gp) gp.applyHit('player', o.kind);
        if (mine && o.type === 'blocked' && gp) { var K = gp.kart('player'); if (K) K.shieldT = 0; }
        out.push(o);
      });
      if (out.length && gp && typeof gp.pushEvents === 'function') gp.pushEvents(out);
    }
    function peerLeft(peerId, reason) {
      var id = peerToCar[peerId];
      if (!id || gone[id]) return;
      gone[id] = { at: raceNow(), reason: reason || 'left' };
      if (gp) gp.setNet({ humans: grid.filter(function (e) { return e.kind === 'human' && e.carId !== myCarId && !gone[e.carId]; }).map(function (e) { return e.carId; }) });
      var car = carsByLocal[id];
      if (car) car.humanAssist = null;   // the host's AI drives it from here
      note('net', ((gridById[id] && gridById[id].name) || id) + ' left — AI takes the car', id);
      sendRel({ t: 'na.leave', id: id, reason: reason || 'left' });
    }
    function endSession(reason, message) {
      if (ended) return;
      ended = { reason: reason, message: message, at: start ? raceNow() : 0 };
      note('net', message, null);
      endFns.slice().forEach(function (fn) { try { fn(ended); } catch (e) { /* ignore */ } });
    }
    function fireResults() { resultsFns.slice().forEach(function (fn) { try { fn(api.results()); } catch (e) { /* ignore */ } }); }

    /* ---------------- client: send inputs ---------------- */
    function clientSend(tRace) {
      if (!changes.length) return;
      if (tRace - lastInSendT < 1 / (link.mode() === 'relay' ? DEFAULTS.relayInputHz : DEFAULTS.inputHz) - 1e-6) return;
      lastInSendT = tRace;
      // keep the newest change at or before the host's ack as the base, drop older ones
      var k = 0;
      while (k + 1 < changes.length && changes[k + 1][0] <= ackTick) k++;
      if (k > 0) changes.splice(0, k);
      var a = changes.length > 80 ? changes.slice(-80) : changes;
      stats.inputOut++;
      link.send('fast', { t: 'na.in', n: curTick, a: a });
    }

    /* ---------------- update ---------------- */
    function update(dt, input) {
      if (destroyed) return 0;
      updateClock();
      if (!isHost && !ended && start && link.now() - lastHostMsg > cfg.hostTimeout_s && link.state() !== 'open') endSession('host-timeout', 'Lost connection to the host — session ended');
      if (!start || !sim) return 0;
      var tNow = raceNow();
      // the session's own clock is time() + the unstepped remainder (alpha · STEP): feeding tNow − time() alone counts
      // that remainder twice, so substeps per frame came out 3,1,2,2,3,1 … and every car juddered (worst on guests,
      // whose race clock also follows the host clock estimate)
      var simT = sim.time() + (typeof sim.alpha === 'function' ? clamp01(num(safe(function () { return sim.alpha(); }, 0), 0)) * STEP : 0);
      var feed = ended ? clamp(num(dt, 0), 0, 0.5) : clamp(tNow - simT, 0, 0.5);
      if (!isHost && interpTarget !== null) {   // playback rate changes by at most -12 % / +35 % while the buffer adapts
        if (stats.snapIn <= 1) interpDelay = interpTarget;
        else interpDelay += clamp(interpTarget - interpDelay, -0.12 * feed, 0.35 * feed);
      }
      var n = feed > 0 ? (sim.update(feed, input || {}) || 0) : 0;
      var tRace = sim.time();
      if (!ended) {
        if (isHost) { if (!finalResults) hostTick(tRace); }
        else clientSend(tRace);
      }
      return n;
    }

    /* ---------------- snapshot / results ---------------- */
    function snapshot() {
      if (!sim) return { t: 0, phase: 'grid', countdown: { lightsOn: 0, lightsOut: false, goTime: null }, lapsTotal: start ? start.cfg.laps : 0, mode: 'race', cars: [], order: [], events: drain(), net: netSummary(), netMode: true };
      var snap = sim.snapshot();
      if (visQueue.length) {
        var tk = Math.round(sim.time() / STEP);
        visQueue = visQueue.filter(function (q) { if (q.tick >= tk) return true;   // shown once the held step is the drawn (previous-substep) pose
        addVis(q.w, q.t, q.id); return false; });
      }
      var rows = {}, srows = standings && standings.rows ? standings.rows : null;
      if (srows) srows.forEach(function (rw) { rows[rw.id] = rw; });
      (snap.cars || []).forEach(function (c) {
        var netId = c.isPlayer ? myCarId : c.id, e = gridById[netId], rw = rows[netId];
        c.netId = netId; c.kind = e ? (gone[netId] ? 'ai' : e.kind) : 'ai';
        if (kind === 'stunt' && visBy[c.id]) applyVis(c, c.id, carsByLocal[c.id]);
        if (!c.isPlayer) { c.remote = !isHost || (e && e.kind === 'human'); c.opacity = 1; }
        if (e && e.number != null) c.number = String(e.number);
        if (rw) {
          c.position = rw.pos;
          if (!c.isPlayer && !isHost) { c.lap = rw.lap; c.finished = !!rw.fin; c.finishTime_s = rw.ft; c.bestLap_s = rw.best; c.lastLap_s = rw.last; }
          if (rw.fin) c.finishPosition = rw.pos;
        }
      });
      if (srows) {
        var order = [];
        srows.forEach(function (rw) { var id = localId(rw.id); if ((snap.cars || []).some(function (c) { return c.id === id; })) order.push(id); });
        snap.order = order; snap.leaderId = order[0] || null;
      }
      snap.events = (snap.events || []).concat(drain());
      if (ended || finalResults) snap.phase = 'finished';
      else if (snap.phase === 'finished') snap.phase = 'racing';
      snap.netMode = true; snap.arcadeNet = true;
      snap.net = netSummary();
      return snap;
    }
    function drain() { var p = pending; pending = []; return p; }
    function netSummary() {
      return { role: role, mode: 'race', arcade: true, kind: kind, carId: myCarId, phase: finalResults || ended ? 'finished' : null, raceTime: r3(raceNow()),
               ping_ms: isHost ? 0 : Math.round(link.rtt() * 1000), final: !!finalResults, ended: ended ? assign({}, ended) : null,
               message: ended ? ended.message : null, players: grid.filter(function (e) { return e.kind === 'human'; }).length };
    }
    function provisional() {
      if (!standings || !standings.rows) return null;
      return { final: false, mode: 'race', arcade: true, classification: standings.rows.map(function (rw, i) {
        var e = gridById[rw.id] || {};
        return { position: i + 1, id: rw.id, name: e.name, kind: e.kind, status: rw.fin ? 'finished' : 'running', laps: rw.lap, raceTime_s: rw.ft, totalTime_s: rw.ft,
                 bestLap_s: rw.best, lastLap_s: rw.last, gapText: i === 0 ? 'Leader' : '' };
      }) };
    }
    function results() {
      var local = sim ? safe(function () { return sim.results(); }, null) : null;
      var out = local ? assign({}, local) : { mode: 'race', classification: [] };
      var src = finalResults || provisional();
      if (src && Array.isArray(src.classification)) {
        out.classification = src.classification.map(function (rw) {
          var e = gridById[rw.id] || {}, mine = rw.id === myCarId;
          return assign({ number: e.number, color: e.color, accent: e.accent, team: e.team || '', bodyStyle: e.build && e.build.body ? e.build.body.style : undefined },
                        rw, { id: mine ? 'player' : rw.id, netId: rw.id, isPlayer: mine });
        });
        out.player = out.classification.filter(function (rw) { return rw.isPlayer; })[0] || null;
        out.fastestLap = src.fastestLap ? assign({}, src.fastestLap, { carId: localId(src.fastestLap.carId) }) : null;
        if (isNum(src.raceTime_s)) out.raceTime_s = src.raceTime_s;
      }
      out.mode = 'race'; out.netMode = 'arcade'; out.handling = 'arcade';
      out.arcade = assign({}, out.arcade || {}, { kind: kind, net: true, settings: start ? start.cfg.arcade : null });
      out.complete = !!finalResults; out.final = !!finalResults; out.aborted = !!(ended && !finalResults);
      out.message = ended ? ended.message : null;
      out.net = { role: role, carId: myCarId, seed: start ? start.seed : null, arcade: true };
      return out;
    }
    function netState() {
      var now = raceNow();
      var players = grid.map(function (e) {
        var local = e.carId === myCarId, b = inbufs[e.carId];
        var ping = local ? (isHost ? 0 : Math.round(link.rtt() * 1000)) : (isHost && e.peerId != null && link.rttOf ? (link.rttOf(e.peerId) !== null ? Math.round(link.rttOf(e.peerId) * 1000) : null) : null);
        return { carId: e.carId, peerId: e.peerId, name: e.name, kind: gone[e.carId] ? 'ai' : e.kind, isLocal: local, connected: !gone[e.carId], ping_ms: ping,
                 via: isHost && !local && e.peerId != null && e.kind === 'human' ? link.modeOf(e.peerId) : null,
                 inputDelay_ms: b ? Math.round(b.D * STEP * 1000) : null, starved: b ? b.starved : null };
      });
      var rtt = isHost ? 0 : link.rtt();
      var quality = rtt > 0.25 ? 'poor' : rtt > 0.12 ? 'fair' : 'good';
      return {
        role: role, version: VERSION, arcade: true, kind: kind, started: !!start, via: isHost ? null : link.mode(), connected: isHost ? true : link.state() === 'open', state: isHost ? 'open' : link.state(),
        mode: 'race', carId: myCarId, spectator: false, seed: start ? start.seed : null, raceTime: r3(now), phase: ended || finalResults ? 'finished' : sim ? 'racing' : 'waiting',
        ping_ms: Math.round(rtt * 1000), clockReady: isHost || clockOff !== null, players: players,
        sync: { quality: quality, interpDelay_ms: Math.round(interpDelay * 1000), corrections: stats.corrections, snaps: stats.snaps, maxErr_m: r3(stats.maxErr),
                snapshotsIn: stats.snapIn, snapshotsOut: stats.snapOut, inputsIn: stats.inputIn, inputsOut: stats.inputOut },
        ended: ended ? assign({}, ended) : null, final: !!finalResults
      };
    }

    /* ---------------- wiring ---------------- */
    link.onMessage(onMessage);
    if (isHost) link.onLeave(function (peerId, reason) { peerLeft(peerId, reason); });
    else link.onClose(function (reason) {
      if (destroyed) return;
      var msg = reason === 'kicked' ? 'You were removed by the host' : reason === 'host-closed' ? 'The host closed the room — session ended' : 'Lost connection to the host — session ended';
      if (!finalResults || reason === 'kicked') endSession(reason === 'host-closed' ? 'host-left' : reason || 'closed', msg);
    });

    var api = {
      netRole: role, VERSION: VERSION, STEP: STEP, isArcadeNet: true,
      get arcadeKind() { return kind; },
      get geom() { return sim ? sim.geom : null; },
      get trackDef() { return sim ? sim.trackDef : null; },
      get track() { return sim ? (kind === 'stunt' ? sim.track : sim.trackDef) : null; },
      get config() { return sim ? assign({}, sim.config, { net: true, netMode: 'race', arcadeNet: true }) : { net: true, netMode: 'race', arcadeNet: true }; },
      get engine() { return sim ? (sim.engine || sim) : null; },
      get arcade() { return sim ? sim.arcade : null; },
      get gameplay() { return gp; },
      get mode() { return 'race'; },
      get wantsRawInput() { return false; },
      update: update, snapshot: snapshot, results: results, netState: netState,
      restart: function () { return api; },
      resetPlayerToTrack: function () { /* no manual resets in a multiplayer race (stunt falls respawn on their own) */ },
      setAssists: function () {},
      setAssistLevel: function () { return 'off'; },   // arcade: no steering assist
      getAssistLevel: function () { return 'off'; },
      setPlayerAutopilot: function (on) { autopilot = !!on; if (sim && typeof sim.setPlayerAutopilot === 'function') sim.setPlayerAutopilot(autopilot); },
      playerState: function () { return sim && typeof sim.playerState === 'function' ? sim.playerState() : null; },
      setButtons: function (b) { buttons = b ? assign({}, b) : null; if (gp && b) gp.setInput({ nitro: !!b.nitro, item: !!b.item, aimBack: !!b.aimBack }); },
      time: function () { return sim ? sim.time() : 0; },
      alpha: function () { return sim && typeof sim.alpha === 'function' ? sim.alpha() : 0; },
      getPhase: function () { return ended || finalResults ? 'finished' : sim ? (sim.getPhase() === 'finished' ? 'racing' : sim.getPhase()) : 'waiting'; },
      isFinished: function () { return !!(finalResults || ended); },
      fmtTime: fmtTime,
      end: function () { if (isHost && start && !finalResults) finish(raceNow()); },
      onResults: function (fn) { resultsFns.push(fn); return function () { var i = resultsFns.indexOf(fn); if (i >= 0) resultsFns.splice(i, 1); }; },
      onEnd: function (fn) { endFns.push(fn); return function () { var i = endFns.indexOf(fn); if (i >= 0) endFns.splice(i, 1); }; },
      destroy: function () {
        if (destroyed) return;
        if (isHost && start && !finalResults) sendRel({ t: 'na.end', reason: 'host-left', message: 'The host left — session ended' });
        else if (!isHost && start && !ended) sendRel({ t: 'na.quit' });
        destroyed = true; link.close(); resultsFns = []; endFns = [];
        if (sim && sim.arcade && typeof sim.arcade.destroy === 'function') safe(function () { sim.arcade.destroy(); });
      },
      _debug: function () { return { start: start, sim: sim, gp: gp, grid: grid, inbufs: inbufs, gone: gone, standings: standings, stats: stats, cars: carsByLocal, raceNow: raceNow, hist: hist, interpDelay: interpDelay, interpTarget: interpTarget, snaps: snaps, kind: kind, goTick: goTick, pendingCorr: pendingCorr, vis: visBy }; }
    };

    if (isHost) initHost();
    else if (cfg.start && isArcadeStart(cfg.start)) applyStart(cfg.start);
    return api;
  }

  function isArcadeStart(m) { return !!(m && typeof m === 'object' && m.t === 'start' && m.arcade === true); }
  function waitForStart(client, fn) {
    var done = false, off = onOf(client, 'message', function (ch, m) {
      if (done || !isArcadeStart(m)) return;
      done = true; off();
      try { fn(m); } catch (e) { /* ignore */ }
    });
    return function () { done = true; off(); };
  }

  CB.net.arcade = {
    VERSION: VERSION, DEFAULTS: DEFAULTS, isArcadeStart: isArcadeStart, waitForStart: waitForStart,
    createHostSession: function (host, cfg) { return createSession(host, cfg, 'host'); },
    createClientSession: function (client, cfg) { return createSession(client, cfg, 'peer'); },
    _internal: { InputBuffer: InputBuffer, quantInput: quantInput, inputOf: inputOf, packStunt: packStunt, unpackStunt: unpackStunt, packCircuit: packCircuit,
                 unpackCircuit: unpackCircuit, interpStunt: interpStunt, interpCircuit: interpCircuit, capAssist: capAssist, stuntAssist: stuntAssist }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.net.arcade;

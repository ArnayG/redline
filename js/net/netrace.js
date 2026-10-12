/* ==========================================================================
   FORGE Atelier — js/net/netrace.js
   CB.net.race : multiplayer race / drift-battle / free-roam sessions over CB.net.transport (docs/NET-SPEC.md).
   Pure logic (no DOM). Classic <script> in browsers, require()-able in Node.

   Model (host authoritative, star topology):
     - every peer runs its OWN local CB.race.engine (or CB.race.drift) session with its own build as the player car;
       every other car in that session is a "puppet": the engine car exists (so renderer / HUD / collisions / lap
       tracking work unchanged) but after every physics substep its pose is overwritten (engine hook postStep) from a
       jitter buffer of received network states (Hermite interpolation ~100 ms behind, bounded extrapolation,
       smoothed corrections). Puppets therefore act as kinematic obstacles: the engine's own car-vs-car contact pushes
       the local car out (mass-weighted, so each side resolves its half of the same contact — symmetric enough to feel fair).
     - all engines share the seed, grid order, lights timing (grid / interval / random hold chosen by the host) and a
       common race clock (host clock − t0, via the transport clock offset), so the lights go out together everywhere.
     - each peer streams its car at sendHz (binary CB.net.transport.packStates on 'fast') plus 5 Hz aux info
       (lap, race distance, penalties, drift score); the host relays everything to everyone else.
     - the host runs race control: grid (N humans + optional AI fill simulated on the host and broadcast), lights,
       laps (client claims validated against positions the host itself observes), positions / gaps / penalties /
       finish / timeout, final results (broadcast `results`). Drift battle and free roam likewise.

   API
     CB.net.race.createHostSession(host, cfg)   host = CB.net.transport Host (T.host(signal) / loopback.host())
       cfg: { mode 'race'|'drift'|'free', trackId, laps, weather, timeOfDay, ai (AI fill count), difficulty, field,
              build (host's), name, players: [{peerId, name, build}] (default: every open peer, default build),
              seed, gridOrder 'random'|'given', leadIn_s 3, lightsOutDelay_s (default seeded 0.4..2.8),
              assists (host's own), assistsAllowed {abs,tc,autoShift,racingLine,steeringAssist} (booleans; false forbids),
              drift: {format 'auto'|'tandem'|'attack', runs 2, runTime_s 60, startDelay_s 3, interRun_s 5,
                      assistLevel, tuneLevel},
              finishTimeout_s, maxPlayers 8, sendHz 25, interpDelay_s 0.1, maxExtrap_s 0.3, autopilot,
              hooks (extra engine hooks, e.g. race-ui's assist preStep), resolvePlayer(peerId) -> {name, build} }
       Sends `start` to every player immediately (t0 = host now + leadIn_s).
     CB.net.race.createClientSession(client, cfg)  client = CB.net.transport Client (T.connect(signal) / loopback.connect())
       cfg: { start (the host's `start` message, if the caller already received it), build, name, assists,
              assistLevel, tuneLevel, autopilot, hooks }   Without cfg.start the session waits for it (snapshot() then
              returns an empty 'grid' snapshot and geom is null until it arrives — prefer passing start).
     CB.net.race.waitForStart(client, fn(startMsg)) -> unsubscribe
     Session surface (same as engine sessions so race-ui / renderer3d / hud work unchanged):
       update(dt, input) -> substeps, snapshot(), results(), restart() (no-op: net sessions cannot restart),
       destroy(), resetPlayerToTrack(), setAssists(a), setAssistLevel(l), setPlayerAutopilot(on), playerState(),
       scorerState(), assistDebug(), time(), alpha(), getPhase(), isFinished(), end() (host: finish now),
       geom, trackDef, track, config, wantsRawInput (true for drift: feed race-ui's raw key intent),
       netState() -> {role, connected, ping_ms, clockOffset_ms, players:[…], sync:{…}, phase, ended, final},
       onResults(fn) -> unsubscribe (fires when the host's final results arrive), onEnd(fn) (host left / kicked),
       addPlayer(peerId, {name, build}) (host: late joiner details for free roam), rng() (shared seeded RNG).
     snapshot() is the engine snapshot (RACE-SPEC contract) with: positions / gaps / laps / finish of remote cars from
       the host's standings, remote cars flagged {remote, netId, kind, ghost, disconnected, opacity}, snap.net {…}.
     results() is engine-results shaped; classification comes from the host (complete === true once final).

   Messages (rel, JSON): start{v, seed, t0, hn, cfg, grid, you, spectator, epoch} · lights{n} · go{t} ·
     lap{id, lap, time, valid, sectors} · finish{id, time, laps, penalties} · results{…} · nr.st (standings 5 Hz) ·
     nr.score{id, run, total} · nr.join{entry} · nr.leave{id, reason} · nr.end{reason, message} · nr.quit{}.
   Fast: packed car states (CB.net.transport.packStates; JSON {t:'nr.s', s:[…]} fallback) · nr.aux{a:[[…]]}.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.net = CB.net || {};

(function () {
  'use strict';

  var VERSION = 'forge-net-race/1';
  var STEP = 1 / 120;
  var STEER_SCALE = 0.75;              // rad per unit of the packed (−1..1) steer field
  var DEFAULTS = {
    sendHz: 25, auxHz: 5, standingsHz: 5, interpDelay_s: 0.1, maxDelay_s: 0.35, maxExtrap_s: 0.3,
    staleAfter_s: 1.0, ghost_s: 3, leadIn_s: 3, hostTimeout_s: 12, maxPlayers: 8, maxGrid: 11, claimWait_s: 6,
    gridTime_s: 1.5, lightInterval_s: 1.0
  };
  var FL = { handbrake: 1, braking: 2, skid: 4, spin: 8, offTrack: 16, finished: 32, dnf: 64 };
  var GAP_B = 5, GAP_OFF = 1500;       // race-control distance->time history (m)
  var MODES = ['race', 'drift', 'free'];

  /* ======================================================================
     Small helpers
     ====================================================================== */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wrapAngle(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }
  function r(v, d) { if (!isNum(v)) return v; var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }
  function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; } return t; }
  function jclone(o) { if (o == null) return o; try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; } }
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  function safe(fn, d) { try { var v = fn(); return v === undefined ? d : v; } catch (e) { return d; } }
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
  function TP() { return (CB.net && CB.net.transport) || null; }
  function defaultBuild() {
    var D = CB.data;
    if (D && typeof D.defaultBuild === 'function') { try { return D.defaultBuild(); } catch (e) { /* ignore */ } }
    return null;
  }

  /* ======================================================================
     Packing (binary via CB.net.transport, JSON fallback)
     ====================================================================== */
  function packList(states) {
    var T = TP();
    if (T && typeof T.packStates === 'function') { try { return T.packStates(states); } catch (e) { /* JSON below */ } }
    return { t: 'nr.s', s: states.map(function (s) { return [s.id, r(s.t, 1), r(s.x, 3), r(s.y, 3), r(s.heading, 4), r(s.vx, 2), r(s.vy, 2), r(s.yawRate, 3), r(s.steer, 3), r(s.throttle, 2), r(s.brake, 2), s.gear, Math.round(s.rpm), s.flags]; }) };
  }
  function unpackAny(data) {
    if (!data) return null;
    if (typeof data === 'object' && data.t === 'nr.s' && Array.isArray(data.s)) {
      return data.s.map(function (a) { return { id: a[0], t: a[1], x: a[2], y: a[3], heading: a[4], vx: a[5], vy: a[6], yawRate: a[7], steer: a[8], throttle: a[9], brake: a[10], gear: a[11], rpm: a[12], flags: a[13] }; });
    }
    var bin = (typeof ArrayBuffer !== 'undefined') && (data instanceof ArrayBuffer || ArrayBuffer.isView(data));
    if (!bin) return null;
    var T = TP();
    if (!T || typeof T.isStates !== 'function' || !T.isStates(data)) return null;
    try { return T.unpackStates(data); } catch (e) { return null; }
  }

  /* ======================================================================
     Transport adapters (CB.net.transport Host / Client, see transport.js)
     ====================================================================== */
  function onOf(obj, type, fn) {
    if (obj && typeof obj.on === 'function') {
      var off = obj.on(type, fn);
      return typeof off === 'function' ? off : function () { if (typeof obj.off === 'function') obj.off(type, fn); };
    }
    return function () {};
  }
  function hostLink(H) {
    if (!H || typeof H.on !== 'function') throw new Error('CB.net.race: host transport required (CB.net.transport.host / loopback().host())');
    var offs = [];
    var L = { role: 'host', id: H.id || 'host' };
    L.now = function () { return (typeof H.now === 'function' ? H.now() : Date.now()) / 1000; };
    L.send = function (id, ch, data) { try { return typeof H.send === 'function' ? H.send(id, ch, data) : false; } catch (e) { return false; } };
    L.broadcast = function (ch, data, except) { try { return typeof H.broadcast === 'function' ? H.broadcast(ch, data, except) : 0; } catch (e) { return 0; } };
    L.peers = function () { return (typeof H.list === 'function' ? H.list() : []).filter(function (p) { return p && p.state !== 'closed'; }).map(function (p) { return p.id; }); };
    L.peer = function (id) { return typeof H.get === 'function' ? H.get(id) : null; };
    L.rttOf = function (id) { var p = L.peer(id); return p && isNum(p.rtt) && p.rtt > 0 ? p.rtt / 1000 : null; };
    L.stateOf = function (id) { var p = L.peer(id); return p ? p.state : 'closed'; };
    L.onMessage = function (fn) { offs.push(onOf(H, 'message', function (peer, ch, data) { fn(peer && peer.id != null ? peer.id : peer, ch, data); })); };
    L.onJoin = function (fn) { offs.push(onOf(H, 'peer', function (peer) { fn(peer && peer.id != null ? peer.id : peer); })); };
    L.onLeave = function (fn) { offs.push(onOf(H, 'peer-leave', function (peer, reason) { fn(peer && peer.id != null ? peer.id : peer, reason); })); };
    L.onPeerState = function (fn) { offs.push(onOf(H, 'peer-state', function (peer, st) { fn(peer && peer.id != null ? peer.id : peer, st); })); };
    L.onClose = function (fn) { offs.push(onOf(H, 'close', fn)); };
    L.close = function () { offs.forEach(function (o) { try { o(); } catch (e) { /* ignore */ } }); offs = []; };
    return L;
  }
  function clientLink(C) {
    if (!C || typeof C.on !== 'function' || typeof C.send !== 'function') throw new Error('CB.net.race: client transport required (CB.net.transport.connect / loopback().connect())');
    var offs = [];
    var L = { role: 'peer', id: C.selfId || C.id || null };
    L.now = function () { return (typeof C.now === 'function' ? C.now() : Date.now()) / 1000; };
    L.offsetReady = function () { return isNum(C.rtt) && C.rtt > 0 && isNum(C.clockOffset); };
    L.offset = function () { return num(C.clockOffset, 0) / 1000; };
    L.rtt = function () { return isNum(C.rtt) ? C.rtt / 1000 : 0; };
    L.state = function () { return C.state || 'open'; };
    L.send = function (ch, data) { try { return C.send(ch, data); } catch (e) { return false; } };
    L.onMessage = function (fn) { offs.push(onOf(C, 'message', function (ch, data) { fn('host', ch, data); })); };
    L.onClose = function (fn) { offs.push(onOf(C, 'close', fn)); };
    L.onState = function (fn) { offs.push(onOf(C, 'state', fn)); };
    L.close = function () { offs.forEach(function (o) { try { o(); } catch (e) { /* ignore */ } }); offs = []; };
    return L;
  }

  /* ======================================================================
     RemoteTrack: jitter buffer + interpolation / bounded extrapolation + smoothed corrections
     ====================================================================== */
  function RemoteTrack(o) {
    this.base = num(o.base, DEFAULTS.interpDelay_s);
    this.maxDelay = num(o.maxDelay, DEFAULTS.maxDelay_s);
    this.maxExtrap = num(o.maxExtrap, DEFAULTS.maxExtrap_s);
    this.hz = num(o.hz, DEFAULTS.sendHz);
    this.reset();
  }
  RemoteTrack.prototype.reset = function () {
    this.buf = []; this.late = null; this.jit = 0; this.delay = this.base; this.target = this.base;
    this.prevT = null; this.prevRt = null; this.prevRaw = null; this.cx = 0; this.cy = 0; this.ch = 0;
    this.received = 0; this.firstT = null; this.lastT = null; this.lastArrival = -Infinity; this.extrap = 0; this.maxExtrapSeen = 0;
  };
  /** s: {t (race s), x, y, h, vx, vy, w, steer, thr, brk, gear, rpm, flags}; now: receiver race time (s) */
  RemoteTrack.prototype.push = function (s, now) {
    if (!isNum(s.t) || !isNum(s.x) || !isNum(s.y) || !isNum(s.h)) return false;
    var b = this.buf, n = b.length;
    if (n && s.t <= b[0].t) return false;                      // older than the whole window
    var i = n;
    while (i > 0 && b[i - 1].t > s.t) i--;
    if (i > 0 && Math.abs(b[i - 1].t - s.t) < 1e-6) return false; // duplicate
    b.splice(i, 0, s);
    var newest = b[b.length - 1].t;
    while (b.length > 3 && b[1].t < newest - 1.5) b.shift();
    this.received++;
    if (this.firstT === null || s.t < this.firstT) this.firstT = s.t;
    if (this.lastT === null || s.t > this.lastT) this.lastT = s.t;
    this.lastArrival = now;
    var late = now - s.t;
    if (isNum(late)) {
      if (this.late === null) this.late = late;
      else this.late += (late - this.late) * (late > this.late ? 0.2 : 0.04);
      this.jit += (Math.abs(late - this.late) - this.jit) * 0.08;
      this.target = clamp(Math.max(this.base, this.late + 2 * this.jit + 0.5 / this.hz), this.base, this.maxDelay);
    }
    return true;
  };
  function hermite(a, b, rt) {
    var dt = b.t - a.t;
    if (!(dt > 1e-6)) return assign({}, b);
    var u = clamp((rt - a.t) / dt, 0, 1), o = assign({}, u < 0.5 ? a : b);
    var dh = wrapAngle(b.h - a.h);
    if (dt > 0.6) {                                            // long gap (loss): plain lerp, velocities are stale
      o.x = lerp(a.x, b.x, u); o.y = lerp(a.y, b.y, u); o.h = wrapAngle(a.h + dh * u);
    } else {
      var u2 = u * u, u3 = u2 * u;
      var h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      o.x = h00 * a.x + h10 * dt * a.vx + h01 * b.x + h11 * dt * b.vx;
      o.y = h00 * a.y + h10 * dt * a.vy + h01 * b.y + h11 * dt * b.vy;
      o.h = wrapAngle(a.h + h10 * dt * a.w + h01 * dh + h11 * dt * b.w);
    }
    o.vx = lerp(a.vx, b.vx, u); o.vy = lerp(a.vy, b.vy, u); o.w = lerp(a.w, b.w, u);
    o.thr = lerp(a.thr, b.thr, u); o.brk = lerp(a.brk, b.brk, u); o.steer = lerp(a.steer, b.steer, u);
    o.rpm = lerp(a.rpm, b.rpm, u);
    return o;
  }
  function extrapolate(s, e) {
    var w = clamp(s.w, -2.5, 2.5), th = w * e, hm = th / 2, c = Math.cos(hm), sn = Math.sin(hm);
    var o = assign({}, s);
    o.x = s.x + (c * s.vx - sn * s.vy) * e;
    o.y = s.y + (sn * s.vx + c * s.vy) * e;
    o.h = wrapAngle(s.h + th);
    var c2 = Math.cos(th), s2 = Math.sin(th);
    o.vx = c2 * s.vx - s2 * s.vy; o.vy = s2 * s.vx + c2 * s.vy;
    return o;
  }
  /** Raw (uncorrected) pose at render time rt. */
  RemoteTrack.prototype.rawAt = function (rt) {
    var b = this.buf, n = b.length;
    if (!n) return null;
    var last = b[n - 1];
    if (rt >= last.t) {
      var e = rt - last.t;
      this.extrap = e;
      if (e > this.maxExtrapSeen) this.maxExtrapSeen = e;
      return extrapolate(last, Math.min(e, this.maxExtrap));
    }
    this.extrap = 0;
    if (rt <= b[0].t) return assign({}, b[0]);
    var i = n - 2;
    while (i > 0 && b[i].t > rt) i--;
    return hermite(b[i], b[i + 1], rt);
  };
  /** Displayed pose at local race time T (interpolation delay slews smoothly towards its adaptive target). */
  RemoteTrack.prototype.sample = function (T) {
    if (!this.buf.length) return null;
    var dt = this.prevT === null ? 0 : clamp(T - this.prevT, 0, 0.25);
    if (this.prevT === null) this.delay = this.target;
    else this.delay += clamp(this.target - this.delay, -0.2 * dt, 0.2 * dt);
    var rt = T - this.delay;
    var raw = this.rawAt(rt);
    if (!raw) return null;
    if (this.prevRaw && this.prevT !== null && dt > 0) {
      var drt = rt - this.prevRt, p = this.prevRaw;
      var jx = raw.x - (p.x + p.vx * drt), jy = raw.y - (p.y + p.vy * drt), jh = wrapAngle(raw.h - (p.h + p.w * drt));
      if (Math.abs(jx) + Math.abs(jy) > 0.02 || Math.abs(jh) > 0.01) { this.cx -= jx; this.cy -= jy; this.ch -= jh; }
      var k = Math.exp(-dt / 0.1);
      this.cx *= k; this.cy *= k; this.ch *= k;
      if (Math.abs(this.cx) + Math.abs(this.cy) > 6 || Math.abs(this.ch) > 1.2) { this.cx = 0; this.cy = 0; this.ch = 0; }   // teleport: snap
    }
    this.prevRaw = raw; this.prevT = T; this.prevRt = rt;
    var o = assign({}, raw);
    o.x = raw.x + this.cx; o.y = raw.y + this.cy; o.h = wrapAngle(raw.h + this.ch);
    o.rt = rt;
    return o;
  };
  RemoteTrack.prototype.lossPct = function () {
    if (this.firstT === null || this.lastT === null || this.lastT <= this.firstT) return 0;
    var expected = (this.lastT - this.firstT) * this.hz + 1;
    return clamp(100 * (1 - this.received / expected), 0, 100);
  };

  /* ======================================================================
     Local simulation: one engine / drift session with puppets for remote cars
     ====================================================================== */
  function entrantFor(e) {
    return { id: e.carId, name: e.name || e.carId, team: e.team || '', number: e.number, color: e.color, accent: e.accent,
             build: e.build || undefined, skill: num(e.skill, 0.8), aggression: num(e.aggression, 0.3), consistency: num(e.consistency, 0.9),
             livery: e.livery };
  }
  /**
   * o: { kind 'race'|'free'|'drift', driftMode, trackId, track, laps, weather, timeOfDay, seed, build, playerName, assists,
   *      entrants (ordered), selfIdx (-1 = spectator), isPuppet(id), pose(id, tRace), epoch, onEvent(e), hooks,
   *      lightsOutDelay_s, gridTime_s, lightInterval_s, autopilot, drift: {...} }
   */
  function createLocalSim(o) {
    var cars = {}, player = null, epoch = o.epoch;
    var spectator = o.selfIdx < 0;
    var netHook = {
      carCreated: function (car) {
        if (car.isPlayer) {
          player = car;
          if (spectator) { car.dnf = true; car.frozenUntil = 1e9; car._netHidden = true; }
          return;
        }
        cars[car.id] = car;
        if (o.isPuppet(car.id)) {
          car._net = true; car.frozenUntil = 1e9;
          car._hold = { x: car.state.x, y: car.state.y, heading: car.state.heading };
        }
      },
      postStep: function (car) {
        if (!car._net) return;
        car.frozenUntil = 1e9; car.wrongT = 0; car.exc = null; car.progressT = car.ctx ? car.ctx.t : 0;
        var t = epoch + (car.ctx ? num(car.ctx.t, 0) : 0);
        var p = o.pose(car.id, t), st = car.state;
        if (!p) {
          var hd = car._hold;
          st.x = hd.x; st.y = hd.y; st.heading = hd.heading; st.vx = 0; st.vy = 0; st.yawRate = 0; st.speed = 0;
          car.wvx = 0; car.wvy = 0;
          car.dnf = !!o.hiddenPuppet(car.id);
          return;
        }
        st.x = p.x; st.y = p.y; st.heading = p.h;
        var c = Math.cos(p.h), s = Math.sin(p.h);
        var bvx = c * p.vx + s * p.vy, bvy = -s * p.vx + c * p.vy;
        st.vx = bvx; st.vy = bvy;
        st.speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) * (bvx < -0.3 ? -1 : 1);
        st.yawRate = p.w;
        if (isNum(p.rpm)) st.rpm = p.rpm;
        if (isNum(p.gear)) { st.gear = p.gear; if ('gearDisplay' in st) st.gearDisplay = p.gear; }
        st.steerAngle = num(p.steer, 0) * STEER_SCALE;
        var f = p.flags | 0;
        st.skidding = f & FL.skid ? 0.8 : 0; st.wheelspin = f & FL.spin ? 0.8 : 0;
        car.wvx = p.vx; car.wvy = p.vy;
        car.input = { throttle: num(p.thr, 0), brake: num(p.brk, 0), steer: num(p.steer, 0), handbrake: !!(f & FL.handbrake) };
        car.dnf = !!p.ghost;
      }
    };
    var opp = [];
    o.entrants.forEach(function (e, i) { if (i !== o.selfIdx) opp.push(entrantFor(e)); });
    var startPosition = spectator ? o.entrants.length + 1 : o.selfIdx + 1;
    var hooks = [netHook].concat(Array.isArray(o.hooks) ? o.hooks : (o.hooks ? [o.hooks] : []));
    var storage = memStorage();
    var s, kind = o.kind;
    if (kind === 'drift') {
      var DR = CB.race && CB.race.drift;
      if (!DR || typeof DR.createSession !== 'function') throw new Error('CB.net.race: drift battles need CB.race.drift.createSession');
      var dd = o.drift || {};
      s = DR.createSession({
        trackId: o.trackId, track: o.track, mode: o.driftMode, build: o.build, assist: dd.assistLevel || 'heavy', tune: dd.tuneLevel || 'street',
        timeOfDay: o.timeOfDay, weather: o.weather, duration_s: dd.runTime_s, startDelay_s: dd.startDelay_s, seed: o.seed,
        playerName: o.playerName, difficulty: o.difficulty, leadBuild: (opp[0] && opp[0].build) || o.build, storage: storage,
        engineCfg: { opponents: opp, startPosition: startPosition, gridOrder: 'given', stuckDnf_s: 0, extras: { onEvent: o.onEvent },
                     persistGhost: false, storage: storage, playerAutopilot: !!o.autopilot },
        hooks: hooks
      });
    } else {
      var E = CB.race && CB.race.engine;
      if (!E || typeof E.createSession !== 'function') throw new Error('CB.net.race: CB.race.engine is not loaded');
      var race = kind === 'race';
      s = E.createSession({
        trackId: o.trackId, track: o.track, mode: race ? 'race' : 'practice', laps: race ? o.laps : 0,
        weather: o.weather, timeOfDay: o.timeOfDay, seed: o.seed, opponents: opp, gridOrder: 'given', startPosition: startPosition,
        playerBuild: o.build || undefined, playerName: o.playerName, playerTeam: o.playerTeam, playerMetrics: o.playerMetrics,
        assists: o.assists, difficulty: o.difficulty, lightsOutDelay_s: o.lightsOutDelay_s, gridTime_s: o.gridTime_s,
        lightInterval_s: o.lightInterval_s, stuckDnf_s: 0, finishTimeout_s: 1e7, persistGhost: false, storage: storage,
        trackLimitsWarnings: o.trackLimitsWarnings, extras: { onEvent: o.onEvent }, hooks: hooks, playerAutopilot: !!o.autopilot
      });
    }
    if (!player) { var dbg = safe(function () { return s._debug && s._debug(); }, null); if (dbg && dbg.player) player = dbg.player; }
    return {
      s: s, kind: kind, epoch: epoch, cars: cars, spectator: spectator,
      player: function () { return player; },
      time: function () { return num(s.time(), 0); },
      alpha: function () { return typeof s.alpha === 'function' ? num(s.alpha(), 0) : 0; },
      engineTime: function () { return num(s.time(), 0) + (typeof s.alpha === 'function' ? num(s.alpha(), 0) * STEP : 0); },
      phase: function () { return typeof s.getPhase === 'function' ? s.getPhase() : 'racing'; },
      update: function (dt, inp) { return s.update(dt, inp); },
      snapshot: function () { return s.snapshot(); },
      results: function () { return s.results(); }
    };
  }

  /* ======================================================================
     Race control (host): laps / positions / gaps / penalties / finish / results
     ====================================================================== */
  function RaceControl(o) {
    this.mode = o.mode; this.laps = o.laps; this.L = o.L; this.claimWait = num(o.claimWait_s, DEFAULTS.claimWait_s);
    this.finishTimeout = o.finishTimeout_s;
    this.cars = {}; this.list = []; this.goT = null; this.flagT = null; this.avgLap = 60; this.fastest = null;
    this.ended = false; this.endT = null; this.finishOrder = []; this.events = []; this.rejected = 0; this.corrected = 0;
    var self = this;
    o.entrants.forEach(function (e, i) { self.add(e, i); });
  }
  RaceControl.prototype.add = function (e, i) {
    var c = this.cars[e.carId];
    if (!c) {
      c = this.cars[e.carId] = { id: e.carId, gridIdx: i, hist: [], h0: null, hd: null, ht: null };
      this.list.push(c);
    }
    assign(c, { kind: e.kind, name: e.name, active: e.kind !== 'reserve', connected: true, trusted: !!e._trusted,
      lap: 0, lapTimes: [], detail: [], bestLap: null, lastLap: null, dist: null, distT: null, speed: 0, pen: 0,
      finished: false, finishT: null, finishLaps: 0, finishPos: null, dnf: false, dnfReason: null, claims: [], fin: null,
      obsN: 0, obsSeen: [], obsDist: -Infinity, obsTimes: [], ping: null, score: 0 });
    c.hist = []; c.h0 = null; c.hd = null; c.ht = null;
    return c;
  };
  RaceControl.prototype.record = function (c, t, d) {
    if (!isNum(d) || !isNum(t)) return;
    var k1 = Math.floor((d + GAP_OFF) / GAP_B);
    if (c.h0 === null) { c.h0 = k1; c.hist = [t]; c.hd = d; c.ht = t; return; }
    var lastK = c.h0 + c.hist.length - 1, guard = 0;
    while (lastK < k1 && guard++ < 400) {
      lastK++;
      var bd = lastK * GAP_B - GAP_OFF, frac = d > c.hd ? clamp((bd - c.hd) / (d - c.hd), 0, 1) : 1;
      c.hist.push(c.ht + (t - c.ht) * frac);
    }
    if (d > c.hd) { c.hd = d; c.ht = t; }
  };
  RaceControl.prototype.timeAt = function (c, d) {
    if (c.h0 === null) return null;
    var k = (d + GAP_OFF) / GAP_B, i = Math.floor(k) - c.h0;
    if (i < 0 || i >= c.hist.length) return null;
    var a = c.hist[i], b = i + 1 < c.hist.length ? c.hist[i + 1] : a;
    return a + (b - a) * (k - Math.floor(k));
  };
  /** Host-simulated car (host's own / AI): engine internal car object. */
  RaceControl.prototype.feedTrusted = function (id, car, t) {
    var c = this.cars[id];
    if (!c || !car) return;
    c.trusted = true;
    c.dist = car.raceDist; c.distT = t; c.speed = Math.abs(num(car.state && car.state.speed, 0)); c.pen = num(car.penalties, 0);
    c.dnf = !!car.dnf && !c.finished;
    this.record(c, t, c.dist);
    var lt = car.lapTimes || [];
    while (c.lapTimes.length < lt.length) {
      var L0 = lt[c.lapTimes.length];
      this.acceptLap(c, c.lapTimes.length + 1, L0.time, L0.valid !== false, L0.sectors, null);
    }
    if (car.finished && !c.finished) this.finish(c, num(car.finishRaceT, 0), num(car.finishLaps, c.lap), c.pen);
  };
  /** Remote car aux report: {dist, speed, pen, score} at race time t. */
  RaceControl.prototype.feedReported = function (id, a, t) {
    var c = this.cars[id];
    if (!c || c.trusted) return;
    if (isNum(a.dist)) { c.dist = a.dist; c.distT = t; this.record(c, t, a.dist); }
    if (isNum(a.speed)) c.speed = Math.abs(a.speed);
    if (isNum(a.pen) && !c.finished) c.pen = Math.max(c.pen, a.pen);
    if (isNum(a.score)) c.score = a.score;
    if (isNum(a.rtt)) c.ping = a.rtt;
  };
  /** Positions the host itself observes for a remote car (its puppet in the host engine). */
  RaceControl.prototype.observe = function (id, car, now) {
    var c = this.cars[id];
    if (!c || !car) return;
    var lt = car.lapTimes || [];
    while (c.obsN < lt.length) { c.obsTimes.push(lt[c.obsN].time); c.obsSeen.push(now); c.obsN++; }
    if (isNum(car.raceDist)) c.obsDist = car.raceDist;
  };
  RaceControl.prototype.claimLap = function (id, m, now) {
    var c = this.cars[id];
    if (!c || c.trusted || !isNum(m.lap)) return;
    c.claims.push({ lap: Math.round(m.lap), time: num(+m.time, NaN), valid: m.valid !== false, sectors: Array.isArray(m.sectors) ? m.sectors.slice(0, 3) : null, at: now });
    c.claims.sort(function (a, b) { return a.lap - b.lap; });
  };
  RaceControl.prototype.claimFinish = function (id, m, now) {
    var c = this.cars[id];
    if (!c || c.trusted || c.finished) return;
    c.fin = { time: num(+m.time, NaN), laps: Math.round(num(+m.laps, c.lap)), pen: num(+m.penalties, c.pen), at: now };
  };
  RaceControl.prototype.acceptLap = function (c, lap, time, valid, sectors, how) {
    while (c.lapTimes.length < lap - 1) {             // a skipped (rejected) lap filled in from observation
      var k = c.lapTimes.length, ot = c.obsTimes[k];
      c.lapTimes.push(isNum(ot) ? ot : null); c.detail.push({ lap: k + 1, time: isNum(ot) ? ot : null, valid: false, sectors: [null, null, null] });
    }
    c.lap = lap; c.lapTimes.push(time); c.lastLap = time;
    c.detail.push({ lap: lap, time: time, valid: !!valid, sectors: sectors || [null, null, null], how: how || null });
    if (how === 'corrected') this.corrected++;
    if (valid && isNum(time)) {
      if (c.bestLap === null || time < c.bestLap) c.bestLap = time;
      if (!this.fastest || time < this.fastest.time) {
        this.fastest = { carId: c.id, time: time, lap: lap, name: c.name };
        if (this.mode === 'race' && lap > 0) this.events.push({ type: 'fastestLap', carId: c.id, value: r(time, 3), text: 'Fastest lap ' + fmtTime(time) + ' — ' + c.name });
      }
    }
  };
  RaceControl.prototype.finish = function (c, time, laps, pen) {
    if (c.finished) return;
    c.finished = true; c.finishT = time; c.finishLaps = laps; c.pen = num(pen, c.pen);
    this.finishOrder.push(c.id); c.finishPos = this.finishOrder.length;
    if (this.flagT === null && laps >= this.laps) { this.flagT = time; this.avgLap = time / Math.max(1, laps); }
    this.events.push({ type: 'finish', carId: c.id, value: c.finishPos, text: 'P' + c.finishPos + ' — ' + c.name });
  };
  RaceControl.prototype.disconnect = function (id, reason) {
    var c = this.cars[id];
    if (!c) return;
    c.connected = false;
    if (!c.finished) { c.dnf = true; c.dnfReason = reason || 'disconnected'; }
    this.events.push({ type: 'net', carId: id, text: (c.name || id) + ' disconnected' });
  };
  RaceControl.prototype.processClaims = function (now) {
    var L = this.L, minLap = L / 95, self = this;
    this.list.forEach(function (c) {
      if (c.trusted || !c.active) return;
      while (c.claims.length) {
        var q = c.claims[0];
        if (q.lap <= c.lap) { c.claims.shift(); continue; }
        if (!(q.time >= minLap) || q.lap > self.laps + 1 && self.mode === 'race') { c.claims.shift(); self.reject(c, q, 'implausible'); continue; }
        var seen = c.obsN >= q.lap || c.obsDist >= q.lap * L - 25;
        if (seen) {
          var ot = c.obsTimes[q.lap - 1], time = q.time, how = null;
          if (isNum(ot) && q.time < ot - Math.max(1.5, 0.05 * ot)) { time = ot; how = 'corrected'; }
          self.acceptLap(c, q.lap, time, q.valid, q.sectors, how);
          c.claims.shift();
          continue;
        }
        if (now - q.at > self.claimWait) { c.claims.shift(); self.reject(c, q, 'not observed'); continue; }
        break;
      }
      // observed but never (validly) claimed: credit from the host's own observation
      if (!c.claims.length && c.obsN > c.lap && now - c.obsSeen[c.lap] > 4) {
        self.acceptLap(c, c.lap + 1, c.obsTimes[c.lap], true, null, 'observed');
      }
      var f = c.fin;
      if (f && !c.finished) {
        var ok = c.lap >= f.laps && f.laps > 0 && (f.laps >= self.laps || self.flagT !== null);
        if (ok) {
          var sum = 0, have = true;
          for (var i = 0; i < f.laps; i++) { if (isNum(c.lapTimes[i])) sum += c.lapTimes[i]; else have = false; }
          var time = f.time;
          if (!isNum(time) || (have && Math.abs(time - sum) > 1.0)) time = have ? sum : time;
          if (isNum(time)) self.finish(c, time, f.laps, f.pen);
          c.fin = null;
        } else if (now - f.at > self.claimWait + 4) { c.fin = null; self.reject(c, { lap: f.laps }, 'finish not plausible'); }
      }
    });
  };
  RaceControl.prototype.reject = function (c, q, why) {
    this.rejected++;
    this.events.push({ type: 'claimRejected', carId: c.id, value: q.lap, text: 'Lap ' + q.lap + ' of ' + (c.name || c.id) + ' not validated (' + why + ')' });
  };
  RaceControl.prototype.est = function (c, now) {
    if (c.finished) return Infinity;
    if (!isNum(c.dist)) return -1e9;
    return c.dist + c.speed * clamp(now - num(c.distT, now), 0, 0.5);
  };
  RaceControl.prototype.order = function (now) {
    var self = this, race = this.mode === 'race';
    var act = this.list.filter(function (c) { return c.active; });
    act.sort(function (a, b) {
      if (!race) {
        var ab = a.bestLap, bb = b.bestLap;
        if (ab !== null && bb !== null) return ab - bb || a.gridIdx - b.gridIdx;
        if (ab !== null) return -1; if (bb !== null) return 1;
        return a.gridIdx - b.gridIdx;
      }
      var ad = a.dnf && !a.finished, bd = b.dnf && !b.finished;
      if (ad !== bd) return ad ? 1 : -1;
      if (a.finished && b.finished) return (b.finishLaps - a.finishLaps) || (a.finishT - b.finishT) || a.gridIdx - b.gridIdx;
      if (a.finished !== b.finished) {
        var f = a.finished ? a : b, other = a.finished ? b : a, fFirst = f.finishLaps >= other.lap;
        return fFirst ? (a.finished ? -1 : 1) : (a.finished ? 1 : -1);
      }
      return (self.est(b, now) - self.est(a, now)) || a.gridIdx - b.gridIdx;
    });
    return act;
  };
  RaceControl.prototype.gap = function (c, ref) {
    if (c === ref) return 0;
    if (c.finished && ref.finished) return Math.max(0, c.finishT - ref.finishT);
    if (c.h0 === null || ref.h0 === null) return 0;
    var tr = this.timeAt(ref, c.hd);
    return tr === null ? 0 : Math.max(0, c.ht - tr);
  };
  /** goT: race time of lights out (null before); now: race time. Returns the standings message body. */
  RaceControl.prototype.tick = function (now, goT, phase) {
    if (goT !== null && this.goT === null) this.goT = goT;
    this.processClaims(now);
    var ord = this.order(now), self = this, leader = ord[0];
    var rows = ord.map(function (c, i) {
      var gl = self.mode === 'race' ? (i === 0 ? 0 : self.gap(c, leader)) : (c.bestLap !== null && leader.bestLap !== null ? c.bestLap - leader.bestLap : 0);
      var ga = i === 0 ? 0 : (self.mode === 'race' ? self.gap(c, ord[i - 1]) : (c.bestLap !== null && ord[i - 1].bestLap !== null ? c.bestLap - ord[i - 1].bestLap : 0));
      return { id: c.id, pos: i + 1, lap: c.lap, dist: r(num(c.dist, 0), 1), gapL: r(gl, 3), gapA: r(ga, 3), fin: c.finished, ft: c.finishT,
               fl: c.finishLaps, fp: c.finishPos, pen: c.pen, dnf: c.dnf && !c.finished, dr: c.dnfReason, best: c.bestLap, last: c.lastLap,
               conn: c.connected, ping: c.ping, score: c.score };
    });
    if (this.mode === 'race' && !this.ended && this.goT !== null) {
      var sinceGo = now - this.goT;
      var all = ord.every(function (c) { return c.finished || c.dnf || !c.connected; });
      var anyFinished = ord.some(function (c) { return c.finished; });
      var limit = isNum(this.finishTimeout) ? this.finishTimeout : Math.max(60, this.avgLap * 1.3 + 20);
      if ((all && (anyFinished || ord.length === 0 || ord.every(function (c) { return !c.connected || c.dnf; }))) ||
          (this.flagT !== null && sinceGo - this.flagT > limit)) { this.ended = true; this.endT = now; }
    }
    return { t: 'nr.st', rt: r(now, 3), phase: this.ended ? 'finished' : phase, goT: this.goT, flag: this.flagT !== null,
             fastestLap: this.fastest ? { carId: this.fastest.carId, time: this.fastest.time, lap: this.fastest.lap } : null, rows: rows };
  };
  RaceControl.prototype.results = function (now, final) {
    var race = this.mode === 'race', self = this;
    var act = this.list.filter(function (c) { return c.active; });
    function status(c) { return c.finished ? 'finished' : (c.dnf || !c.connected) ? 'dnf' : 'running'; }
    act.sort(function (a, b) {
      if (!race) return self.order(now).indexOf(a) - self.order(now).indexOf(b);
      var ra = { finished: 0, running: 1, dnf: 2 }[status(a)], rb = { finished: 0, running: 1, dnf: 2 }[status(b)];
      if (ra !== rb) {
        if (ra === 0 && rb === 1 && b.lap > a.finishLaps) return 1;
        if (ra === 1 && rb === 0 && a.lap > b.finishLaps) return -1;
        return ra - rb;
      }
      if (ra === 0) return (b.finishLaps - a.finishLaps) || ((a.finishT + a.pen) - (b.finishT + b.pen)) || a.gridIdx - b.gridIdx;
      return (b.lap - a.lap) || (num(b.dist, -1e9) - num(a.dist, -1e9)) || a.gridIdx - b.gridIdx;
    });
    var win = act[0];
    var rows = act.map(function (c, i) {
      var st = status(c), total = c.finished ? c.finishT + c.pen : null, gap = null, gapText = '';
      if (race) {
        if (i === 0) gapText = st === 'finished' ? fmtTime(total) : 'Leader';
        else if (st === 'dnf') gapText = 'DNF';
        else if (st === 'finished' && win.finished && c.finishLaps === win.finishLaps) { gap = total - (win.finishT + win.pen); gapText = '+' + fmtTime(gap); }
        else {
          var down = win.finished ? Math.max(0, win.finishLaps - (c.finished ? c.finishLaps : c.lap) - (c.finished ? 0 : 1)) : 0;
          if (!c.finished && win.finished && isNum(c.dist)) down = Math.max(0, Math.floor((win.finishLaps * self.L - c.dist) / self.L));
          if (down > 0) gapText = '+' + down + (down === 1 ? ' Lap' : ' Laps');
          else { gap = self.gap(c, win); gapText = '+' + fmtTime(gap); }
        }
      } else {
        gap = c.bestLap !== null && win.bestLap !== null ? c.bestLap - win.bestLap : null;
        gapText = c.bestLap === null ? 'No time' : i === 0 ? fmtTime(c.bestLap) : '+' + fmtTime(gap);
      }
      return { position: i + 1, id: c.id, name: c.name, kind: c.kind, status: st, laps: c.finished ? c.finishLaps : c.lap,
               raceTime_s: c.finished ? c.finishT : null, totalTime_s: total, penalties_s: c.pen, gap_s: gap, gapText: gapText,
               bestLap_s: c.bestLap, lastLap_s: c.lastLap, lapTimes: c.lapTimes.slice(), laps_detail: c.detail.slice(),
               gridPosition: c.gridIdx + 1, dnfReason: st === 'dnf' ? (c.dnfReason || 'disconnected') : null,
               fastestLap: !!(self.fastest && self.fastest.carId === c.id), connected: c.connected, ping_ms: c.ping };
    });
    return { t: 'results', v: VERSION, final: !!final, mode: this.mode, lapsTotal: this.laps, trackLength_m: this.L,
             raceTime_s: this.goT !== null ? Math.max(0, (this.endT !== null ? this.endT : now) - this.goT) : 0,
             fastestLap: this.fastest ? assign({}, this.fastest) : null, classification: rows,
             validation: { rejected: this.rejected, corrected: this.corrected } };
  };

  /* ======================================================================
     Drift battle control (shared schedule; scores on the host)
     ====================================================================== */
  function driftPlan(dcfg, humans) {
    var fmt = dcfg.format === 'attack' || humans.length !== 2 ? 'attack' : 'tandem';
    var runs = fmt === 'tandem' ? Math.max(2, Math.round(num(dcfg.runs, 2) / 2) * 2) : 1;
    var startDelay = num(dcfg.startDelay_s, 3), runTime = num(dcfg.runTime_s, fmt === 'tandem' ? 60 : 90), inter = num(dcfg.interRun_s, 5);
    var slot = startDelay + runTime + inter;
    return {
      format: fmt, runs: runs, startDelay_s: startDelay, runTime_s: runTime, interRun_s: inter, slot: slot, humans: humans.slice(),
      run: function (k) {
        var ep = k * slot, lead = fmt === 'tandem' ? humans[k % 2] : null, chase = fmt === 'tandem' ? humans[(k + 1) % 2] : null;
        return { k: k, epoch: ep, go: ep + startDelay, end: ep + startDelay + runTime, leadId: lead, chaseId: chase,
                 order: fmt === 'tandem' ? [lead, chase] : humans.slice() };
      },
      indexAt: function (t) { return clamp(Math.floor((t + 1.0) / slot), 0, runs - 1); },
      endAll: function () { return (runs - 1) * slot + startDelay + runTime; }
    };
  }
  function DriftControl(plan, entrants) {
    this.plan = plan; this.scores = {}; this.live = {}; this.names = {}; this.gridIdx = {}; this.ended = false; this.connected = {};
    var self = this;
    entrants.forEach(function (e, i) { if (e.kind === 'human') { self.scores[e.carId] = []; self.names[e.carId] = e.name; self.gridIdx[e.carId] = i; self.connected[e.carId] = true; } });
  }
  DriftControl.prototype.submit = function (id, run, total) {
    if (!this.scores[id] || !isNum(run) || run < 0 || run >= this.plan.runs) return;
    this.scores[id][run] = Math.max(0, Math.round(num(total, 0)));
  };
  DriftControl.prototype.liveScore = function (id, run, total) { if (this.scores[id]) this.live[id] = { run: run, total: num(total, 0) }; };
  DriftControl.prototype.total = function (id, withLive) {
    var s = this.scores[id] || [], t = 0;
    for (var k = 0; k < this.plan.runs; k++) {
      if (isNum(s[k])) t += s[k];
      else if (withLive && this.live[id] && this.live[id].run === k) t += Math.round(this.live[id].total);
    }
    return t;
  };
  DriftControl.prototype.tick = function (now) {
    if (this.ended) return;
    var self = this, ids = Object.keys(this.scores);
    var done = ids.every(function (id) { return !self.connected[id] || isNum(self.scores[id][self.plan.runs - 1]); });
    if ((done && now > this.plan.endAll()) || now > this.plan.endAll() + 8) this.ended = true;
  };
  DriftControl.prototype.rows = function () {
    var self = this, ids = Object.keys(this.scores);
    ids.sort(function (a, b) {
      var ta = self.total(a, true), tb = self.total(b, true);
      if (ta !== tb) return tb - ta;
      var ba = Math.max.apply(null, [0].concat((self.scores[a] || []).filter(isNum))), bb = Math.max.apply(null, [0].concat((self.scores[b] || []).filter(isNum)));
      return (bb - ba) || self.gridIdx[a] - self.gridIdx[b];
    });
    return ids.map(function (id, i) {
      return { id: id, pos: i + 1, score: self.total(id, true), runs: (self.scores[id] || []).slice(), conn: !!self.connected[id] };
    });
  };
  DriftControl.prototype.results = function (final) {
    var self = this, rows = this.rows();
    var runs = [];
    for (var k = 0; k < this.plan.runs; k++) {
      var ri = this.plan.run(k), sc = {};
      Object.keys(this.scores).forEach(function (id) { sc[id] = isNum(self.scores[id][k]) ? self.scores[id][k] : null; });
      runs.push({ run: k, leadId: ri.leadId, chaseId: ri.chaseId, scores: sc });
    }
    var cls = rows.map(function (rw, i) {
      return { position: i + 1, id: rw.id, name: self.names[rw.id], kind: 'human', status: rw.conn ? 'finished' : 'dnf', score: rw.score,
               runScores: rw.runs, gapText: i === 0 ? rw.score + ' pts' : '−' + (rows[0].score - rw.score) + ' pts', gap_s: null,
               dnfReason: rw.conn ? null : 'disconnected', connected: rw.conn };
    });
    return { t: 'results', v: VERSION, final: !!final, mode: 'drift', format: this.plan.format, classification: cls,
             battle: { format: this.plan.format, runs: runs, totals: rows.reduce(function (o, rw) { o[rw.id] = rw.score; return o; }, {}),
                       winnerId: rows.length ? rows[0].id : null } };
  };

  /* ======================================================================
     Net session (host + client share this core)
     ====================================================================== */
  function normMode(m) { m = m === 'free-roam' || m === 'freeroam' || m === 'practice' ? 'free' : m; return MODES.indexOf(m) >= 0 ? m : 'race'; }

  function createSession(tp, cfgIn, role) {
    var cfg = assign({}, DEFAULTS, cfgIn || {});
    var isHost = role === 'host';
    var link = isHost ? hostLink(tp) : clientLink(tp);
    var start = null, sim = null, rc = null, dc = null, plan = null;
    var myCarId = null, spectator = false, grid = [], gridById = {}, peerToCar = {}, mode = 'race';
    var tracks = {}, aux = {}, gone = {}, standings = null, finalResults = null, ended = null, destroyed = false;
    var pending = [], resultsFns = [], endFns = [], latch = { shiftUp: false, shiftDown: false, requestReset: false, pit: false };
    var lastSendT = -1e9, lastAuxT = -1e9, lastStT = -1e9, claimed = 0, finishSent = false, goRace = null, lights = 0;
    var clockOff = null, roughOff = null, lastHostMsg = 0, curRun = -1, scoreSent = {}, autopilot = !!cfg.autopilot;
    var rngShared = null, hostLights = { lights: 0, go: null }, stats = { pktIn: 0, pktOut: 0, relIn: 0, relOut: 0 };
    var assistLevel = (cfg.drift && cfg.drift.assistLevel) || cfg.assistLevel || null, tuneLevel = (cfg.drift && cfg.drift.tuneLevel) || cfg.tuneLevel || null;

    /* ---------------- clocks ---------------- */
    function hostNow() {
      if (isHost) return link.now();
      var o = clockOff !== null ? clockOff : (roughOff !== null ? roughOff : 0);
      return link.now() + o;
    }
    function raceNow() { return start ? hostNow() - start.t0 : 0; }
    function updateClock() {
      if (isHost || !link.offsetReady()) return;
      var o = link.offset();
      if (clockOff === null || Math.abs(o - clockOff) > 0.25) clockOff = o;
      else clockOff += (o - clockOff) * 0.1;
    }

    /* ---------------- outbound ---------------- */
    function sendRel(msg, toPeer) {
      stats.relOut++;
      if (isHost) { if (toPeer) return link.send(toPeer, 'rel', msg); return link.broadcast('rel', msg); }
      return link.send('rel', msg);
    }
    function sendFast(data, except) {
      stats.pktOut++;
      if (isHost) return link.broadcast('fast', data, except);
      return link.send('fast', data);
    }
    function note(type, text, carId, extra) {
      var e = assign({ type: type, carId: carId == null ? null : mapId(carId), text: text, intensity: 0.5, x: 0, y: 0, t: sim ? r(sim.time(), 3) : 0 }, extra || {});
      pending.push(e);
      if (pending.length > 64) pending.shift();
    }
    function mapId(id) { return id === myCarId && !spectator ? 'player' : id; }

    /* ---------------- grid / puppets ---------------- */
    function isPuppet(id) {
      var e = gridById[id];
      if (!e || id === myCarId) return false;
      if (isHost && e.kind === 'ai') return false;
      return true;
    }
    function hiddenPuppet(id) {
      var e = gridById[id];
      if (!e) return true;
      if (e.kind === 'reserve') return true;
      var g = gone[id];
      return !!(g && raceNow() - g.at > cfg.ghost_s);
    }
    function trackFor(id) {
      if (!tracks[id]) tracks[id] = new RemoteTrack({ base: start.cfg.interpDelay_s, maxDelay: cfg.maxDelay_s, maxExtrap: start.cfg.maxExtrap_s, hz: start.cfg.sendHz });
      return tracks[id];
    }
    function poseFor(id, t) {
      var tr = tracks[id];
      if (!tr || !tr.buf.length) return null;
      var p = tr.sample(t);
      if (!p) return null;
      var e = gridById[id];
      p.ghost = !!gone[id] || (e && e.kind === 'reserve') || (t - tr.lastArrival > cfg.staleAfter_s);
      return p;
    }

    function buildSim(k) {
      var sc = start.cfg, entrants, selfIdx, epoch = num(start.epoch, 0), kind, driftMode = null;
      if (mode === 'drift') {
        var ri = plan.run(k);
        entrants = ri.order.map(function (id) { return gridById[id]; }).filter(Boolean);
        selfIdx = spectator ? -1 : entrants.map(function (e) { return e.carId; }).indexOf(myCarId);
        if (selfIdx < 0 && !spectator) { spectator = true; }
        epoch = Math.max(ri.epoch, num(start.epoch, 0));
        kind = 'drift';
        driftMode = plan.format === 'attack' ? 'trial' : (ri.leadId === myCarId ? 'free' : 'tandem');
      } else {
        entrants = grid.slice();
        selfIdx = spectator ? -1 : entrants.map(function (e) { return e.carId; }).indexOf(myCarId);
        kind = mode === 'race' ? 'race' : 'free';
      }
      var allowed = sc.assistsAllowed || {}, ass = assign({}, cfg.assists || {});
      Object.keys(allowed).forEach(function (key) { if (allowed[key] === false) ass[key] = false; });
      var me = gridById[myCarId] || {};
      return createLocalSim({
        kind: kind, driftMode: driftMode, trackId: sc.trackId, track: cfg.track && cfg.track.id === sc.trackId ? cfg.track : undefined,
        laps: sc.laps, weather: sc.weather, timeOfDay: sc.timeOfDay, seed: start.seed, build: cfg.build || me.build || defaultBuild(),
        playerName: cfg.name || cfg.playerName || me.name || 'You', playerMetrics: cfg.playerMetrics, assists: ass, difficulty: sc.difficulty,
        entrants: entrants, selfIdx: selfIdx, isPuppet: isPuppet, hiddenPuppet: hiddenPuppet, pose: poseFor, epoch: epoch,
        onEvent: onSimEvent, hooks: cfg.hooks, lightsOutDelay_s: sc.lightsOutDelay_s, gridTime_s: sc.gridTime_s,
        lightInterval_s: sc.lightInterval_s, trackLimitsWarnings: sc.trackLimitsWarnings, autopilot: autopilot,
        drift: { runTime_s: plan ? plan.runTime_s : 0, startDelay_s: plan ? plan.startDelay_s : 0,
                 assistLevel: assistLevel || (sc.drift && sc.drift.assistLevel) || 'heavy', tuneLevel: tuneLevel || (sc.drift && sc.drift.tuneLevel) || 'street' }
      });
    }

    function applyStart(st) {
      if (start) return;
      if (st.v && st.v !== VERSION) { endSession('version', 'Version mismatch with the host (' + st.v + ' vs ' + VERSION + ')'); return; }
      start = st;
      start.cfg = assign({ sendHz: DEFAULTS.sendHz, interpDelay_s: DEFAULTS.interpDelay_s, maxExtrap_s: DEFAULTS.maxExtrap_s }, st.cfg || {});
      mode = normMode(start.cfg.mode);
      grid = (st.grid || []).map(function (e) { return assign({}, e); });
      gridById = {}; peerToCar = {};
      grid.forEach(function (e) { gridById[e.carId] = e; if (e.peerId != null) peerToCar[e.peerId] = e.carId; });
      myCarId = st.you || null;
      spectator = !!st.spectator || !myCarId || !gridById[myCarId];
      rngShared = mulberry32((start.seed ^ 0x2545f491) >>> 0);
      if (!isHost && isNum(st.hn)) roughOff = st.hn - link.now() + 0.03;
      lastHostMsg = link.now();
      if (mode === 'drift') {
        plan = driftPlan(start.cfg.drift || {}, grid.filter(function (e) { return e.kind === 'human'; }).map(function (e) { return e.carId; }));
        curRun = plan.indexAt(Math.max(raceNow(), num(start.epoch, 0)));
        sim = buildSim(curRun);
      } else sim = buildSim(0);
      if (isHost) {
        grid.forEach(function (e) { e._trusted = e.carId === myCarId || e.kind === 'ai'; });
        rc = new RaceControl({ mode: mode === 'free' ? 'free' : 'race', laps: start.cfg.laps, L: trackLength(), entrants: grid, finishTimeout_s: cfg.finishTimeout_s, claimWait_s: cfg.claimWait_s });
        if (mode === 'drift') dc = new DriftControl(plan, grid);
      }
    }
    function trackLength() {
      var g = sim && sim.s.geom;
      var L = g && (g.length || g.totalLength || g.length_m || g.L);
      if (isNum(L) && L > 0) return L;
      var sn = safe(function () { return sim.s.snapshot(); }, null);   // engine snapshot carries trackLength
      return sn && isNum(sn.trackLength) ? sn.trackLength : 1000;
    }

    /* ---------------- local sim events ---------------- */
    function onSimEvent(e) {
      if (!e) return;
      if (isHost) {
        if (e.type === 'light' && e.carId == null) { hostLights.lights = e.value; sendRel({ t: 'lights', n: e.value }); }
        else if (e.type === 'start' && e.carId == null && mode === 'race') { hostLights.go = (sim ? sim.epoch : 0) + num(e.value, 0); sendRel({ t: 'go', t0: start.t0, rt: hostLights.go, t: (start.t0 + hostLights.go) * 1000 }); }
      }
      if (e.type === 'start' && e.carId == null) goRace = (sim ? sim.epoch : 0) + num(e.value, 0);
    }

    /* ---------------- inbound ---------------- */
    function ingestStates(states, from) {
      var now = raceNow();
      for (var i = 0; i < states.length; i++) {
        var s = states[i];
        if (!s || s.id == null) continue;
        var id = String(s.id);
        if (id === myCarId) continue;
        if (isHost && peerToCar[from] !== id) continue;       // a peer may only speak for its own car
        if (!gridById[id]) continue;
        var f = s.flags | 0, run = (f >> 8) & 15;
        if (mode === 'drift' && run !== (curRun & 15)) continue;
        trackFor(id).push({ t: s.t / 1000, x: s.x, y: s.y, h: s.heading, vx: s.vx, vy: s.vy, w: num(s.yawRate, 0), steer: num(s.steer, 0),
                            thr: num(s.throttle, 0), brk: num(s.brake, 0), gear: s.gear, rpm: s.rpm, flags: f & 255 }, now);
        if (gone[id] && gone[id].reason === 'stale') delete gone[id];
      }
    }
    function ingestAux(rows, from) {
      if (!Array.isArray(rows)) return;
      var now = raceNow();
      rows.forEach(function (a) {
        if (!Array.isArray(a)) return;
        var id = String(a[0]);
        if (id === myCarId || !gridById[id]) return;
        if (isHost && peerToCar[from] !== id) return;
        var o = { t: num(a[1], 0) / 1000, lap: a[2], dist: a[3], speed: a[4], pen: a[5], score: a[6], run: a[7], fin: !!a[8], dnf: !!a[9], rtt: a[10] };
        if (aux[id] && aux[id].t > o.t) return;
        aux[id] = o;
        if (rc) rc.feedReported(id, o, o.t);
        if (dc) dc.liveScore(id, o.run, o.score);
      });
      void now;
    }
    function onMessage(from, ch, data) {
      if (destroyed) return;
      if (!isHost) lastHostMsg = link.now();
      var states = unpackAny(data);
      if (states) {
        stats.pktIn++;
        if (!start) return;
        ingestStates(states, from);
        if (isHost && from !== 'host') sendFast(data, from);   // relay to everyone else as-is
        return;
      }
      if (!data || typeof data !== 'object' || typeof data.t !== 'string') return;
      if (ch === 'rel') stats.relIn++;
      var m = data;
      switch (m.t) {
        case 'nr.aux':
          if (!start) return;
          ingestAux(m.a, from);
          if (isHost && from !== 'host') sendFast(m, from);
          return;
        case 'start':
          if (!isHost && !start) applyStart(m);
          return;
        case 'lights': if (!isHost) hostLights.lights = m.n; return;
        case 'go': if (!isHost) hostLights.go = num(m.rt, null); return;
        case 'lap':
          if (isHost && rc && peerToCar[from] === m.id) rc.claimLap(m.id, m, raceNow());
          return;
        case 'finish':
          if (isHost && rc && peerToCar[from] === m.id) rc.claimFinish(m.id, m, raceNow());
          return;
        case 'nr.score':
          if (isHost && dc && peerToCar[from] === m.id) dc.submit(m.id, m.run, m.total);
          return;
        case 'nr.st':
          if (!isHost) standings = m;
          return;
        case 'nr.ev':
          if (!isHost && Array.isArray(m.ev)) m.ev.forEach(function (ev) { if (ev && (ev.carId !== myCarId || ev.type === 'net')) note(ev.type, ev.text, ev.carId, { value: ev.value }); });
          return;
        case 'results':
          if (!isHost && !finalResults && m.final !== false) { finalResults = m; fireResults(); }
          return;
        case 'nr.leave':
          if (!isHost) markGone(m.id, m.reason || 'left', true);
          return;
        case 'nr.join':
          if (!isHost && m.entry) activateEntry(m.entry);
          return;
        case 'nr.end':
          if (!isHost) endSession(m.reason || 'host-ended', m.message || 'The host ended the session');
          return;
        case 'nr.quit': case 'bye':
          if (isHost) onPeerLeave(from, 'left');
          else if (m.t === 'bye') endSession('host-left', 'The host left — session ended');
          return;
        default: return;
      }
    }
    function markGone(id, reason, announce) {
      if (!id || gone[id] && gone[id].reason !== 'stale') return;
      gone[id] = { at: raceNow(), reason: reason };
      var e = gridById[id];
      if (announce !== false) note('net', ((e && e.name) || id) + (reason === 'kicked' ? ' was removed' : ' left the session'), id);
    }
    function activateEntry(entry) {
      var e = gridById[entry.carId];
      if (!e) return;
      assign(e, entry);
      if (entry.peerId != null) peerToCar[entry.peerId] = entry.carId;
      delete gone[entry.carId];
      if (tracks[entry.carId]) tracks[entry.carId].reset();
      var car = sim && sim.cars[entry.carId];
      if (car && entry.build) {
        car.build = entry.build; car.bodyStyle = (entry.build.body && entry.build.body.style) || car.bodyStyle;
        car.name = entry.name || car.name; car.color = entry.color || car.color; car.accent = entry.accent || car.accent;
        if (entry.number != null) car.number = String(entry.number);
        var body = entry.build.body || {};
        var Lm = clamp(num(body.wheelbase_mm, 2650) / 1000 + 1.9, 2.8, 6.5), W = clamp(num(body.trackWidth_mm, 1600) / 1000 + 0.32, 1.4, 2.4);
        car.length_m = Lm; car.width_m = W; car.halfL = Lm / 2; car.halfW = W / 2;
      }
      if (rc) { var c = rc.cars[entry.carId]; if (c) { rc.add(entry, c.gridIdx); } }
      if (entry.kind === 'human') note('net', (entry.name || entry.carId) + ' joined', entry.carId);
    }

    /* ---------------- host: peers ---------------- */
    function onPeerLeave(peerId, reason) {
      var id = peerToCar[peerId];
      if (!id || gone[id] && gone[id].reason !== 'stale') return;
      markGone(id, reason || 'left');
      if (rc) rc.disconnect(id, reason === 'kicked' ? 'kicked' : 'disconnected');
      if (dc) dc.connected[id] = false;
      sendRel({ t: 'nr.leave', id: id, reason: reason || 'left' });
      if (mode === 'free') {                                   // free the slot for a later joiner after the ghost fade
        var e = gridById[id];
        setTimeoutish(function () { if (gone[id] && e) { e.kind = 'reserve'; delete peerToCar[peerId]; e.peerId = null; } }, cfg.ghost_s + 0.5);
      }
    }
    var timers = [];
    function setTimeoutish(fn, secs) { timers.push({ at: raceNow() + secs, fn: fn }); }
    function runTimers() {
      if (!timers.length) return;
      var now = raceNow(), due = timers.filter(function (t) { return t.at <= now; });
      timers = timers.filter(function (t) { return t.at > now; });
      due.forEach(function (t) { try { t.fn(); } catch (e) { /* ignore */ } });
    }
    function startFor(peerId, carId, spec) {
      var m = assign({}, start, { you: carId, spectator: !!spec, hn: hostNow() });
      m.grid = grid.map(function (e) { var o = assign({}, e); delete o._trusted; return o; });
      return m;
    }
    function onPeerJoin(peerId) {
      if (!start || destroyed || peerToCar[peerId] && !gone[peerToCar[peerId]]) return;
      var info = (typeof cfg.resolvePlayer === 'function' ? safe(function () { return cfg.resolvePlayer(peerId); }, null) : null) || {};
      var epoch = raceNow();
      if (mode === 'free') {
        var slot = null;
        for (var i = 0; i < grid.length; i++) if (grid[i].kind === 'reserve' && !(grid[i].peerId != null && gone[grid[i].carId])) { slot = grid[i]; break; }
        if (slot) {
          var b = info.build || slot.build;
          var entry = humanEntry(peerId, info.name || 'Guest', b, grid.indexOf(slot));
          entry.carId = slot.carId;
          activateEntry(entry);
          sendRel({ t: 'nr.join', entry: entry });
          var m = startFor(peerId, slot.carId, false); m.epoch = epoch;
          link.send(peerId, 'rel', m);
          return;
        }
      }
      var ms = startFor(peerId, null, true); ms.epoch = epoch;   // race / drift (or full): spectate
      link.send(peerId, 'rel', ms);
    }
    function humanEntry(peerId, name, build, idx) {
      var ext = (build && build.exterior) || {};
      return { carId: carIdOf(peerId), peerId: peerId, kind: 'human', name: name || 'Driver', team: '', build: build || null,
               number: String(ext.livery_number || idx + 1), color: ext.paint || '#b3121f', accent: ext.stripeColor || '#ffffff' };
    }

    /* ---------------- host init ---------------- */
    function initHost() {
      var m = normMode(cfg.mode);
      var seed = isNum(cfg.seed) ? (cfg.seed >>> 0) : (Math.floor(Math.random() * 4294967296) >>> 0);
      var rng = mulberry32(seed);
      var hostBuild = cfg.build || cfg.playerBuild || defaultBuild();
      var humans = [humanEntry(link.id || 'host', cfg.name || cfg.playerName || 'Host', hostBuild, 0)];
      var players = Array.isArray(cfg.players) ? cfg.players : link.peers().map(function (id) { return { peerId: id }; });
      players.forEach(function (p) {
        if (!p || p.peerId == null || humans.length >= cfg.maxPlayers) return;
        if (humans.some(function (h) { return h.peerId === p.peerId; })) return;
        humans.push(humanEntry(p.peerId, p.name || ('Driver ' + (humans.length + 1)), p.build || null, humans.length));
      });
      if (cfg.gridOrder !== 'given') shuffle(humans, rng);
      humans.forEach(function (h, i) { if (!h.build) h.build = null; h.number = h.number || String(i + 1); });
      var list = humans.slice();
      var aiCount = m === 'drift' ? 0 : clamp(Math.round(num(cfg.ai, num(cfg.aiCount, 0))), 0, Math.max(0, cfg.maxGrid - humans.length - (m === 'free' ? cfg.maxPlayers - humans.length : 0)));
      if (aiCount > 0) {
        var A = CB.race && CB.race.ai, opps = null;
        if (A && typeof A.createGrid === 'function') {
          var orig = Math.random; Math.random = mulberry32((seed ^ 0x1234567) >>> 0);
          try { opps = A.createGrid(hostBuild, { count: aiCount, difficulty: cfg.difficulty || 'amateur', field: cfg.field || 'mixed', seed: seed }); } catch (e) { opps = null; }
          finally { Math.random = orig; }
        }
        for (var k = 0; k < aiCount; k++) {
          var o = (opps && opps[k]) || { name: 'AI ' + (k + 1), build: hostBuild, skill: 0.8 };
          list.push({ carId: 'ai' + (k + 1), peerId: null, kind: 'ai', name: o.name || 'AI ' + (k + 1), team: o.team || '', build: jclone(o.build) || hostBuild,
                      number: String(o.number != null ? o.number : humans.length + k + 1), color: o.color || (o.livery && (o.livery.primary || o.livery.color)) || '#888888',
                      accent: o.accent || (o.livery && (o.livery.accent || o.livery.secondary)) || '#ffffff', skill: o.skill, aggression: o.aggression,
                      consistency: o.consistency, livery: jclone(o.livery) || undefined });
        }
      }
      if (m === 'free') {
        var nRes = Math.max(0, Math.min(cfg.maxPlayers, cfg.maxGrid - aiCount) - humans.length);
        for (var q = 0; q < nRes; q++) list.push({ carId: 'r' + (q + 1), peerId: null, kind: 'reserve', name: '', build: hostBuild, number: String(list.length + 1), color: '#666666', accent: '#ffffff' });
      }
      var laps = clamp(Math.round(num(cfg.laps, 3)), 1, 50);
      var scfg = {
        mode: m, trackId: cfg.trackId || (cfg.track && cfg.track.id) || null, laps: laps, weather: cfg.weather || 'dry', timeOfDay: cfg.timeOfDay || 'day',
        difficulty: cfg.difficulty || 'amateur', lightsOutDelay_s: isNum(cfg.lightsOutDelay_s) ? cfg.lightsOutDelay_s : r(0.4 + rng() * 2.4, 3),
        gridTime_s: cfg.gridTime_s, lightInterval_s: cfg.lightInterval_s, sendHz: cfg.sendHz, interpDelay_s: cfg.interpDelay_s, maxExtrap_s: cfg.maxExtrap_s,
        assistsAllowed: cfg.assistsAllowed || null, trackLimitsWarnings: isNum(cfg.trackLimitsWarnings) ? cfg.trackLimitsWarnings : 3,
        drift: m === 'drift' ? assign({ format: 'auto', runs: 2, runTime_s: 60, startDelay_s: 3, interRun_s: 5 }, cfg.drift || {}) : null
      };
      var st = { t: 'start', v: VERSION, seed: seed, t0: link.now() + num(cfg.leadIn_s, 3), cfg: scfg, grid: list, epoch: 0 };
      var hostEntry = humans.filter(function (h) { return h.peerId === (link.id || 'host'); })[0];
      st.you = hostEntry.carId;
      applyStart(assign({}, st, { grid: list }));
      humans.forEach(function (h) { if (h.peerId !== hostEntry.peerId) link.send(h.peerId, 'rel', startFor(h.peerId, h.carId, false)); });
    }

    /* ---------------- per-update work ---------------- */
    function myState(tRace) {
      var car = sim.player();
      if (!car || !car.state) return null;
      var st = car.state, f = 0, inp = car.input || {};
      if (inp.handbrake) f |= FL.handbrake;
      if (num(inp.brake, 0) > 0.05) f |= FL.braking;
      if (num(st.skidding, 0) > 0.35 || st.skidding === true) f |= FL.skid;
      if (num(st.wheelspin, 0) > 0.35 || st.wheelspin === true) f |= FL.spin;
      if (car.offTrack) f |= FL.offTrack;
      if (car.finished) f |= FL.finished;
      if (car.dnf) f |= FL.dnf;
      if (mode === 'drift') f |= (curRun & 15) << 8;
      return { id: myCarId, t: tRace * 1000, x: st.x, y: st.y, heading: st.heading, vx: num(car.wvx, 0), vy: num(car.wvy, 0), yawRate: num(st.yawRate, 0),
               steer: clamp(num(st.steerAngle, 0) / STEER_SCALE, -1, 1), throttle: clamp01(num(inp.throttle, 0)), brake: clamp01(num(inp.brake, 0)),
               gear: Math.round(num(st.gearDisplay, num(st.gear, 1))), rpm: Math.round(num(st.rpm, 0)), flags: f };
    }
    function aiState(id, car, tRace) {
      var st = car.state, inp = car.input || {}, f = 0;
      if (num(inp.brake, 0) > 0.05) f |= FL.braking;
      if (num(st.skidding, 0) > 0.35) f |= FL.skid;
      if (car.finished) f |= FL.finished;
      return { id: id, t: tRace * 1000, x: st.x, y: st.y, heading: st.heading, vx: num(car.wvx, 0), vy: num(car.wvy, 0), yawRate: num(st.yawRate, 0),
               steer: clamp(num(st.steerAngle, 0) / STEER_SCALE, -1, 1), throttle: clamp01(num(inp.throttle, 0)), brake: clamp01(num(inp.brake, 0)),
               gear: Math.round(num(st.gearDisplay, num(st.gear, 1))), rpm: Math.round(num(st.rpm, 0)), flags: f };
    }
    function scoreNow() {
      var s = sim && sim.s;
      var st = s && typeof s.scorerState === 'function' ? safe(function () { return s.scorerState(); }, null) : null;
      return st && isNum(st.total) ? st.total : 0;
    }
    function auxRow(id, car, tRace) {
      return [id, r(tRace * 1000, 1), car.tracker ? car.tracker.lap : 0, r(num(car.raceDist, 0), 2), r(Math.abs(num(car.state && car.state.speed, 0)), 2),
              num(car.penalties, 0), id === myCarId ? Math.round(scoreNow()) : 0, curRun < 0 ? 0 : curRun, car.finished ? 1 : 0, car.dnf ? 1 : 0,
              isHost ? 0 : Math.round(link.rtt() * 1000)];
    }
    function streamOut(tRace) {
      var hz = start.cfg.sendHz || DEFAULTS.sendHz, me = spectator ? null : sim.player();
      var list = [];
      if (tRace - lastSendT >= 1 / hz - 1e-6) {
        lastSendT = Math.max(lastSendT + 1 / hz, tRace - 1 / hz);   // keeps the average rate at sendHz at any frame rate
        if (me) { var s0 = myState(tRace); if (s0) list.push(s0); }
        if (isHost) Object.keys(sim.cars).forEach(function (id) { var e = gridById[id]; if (e && e.kind === 'ai') list.push(aiState(id, sim.cars[id], tRace)); });
        if (list.length) sendFast(packList(list));
      }
      if (tRace - lastAuxT >= 1 / DEFAULTS.auxHz - 1e-6) {
        lastAuxT = Math.max(lastAuxT + 1 / DEFAULTS.auxHz, tRace - 1 / DEFAULTS.auxHz);
        var rows = [];
        if (me) rows.push(auxRow(myCarId, me, tRace));
        if (isHost) Object.keys(sim.cars).forEach(function (id) { var e = gridById[id]; if (e && e.kind === 'ai') rows.push(auxRow(id, sim.cars[id], tRace)); });
        if (rows.length) sendFast({ t: 'nr.aux', a: rows });
      }
    }
    function claimsOut() {
      if (spectator || mode === 'drift') return;
      var me = sim.player();
      if (!me) return;
      var lt = me.lapTimes || [];
      while (claimed < lt.length) {
        var L0 = lt[claimed];
        claimed++;
        if (!isHost) sendRel({ t: 'lap', id: myCarId, lap: claimed, time: r(L0.time, 4), valid: L0.valid !== false, sectors: (L0.sectors || []).map(function (v) { return r(v, 4); }) });
      }
      if (me.finished && !finishSent && mode === 'race') {
        finishSent = true;
        if (!isHost) sendRel({ t: 'finish', id: myCarId, time: r(me.finishRaceT, 4), laps: me.finishLaps, penalties: me.penalties });
      }
    }
    function hostTick(tRace) {
      var goT = goRace;
      grid.forEach(function (e) {
        if (e.kind === 'reserve') return;
        var car = e.carId === myCarId ? sim.player() : sim.cars[e.carId];
        if (!car) return;
        if (e._trusted) rc.feedTrusted(e.carId, car, tRace); else rc.observe(e.carId, car, tRace);
      });
      // stale peers (no packets) — ghost, but keep them in the race until the transport gives up on them
      Object.keys(tracks).forEach(function (id) {
        var tr = tracks[id];
        if (tr.received && tRace - tr.lastArrival > cfg.staleAfter_s && !gone[id]) gone[id] = { at: tRace, reason: 'stale' };
      });
      var phase = mode === 'drift' ? (dc && dc.ended ? 'finished' : 'racing') : sim.phase();
      if (phase === 'finished' && !rc.ended && mode !== 'drift') phase = 'racing';
      standings = rc.tick(tRace, goT, phase);
      if (dc) { dc.tick(tRace); standings.drift = { run: curRun, rows: dc.rows() }; if (dc.ended) standings.phase = 'finished'; }
      if (rc.events.length) {
        rc.events.forEach(function (ev) { if (ev.carId !== myCarId || ev.type === 'net') note(ev.type, ev.text, ev.carId, { value: ev.value }); });
        sendRel({ t: 'nr.ev', ev: rc.events });
        rc.events = [];
      }
      if (tRace - lastStT >= 1 / DEFAULTS.standingsHz - 1e-6) { lastStT = tRace; sendRel(standings); }
      var over = mode === 'drift' ? dc.ended : (mode === 'race' && rc.ended);
      if (over && !finalResults) {
        finalResults = mode === 'drift' ? dc.results(true) : rc.results(tRace, true);
        sendRel(standings);
        sendRel(finalResults);
        fireResults();
      }
    }
    function driftRuns(tRace) {
      if (mode !== 'drift' || !plan) return;
      var k = plan.indexAt(tRace);
      if (k !== curRun && k > curRun) {
        submitScore(curRun);
        curRun = k;
        Object.keys(tracks).forEach(function (id) { tracks[id].reset(); });
        sim = buildSim(k);
        note('net', plan.format === 'tandem' ? 'Run ' + (k + 1) + ' — ' + (plan.run(k).leadId === myCarId ? 'you lead' : 'you chase') : 'Run ' + (k + 1), null);
      }
      var ri = plan.run(curRun);
      if (tRace >= ri.end + 0.3) submitScore(curRun);
    }
    function submitScore(k) {
      if (k < 0 || scoreSent[k] || spectator) return;
      scoreSent[k] = true;
      var total = Math.round(scoreNow());
      var res = safe(function () { return sim.s.results(); }, null);
      if (res && res.drift && isNum(res.drift.total)) total = Math.round(res.drift.total);
      if (isHost) { if (dc) dc.submit(myCarId, k, total); }
      else sendRel({ t: 'nr.score', id: myCarId, run: k, total: total });
    }
    function checkHostAlive() {
      if (isHost || ended || !start) return;
      var st = link.state();
      if (link.now() - lastHostMsg > cfg.hostTimeout_s && st !== 'open') endSession('host-timeout', 'Lost connection to the host — session ended');
    }
    function endSession(reason, message) {
      if (ended) return;
      ended = { reason: reason, message: message, at: start ? raceNow() : 0 };
      note('net', message, null, { intensity: 1 });
      endFns.slice().forEach(function (fn) { try { fn(ended); } catch (e) { /* ignore */ } });
    }
    function fireResults() { resultsFns.slice().forEach(function (fn) { try { fn(api.results()); } catch (e) { /* ignore */ } }); }

    function update(dt, input) {
      if (destroyed) return 0;
      updateClock();
      checkHostAlive();
      var inp = assign({}, input || {});
      ['shiftUp', 'shiftDown', 'requestReset', 'pit'].forEach(function (k) { if (inp[k]) latch[k] = true; else if (latch[k]) inp[k] = true; });
      if (!start || !sim) return 0;
      var tNow = raceNow();
      runTimers();
      driftRuns(tNow);
      var feed;
      if (ended) feed = clamp(num(dt, 0), 0, 0.5);
      else feed = clamp(tNow - sim.epoch - sim.engineTime(), 0, 0.5);
      var n = 0;
      if (feed > 0) n = sim.update(feed, inp) || 0;
      if (n > 0) latch = { shiftUp: false, shiftDown: false, requestReset: false, pit: false };
      var tRace = sim.epoch + sim.time();
      if (!ended) {
        streamOut(tRace);
        claimsOut();
        if (isHost) hostTick(tRace);
      }
      return n;
    }

    /* ---------------- snapshot ---------------- */
    function emptySnap() {
      return { t: 0, phase: 'grid', countdown: { lightsOn: 0, lightsOut: false, goTime: null }, lapsTotal: start ? start.cfg.laps : 0, mode: mode,
               weather: 'dry', timeOfDay: 'day', playerId: 'player', fastestLap: null, cars: [], order: [], events: drainPending(), ghost: null,
               net: netSummary() };
    }
    function drainPending() { var p = pending; pending = []; return p; }
    var KEEP_GLOBAL = { light: 1, start: 1 };
    function keepEvent(e) {
      if (!e) return false;
      if (e.carId === 'player') return !(spectator);
      if (e.carId == null) return !!KEEP_GLOBAL[e.type];
      if (e.type === 'collision' && e.otherId === 'player') return true;
      var g = gridById[e.carId];
      return !!(isHost && g && g.kind === 'ai' && (e.type === 'collision' || e.type === 'wall'));
    }
    function snapshot() {
      if (!sim) return emptySnap();
      var snap = sim.snapshot();
      var evs = (snap.events || []).filter(keepEvent).concat(drainPending());
      var now = raceNow(), rows = {}, srows = standings && standings.rows ? standings.rows : null;
      if (srows) srows.forEach(function (rw) { rows[rw.id] = rw; });
      var live = {};
      if (standings && standings.drift) standings.drift.rows.forEach(function (rw) { live[rw.id] = rw; });
      var cars = [];
      (snap.cars || []).forEach(function (c) {
        var netId = c.isPlayer ? myCarId : c.id, e = gridById[netId];
        if (c.isPlayer) { if (spectator) return; c.netId = myCarId; c.kind = 'human'; if (e && e.number != null) c.number = String(e.number); }   // the host's grid number, not the local default
        else {
          if (!e || hiddenPuppet(netId)) return;
          c.netId = netId; c.kind = e.kind; c.remote = isPuppet(netId); c.frozen = false; c.autopilot = false;
          var g = gone[netId], tr = tracks[netId];
          var stale = c.remote && (!tr || !tr.buf.length || now - tr.lastArrival > cfg.staleAfter_s);
          if (g || stale) {
            c.ghost = true; c.disconnected = !!(g && g.reason !== 'stale');
            c.opacity = c.disconnected ? clamp01(1 - (now - g.at) / cfg.ghost_s) * 0.5 : 0.5;
          } else c.opacity = 1;
          if (c.remote) c.dnf = !!(c.disconnected && !(rows[netId] && rows[netId].fin));
        }
        var rw = rows[netId];
        if (rw && mode !== 'drift') {
          c.position = rw.pos; c.gapLeader_s = rw.gapL; c.gapAhead_s = rw.gapA;
          if (rw.fp) c.finishPosition = rw.fp;
          if (!c.isPlayer && c.remote) {
            c.lap = rw.lap; c.finished = !!rw.fin; c.finishTime_s = rw.ft; c.penalties_s = rw.pen;
            c.bestLap_s = rw.best; c.lastLap_s = rw.last; if (rw.dnf) c.dnf = true;
          }
          if (c.isPlayer && rw.fp) c.finishPosition = rw.fp;
        }
        if (live[netId]) { c.driftScore = live[netId].score; c.position = live[netId].pos; }
        else if (aux[netId] && mode === 'drift') c.driftScore = Math.round(num(aux[netId].score, 0));
        if (c.isPlayer && mode === 'drift') c.driftScore = Math.round(scoreNow());
        cars.push(c);
      });
      if (srows && mode !== 'drift') {
        var order = [];
        srows.forEach(function (rw) { var id = mapId(rw.id); if (cars.some(function (c) { return c.id === id; })) order.push(id); });
        cars.forEach(function (c) { if (order.indexOf(c.id) < 0) order.push(c.id); });
        snap.order = order;
        snap.leaderId = order[0] || null;
        if (standings.fastestLap) snap.fastestLap = { carId: mapId(standings.fastestLap.carId), time: standings.fastestLap.time, lap: standings.fastestLap.lap };
      } else snap.order = (snap.order || []).filter(function (id) { return cars.some(function (c) { return c.id === id; }); });
      if (spectator && cars.length) {
        var follow = snap.order && snap.order.length ? snap.order[0] : cars[0].id;
        cars.forEach(function (c) { c.isPlayer = c.id === follow; });
        snap.playerId = follow; snap.spectating = follow;
      }
      snap.cars = cars;
      snap.events = evs;
      var ph = snap.phase;
      if (ended || finalResults) ph = 'finished';
      else if (ph === 'finished') ph = mode === 'free' ? 'racing' : 'racing';
      if (spectator && standings && standings.phase && !finalResults && !ended) {
        ph = standings.phase === 'finished' ? 'racing' : standings.phase;
        if (ph === 'racing') snap.countdown = { lightsOn: 0, lightsOut: true, goTime: snap.countdown ? snap.countdown.goTime : null };
      }
      snap.phase = ph;
      snap.netMode = true;
      snap.net = netSummary();
      return snap;
    }
    function netSummary() {
      var o = { role: role, mode: mode, carId: myCarId, spectator: spectator, phase: finalResults || ended ? 'finished' : null,
                raceTime: start ? r(raceNow(), 3) : 0, ping_ms: isHost ? 0 : Math.round(link.rtt() * 1000), final: !!finalResults,
                ended: ended ? assign({}, ended) : null, message: ended ? ended.message : null, players: grid.filter(function (e) { return e.kind === 'human'; }).length };
      if (mode === 'drift' && plan) {
        var ri = plan.run(Math.max(0, curRun)), now = raceNow();
        o.battle = { format: plan.format, run: curRun, runs: plan.runs, leadId: mapId(ri.leadId), chaseId: mapId(ri.chaseId),
                     role: plan.format === 'tandem' ? (ri.leadId === myCarId ? 'lead' : ri.chaseId === myCarId ? 'chase' : 'spectator') : 'attack',
                     runStartsIn_s: Math.max(0, r(ri.go - now, 2)), runEndsIn_s: Math.max(0, r(ri.end - now, 2)),
                     nextRunIn_s: curRun + 1 < plan.runs ? Math.max(0, r(plan.run(curRun + 1).go - now, 2)) : null,
                     scores: standings && standings.drift ? standings.drift.rows.map(function (rw) { return { id: mapId(rw.id), name: (gridById[rw.id] || {}).name, total: rw.score, runs: rw.runs, position: rw.pos }; }) : [] };
      }
      return o;
    }

    /* ---------------- results ---------------- */
    function provisional() {
      if (isHost) return mode === 'drift' ? (dc ? dc.results(false) : null) : (rc ? rc.results(raceNow(), false) : null);
      if (!standings) return null;
      if (mode === 'drift' && standings.drift) {
        return { final: false, mode: 'drift', classification: standings.drift.rows.map(function (rw, i) {
          return { position: i + 1, id: rw.id, name: (gridById[rw.id] || {}).name, status: rw.conn ? 'running' : 'dnf', score: rw.score, runScores: rw.runs };
        }) };
      }
      return { final: false, mode: mode, classification: (standings.rows || []).map(function (rw, i) {
        return { position: i + 1, id: rw.id, name: (gridById[rw.id] || {}).name, status: rw.fin ? 'finished' : rw.dnf ? 'dnf' : 'running',
                 laps: rw.fin ? rw.fl : rw.lap, raceTime_s: rw.ft, totalTime_s: rw.fin ? rw.ft + num(rw.pen, 0) : null, penalties_s: rw.pen,
                 gap_s: rw.gapL, gapText: i === 0 ? 'Leader' : '+' + fmtTime(rw.gapL), bestLap_s: rw.best, lastLap_s: rw.last, dnfReason: rw.dr };
      }) };
    }
    function results() {
      var local = sim ? safe(function () { return sim.results(); }, null) : null;
      var out = local ? assign({}, local) : { mode: mode, classification: [] };
      var src = finalResults || provisional();
      var myLocalRow = local && local.player ? local.player : null;
      if (src && Array.isArray(src.classification)) {
        out.classification = src.classification.map(function (rw) {
          var e = gridById[rw.id] || {}, mine = rw.id === myCarId && !spectator;
          var base = mine && myLocalRow ? assign({}, myLocalRow) : {};
          return assign(base, { number: e.number, color: e.color, accent: e.accent, team: e.team || '', bodyStyle: e.build && e.build.body ? e.build.body.style : base.bodyStyle },
                        rw, { id: mine ? 'player' : rw.id, netId: rw.id, isPlayer: mine, kind: rw.kind || e.kind });
        });
        out.player = out.classification.filter(function (rw) { return rw.isPlayer; })[0] || null;
        if (src.fastestLap) out.fastestLap = assign({}, src.fastestLap, { carId: mapId(src.fastestLap.carId) });
        if (isNum(src.raceTime_s)) out.raceTime_s = src.raceTime_s;
      }
      if (mode === 'drift') {
        var bt = src && src.battle ? src.battle : null;
        var myTotal = bt && bt.totals ? bt.totals[myCarId] : (out.player ? out.player.score : null);
        out.drift = assign({}, local && local.drift ? local.drift : {}, isNum(myTotal) ? { total: myTotal, lastRunTotal: local && local.drift ? local.drift.total : null } : {});
        out.battle = bt ? assign({}, bt, { winnerId: mapId(bt.winnerId) }) : null;
        out.driftMode = plan ? plan.format : null;
      }
      out.mode = mode === 'free' ? 'practice' : (mode === 'drift' ? (local && local.mode) || 'practice' : 'race');
      out.netMode = mode;
      out.complete = !!finalResults;
      out.final = !!finalResults;
      out.aborted = !!(ended && !finalResults);
      out.message = ended ? ended.message : null;
      out.net = { role: role, carId: myCarId, spectator: spectator, seed: start ? start.seed : null, validation: src && src.validation ? src.validation : null };
      return out;
    }

    /* ---------------- netState ---------------- */
    function netState() {
      var now = raceNow(), worstLate = 0, delays = [], extrap = 0;
      var players = grid.filter(function (e) { return e.kind !== 'reserve'; }).map(function (e) {
        var tr = tracks[e.carId], local = e.carId === myCarId, a = aux[e.carId];
        var ping = local ? (isHost ? 0 : Math.round(link.rtt() * 1000)) : (isHost && e.peerId != null ? (link.rttOf(e.peerId) !== null ? Math.round(link.rttOf(e.peerId) * 1000) : null) : (a && isNum(a.rtt) ? a.rtt : null));
        if (tr && tr.buf.length) { delays.push(tr.delay); if (tr.late > worstLate) worstLate = tr.late; if (tr.extrap > 0) extrap++; }
        return { carId: e.carId, peerId: e.peerId, name: e.name, kind: e.kind, isLocal: local, connected: !gone[e.carId] || gone[e.carId].reason === 'stale',
                 ghost: !!gone[e.carId], stale: !!(tr && tr.received && now - tr.lastArrival > cfg.staleAfter_s), ping_ms: ping,
                 delay_ms: tr ? Math.round(tr.delay * 1000) : null, jitter_ms: tr ? Math.round(tr.jit * 1000) : null,
                 lateness_ms: tr && tr.late !== null ? Math.round(tr.late * 1000) : null,
                 lastPacketAge_ms: tr && tr.received ? Math.round((now - tr.lastArrival) * 1000) : null, loss_pct: tr ? r(tr.lossPct(), 1) : null,
                 packets: tr ? tr.received : 0, extrapolating: !!(tr && tr.extrap > 0) };
      });
      var avgDelay = delays.length ? delays.reduce(function (s, v) { return s + v; }, 0) / delays.length : 0;
      var rtt = isHost ? 0 : link.rtt();
      var quality = rtt > 0.25 || worstLate > 0.3 ? 'poor' : rtt > 0.12 || worstLate > 0.18 ? 'fair' : 'good';
      return {
        role: role, version: VERSION, started: !!start, connected: isHost ? true : link.state() === 'open', state: isHost ? 'open' : link.state(),
        mode: mode, carId: myCarId, spectator: spectator, seed: start ? start.seed : null, raceTime: r(now, 3), phase: snapshotPhase(),
        ping_ms: Math.round(rtt * 1000), clockOffset_ms: isHost ? 0 : Math.round(num(clockOff !== null ? clockOff : roughOff, 0) * 1000),
        clockReady: isHost || clockOff !== null, players: players,
        sync: { quality: quality, interpDelay_ms: Math.round(avgDelay * 1000), worstLateness_ms: Math.round(worstLate * 1000), extrapolating: extrap,
                engineLag_ms: sim && start ? Math.round((now - sim.epoch - sim.engineTime()) * 1000) : 0, packetsIn: stats.pktIn, packetsOut: stats.pktOut,
                relIn: stats.relIn, relOut: stats.relOut },
        run: curRun, ended: ended ? assign({}, ended) : null, final: !!finalResults,
        validation: rc ? { rejected: rc.rejected, corrected: rc.corrected } : null
      };
    }
    function snapshotPhase() {
      if (ended || finalResults) return 'finished';
      if (!sim) return 'waiting';
      var p = sim.phase();
      return p === 'finished' ? 'racing' : p;
    }

    /* ---------------- wiring ---------------- */
    link.onMessage(onMessage);
    if (isHost) {
      link.onLeave(function (peerId, reason) { onPeerLeave(peerId, reason); });
      link.onJoin(function (peerId) { onPeerJoin(peerId); });
    } else {
      link.onClose(function (reason) {
        if (destroyed) return;
        var msg = reason === 'kicked' ? 'You were removed by the host' : reason === 'host-closed' ? 'The host closed the room — session ended'
          : reason === 'version' ? 'Version mismatch with the host' : 'Lost connection to the host — session ended';
        if (!finalResults || reason === 'kicked') endSession(reason === 'host-closed' ? 'host-left' : reason || 'closed', msg);
      });
    }

    var api = {
      netRole: role, VERSION: VERSION, STEP: STEP,
      get geom() { return sim ? sim.s.geom : null; },
      get trackDef() { return sim ? sim.s.trackDef : null; },
      get track() { return sim ? sim.s.trackDef : null; },
      get config() { return sim ? assign({}, sim.s.config, { net: true, netMode: mode }) : { net: true, netMode: mode }; },
      get engine() { return sim ? (sim.s.engine || sim.s) : null; },
      get mode() { return mode; },
      get wantsRawInput() { return mode === 'drift'; },
      update: update,
      snapshot: snapshot,
      results: results,
      netState: netState,
      restart: function () { return api; },                     // a net session cannot be restarted by one peer (rematch = new session)
      resetPlayerToTrack: function () { if (sim && !spectator && typeof sim.s.resetPlayerToTrack === 'function') sim.s.resetPlayerToTrack(); },
      setAssists: function (a) {
        var allowed = (start && start.cfg.assistsAllowed) || {}, b = assign({}, a || {});
        Object.keys(allowed).forEach(function (k) { if (allowed[k] === false) b[k] = false; });
        if (sim && typeof sim.s.setAssists === 'function') sim.s.setAssists(b);
      },
      setAssistLevel: function (l) { assistLevel = l; return sim && typeof sim.s.setAssistLevel === 'function' ? sim.s.setAssistLevel(l) : l; },
      getAssistLevel: function () { return sim && typeof sim.s.getAssistLevel === 'function' ? sim.s.getAssistLevel() : assistLevel; },
      setPlayerAutopilot: function (on) { autopilot = !!on; if (sim && typeof sim.s.setPlayerAutopilot === 'function') sim.s.setPlayerAutopilot(autopilot); },
      playerState: function () { return sim && typeof sim.s.playerState === 'function' ? sim.s.playerState() : null; },
      scorerState: function () { return sim && typeof sim.s.scorerState === 'function' ? sim.s.scorerState() : null; },
      assistDebug: function () { return sim && typeof sim.s.assistDebug === 'function' ? sim.s.assistDebug() : null; },
      time: function () { return sim ? sim.time() : 0; },
      alpha: function () { return sim ? sim.alpha() : 0; },
      getPhase: snapshotPhase,
      isFinished: function () { return !!(finalResults || ended); },
      fmtTime: fmtTime,
      end: function () {
        if (!isHost || finalResults || !start) return;
        if (rc) rc.ended = true;
        if (dc) dc.ended = true;
        var t = raceNow();
        finalResults = mode === 'drift' && dc ? dc.results(true) : rc.results(t, true);
        sendRel(finalResults); fireResults();
      },
      onResults: function (fn) { resultsFns.push(fn); return function () { var i = resultsFns.indexOf(fn); if (i >= 0) resultsFns.splice(i, 1); }; },
      onEnd: function (fn) { endFns.push(fn); return function () { var i = endFns.indexOf(fn); if (i >= 0) endFns.splice(i, 1); }; },
      addPlayer: function (peerId, info) {
        if (!isHost || !start) return false;
        var id = peerToCar[peerId], e = id && gridById[id];
        if (!e) return false;
        var ent = humanEntry(peerId, (info && info.name) || e.name, (info && info.build) || e.build, grid.indexOf(e));
        ent.carId = id;
        activateEntry(ent);
        sendRel({ t: 'nr.join', entry: ent });
        return true;
      },
      rng: function () { return rngShared ? rngShared() : Math.random(); },
      destroy: function () {
        if (destroyed) return;
        if (isHost && start && !finalResults) sendRel({ t: 'nr.end', reason: 'host-left', message: 'The host left — session ended' });
        else if (!isHost && start && !ended) sendRel({ t: 'nr.quit' });
        destroyed = true;
        link.close();
        resultsFns = []; endFns = [];
      },
      _debug: function () { return { start: start, sim: sim, rc: rc, dc: dc, tracks: tracks, standings: standings, grid: grid, plan: plan, aux: aux, gone: gone, raceNow: raceNow, hostNow: hostNow }; }
    };

    if (isHost) initHost();
    else if (cfg.start) applyStart(jclone(cfg.start) || cfg.start);
    return api;
  }

  function createHostSession(host, cfg) { return createSession(host, cfg, 'host'); }
  function createClientSession(client, cfg) { return createSession(client, cfg, 'peer'); }
  /** Lobby helper: call fn(startMsg) once when the host's `start` arrives on this client transport. */
  function waitForStart(client, fn) {
    var done = false, off = onOf(client, 'message', function (ch, m) {
      if (done || !m || typeof m !== 'object' || m.t !== 'start') return;
      done = true; off();
      try { fn(m); } catch (e) { /* ignore */ }
    });
    return function () { done = true; off(); };
  }

  CB.net.race = {
    VERSION: VERSION, DEFAULTS: DEFAULTS, FLAGS: FL,
    createHostSession: createHostSession, createClientSession: createClientSession, waitForStart: waitForStart,
    _internal: { RemoteTrack: RemoteTrack, RaceControl: RaceControl, DriftControl: DriftControl, driftPlan: driftPlan, hermite: hermite,
                 extrapolate: extrapolate, packList: packList, unpackAny: unpackAny, mulberry32: mulberry32, createLocalSim: createLocalSim }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.net.race;

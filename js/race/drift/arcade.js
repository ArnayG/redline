/* ==========================================================================
   FORGE Atelier — js/race/drift/arcade.js
   CB.race.drift.arcade : the "drift lock" — an arcade layer that makes HEAVY / AUTO assist
   drift mode arcade-easy with nothing but the arrow keys.

   Pure logic (no DOM). Classic <script> in browsers, require()-able in Node.
   Driven by js/race/drift/session.js through the engine's hook contract:

     var a = CB.race.drift.arcade.create({ level: 'heavy'|'auto', geom, params });
     preStep : input = a.control(rawIntent, car, dt)   // car = engine internal car {state, params, ...}
     postStep: a.shape(car, dt)                         // regulates the vehicle state after each physics substep
     a.debug() / a.reset() / a.setLevel(l) / a.isDrifting() / a.cosmetics() / a.active

   What the player does (heavy):
     Up                hold = go. The car follows the road by itself (gentle auto-steer toward the drift line).
     Left / Right      pick the drift DIRECTION (and a bit more ANGLE / a tighter line). Tapping toward a corner's
                       inside above ~30 km/h starts a drift; the lock then HOLDS it for as long as Up is held and
                       the road keeps turning that way — 10 s sweepers, full hairpins, the 270° skidpad.
     opposite arrow    swing to the other side (smooth controlled transition) or, while the road still turns the
                       current way, straighten up and end the drift.
     keep holding it   COMMIT: the angle target ramps 40 -> 52 deg over ~2.6 s and Up earns up to +10 % pace over the
                       drift profile -> big angle at speed is earned. Holding the key toward a corner's OUTSIDE drifts
                       it "wrong way": small angle, ~14 % slower.
     release Up        the drift ends smoothly.  Down = wide line (less angle, aims for the outside half, slower).
   AUTO: holding just Up drifts every corner automatically (tight ones by curvature, fast sweepers / banked ovals by the
   lateral g they ask for at that speed); Left/Right only nudge the angle.

   How (per 120 Hz substep):
     - the target drift angle is shaped by a critically-damped 2nd-order filter (rate limited) -> no snaps,
       left<->right swings are one smooth arc;
     - the travel direction follows a pure-pursuit path on the track (edge-clamped lateral target, lateral
       acceleration capped, low-pass filtered) -> no walls, releasing all keys keeps the car on the road;
     - yaw rate is regulated to (path yaw + filtered angle rate + P on the angle error) -> the slide never dies
       on its own and never spins (hard clamp below 75°, instant recovery above 80°);
     - speed is governed by a drift speed profile (auto lift / brake before corners) plus a small "drift drive"
       that compensates tyre scrub, so long drifts keep their speed;
     - the engine inputs (counter-steer, throttle, light governor brake) are produced to match the slide and
       are smoothed (critically damped + rate limited), so wheels / audio / smoke look and sound right.
   Below ~30 km/h (and on launch) it is an easy grip car: smoothed steering, slip damping, traction limit.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

(function () {
  'use strict';

  var DEG = Math.PI / 180, TAU = Math.PI * 2, G = 9.81;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function wrap(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
  function smooth01(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function approach(cur, tgt, d) { return cur < tgt ? Math.min(cur + d, tgt) : Math.max(cur - d, tgt); }
  function blendK(dt, tau) { return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau); }

  /* ------------------------------------------------------------ tuning */
  var T = {
    vEnter: 30 / 3.6,        // m/s: drifts start above this
    vExit: 20 / 3.6,         // m/s: drift lock releases below this
    vArc: [3, 7],            // m/s: arcade shaping fades in over this band
    angleHold: 31,           // deg: drift angle with Up only
    angleMore: 40,           // deg: with the drift-direction key held
    angleLess: 17,           // deg: Down held / opposite key while the road still turns
    angleBig: 52,            // deg: the drift-direction key held for a while ramps the target up to this
    angleMax: 54,            // deg: never more (target)
    angleWide: 24,           // deg: Down held while drifting (wide, tidy line)
    holdRamp: [0.6, 2.6],    // s of drift-direction key held: angleMore -> angleBig, push 0 -> pushMax
    pushMax: 0.10,           // committed drift (key held into the corner + Up): speed target up to +10 % over the profile
    pushUpOnly: 0.06,        // ... Up-only (tapped-in) drift into a corner
    wrongWayK: 0.86,         // drift held against the corner (key toward the outside): speed target x this, small angle
    autoLatG: 0.42 * G,      // auto: also enter a drift when the corner asks this much lateral accel (fast sweepers)
    // heavy, Up held with no arrow through a LONG corner: the lock starts a gentle drift in the corner's direction by
    // itself (drift mode is expected to drift); any arrow takes over (same way = commit, opposite = straighten up)
    gentleAuto: true,
    gentleK: 1 / 170,        // 1/m: the corner is at least this tight right ahead ...
    gentleLen_s: 1.6,        // ... and keeps turning that way for this long at the current speed
    gentleDwell_s: 0.35,     // s of Up-only in such a corner before the slide starts (a brush through a kink never does)
    angleGentle: 25,         // deg: the gentle drift angle (Up only)
    gentleSwingR: 400,       // m: a gentle drift swings once the road ahead turns the other way tighter than this
    clampAngle: 72 * DEG,    // hard clamp on the actual angle while locked
    spinAngle: 80 * DEG,     // beyond: instant recovery
    wEntry: 4.2,             // rad/s natural frequency of the angle filter (entry / hold)
    wSwing: 3.3,             // ... during a left<->right swing
    wExit: 2.6,              // ... while a drift unwinds back to grip (lift / straight / opposite key): a slow, smooth
                             //     straighten instead of a snap to the grip regulator (no counter-fishtail)
    exitEnd_deg: 3,          // deg: the unwinding drift hands over to grip below this angle
    maxAngleRate: 1.7,       // rad/s
    kTheta: 7.0,             // 1/s: P gain angle error -> yaw rate
    tauYaw: 0.022,           // s: yaw-rate regulation time constant (drift lock)
    tauVel: 0.035,           // s: travel-direction regulation time constant (drift lock)
    phiWindup: 0.10,         // rad: max lag of the measured travel direction behind its reference
    tauPath: 0.14,           // s: low-pass on the path yaw rate
    aLatCap: 1.35 * G,       // m/s^2: max path lateral acceleration
    profLat: 1.05 * G,       // m/s^2: drift speed profile lateral g (less auto-braking with Up held)
    profBrake: 6.0,          // m/s^2: profile braking decel
    vMax: 46,                // m/s: profile ceiling (165 km/h)
    govDecel: 7.5,           // m/s^2: max governor speed reduction
    drive: 3.2,              // m/s^2: drift drive (scrub compensation) toward the target speed
    edgeMargin: 3.1,         // m: centre-line lateral limit while sliding (rear swings out)
    gripMargin: 2.2,         // m: ... while gripping
    swingCool: 0.45,         // s between swings
    straightExit: 0.6,       // s of straight road (no key) before the drift ends
    oppExit: 0.5,            // s of opposite key (road still turning) before the drift ends
    liftExit: 0.25,          // s after releasing Up before the drift ends
    steerW: 11,              // rad/s: steer output critically-damped filter
    steerRate: 3.2,          // 1/s: steer output rate limit (full lock per 0.31 s)
    thrRate: 3.0,            // 1/s: throttle output rate limit
    gripSpeedK: 0.9,
    gripLook: 0.35,          // s: extra pure-pursuit look-ahead time while gripping at speed (damps the high-speed weave)
    gripBlend: [2.5, 6],      // m/s: low-speed easy car -> auto-steered grip car blend band
    gripLatCap: 1.35 * G,    // m/s^2: path lateral accel asked for while gripping at speed
    gripLatLow: 0.5 * G,     // ... at low speed (no tight re-centring loops on launch -> no rear slide)
    launchG: 0.45 * G,       // m/s^2: max lateral accel asked for below drift speed (no tight full-lock circles)
    launchLock: 0.85,        // max steer (fraction of lock) from an arrow at crawling speed
    tcFloor: [0.18, 0.45],   // launch traction-control throttle floor: clean launch -> after tcRamp s still slow
    tcRamp: [2.0, 4.0],      // s with Up held below drift speed (a lock-to-lock crawl must not hold the car at 0.18)
    stuckV: 3.0,             // m/s: with Up held and slower than this for stuckT s -> "no progress" fallback
    stuckT: 1.5,
    stuckClear: 6.0,         // m/s: fallback ends above this
    // engine in a drift: soft rev cap + limiter short-shift (no fuel-cut bounce = no torque / audio flutter)
    revSoft: 0.95,           // x redline: throttle is capped above this while drifting
    revCut: 6, revRecover: 0.8, revCapMin: 0.25,
    limShift_s: 0.4,         // s near the limiter mid-drift before a short-shift ...
    limShiftMin: 0.6,        // ... if the next gear still pulls above this x redline
    // per-car drift character (0 = heavy AWD van .. 1 = light, punchy RWD): the angle capability and drift drive
    // scale around the reference car (charRef ~ the default muscle drift car keeps the tuned values above)
    charRef: 0.8,
    charAngleBig: 30,        // deg of angleBig per unit of character (light RWD ~55-57 deg, van ~36 deg)
    charAngleMore: 14,
    charAngleHold: 8,
    angleCap: 58,            // deg: absolute target ceiling for any car
    charDrive: [0.75, 1.2]   // drift drive multiplier: low -> high power-to-weight
  };

  /** Drift character of a car (0..1) from its vehicle params: original layout (the drift tune makes everything
   *  RWD), mass, power-to-weight (original hp) and wheelbase. */
  function carCharacter(p) {
    p = p || {};
    var dr = p.drift || {}, lay = String(dr.originalLayout || p.layout || 'rwd').toLowerCase();
    var layK = lay === 'rwd' || lay === 'mr' || lay === 'rr' ? 1 : lay === 'fwd' ? 0.35 : 0.55;
    var mass = num(p.mass, 1500), hp = num(dr.originalHp, num(p.powerKw, 250) / 0.7457);
    var pw = hp * 0.7457 * 1000 / Math.max(500, mass);
    var massK = smooth01(2600, 1250, mass), pwK = clamp((pw - 100) / 200, 0, 1), wbK = clamp((3.4 - num(p.wheelbase, 2.65)) / 1.0, 0, 1);
    return { c: clamp(0.4 * layK + 0.3 * massK + 0.15 * pwK + 0.15 * wbK, 0, 1), pw: pwK, layout: lay, mass: mass };
  }
  function charTuning(p) {
    var ch = carCharacter(p), k = ch.c - T.charRef;
    var big = clamp(T.angleBig + T.charAngleBig * k, 30, T.angleCap);
    return {
      c: ch.c, pw: ch.pw,
      angleBig: big,
      angleMore: clamp(T.angleMore + T.charAngleMore * k, 26, big),
      angleHold: clamp(T.angleHold + T.charAngleHold * k, 22, 36),
      angleMax: Math.min(T.angleCap, Math.max(T.angleMax, big + 2)),
      drive: T.drive * (T.charDrive[0] + (T.charDrive[1] - T.charDrive[0]) * ch.pw)
    };
  }

  /* ------------------------------------------------------------ track helpers */
  function samplesOf(geom) { return geom && Array.isArray(geom.samples) && geom.samples.length > 8 ? geom.samples : null; }
  function dsOf(geom, S) { return num(geom.ds, num(geom.length, S.length * 5) / S.length); }

  /** Drift speed profile (m/s per sample): curvature-limited, braked backwards. */
  function speedProfile(geom, latA, brakeA, vMax) {
    var S = samplesOf(geom); if (!S) return null;
    var N = S.length, ds = dsOf(geom, S), v = new Array(N), i, k;
    for (i = 0; i < N; i++) {
      // max |curvature| over a small window (smoothed geometry still has short spikes in hairpins)
      var kmax = 0;
      for (k = -2; k <= 2; k++) kmax = Math.max(kmax, Math.abs(num(S[mod(i + k, N)].curvature, 0)));
      v[i] = Math.min(vMax, Math.sqrt(latA / Math.max(kmax, 1e-4)));
    }
    for (var pass = 0; pass < 2; pass++) {
      for (i = N - 1; i >= 0; i--) {
        var nx = v[mod(i + 1, N)], lim = Math.sqrt(nx * nx + 2 * brakeA * ds);
        if (v[i] > lim) v[i] = lim;
      }
    }
    return v;
  }

  function projectOn(geom, x, y, hint) {
    var TR = CB.race && CB.race.tracks;
    if (TR && typeof TR.project === 'function') {
      try { return TR.project(geom, x, y, hint); } catch (e) { /* fall through */ }
    }
    // tiny fallback: nearest sample (windowed)
    var S = samplesOf(geom), N = S.length, best = 0, bd = Infinity, h = hint == null ? null : Math.round(hint);
    var from = h == null ? 0 : h - 30, to = h == null ? N - 1 : h + 30;
    for (var j = from; j <= to; j++) {
      var i = mod(j, N), dx = S[i].x - x, dy = S[i].y - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    var sm = S[best], hd = num(sm.heading, 0), nx = -Math.sin(hd), ny = Math.cos(hd);
    var lat = (x - sm.x) * nx + (y - sm.y) * ny, hw = num(sm.hw, num(sm.width, 14) / 2);
    return { index: best, s: sm.s, lateral: lat, halfWidth: hw, heading: hd, edgeDist: hw - Math.abs(lat), onTrack: Math.abs(lat) <= hw };
  }

  /** Mean signed curvature over samples [i + a, i + b]. */
  function meanCurv(S, i, a, b) {
    var N = S.length, s = 0, n = 0;
    for (var k = Math.round(a); k <= Math.round(b); k++) { s += num(S[mod(i + k, N)].curvature, 0); n++; }
    return n ? s / n : 0;
  }

  /* ------------------------------------------------------------ create */
  function create(opts) {
    opts = opts || {};
    var level = opts.level === 'auto' ? 'auto' : 'heavy';
    var geom = opts.geom || null;
    var S = samplesOf(geom);
    var ds = S ? dsOf(geom, S) : 5;
    var prof = S ? speedProfile(geom, T.profLat, T.profBrake, T.vMax) : null;
    var m;

    function reset() {
      m = {
        phase: 'grip', d: 0, th: 0, thv: 0, thT: 0, swing: false, phi: null, wp: 0, wpT: 0, latS: 0, latT: 0,
        vt: T.vMax, up: false, down: false, kd: 0, driftT: 0, oppT: 0, straightT: 0, liftT: 0, swingCool: 0,
        hint: null, idx: 0, lat: 0, hw: 8, kAhead: 0, kNear: 0, steer: 0, steerV: 0, thr: 0, brake: 0,
        resets: null, tcf: 1, recover: false, swings: 0, drifts: 0, govOn: false, lastCtl: null, angle: 0, entrySpeed: 0,
        stuckT: 0, stuck: false, launchT: 0, holdT: 0, push: 0, wrongWay: false,
        gentle: false, gentleT: 0, gBlock: 0, gentles: 0,
        exiting: false, exitKd: 0, exitUp: false, exits: 0, revCap: 1, limT: 0, shiftCool: 0, shifts: 0, assistBrake: false
      };
    }
    reset();
    var CT = charTuning(opts.params), ctParams = opts.params || null;
    /** per-car drift character (recomputed when the engine swaps / re-tunes the params object) */
    function charOf(car) {
      var p = car && car.params;
      if (p && p !== ctParams) { ctParams = p; CT = charTuning(p); }
      return CT;
    }

    function readCar(car) {
      var st = car.state || car, h = num(st.heading, 0), vx = num(st.vx, 0), vy = num(st.vy, 0);
      var v = Math.hypot(vx, vy);
      var phi = v > 0.4 ? wrap(h + Math.atan2(vy, vx)) : h;
      return { st: st, x: num(st.x, 0), y: num(st.y, 0), h: h, vx: vx, vy: vy, v: v, phi: phi, th: wrap(h - phi), r: num(st.yawRate, 0),
               gear: num(st.gear, 1), wheelspin: num(st.wheelspin, 0) };
    }
    function locate(o) {
      if (!S) return null;
      var p = projectOn(geom, o.x, o.y, m.hint);
      if (p) { m.hint = p.index; m.idx = p.index; m.lat = num(p.lateral, 0); m.hw = num(p.halfWidth, num(S[p.index].hw, 8)); }
      return p;
    }
    var speedCap = null;           // optional external ceiling (m/s), e.g. tandem follow: never rear-end the lead
    function targetSpeed(v) {
      if (speedCap != null) return Math.min(speedCap, targetSpeed0(v));
      return targetSpeed0(v);
    }
    function targetSpeed0(v) {
      if (!prof) return T.vMax;
      var N = prof.length, n = Math.max(3, Math.round((v * 1.25 + 8) / ds)), vt = Infinity;
      for (var k = 0; k <= n; k++) vt = Math.min(vt, prof[mod(m.idx + k, N)]);
      return vt;
    }
    function lockOf(car) { var p = car.params || {}; return Math.max(0.3, num(p.lockAngle, num(p.maxSteer, 0.6))); }
    /** The vehicle's speed-sensitive steering limit (mirrors js/race/vehicle.js substep): steer = 1 asks for this
     *  angle, not the full lock, so grip steering at speed must be scaled by it (else ~3x too little at 150 km/h). */
    function effLockOf(car, v) {
      var p = car.params || {}, lock = lockOf(car), vF = Math.max(0, v);
      var speedLimit = lock / (1 + Math.pow(vF / 21, 1.6));
      if (vF <= 1) return lock;
      var VEH = CB.race && CB.race.vehicle, latCap = 9.5;
      if (VEH && typeof VEH.latAccelAt === 'function' && p.mass) { try { latCap = num(VEH.latAccelAt(p, vF, 1), latCap); } catch (e) { /* default */ } }
      var phys = Math.atan(wbOf(car) * latCap / (vF * vF)) + Math.atan(num(p.tanAlphaPeakF, 0.14)) * 1.25;
      return clamp(Math.max(speedLimit, Math.min(phys, lock)), 0.045, lock);
    }
    function wbOf(car) { var p = car.params || {}; return clamp(num(p.wheelbase, 2.65), 1.8, 4.2); }

    /** Path yaw-rate target (pure pursuit toward the lateral target on the track). */
    function pursuit(o, latTarget, dt, shortLook, latCap) {
      if (!S) return 0;
      var N = S.length;
      m.latT = latTarget;
      m.latS = approach(m.latS, latTarget, 3.0 * dt);
      // grip at speed looks further ahead (~1 s): the short drift look-ahead weaves on fast straights (limit cycle)
      var Ld = (m.phase === 'drift' ? clamp(0.55 * o.v + 6, 9, 32) : clamp((0.55 + T.gripLook * smooth01(15, 35, o.v)) * o.v + 6, 9, 50)) *
               (shortLook ? 0.75 : 1);
      var j = mod(m.idx + Math.max(2, Math.round(Ld / ds)), N), sm = S[j];
      var hd = num(sm.heading, 0), nx = num(sm.nx, -Math.sin(hd)), ny = num(sm.ny, Math.cos(hd));
      var hwj = num(sm.hw, m.hw), lim = Math.max(0, hwj - (m.phase === 'drift' ? T.edgeMargin : T.gripMargin));
      var lj = clamp(m.latS, -lim, lim);
      var px = sm.x + nx * lj, py = sm.y + ny * lj;
      var dist = Math.max(4, Math.hypot(px - o.x, py - o.y));
      var alpha = wrap(Math.atan2(py - o.y, px - o.x) - o.phi);
      var w = o.v * 2 * Math.sin(clamp(alpha, -1.2, 1.2)) / dist;
      var cap = (latCap || T.aLatCap) / Math.max(3, o.v);
      return clamp(w, -cap, cap);
    }

    /* ---------------------------------------------------------- preStep: decide + produce engine input */
    function control(raw, car, dt) {
      raw = raw || {};
      dt = num(dt, 1 / 120);
      var o = readCar(car);
      if (m.resets !== null && car.resets !== undefined && car.resets !== m.resets) reset();
      m.resets = car.resets !== undefined ? car.resets : m.resets;
      locate(o);
      var kd = (raw.left ? 1 : 0) - (raw.right ? 1 : 0);
      // analog wheel (phone tilt / wheel, raw.steerAnalog): the DIRECTION still comes from the wheel (with hysteresis so a
      // wheel held near the threshold never flickers), and its MAGNITUDE scales the angle / line / low-speed steer below
      var ax = typeof raw.steerAxis === 'number' && isFinite(raw.steerAxis) ? clamp(raw.steerAxis, -1, 1) : 0;
      var analog = !!raw.steerAnalog && !kd;
      if (!kd && analog) kd = m.kdA && sign(ax) === m.kdA && Math.abs(ax) > 0.18 ? m.kdA : Math.abs(ax) > 0.35 ? sign(ax) : 0;
      else if (!kd && Math.abs(ax) > 0.35) kd = sign(ax);
      m.kdA = analog ? kd : 0;
      var ka = analog ? clamp((Math.abs(ax) - 0.1) / 0.6, 0, 1) : (kd ? 1 : 0);   // how hard the wheel is turned
      var kv = analog ? ax : kd;                                                   // continuous steer, + = left
      var kAny = analog ? Math.abs(kv) > 0.05 : !!kd;
      var up = !!raw.up || num(raw.throttleAxis, 0) > 0.4, down = !!raw.down || num(raw.brakeAxis, 0) > 0.4;
      m.kd = kd; m.up = up; m.down = down;
      var auto = level === 'auto';
      var C = charOf(car);
      var reversing = o.gear < 0 || o.vx < -0.5;
      if (S) {
        var nA = Math.max(4, o.v * 0.9 / ds), nN0 = Math.max(1, o.v * 0.35 / ds), nN1 = Math.max(6, o.v * 1.1 / ds);
        m.kAhead = meanCurv(S, m.idx, 0, nA);
        m.kNear = meanCurv(S, m.idx, nN0, nN1);
      }
      m.vt = targetSpeed(o.v);
      if (m.swingCool > 0) m.swingCool -= dt;
      // no-progress watchdog (grip phase, Up held, crawling): see the low-speed steer / traction control below
      if (up && !down && !reversing && m.phase === 'grip' && o.v < T.stuckV) m.stuckT += dt;
      else if (!up || down || reversing || o.v > T.stuckClear) m.stuckT = 0;
      if (m.stuckT > T.stuckT) m.stuck = true; else if (m.stuckT === 0) m.stuck = false;

      /* ---- phase logic */
      if (reversing) { if (m.phase === 'drift') endDrift(o); }
      else if (m.phase === 'grip') {
        if (Math.abs(o.th) > 50 * DEG && o.v > 4) { startDrift(o, sign(o.th) || 1, true); }      // caught out: lock + recover
        else if (up && !down && o.v > T.vEnter) {
          // auto: tight corners by curvature, fast sweepers (banked ovals) by the lateral g they ask for at this speed
          var aK = Math.abs(m.kNear), autoWant = aK > 1 / 160 || (aK > 1 / 700 && o.v * o.v * aK > T.autoLatG);
          var want = auto ? (autoWant ? sign(m.kNear) : 0) : kd;
          if (auto && kd && Math.abs(m.kNear) > 1 / 300 && sign(m.kNear) === kd) want = kd;
          // heavy, Up only through a long corner: a gentle drift the corner's way (after a short dwell)
          var gDir = !auto && !kd && T.gentleAuto ? gentleCorner(o) : 0, gentle = false;
          if (gDir && gDir !== m.gBlock) { m.gentleT += dt; if (m.gentleT > T.gentleDwell_s) { want = gDir; gentle = true; } }
          else m.gentleT = 0;
          if (want) startDrift(o, want, false, gentle);
        } else m.gentleT = 0;
        // an arrow against the corner (or a drift straightened with one) blocks the gentle drift until that corner ends
        if (!auto && kd && Math.abs(m.kNear) > T.gentleK * 0.5 && kd === -sign(m.kNear)) m.gBlock = sign(m.kNear);
        else if (m.gBlock && (Math.abs(m.kNear) < 1 / 400 || sign(m.kNear) !== m.gBlock)) m.gBlock = 0;
      } else {
        m.driftT += dt;
        var dK = m.d * m.kAhead;
        if (m.recover) {
          // unwinding exit: a FRESH arrow (+ Up) above drift speed in a corner catches the slide again
          var fresh = kd && (kd !== m.exitKd || (up && !m.exitUp));
          if (!kd) m.exitKd = 0;
          if (!up) m.exitUp = false;
          if (m.exiting && o.v < T.vExit) endDrift(o);
          else if (m.exiting && up && !down && fresh && o.v > T.vEnter && (Math.abs(m.kNear) > 1 / 300 || kd !== m.d)) {
            m.exiting = false; startDrift(o, kd, false, false);
          } else if (Math.abs(o.th) < (m.exiting ? T.exitEnd_deg : 8) * DEG) { m.recover = false; endDrift(o); }
        } else {
          if (!up) m.liftT += dt; else m.liftT = 0;
          if (o.v < T.vExit) endDrift(o);
          else if (m.liftT > T.liftExit) softEnd(kd, up);
          else if (!auto && kd === -m.d) {
            if (dK > 1 / 140 && Math.abs(meanCurv(S || [{ curvature: 0 }], m.idx, 0, Math.max(4, o.v * 0.5 / ds))) > 1 / 200) {
              m.oppT += dt;                                   // road still turns our way: straighten / end
              if (m.oppT > T.oppExit) { m.gBlock = m.d; softEnd(kd, up); }
            } else if (m.swingCool <= 0) swing();
          } else if (auto && dK < -1 / 170 && m.swingCool <= 0) swing();
          // gentle (Up-only) drifts swing S-bends too, a little earlier (less angle to unwind: never wrong way round)
          else if (m.gentle && !kd && dK < -1 / T.gentleSwingR && m.swingCool <= 0) swing();
          else {
            m.oppT = 0;
            if (!kd || auto) {
              if (dK < 1 / 380) m.straightT += dt; else m.straightT = 0;
              if (m.straightT > (auto ? 0.75 : T.straightExit)) softEnd(kd, up);
            } else m.straightT = 0;
          }
        }
      }

      /* ---- targets */
      var lock = lockOf(car), wb = wbOf(car), steerT, thrT, brkT = 0, hb = false;
      var corner = Math.abs(m.kAhead) > 1 / 300 ? sign(m.kAhead) : 0;
      var inside = corner * Math.min(Math.max(0, m.hw - T.edgeMargin), 0.3 * m.hw);
      if (m.phase === 'drift') {
        var dKd = m.d * m.kAhead;
        // hold the drift key = commit: the angle target ramps up (40 -> 52 deg) and Up earns a little extra pace
        if (kd === m.d && !m.recover && !m.swing) m.holdT += dt; else m.holdT = Math.max(0, m.holdT - 2.5 * dt);
        if (kd) m.gentle = false;                                                           // the player took over
        if (m.gentle && m.recover) m.gentle = false;
        var ramp = smooth01(T.holdRamp[0], T.holdRamp[1], m.holdT);
        m.wrongWay = !auto && !m.recover && !m.swing && kd === m.d && dKd < -1 / 220;      // key held toward the outside
        var A = C.angleHold;
        if (auto) {
          A = 26 + clamp(Math.abs(m.kAhead) * 1400, 0, 12);
          if (kd === m.d) A += 8 + 6 * ramp; else if (kd === -m.d) A -= 10;
        } else if (kd === m.d) A = C.angleHold + (C.angleMore + (C.angleBig - C.angleMore) * ramp - C.angleHold) * (analog ? ka : 1);
        else if (m.gentle) A = T.angleGentle;
        if (m.wrongWay) A = Math.min(A, T.angleLess + 6);
        if (m.oppT > 0) A = T.angleLess;
        if (down) A = Math.min(A, T.angleWide);
        A = Math.min(C.angleMax, A) * smooth01(T.vExit * 0.8, T.vEnter * 1.3, o.v);
        m.thT = m.recover ? 0 : m.d * A * DEG;
        // speed target: profile x push (committed, into the corner) or x wrongWayK (drifting against the corner)
        var pushT = 0;
        if (up && !down && !m.recover && dKd > 1 / 400) pushT = kd === m.d ? T.pushMax * ramp : m.gentle ? 0 : T.pushUpOnly;
        if (m.wrongWay) pushT = T.wrongWayK - 1;
        m.push = approach(m.push, pushT, (pushT < m.push ? 0.12 : 0.05) * dt);
        m.vt = targetSpeed0(o.v) * (1 + m.push);
        if (speedCap != null) m.vt = Math.min(m.vt, speedCap);
        // Down = wide line: aim for the outside half of the road (less angle, the car runs out toward the edge)
        var outside = -corner * Math.min(Math.max(0, m.hw - T.edgeMargin), 0.45 * m.hw);
        var latTgt = down ? outside : inside + (kAny && !auto ? kv * 1.6 : 0);
        m.wpT = pursuit(o, latTgt, dt, false);
        // engine input: counter-steer (fronts along the travel direction) + path curvature
        var dPath = Math.atan(wb * m.wpT / Math.max(3, o.v));
        steerT = clamp((-o.th * 0.92 + dPath) / lock, -1, 1);
        var over = o.v - m.vt;
        thrT = up ? (over > 0.5 ? 0.45 : 0.92) : 0.25;
        if (over > 2.5 || down) brkT = down ? 0.22 : 0.18;
      } else {
        m.thT = 0; m.holdT = 0; m.push = 0; m.wrongWay = false;
        // low-speed easy car <-> auto-steered grip car: blended over T.gripBlend (no regime switch -> no twitch)
        var wHi = smooth01(T.gripBlend[0], T.gripBlend[1], o.v), steerHi = 0, steerLo = 0;
        var gCap = T.gripLatLow + (T.gripLatCap - T.gripLatLow) * smooth01(6, 16, o.v);   // gentle at low speed
        if (wHi > 0 && !kAny) m.wpT = pursuit(o, inside * 0.5, dt, false, gCap);                   // auto-steer: stay on the road
        else if (wHi > 0 && kAny) m.wpT = pursuit(o, kv * Math.max(0, m.hw - T.gripMargin), dt, true, gCap);  // move across the road (analog: proportionally)
        else m.wpT = 0;
        m.wpT *= wHi;
        if (wHi > 0) steerHi = clamp((Math.atan(wb * m.wpT / Math.max(3, o.v)) - 0.5 * o.th) / effLockOf(car, o.v), -1, 1);
        if (wHi < 1) {
          // low speed: a normal easy car. Key = steer (smoothed by the filter below), no key = gentle auto-steer.
          var auto0 = S && (o.v > 1.5 || m.stuck) ? clamp(Math.atan(wb * pursuit(o, 0, dt, true) / Math.max(2, o.v)) / lock, -0.6, 0.6) : 0;
          // speed-limited lock (lateral accel <= launchG): holding an arrow from a standstill spirals out and builds
          // speed instead of circling forever on full lock
          var dLim = Math.atan(wb * T.launchG / Math.max(1, o.v * o.v)) / lock;
          var kSteer = kAny ? kv * Math.min(T.launchLock, Math.max(0.12, dLim)) : 0;
          if (kAny && S) {
            // edge-aware launch: an arrow held toward the near edge fades into the road-following auto-steer
            // (holding Right off the grid never drives the car into the barrier / onto the grass)
            var eK = kv * m.lat > 0 ? smooth01(m.hw - T.gripMargin - 3.5, m.hw - 1.2, Math.abs(m.lat)) : 0;
            if (m.lat * sign(kv) > m.hw) eK = 1;
            kSteer += (auto0 - kSteer) * eK;
          }
          // no progress with Up held (crawling / circling / nose against something): straighten up and go
          if (m.stuck) kSteer = auto0;
          steerLo = kAny ? kSteer : auto0 * 0.8;
        }
        steerT = steerLo + (steerHi - steerLo) * wHi;
        var over2 = o.v - m.vt * T.gripSpeedK;
        thrT = up ? (over2 > 0.5 ? 0.15 : 1) : 0;
        if (up && !raw.up && typeof raw.throttleAxis === 'number') thrT *= clamp(raw.throttleAxis / 0.85, 0, 1);   // analog pedal
        // launch traction control (below drift speed): adaptive throttle cap while the rears spin -> no launch slide
        // (the floor stays high enough to keep accelerating: a lock-to-lock crawl reads ~0.3 wheelspin by itself)
        if (o.v < T.vEnter) {
          m.launchT = up ? m.launchT + dt : 0;
          var tcFloor = m.stuck ? 0.7 : T.tcFloor[0] + (T.tcFloor[1] - T.tcFloor[0]) * smooth01(T.tcRamp[0], T.tcRamp[1], m.launchT);
          if (o.wheelspin > 0.3 && !m.stuck) m.tcf = Math.max(tcFloor, m.tcf - 4 * dt); else m.tcf = Math.min(1, Math.max(tcFloor, m.tcf + 0.8 * dt));
          thrT = Math.min(thrT, m.tcf);
        } else { m.tcf = Math.min(1, m.tcf + 1.2 * dt); m.launchT = 0; }
        brkT = down ? 1 : (up && over2 > 1.5 ? clamp((over2 - 1.5) / 4, 0, 0.7) : 0);
        if (down && o.v < 0.8) { brkT = 1; }                                              // reverse stays possible
      }
      m.govOn = o.v > m.vt + 0.5;
      m.assistBrake = up && !down && brkT > 0.03 && o.v > 3;

      /* ---- engine in a drift: soft rev cap + short-shift off the limiter (a bouncing fuel cut is an on/off torque
         step on the rears and a ~11 Hz audio flutter) */
      var rpm = num(o.st.rpm, 0), pp = car.params || {}, red = num(pp.redline, num(car.redline, 7000));
      var limR = num(pp.limiterRpm, red + 60), revHi = Math.min(red * T.revSoft, limR - 120), slide = m.phase === 'drift';
      if (m.shiftCool > 0) m.shiftCool -= dt;
      var shiftUp = false;
      if (o.gear >= 1 && rpm > 0 && !reversing) {
        if (slide && rpm > revHi) m.revCap = Math.max(T.revCapMin, m.revCap - dt * T.revCut * (rpm - revHi) / Math.max(200, limR - revHi));
        else m.revCap = Math.min(1, m.revCap + dt * T.revRecover);
        var ratios = Array.isArray(pp.ratios) ? pp.ratios : null, g = Math.round(o.gear);
        if (slide && ratios && !pp.isCVT && rpm > red * 0.93) m.limT += dt; else m.limT = Math.max(0, m.limT - dt);
        if (slide && ratios && g < Math.min(ratios.length, num(pp.maxGear, ratios.length)) && m.limT > T.limShift_s && m.shiftCool <= 0 &&
            !(num(o.st.shiftTimer, 0) > 0)) {
          var rpmUp = rpm * num(ratios[g], 1) / num(ratios[g - 1], 1);
          var minR = pp.driftGearing ? num(pp.driftGearing.minRpm, 0) * 1.05 : 0;
          if (rpmUp > Math.max(red * T.limShiftMin, minR)) { shiftUp = true; m.shiftCool = 1.0; m.limT = 0; m.shifts++; m.revCap = Math.max(m.revCap, 0.8); }
        }
      } else { m.revCap = 1; m.limT = 0; }
      if (slide) thrT = Math.min(thrT, m.revCap);

      /* ---- output smoothing: critically damped + rate limited steer, rate-limited pedals */
      var w = T.steerW, acc = w * w * (steerT - m.steer) - 2 * w * m.steerV;
      m.steerV = clamp(m.steerV + acc * dt, -T.steerRate, T.steerRate);
      m.steer = clamp(m.steer + m.steerV * dt, -1, 1);
      m.thr = approach(m.thr, thrT, T.thrRate * dt);
      if (slide) m.thr = Math.min(m.thr, m.revCap);                        // the cap acts at once (no rate-limit lag)
      m.brake = approach(m.brake, brkT, 5 * dt);
      var out = { throttle: clamp(m.thr, 0, 1), brake: clamp(m.brake, 0, 1), steer: m.steer, handbrake: hb,
                  shiftUp: !!raw.shiftUp || shiftUp, shiftDown: !!raw.shiftDown && !shiftUp };
      if (down && o.v < 0.8 && !up) { out.brake = 1; out.throttle = 0; }
      m.lastCtl = out;
      return out;
    }

    /** Heavy Up-only: the direction of a LONG corner right here (tight now and still turning that way gentleLen_s
     *  ahead at this speed), else 0. */
    function gentleCorner(o) {
      if (!S) return 0;
      var k = m.kNear, dir = sign(k);
      if (Math.abs(k) < T.gentleK || sign(m.kAhead) !== dir) return 0;
      var nL = Math.max(8, o.v * T.gentleLen_s / ds), mean = meanCurv(S, m.idx, 0, nL);
      return sign(mean) === dir && Math.abs(mean) > T.gentleK * 0.75 ? dir : 0;
    }
    function startDrift(o, d, recover, gentle) {
      m.phase = 'drift'; m.d = d; m.driftT = 0; m.oppT = 0; m.straightT = 0; m.liftT = 0; m.swing = false;
      m.th = o.th; m.thv = 0; m.phi = o.phi; m.recover = !!recover; m.entrySpeed = o.v;
      m.gentle = !!gentle && !recover; m.gentleT = 0;
      if (!recover) m.drifts++;
      if (m.gentle) m.gentles++;
    }
    function endDrift() { m.exiting = false; m.phase = 'grip'; m.d = 0; m.thT = 0; m.oppT = 0; m.straightT = 0; m.liftT = 0; m.recover = false; m.swing = false; m.gentle = false; }
    /** a normal drift end (lift / straight road / opposite key): unwind slowly to grip instead of snapping to it */
    function softEnd(kd, up) { m.recover = true; m.exiting = true; m.exitKd = kd || 0; m.exitUp = !!up; m.exits++; m.holdT = 0; }
    function swing() { m.d = -m.d; m.swing = true; m.swingCool = T.swingCool; m.oppT = 0; m.straightT = 0; m.swings++; }

    /* ---------------------------------------------------------- postStep: regulate the vehicle state */
    function shape(car, dt) {
      dt = num(dt, 1 / 120);
      var o = readCar(car), st = o.st;
      if (o.v < 0.5 || o.gear < 0 || o.vx < -0.5) { m.phi = o.phi; m.wp = 0; return; }
      var wA = smooth01(T.vArc[0], T.vArc[1], o.v);
      m.wp += (m.wpT - m.wp) * blendK(dt, T.tauPath);
      if (m.phase === 'drift') {
        // angle filter (critically damped, rate limited)
        var w = m.swing ? T.wSwing : (m.recover ? (m.exiting ? T.wExit : 5.5) : T.wEntry);
        var acc = w * w * (m.thT - m.th) - 2 * w * m.thv;
        m.thv = clamp(m.thv + acc * dt, -T.maxAngleRate, T.maxAngleRate);
        m.th += m.thv * dt;
        if (m.swing && Math.abs(m.thT - m.th) < 2 * DEG) m.swing = false;
        // travel direction: track an integrated reference heading (NOT reset to the measured one each step,
        // so the tyre forces of the physics step cannot slowly bend the path off the drift line)
        var phiRef = wrap((m.phi == null ? o.phi : m.phi) + m.wp * dt);
        var eRef = wrap(phiRef - o.phi);
        if (Math.abs(eRef) > T.phiWindup) phiRef = wrap(o.phi + sign(eRef) * T.phiWindup);   // anti wind-up
        var kv = blendK(dt, T.tauVel) * wA;
        var phiN = wrap(o.phi + kv * wrap(phiRef - o.phi));
        m.phi = phiRef;
        // yaw regulation toward the filtered angle
        var thN = wrap(o.h - phiN);
        var rDes = m.wp + m.thv + T.kTheta * wrap(m.th - thN);
        var kr = blendK(dt, T.tauYaw) * wA;
        var rN = o.r + kr * (rDes - o.r);
        // hard guard: never past the clamp angle (prevents spins even with a wild physics step)
        if (Math.abs(thN) > T.clampAngle) {
          var ex = thN - sign(thN) * T.clampAngle;
          st.heading = wrap(o.h - ex);
          thN = wrap(st.heading - phiN);
          if (sign(rN) === sign(ex)) rN *= 0.3;
        }
        // speed: governor + drift drive
        var vN = o.v;
        if (vN > m.vt) vN = Math.max(m.vt, vN - T.govDecel * dt);
        else if (m.up && !m.down) vN = Math.min(m.vt, vN + charOf(car).drive * dt);
        // write back (body frame: velocity angle relative to the nose = -theta)
        st.vx = vN * Math.cos(thN); st.vy = -vN * Math.sin(thN); st.yawRate = rN; st.speed = vN;
        m.angle = Math.abs(thN);
      } else {
        m.phi = o.phi;
        // grip: slip damping (no spin on launch / when lifting), soft yaw follow, edge guard
        var kS = (o.v < T.vEnter ? 0.12 : 0.035) * wA;
        var vy = o.vy * (1 - kS);
        var vx = o.vx;
        var r = o.r, wHi = smooth01(T.gripBlend[0], T.gripBlend[1], o.v);
        var rLo = o.r, rHi = o.r;
        if (o.v > 0.5 && wHi < 1) {
          // easy car: yaw follows the kinematic (no-slide) yaw rate of the steered wheels -> no twitch, no launch spin
          var rKin = o.v * Math.tan(num(st.steerAngle, 0)) / wbOf(car);
          rLo = o.r + blendK(dt, 0.06) * (rKin - o.r);
        }
        if (wHi > 0) rHi = o.r + blendK(dt, 0.09) * ((m.wp - 3.0 * o.th) - o.r);
        r = rLo + (rHi - rLo) * wHi;
        var vNow = Math.hypot(vx, vy), thNow = wrap(o.h - o.phi), edge = 0;
        if (S) edge = smooth01(m.hw - T.gripMargin - 1.0, m.hw - 0.6, Math.abs(m.lat));
        if (wHi > 0) {
          // travel direction toward the path (stronger near the edge)
          var kv2 = blendK(dt, 0.12) * (0.25 + 0.75 * edge) * wHi;
          thNow = wrap(o.h - (o.phi + kv2 * m.wp * dt));
        }
        // edge guard (all speeds): near the edge, bleed off the velocity component pointing further out (smooth)
        if (S && edge > 0 && o.v > 1.5) {
          var hdT = num(S[m.idx].heading, o.phi), aOut = wrap((o.h - thNow) - hdT);
          if (sign(aOut) === sign(m.lat) && Math.abs(aOut) > 0.005 && Math.abs(aOut) < 1.4) {
            var dEdge = aOut * blendK(dt, 0.35) * edge;
            thNow = wrap(thNow + dEdge);
            r -= dEdge / dt * (1 - wHi);                                   // low speed: the body turns with it (no slide)
          }
        }
        vx = vNow * Math.cos(thNow); vy = -vNow * Math.sin(thNow);
        if (wHi > 0) {
          // grip driving cannot hold the drift profile's lateral g: govern to the grip share of it
          var vt2 = m.vt * T.gripSpeedK;
          if (vNow > vt2 + 1) { var vR = Math.max(vt2, vNow - 4 * dt * wHi) / vNow; vx *= vR; vy *= vR; }
        }
        st.vx = vx; st.vy = vy; st.yawRate = r; st.speed = Math.hypot(vx, vy);
        m.angle = Math.abs(wrap(o.h - o.phi));
      }
    }

    var api = {
      level: level, active: true, T: T,
      control: control, shape: shape, reset: reset,
      setLevel: function (l) { if (l === 'auto' || l === 'heavy') { level = l; api.level = l; } return level; },
      getLevel: function () { return level; },
      /** Optional external speed ceiling in m/s (null clears). The governor eases toward it like a corner. */
      setSpeedCap: function (v) { speedCap = typeof v === 'number' && isFinite(v) ? Math.max(3, v) : null; return speedCap; },
      getSpeedCap: function () { return speedCap; },
      isDrifting: function () { return m.phase === 'drift' && !m.recover; },
      /** per-car drift character {c 0..1, angleBig, angleMore, angleHold, angleMax, drive} */
      character: function () { return CT; },
      /** cosmetic hints for smoke / audio / camera (0..1) */
      cosmetics: function () {
        // an unwinding exit still slides: smoke / squeal fade out with the angle instead of cutting at 25-30 deg
        var drifting = m.phase === 'drift' && (!m.recover || (m.exiting && m.angle > 10 * DEG));
        var slip = drifting ? smooth01(6 * DEG, 34 * DEG, m.angle) : 0;
        return { drifting: drifting, slip: slip, angle_deg: m.angle / DEG, dir: m.d, swing: m.swing, throttle: m.thr, governor: m.govOn,
                 exiting: m.exiting, assistBraking: m.assistBrake };
      },
      debug: function () {
        return {
          arcade: true, level: level, phase: m.recover ? 'recover' : m.phase, dir: m.d, swing: m.swing,
          targetAngle_deg: Math.abs(m.thT) / DEG, filteredAngle_deg: Math.abs(m.th) / DEG, angle_deg: m.angle / DEG,
          beta_deg: m.angle / DEG * (m.d ? -m.d : 1), counterSteer_deg: 0, steer: m.steer, throttle: m.thr, brake: m.brake,
          targetSpeed_kph: m.vt * 3.6, governor: m.govOn, pathYaw: m.wp, latTarget: m.latT, lateral: m.lat, halfWidth: m.hw,
          curvAhead: m.kAhead, drifts: m.drifts, swings: m.swings, driftTime_s: m.driftT,
          commit: smooth01(T.holdRamp[0], T.holdRamp[1], m.holdT), push: m.push, wrongWay: m.wrongWay,
          gentle: m.gentle, gentles: m.gentles,
          exiting: m.exiting, exits: m.exits, assistBraking: m.assistBrake, revCap: m.revCap, limiterShifts: m.shifts,
          character: CT.c, angleCap_deg: CT.angleBig, drive: CT.drive
        };
      },
      _state: function () { return m; }
    };
    return api;
  }

  CB.race.drift.arcade = {
    create: create,
    LEVELS: ['heavy', 'auto'],
    TUNING: T,
    /** true when the arcade drift lock drives this assist level in drift mode */
    appliesTo: function (level, mode) { return mode !== 'race' && (level === 'heavy' || level === 'auto'); },
    carCharacter: carCharacter, charTuning: charTuning,
    _internal: { speedProfile: speedProfile, meanCurv: meanCurv, wrap: wrap, projectOn: projectOn }
  };
})();
if (typeof module !== 'undefined') module.exports = CB.race.drift.arcade;

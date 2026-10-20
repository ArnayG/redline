/* ==========================================================================
   Redline — js/derby/derby-physics.js
   CB.derby.physics : 2.5D rigid-body car model for Demolition Derby (docs/DERBY-SPEC.md §4).

     DT                                  fixed step (1/120 s)
     specFromBuild(build, metrics?)      -> spec {mass, Iz, length, width, height, wheelbase, a, b, cgH, powerKw, drive, enginePos,
                                            topSpeed, accel, brakeDecel, grip, steerLock, baseMass}
     withMass(spec, extraKg)             -> spec with accessory mass (handling scales)
     createBody(car, pose)               resets the kinematic state on a car object
     corners(car, inflate?) -> [[x,y] x4] (FL, FR, RR, RL)     probes(car) -> 8 points (+ local coords)
     drive(world, car, input, mods, dt)  tyre / drive / brake forces + integration of one car (no contacts)
     collideCars(a, b, opts)             -> contact|null (resolves the impulse + separation)
     collideArena(world, car)            -> [contacts] walls / obstacles / steps, resolved
     surfaceAt(arena, x, y, t)           -> {z, grip, drag, kind, floor, open, pit, crush, dps, ignite}
     raycast(world, x, y, dx, dy, maxDist, ignoreId) -> {dist, kind, id}
     edgeInfo(arena, x, y)               -> {dist, nx, ny, open}
     applyImpulse(car, jx, jy, px, py)   impulse at a world point (N·s)
     toLocal(car, x, y) -> {lx, ly}      toWorld(car, lx, ly) -> {x, y}

   Contacts: { a, b, kind 'car'|'wall'|'obstacle'|'step', px, py, nx, ny (unit, from a toward b / out of the wall
   into a for walls), vn (closing speed m/s, >= 0), vt, j (N·s), energy (J), obstacleId }.
   Deterministic: pure arithmetic, no Math.random. Classic script, Node-loadable.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  var A = function () { return CB.derby.arenas; };
  var G = 9.81, DT = 1 / 120;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function wrap(a) { if (!(a > -Math.PI && a <= Math.PI)) { if (!isFinite(a)) return 0; a = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI)); } return a; }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  /* ================================================================== spec from a Garage build */
  var HEIGHT = { suv: 1.75, van: 1.95, pickup: 1.85, wagon: 1.48, hatchback: 1.45, sedan: 1.44, coupe: 1.3, roadster: 1.25, hypercar: 1.15, 'shooting-brake': 1.38 };
  function specFromBuild(build, metrics) {
    build = build || {};
    var V = CB.race && CB.race.vehicle, P = null, m = metrics || null;
    if (!m && CB.physics && typeof CB.physics.compute === 'function') { try { m = CB.physics.compute(build); } catch (e) { m = null; } }
    if (V && typeof V.fromBuild === 'function') { try { P = V.fromBuild(build, m); } catch (e2) { P = null; } }
    var body = build.body || {}, eng = build.engine || {}, dtl = build.drivetrain || {};
    var style = body.style || 'coupe';
    var mass = clamp(num(P && P.mass, num(m && m.weight_kg, 1500)), 700, 3200);
    var length = clamp(num(P && P.length_m, 4.5), 3.5, 5.6);
    var width = clamp(num(P && P.width_m, 1.9), 1.6, 2.15);
    var wheelbase = clamp(num(P && P.wheelbase, (body.wheelbase_mm || 2650) / 1000), 2.2, 3.6);
    var wf = clamp(num(P && P.weightFront, 0.55), 0.35, 0.65);
    var a = wheelbase * (1 - wf), b = wheelbase * wf;
    var powerKw = clamp(num(P && P.power_kw, num(m && m.power_hp, 300) * 0.7457), 60, 1500);
    var pw = powerKw / (mass / 1000);                           // kW per tonne (eco 120 .. hyper 900)
    var layout = String(dtl.layout || (P && P.layout) || 'rwd').toLowerCase();
    var drive = layout.indexOf('awd') >= 0 || layout === '4wd' ? 'awd' : layout === 'fwd' ? 'fwd' : 'rwd';
    var pos = String(eng.position || 'front');
    var enginePos = pos === 'mid' || pos.indexOf('mid') >= 0 ? 'mid' : pos === 'rear' ? 'rear' : 'front';
    if (eng.type === 'ev') enginePos = pos === 'front' ? 'front' : enginePos;
    var height = HEIGHT[style] || 1.4;
    // derby envelope: arenas are ~100 m across, so top speeds are compressed (100..150 km/h) while the power to
    // weight ratio still separates a hatch from a hypercar off the line
    var topSpeed = 30 + 14 * smooth(80, 620, pw);
    var accel = clamp(6.2 + 4.6 * smooth(60, 600, pw), 6.2, 10.8) * (drive === 'awd' ? 1.05 : 1);   // fun pass: punchy launches (0-80 km/h ~2.2-3.4 s)
    var grip = clamp(0.98 + (P && isFinite(P.muF) ? (P.muF - 1.05) * 0.25 : 0), 0.9, 1.12);
    return {
      mass: mass, baseMass: mass, length: length, width: width, height: height, wheelbase: wheelbase, a: a, b: b,
      cgH: height * 0.38, track: width - 0.3, powerKw: powerKw, pw: pw, drive: drive, enginePos: enginePos, style: style,
      topSpeed: topSpeed, accel: accel, brakeDecel: 9.5, grip: grip, steerLock: 0.6, Iz: mass * (length * length + width * width) / 12 * 0.95
    };
  }
  /** accessory mass: heavier = harder hitting but slower to accelerate / turn */
  function withMass(spec, extraKg, reach) {
    var s = {}; for (var k in spec) s[k] = spec[k];
    var m = spec.baseMass + (extraKg || 0);
    s.mass = m;
    s.Iz = spec.Iz * (m / spec.baseMass) * (1 + 0.12 * (extraKg || 0) / 300);
    s.accel = spec.accel * Math.pow(spec.baseMass / m, 0.6);
    s.topSpeed = spec.topSpeed * (1 - 0.05 * clamp((extraKg || 0) / 300, 0, 1.4));
    s.reachF = num(reach && reach.front, 0); s.reachR = num(reach && reach.rear, 0);
    return s;
  }

  /* ================================================================== body helpers */
  function createBody(car, pose) {
    car.x = num(pose && pose.x, 0); car.y = num(pose && pose.y, 0); car.heading = num(pose && pose.heading, 0);
    car.z = num(pose && pose.z, 0); car.vx = 0; car.vy = 0; car.vz = 0; car.w = 0;
    car.pitch = 0; car.roll = 0; car.pitchV = 0; car.rollV = 0; car.airborne = false; car.flipped = false; car.flipT = 0;
    car.steer = 0; car.throttle = 0; car.brake = 0; car.gear = 1; car.airT = 0; car.groundZ = car.z; car.slip = 0;
    car.px = car.x; car.py = car.y;
    return car;
  }
  function toLocal(car, x, y) {
    var c = Math.cos(car.heading), s = Math.sin(car.heading), dx = x - car.x, dy = y - car.y;
    return { lx: dx * c + dy * s, ly: -dx * s + dy * c };
  }
  function toWorld(car, lx, ly) {
    var c = Math.cos(car.heading), s = Math.sin(car.heading);
    return { x: car.x + lx * c - ly * s, y: car.y + lx * s + ly * c };
  }
  /** FL, FR, RR, RL world corners (front reach from a ram / ramp extends the nose) */
  function corners(car, inflate) {
    var sp = car.spec, L = sp.length / 2 + (inflate || 0), W = sp.width / 2 + (inflate || 0);
    var Lf = L + num(sp.reachF, 0), Lr = L + num(sp.reachR, 0) * 0;
    var c = Math.cos(car.heading), s = Math.sin(car.heading);
    function p(lx, ly) { return [car.x + lx * c - ly * s, car.y + lx * s + ly * c]; }
    return [p(Lf, W), p(Lf, -W), p(-Lr, -W), p(-Lr, W)];
  }
  /** 8 contact probes: 4 corners + 4 edge mid-points (+ the nose tip when a ram is fitted) */
  function probes(car) {
    var sp = car.spec, L = sp.length / 2, W = sp.width / 2, Lf = L + num(sp.reachF, 0);
    var c = Math.cos(car.heading), s = Math.sin(car.heading);
    var loc = [[Lf, W * 0.92], [Lf, -W * 0.92], [-L, -W], [-L, W], [Lf, 0], [-L, 0], [0, W], [0, -W], [L * 0.5, W], [L * 0.5, -W], [-L * 0.5, W], [-L * 0.5, -W]];
    return loc.map(function (q) { return { x: car.x + q[0] * c - q[1] * s, y: car.y + q[0] * s + q[1] * c, lx: q[0], ly: q[1] }; });
  }
  function applyImpulse(car, jx, jy, px, py) {
    var m = car.spec.mass, I = car.spec.Iz;
    car.vx += jx / m; car.vy += jy / m;
    var rx = px - car.x, ry = py - car.y;
    car.w += (rx * jy - ry * jx) / I;
  }
  function pointVel(car, px, py) {
    var rx = px - car.x, ry = py - car.y;
    return { x: car.vx - car.w * ry, y: car.vy + car.w * rx };
  }

  /* ================================================================== surface */
  function surfaceAt(arena, x, y, t) {
    var AR = A();
    var hz = AR.heightAt(arena, x, y);
    var bd = AR.sdBoundary(arena, x, y);
    var haz = AR.hazardAt(arena, x, y, t || 0);
    var outside = bd.d < -0.05;
    var s = arena.surface || {};
    var g = num(s.grip, 1) * haz.grip;
    var z = hz.z;
    var floorOK = !(outside && bd.open) && !haz.pit;
    if (hz.src && hz.src.kind === 'kicker') g = Math.min(g, 1);
    if (hz.src) g = Math.max(g, 0.85 * num(s.grip, 1) < 0.5 ? 0.6 : g);   // ramps / decks are dry concrete even on ice
    return { z: floorOK ? z : -50, grip: clamp(g, 0.08, 1.6), drag: haz.drag, kind: haz.kind || s.kind, floor: floorOK, open: outside && bd.open,
      pit: haz.pit, crush: haz.crush, dps: haz.dps, ignite: haz.ignite, src: hz.src, boundary: bd,
      carry: haz.carry && isFinite(haz.carry.vx) && isFinite(haz.carry.vy) ? haz.carry : null, kick: haz.kick || null };
  }
  function edgeInfo(arena, x, y) {
    var b = A().sdBoundary(arena, x, y);
    return { dist: b.d, nx: b.nx, ny: b.ny, open: b.open };
  }

  /* ================================================================== drive one car (no contacts) */
  /**
   * input {throttle, brake, steer (+1 left), handbrake}; mods (damage + accessories):
   * {powerMult, topMult, accelMult, gripMult[4] (FL FR RL RR), steerPull (rad), steerLockMult, wobble, dragAdd, brakeMult,
   *  noDrive, extraForce {x,y} (N, magnet / nitro push), stunned}
   */
  function drive(world, car, input, mods, dt) {
    var sp = car.spec, m = sp.mass;
    mods = mods || {};
    var arena = world.arena, t = world.t || 0;
    car.px = car.x; car.py = car.y;
    var surf = surfaceAt(arena, car.x, car.y, t);
    car.surf = surf.kind; car.surfGrip = surf.grip;
    var ch = Math.cos(car.heading), sh = Math.sin(car.heading);
    // moving ground (turntables / conveyors, CB.derby.arenas hazardAt carry {vx, vy, omega}): the tyres grip the platform,
    // so all tyre forces work on the velocity RELATIVE to the surface -> cars ride it and get flung into each other
    var cvx = 0, cvy = 0, com = 0;
    if (surf.carry && !car.airborne && (surf.carry.vx || surf.carry.vy)) {
      cvx = num(surf.carry.vx, 0); cvy = num(surf.carry.vy, 0);
      if (surf.carry.omega != null) com = num(surf.carry.omega, 0);
      else {
        // yaw rate of the ground under the car: carry difference between the axles (turntables spin the car with them)
        var ax0 = sp.wheelbase / 2, hc = Math.cos(car.heading), hs = Math.sin(car.heading);
        var cf = A().hazardAt(arena, car.x + hc * ax0, car.y + hs * ax0, t).carry || { vx: 0, vy: 0 };
        var cr = A().hazardAt(arena, car.x - hc * ax0, car.y - hs * ax0, t).carry || { vx: 0, vy: 0 };
        com = ((-(cf.vx - cr.vx) * hs + (cf.vy - cr.vy) * hc)) / (2 * ax0);
      }
    }
    var rvx = car.vx - cvx, rvy = car.vy - cvy, rw = car.w - com;
    var u = rvx * ch + rvy * sh;                // forward speed (relative to the ground)
    var v = -rvx * sh + rvy * ch;               // lateral speed (+ left)
    var speed = Math.hypot(car.vx, car.vy);
    var thr = clamp(num(input && input.throttle, 0), 0, 1), brk = clamp(num(input && input.brake, 0), 0, 1);
    var hb = !!(input && input.handbrake);
    var steerIn = clamp(num(input && input.steer, 0), -1, 1);
    if (car.flipped || mods.noControl) { thr = 0; brk = 0; steerIn = 0; hb = false; }
    // reverse logic: brake held while (almost) stopped engages reverse; throttle in reverse brakes
    if (car.gear > 0 && brk > 0.15 && u < 0.8 && thr < 0.1) car.gear = -1;
    else if (car.gear < 0 && thr > 0.15 && u > -0.8) car.gear = 1;
    var wantDrive = car.gear > 0 ? thr : brk, wantBrake = car.gear > 0 ? brk : thr;
    car.throttle = car.gear > 0 ? thr : 0; car.brake = wantBrake;
    // steering: speed-sensitive lock, slew-limited, damage pull + wobble
    var lock = sp.steerLock * num(mods.steerLockMult, 1) * (1 / (1 + Math.max(0, Math.abs(u) - 8) * 0.032));
    var wob = num(mods.wobble, 0) * Math.sin(t * (6 + Math.abs(u) * 0.35)) * clamp(Math.abs(u) / 10, 0, 1);
    var target = steerIn * lock + num(mods.steerPull, 0) * clamp(Math.abs(u) / 6, 0, 1) + wob;
    var rate = 4.2 * dt;
    car.steer += clamp(target - car.steer, -rate, rate);
    var grounded = !car.airborne;
    var gm = mods.gripMult || [1, 1, 1, 1];
    var muBase = sp.grip * surf.grip;
    var muF = muBase * (num(gm[0], 1) + num(gm[1], 1)) / 2, muR = muBase * (num(gm[2], 1) + num(gm[3], 1)) / 2;
    if (hb) muR *= 0.42;
    var Nf = m * G * sp.b / sp.wheelbase, Nr = m * G * sp.a / sp.wheelbase;
    var fx = 0, fy = 0, tq = 0;   // world force + yaw torque
    if (grounded && !car.flipped) {
      // ---- longitudinal: drive (accel envelope fading to top speed), brakes, rolling / aero drag
      var top = sp.topSpeed * num(mods.topMult, 1) * (car.gear < 0 ? 0.5 : 1);
      var aMax = sp.accel * num(mods.powerMult, 1) * num(mods.accelMult, 1);
      var sAbs = Math.abs(u), fade = 1 - Math.pow(clamp(sAbs / Math.max(4, top), 0, 1.2), 2.2);
      var Fdrive = mods.noDrive ? 0 : wantDrive * aMax * m * Math.max(fade, car.gear > 0 && sAbs > top ? -0.4 : 0) * (car.gear > 0 ? 1 : -1.05);
      // traction cap per driven axle
      var muDrive = sp.drive === 'awd' ? (muF + muR) / 2 * (Nf + Nr) : sp.drive === 'fwd' ? muF * Nf : muR * Nr;
      // derby tyres + weight transfer onto the driven axle: launches are punchy (traction cap ~1.4 x static axle load)
      var trac = 1.9 * num((arena.surface || {}).traction, 1);
      Fdrive = clamp(Fdrive, -muDrive * trac, muDrive * trac);
      var Fbrake = 0;
      if (wantBrake > 0 && Math.abs(u) > 0.05) Fbrake = -Math.sign(u) * Math.min(wantBrake * sp.brakeDecel * num(mods.brakeMult, 1) * m, Math.abs(u) * m / dt * 0.9);
      if (hb && Math.abs(u) > 0.05) Fbrake += -Math.sign(u) * Math.min(0.45 * G * m, Math.abs(u) * m / dt * 0.5);
      var roll = num((arena.surface || {}).rolling, 0.02) + num(surf.drag, 0) * 0.12 + num(mods.dragAdd, 0);
      var Fres = -u * (roll * G * m / Math.max(1, Math.abs(u)) * clamp(Math.abs(u), 0, 1)) - u * Math.abs(u) * 0.42 - u * m * num(surf.drag, 0) * 0.08;
      // ram boost / rocket push (m/s^2 forward, not traction limited: it is a shove, not wheelspin)
      var Fpush = mods.push && car.gear > 0 && !mods.noDrive ? num(mods.push, 0) * m * (sAbs > top ? 0.15 : 1) : 0;
      var Flong = Fdrive + Fbrake + Fres + Fpush;
      // ---- lateral: impulse-style axle friction (kills slip up to the friction limit, combined with longitudinal use)
      var cs = Math.cos(car.steer), ss = Math.sin(car.steer);
      // velocity at the axles (car frame)
      var vfx = u, vfy = v + rw * sp.a, vrx = u, vry = v - rw * sp.b;
      // front wheel frame lateral speed
      var latF = -vfx * ss + vfy * cs, latR = vry;
      // effective mass for a lateral impulse at an axle
      var mEffF = 1 / (1 / m + sp.a * sp.a / sp.Iz), mEffR = 1 / (1 / m + sp.b * sp.b / sp.Iz);
      var stiff = 0.55 + 0.35 * clamp(Math.abs(u) / 12, 0, 1);
      var useF = sp.drive === 'fwd' ? Math.abs(Fdrive) / Math.max(1, muF * Nf) : sp.drive === 'awd' ? Math.abs(Fdrive) * 0.5 / Math.max(1, muF * Nf) : 0;
      var useR = sp.drive === 'rwd' ? Math.abs(Fdrive) / Math.max(1, muR * Nr) : sp.drive === 'awd' ? Math.abs(Fdrive) * 0.5 / Math.max(1, muR * Nr) : 0;
      // arcade friction circle: full throttle costs at most ~40 % of the lateral grip (no power-donuts on the spot;
      // the handbrake is the way to swing the tail)
      useF = clamp(useF, 0, 1); useR = clamp(useR, 0, 1);
      var capF = muF * Nf * Math.max(0.6, 1 - 0.4 * useF * useF);
      var capR = muR * Nr * Math.max(0.6, 1 - 0.4 * useR * useR);
      var FyF = clamp(-latF * mEffF * stiff / dt, -capF, capF);
      var FyR = clamp(-latR * mEffR * stiff / dt, -capR, capR);
      car.slip = Math.max(Math.abs(FyF) >= capF * 0.999 ? 1 : 0, Math.abs(FyR) >= capR * 0.999 ? 1 : 0) * clamp(speed / 6, 0, 1);
      // front force in car frame (wheel lateral -> car axes)
      var fFx = -FyF * ss, fFy = FyF * cs;
      var cx = Flong + fFx, cy = fFy + FyR;
      tq = sp.a * fFy - sp.b * FyR;
      // per-corner drag from damaged / lost wheels (yaw pull)
      var wd = mods.cornerDrag;
      if (wd) {
        var Lh = sp.wheelbase / 2, Wh = sp.track / 2;
        var cl = [[sp.a, Wh], [sp.a, -Wh], [-sp.b, Wh], [-sp.b, -Wh]];
        for (var k = 0; k < 4; k++) {
          if (!wd[k]) continue;
          var vxk = u - rw * cl[k][1];
          var fk = -vxk * wd[k] * m * 0.9;
          cx += fk; tq += -cl[k][1] * fk;
        }
        void Lh;
      }
      fx = cx * ch - cy * sh; fy = cx * sh + cy * ch;
    } else if (car.flipped && grounded) {
      // on the roof: heavy scraping friction
      var fr = Math.min(1, 0.7 * G * dt / Math.max(0.01, speed));
      car.vx -= car.vx * fr; car.vy -= car.vy * fr; car.w *= 0.96;
    }
    if (mods.extraForce) { fx += num(mods.extraForce.x, 0); fy += num(mods.extraForce.y, 0); }
    car.vx += fx / m * dt; car.vy += fy / m * dt;
    car.w += tq / sp.Iz * dt;
    if (grounded) car.w = com + (car.w - com) * (1 - 0.6 * dt);   // tyre scrub / yaw damping (relative to a turning platform)
    // integrate
    car.x += car.vx * dt; car.y += car.vy * dt; car.heading = wrap(car.heading + car.w * dt);
    vertical(world, car, dt);
    car.speed = Math.hypot(car.vx, car.vy);
    var c2 = Math.cos(car.heading), s2 = Math.sin(car.heading);
    car.u = car.vx * c2 + car.vy * s2;
    return car;
  }

  /** z / pitch / roll: floors + ramps height field, ballistic flight, rollover recovery */
  function vertical(world, car, dt) {
    var arena = world.arena, sp = car.spec;
    var surf = surfaceAt(arena, car.x, car.y, world.t);
    var gz = surf.z;
    car.groundZ = gz; car.overOpen = !surf.floor;
    // fore / aft and side samples for the body attitude on ramps
    var ch = Math.cos(car.heading), sh = Math.sin(car.heading);
    var hl = sp.wheelbase / 2, hw = sp.track / 2;
    var zf = surfaceAt(arena, car.x + ch * hl, car.y + sh * hl, world.t).z, zr = surfaceAt(arena, car.x - ch * hl, car.y - sh * hl, world.t).z;
    var zl = surfaceAt(arena, car.x - sh * hw, car.y + ch * hw, world.t).z, zrr = surfaceAt(arena, car.x + sh * hw, car.y - ch * hw, world.t).z;
    if (zf < -40) zf = gz; if (zr < -40) zr = gz; if (zl < -40) zl = gz; if (zrr < -40) zrr = gz;
    var slopeP = Math.atan2(zf - zr, 2 * hl), slopeR = Math.atan2(zl - zrr, 2 * hw);
    if (!car.airborne) {
      if (gz >= car.z - 0.35 && gz > -40) {
        var vzG = (gz - car.z) / dt;
        car.z = gz;
        car.vz = clamp(vzG, -30, 30);
        // ramp lip: ground drops away while the car rises -> launch
      } else {
        car.airborne = true; car.airT = 0;
      }
    }
    if (car.airborne) {
      car.airT += dt;
      car.vz -= G * dt;
      car.z += car.vz * dt;
      car.pitch += car.pitchV * dt; car.roll += car.rollV * dt;
      car.pitchV *= 1 - 0.15 * dt; car.rollV *= 1 - 0.15 * dt;
      // gentle self-levelling in the air (arcade): stops endless tumbling
      car.pitchV += (-car.pitch * 1.2) * dt;
      if (gz > -40 && car.z <= gz) {
        car.landV = -car.vz; car.z = gz; car.airborne = false;
        car.vz = 0;
        var r = wrap(car.roll);
        if (Math.abs(r) > 1.75) { car.flipped = true; car.flipT = 0; car.roll = r > 0 ? Math.PI : -Math.PI; }
        else car.roll = r;
        car.rollV *= 0.3; car.pitchV *= 0.3;
        car.justLanded = car.landV;
      }
    } else {
      // spring the body attitude toward the surface (flipped cars stay on the roof)
      var tp = slopeP, tr = car.flipped ? (car.roll > 0 ? Math.PI : -Math.PI) : slopeR;
      car.pitchV += ((tp - car.pitch) * 60 - car.pitchV * 11) * dt;
      car.rollV += ((tr - car.roll) * (car.flipped ? 20 : 45) - car.rollV * 9) * dt;
      // a big roll kick can tip the car over the 'point of no return' while grounded
      if (!car.flipped && Math.abs(car.roll) > 1.25 && Math.abs(car.rollV) > 0.5 && Math.sign(car.rollV) === Math.sign(car.roll)) {
        car.airborne = true; car.vz = Math.max(car.vz, 2.2); car.airT = 0;
      }
      car.pitch += car.pitchV * dt; car.roll += car.rollV * dt;
    }
    if (Math.abs(car.roll) > 2 * Math.PI) car.roll = wrap(car.roll);
    if (Math.abs(car.pitch) > 2 * Math.PI) car.pitch = wrap(car.pitch);
  }

  /* ================================================================== car-car contact (OBB SAT) */
  function axesOf(car) { var c = Math.cos(car.heading), s = Math.sin(car.heading); return [[c, s], [-s, c]]; }
  function project(pts, ax) {
    var mn = 1e9, mx = -1e9;
    for (var i = 0; i < pts.length; i++) { var p = pts[i][0] * ax[0] + pts[i][1] * ax[1]; if (p < mn) mn = p; if (p > mx) mx = p; }
    return [mn, mx];
  }
  /**
   * Resolve a contact between two cars. opts {restitution, friction, massMultA, massMultB (shield etc.)}.
   * Returns the contact (with closing speed / impulse / energy) or null.
   */
  function collideCars(a, b, opts) {
    opts = opts || {};
    if (Math.abs(a.z - b.z) > 1.4) return null;
    var dx = b.x - a.x, dy = b.y - a.y;
    var ra = a.spec.length / 2 + num(a.spec.reachF, 0), rb = b.spec.length / 2 + num(b.spec.reachF, 0);
    if (dx * dx + dy * dy > (ra + rb) * (ra + rb)) return null;
    var ca = corners(a), cb = corners(b);
    var axes = axesOf(a).concat(axesOf(b));
    var best = 1e9, bn = null, bi = -1;
    for (var i = 0; i < 4; i++) {
      var ax = axes[i], pa = project(ca, ax), pb = project(cb, ax);
      var o = Math.min(pa[1], pb[1]) - Math.max(pa[0], pb[0]);
      if (o <= 0) return null;
      if (o < best) { best = o; bn = ax; bi = i; }
    }
    // normal from a toward b
    var nx = bn[0], ny = bn[1];
    if (nx * dx + ny * dy < 0) { nx = -nx; ny = -ny; }
    // contact point: the deepest vertex of the box that does NOT own the axis (incident box)
    var px, py;
    if (bi < 2) {   // axis of a -> b's vertices most toward -n
      var mn = 1e9, cand = [];
      cb.forEach(function (p) { var d = p[0] * nx + p[1] * ny; if (d < mn - 0.04) { mn = d; cand = [p]; } else if (d < mn + 0.04) cand.push(p); });
      px = 0; py = 0; cand.forEach(function (p) { px += p[0]; py += p[1]; }); px /= cand.length; py /= cand.length;
    } else {
      var mx = -1e9, cand2 = [];
      ca.forEach(function (p) { var d = p[0] * nx + p[1] * ny; if (d > mx + 0.04) { mx = d; cand2 = [p]; } else if (d > mx - 0.04) cand2.push(p); });
      px = 0; py = 0; cand2.forEach(function (p) { px += p[0]; py += p[1]; }); px /= cand2.length; py /= cand2.length;
      // move to the middle of the overlap
      px -= nx * best * 0.5; py -= ny * best * 0.5;
    }
    if (bi < 2) { px += nx * best * 0.5; py += ny * best * 0.5; }
    // tangential position: the middle of the real overlap of both outlines along the contact tangent (face-to-face hits
    // otherwise snap to the middle of the incident face and an off-centre T-bone would never spin the victim)
    var tx0 = -ny, ty0 = nx, pta = project(ca, [tx0, ty0]), ptb = project(cb, [tx0, ty0]);
    var tlo = Math.max(pta[0], ptb[0]), thi = Math.min(pta[1], ptb[1]);
    if (thi > tlo) { var tc = (tlo + thi) / 2, tcur = px * tx0 + py * ty0; px += tx0 * (tc - tcur); py += ty0 * (tc - tcur); }
    var ma = a.spec.mass * num(opts.massMultA, 1), mb = b.spec.mass * num(opts.massMultB, 1);
    var Ia = a.spec.Iz * num(opts.massMultA, 1), Ib = b.spec.Iz * num(opts.massMultB, 1);
    var va = pointVel(a, px, py), vb = pointVel(b, px, py);
    var rvx = vb.x - va.x, rvy = vb.y - va.y;
    var vn = rvx * nx + rvy * ny;            // < 0 = closing
    var rax = px - a.x, ray = py - a.y, rbx = px - b.x, rby = py - b.y;
    var raN = rax * ny - ray * nx, rbN = rbx * ny - rby * nx;
    var kN = 1 / ma + 1 / mb + raN * raN / Ia + rbN * rbN / Ib;
    var jn = 0, jt = 0, vt = 0, tx = -ny, ty = nx;
    // who drove into whom (before the impulse): each car's own velocity toward the other along n
    var aIn = Math.max(0, a.vx * nx + a.vy * ny), bIn = Math.max(0, -(b.vx * nx + b.vy * ny));
    if (vn < 0) {
      var e = num(opts.restitution, 0.22);
      jn = -(1 + e) * vn / kN;
      // friction
      vt = rvx * tx + rvy * ty;
      var raT = rax * ty - ray * tx, rbT = rbx * ty - rby * tx;
      var kT = 1 / ma + 1 / mb + raT * raT / Ia + rbT * rbT / Ib;
      jt = clamp(-vt / kT, -num(opts.friction, 0.35) * jn, num(opts.friction, 0.35) * jn);
      var jx = nx * jn + tx * jt, jy = ny * jn + ty * jt;
      // apply (mass multipliers only scale the response of a shielded / anchored car)
      a.vx -= jx / ma; a.vy -= jy / ma; a.w -= (rax * jy - ray * jx) / Ia;
      b.vx += jx / mb; b.vy += jy / mb; b.w += (rbx * jy - rby * jx) / Ib;
    }
    // positional correction (split by inverse mass)
    var corr = Math.max(0, best - 0.01) * 0.85, wa = (1 / ma) / (1 / ma + 1 / mb);
    a.x -= nx * corr * wa; a.y -= ny * corr * wa;
    b.x += nx * corr * (1 - wa); b.y += ny * corr * (1 - wa);
    var closing = Math.max(0, -vn);
    var mu = ma * mb / (ma + mb);
    return {
      a: a, b: b, kind: 'car', px: px, py: py, nx: nx, ny: ny, vn: closing, vt: Math.abs(vt), j: jn,
      energy: 0.5 * mu * closing * closing, depth: best, aIn: aIn, bIn: bIn
    };
  }

  /**
   * ARCADE BOUNCE (Burnout / Destruction AllStars feel), applied by the session on top of the exact collideCars impulse:
   * the cars ricochet apart (separation speed >= max(minSep, e·closing)), the ATTACKER keeps most of its momentum
   * (effective mass ×attMass, ×follow when ram-boosting) while the victim is shoved, spun (a side hit sends it spinning
   * away) and, on big hits, hopped / rolled. Overlap is removed in one step. Not momentum-conserving on purpose.
   * o {attacker: a|b, e, minSep, attMass, spin, follow (bool), hop (bool)} -> {jx, jy, sep}
   */
  function arcadeBounce(a, b, ct, o) {
    o = o || {};
    var nx = ct.nx, ny = ct.ny, closing = num(ct.vn, 0);
    var att = o.attacker === b ? b : a, vic = att === a ? b : a;
    // full separation along the normal (never leave them interlocked)
    var depth = Math.max(0, num(ct.depth, 0));
    if (depth > 0) {
      var wa0 = a === att ? 0.25 : 0.75;
      a.x -= nx * (depth + 0.03) * wa0; a.y -= ny * (depth + 0.03) * wa0;
      b.x += nx * (depth + 0.03) * (1 - wa0); b.y += ny * (depth + 0.03) * (1 - wa0);
    }
    var e = num(o.e, 0.55) + 0.18 * clamp((closing - 6) / 14, 0, 1);
    var target = Math.max(num(o.minSep, 2.5), e * closing);
    var va = pointVel(a, ct.px, ct.py), vb = pointVel(b, ct.px, ct.py);
    var sep = (vb.x - va.x) * nx + (vb.y - va.y) * ny;
    if (sep >= target) return { jx: 0, jy: 0, sep: sep };
    var am = num(o.attMass, 2.6) * (o.follow ? 2.2 : 1);
    var ma = a.spec.mass * (a === att ? am : 1), mb = b.spec.mass * (b === att ? am : 1);
    var J = (target - sep) / (1 / ma + 1 / mb);
    var jx = nx * J, jy = ny * J;
    a.vx -= jx / ma; a.vy -= jy / ma; b.vx += jx / mb; b.vy += jy / mb;
    // spin the victim from the lever arm of the hit (side hits spin hardest); the attacker barely twists
    var spin = num(o.spin, 1.5), r = vic === b ? 1 : -1;
    var rx = ct.px - vic.x, ry = ct.py - vic.y, lev = rx * (ny * r) - ry * (nx * r);
    vic.w += clamp(lev * J * r * r / vic.spec.Iz * spin, -4.5, 4.5);
    vic.w = clamp(vic.w, -6, 6);
    // big hits: hop + roll kick on the victim (light cars fly)
    if (o.hop && closing > 16 && !vic.airborne) {
      var lightK = Math.sqrt(1500 / vic.spec.mass);
      vic.vz = Math.max(vic.vz, clamp(0.8 + (closing - 16) * 0.16, 0.8, 3) * lightK);
      vic.airborne = true; vic.airT = 0;
      var cv = Math.cos(vic.heading), sv = Math.sin(vic.heading), side = -(nx * r) * sv + (ny * r) * cv;   // + = shoved toward its left
      vic.rollV += clamp(side * (1.2 + (closing - 16) * 0.18), -4.5, 4.5) * lightK;
    }
    return { jx: jx, jy: jy, sep: target };
  }

  /* ================================================================== car vs arena (walls, obstacles, steps) */
  function resolveStatic(car, p, nx, ny, depth, e, f) {
    // nx, ny: normal pointing INTO the free space (pushes the car out)
    var m = car.spec.mass, I = car.spec.Iz;
    var v = pointVel(car, p.x, p.y);
    var vn = v.x * nx + v.y * ny;
    var rx = p.x - car.x, ry = p.y - car.y, rN = rx * ny - ry * nx;
    var j = 0, vt = 0;
    if (vn < 0) {
      j = -(1 + e) * vn / (1 / m + rN * rN / I);
      var tx = -ny, ty = nx; vt = v.x * tx + v.y * ty;
      var rT = rx * ty - ry * tx, jt = clamp(-vt / (1 / m + rT * rT / I), -f * j, f * j);
      applyImpulse(car, nx * j + tx * jt, ny * j + ty * jt, p.x, p.y);
    }
    car.x += nx * depth * 0.9; car.y += ny * depth * 0.9;
    return { vn: Math.max(0, -vn), vt: Math.abs(vt), j: j };
  }
  function collideArena(world, car) {
    var arena = world.arena, AR = A(), out = [];
    var W = arena.wall || {}, e = num(W.restitution, 0.3), f = num(W.friction, 0.35);
    // CCD on the centre: never let the centre cross a closed wall
    var bc = AR.sdBoundary(arena, car.x, car.y);
    if (bc.d < 0 && !bc.open && !car.overOpen) {
      var pen = -bc.d + car.spec.width * 0.5;
      var vnC = car.vx * bc.nx + car.vy * bc.ny;
      if (vnC < 0) { car.vx -= (1 + e) * vnC * bc.nx; car.vy -= (1 + e) * vnC * bc.ny; }
      car.x += bc.nx * pen; car.y += bc.ny * pen;
    }
    var P = probes(car);
    var bestWall = null, bestObs = {}, bestStep = null;
    // the boundary distance is a true signed distance: far from the wall no probe can be outside -> skip the per-probe tests
    var nearWall = bc.d < Math.hypot(car.spec.length / 2 + num(car.spec.reachF, 0), car.spec.width / 2) + 0.35;
    for (var i = 0; i < P.length; i++) {
      var p = P[i];
      // walls (open edges have no wall)
      var b = nearWall ? AR.sdBoundary(arena, p.x, p.y) : null;
      if (b && b.d < 0 && !b.open && car.z < num(W.height, 1.2) + 1.2) {
        if (!bestWall || b.d < bestWall.d) bestWall = { p: p, d: b.d, nx: b.nx, ny: b.ny };
      }
      // obstacles
      var obs = arena.obstacles;
      for (var k = 0; k < obs.length; k++) {
        var o = obs[k];
        var ddx = p.x - o.x, ddy = p.y - o.y;
        if (ddx * ddx + ddy * ddy > (o.br + 0.5) * (o.br + 0.5)) continue;
        if (car.z > num(o.h, 1) + 0.25) continue;
        var q = AR.sdObstacle(o, p.x, p.y);
        if (q.d < 0 && (!bestObs[o.id] || q.d < bestObs[o.id].d)) bestObs[o.id] = { p: p, d: q.d, nx: q.nx, ny: q.ny, o: o };
      }
      // steps: a raised deck / ramp side higher than the car can climb
      var hz = AR.heightAt(arena, p.x, p.y);
      if (hz.src && hz.z - car.z > 0.6) {
        var s = hz.src, qb = AR.sdBox(s.x, s.y, s.hw, s.hh, s.rot || 0, p.x, p.y);
        // only the side faces are walls; the low end of a ramp is climbable (its height there is < 0.6)
        if (!bestStep || qb.d < bestStep.d) bestStep = { p: p, d: qb.d, nx: qb.nx, ny: qb.ny };
      }
    }
    if (bestWall) {
      var r = resolveStatic(car, bestWall.p, bestWall.nx, bestWall.ny, -bestWall.d, e, f);
      out.push({ a: car, b: null, kind: 'wall', px: bestWall.p.x, py: bestWall.p.y, nx: -bestWall.nx, ny: -bestWall.ny, vn: r.vn, vt: r.vt, j: r.j, energy: 0.5 * car.spec.mass * r.vn * r.vn });
    }
    Object.keys(bestObs).forEach(function (id) {
      var c = bestObs[id], o = c.o;
      var heavy = o.kind === 'barrel' ? 0.5 : 1;
      var r2 = resolveStatic(car, c.p, c.nx, c.ny, -c.d, o.kind === 'tyres' || o.kind === 'island' ? 0.45 : e * heavy, o.kind === 'tyres' ? 0.6 : f);
      out.push({ a: car, b: null, kind: 'obstacle', obstacleId: o.id, obstacleKind: o.kind, px: c.p.x, py: c.p.y, nx: -c.nx, ny: -c.ny, vn: r2.vn, vt: r2.vt, j: r2.j,
        energy: 0.5 * car.spec.mass * r2.vn * r2.vn * (o.kind === 'tyres' ? 0.35 : o.kind === 'island' ? 0.4 : 1) });
    });
    if (bestStep) {
      var r3 = resolveStatic(car, bestStep.p, bestStep.nx, bestStep.ny, Math.max(0.02, -bestStep.d + 0.02), e, f);
      out.push({ a: car, b: null, kind: 'step', px: bestStep.p.x, py: bestStep.p.y, nx: -bestStep.nx, ny: -bestStep.ny, vn: r3.vn, vt: r3.vt, j: r3.j, energy: 0.5 * car.spec.mass * r3.vn * r3.vn });
    }
    return out;
  }

  /* ================================================================== queries for AI */
  function raycast(world, x, y, dx, dy, maxDist, ignoreId, z) {
    var l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    var arena = world.arena, AR = A(), step = 1.2, best = { dist: maxDist, kind: null, id: null };
    for (var d = step; d <= maxDist; d += step) {
      var px = x + dx * d, py = y + dy * d;
      var b = AR.sdBoundary(arena, px, py);
      if (b.d < 0) { best = { dist: d, kind: b.open ? 'edge' : 'wall', id: null }; break; }
      var hit = null;
      for (var k = 0; k < arena.obstacles.length; k++) { var o = arena.obstacles[k]; if (AR.sdObstacle(o, px, py).d < 0) { hit = o; break; } }
      if (hit) { best = { dist: d, kind: 'obstacle', id: hit.id }; break; }
      // a raised deck / ramp side higher than the car can climb (only when the caller passes its height)
      if (typeof z === 'number' && (arena.floors && arena.floors.length || arena.ramps && arena.ramps.length)) {
        var hs = AR.heightAt(arena, px, py);
        if (hs.z - z > 0.6) { best = { dist: d, kind: 'wall', id: hs.src ? hs.src.id : null, step: true }; break; }
      }
      var hz = AR.hazardAt(arena, px, py, world.t);
      if (hz.pit || hz.crush > 0) { best = { dist: d, kind: hz.pit ? 'pit' : 'crusher', id: null }; break; }
    }
    if (world.cars) {
      world.cars.forEach(function (c) {
        if (c.id === ignoreId) return;
        var rx = c.x - x, ry = c.y - y, t = rx * dx + ry * dy;
        if (t < 0 || t > best.dist) return;
        var px2 = rx - dx * t, py2 = ry - dy * t;
        if (px2 * px2 + py2 * py2 < 1.4 * 1.4) best = { dist: t, kind: 'car', id: c.id };
      });
    }
    return best;
  }

  CB.derby.physics = {
    DT: DT, G: G,
    specFromBuild: specFromBuild, withMass: withMass, createBody: createBody, corners: corners, probes: probes,
    drive: drive, vertical: vertical, collideCars: collideCars, arcadeBounce: arcadeBounce, collideArena: collideArena, surfaceAt: surfaceAt,
    raycast: raycast, edgeInfo: edgeInfo, applyImpulse: applyImpulse, pointVel: pointVel, toLocal: toLocal, toWorld: toWorld,
    _: { clamp: clamp, wrap: wrap, smooth: smooth }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.physics;
})();

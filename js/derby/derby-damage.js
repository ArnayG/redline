/* ==========================================================================
   Redline — js/derby/derby-damage.js
   CB.derby.damage : per-zone damage model for Demolition Derby (docs/DERBY-SPEC.md §5).

     create() -> dmg                       fresh damage state
     zoneOf(car, px, py) -> {zone, lx, ly, wheel, weights {front, rear, left, right}, wheelW}
     engineZone(car) -> 'front'|'rear'
     impactPoints(energy, mass share...)   see apply()
     apply(car, contact, opts) -> {pts, zone, health, events[]}
        opts {share 0..1 (fraction of the energy this car absorbs), mult (accessory / difficulty), wall: bool,
              rng: fn, t, overflow}
     addZone(car, zone, amount, opts)      direct damage (flamethrower, hammer, saws, crusher, fire)
     effects(car) -> mods                  handling effects (powerMult, topMult, gripMult[4], steerPull, steerLockMult,
                                           wobble, cornerDrag[4], brakeMult, vibration, noDrive)
     tick(car, dt, opts) -> events[]       engine temperature, fires, smoke, stall
     repair(car, amount)                   repair kit
     serialize(dmg) / restore(obj)         JSON (dents included)

   Pure + deterministic (randomness only through the rng passed in). Node-loadable.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  var ZONES = ['front', 'rear', 'left', 'right'];
  var TOUGH = { front: 1.0, rear: 1.05, left: 0.75, right: 0.75 };   // sides are the weak spot (T-bones!)
  var K = 124;                // energy scale (fun pass: hits hurt sooner): equal cars closing at 14 m/s ~ 0.27 zone damage each
  var V0 = 2.2;               // closing speed below which nothing breaks
  var HEALTH_PER_PT = 0.155;   // health lost per impact damage point (fun pass: cars crumple long before they die — 0.42 before)
  var ZONE_HPP = 0.26;        // health per point of direct zone damage (flame, hammer, saws, crusher, ring, idle burn)
  var WHEEL = ['fl', 'fr', 'rl', 'rr'];
  var BENT = 0.45, PUNCT = 0.75;
  var MAX_DENTS = 48;
  var HIT_KNEE = 0.09, HIT_MAX = 0.18;
  var IMPACT_SCALE = 0.75;    // match-length knob for car / wall impacts (tools/derby-play.js: 90-150 s with 8 cars)
  var OVERFLOW_HPP = 0.3;     // health per point that lands on an already-destroyed zone (was 0.55)
  var LIMP = { power: 0.38, lock: 0.6, top: 0.58, grip: 0.3 };

  function create() {
    return {
      health: 1, zones: { front: 0, rear: 0, left: 0, right: 0 }, wheels: [0, 0, 0, 0], wheelLost: [false, false, false, false],
      punct: [false, false, false, false],
      engine: { hp: 1, temp: 0, fire: 0, stalled: false, smoke: 0, black: 0 },
      fuelLeak: 0, onFire: 0, burnT: 0,
      parts: { bumperF: false, bumperR: false, hood: false, trunk: false, doorL: false, doorR: false, lightFL: false, lightFR: false, lightRL: false, lightRR: false },
      dents: [], dentSeq: 0, taken: 0
    };
  }

  /** contact point -> zone weights on the car outline (corners shared) + the nearest wheel */
  function zoneOf(car, px, py) {
    var sp = car.spec, c = Math.cos(car.heading), s = Math.sin(car.heading);
    var dx = px - car.x, dy = py - car.y;
    var lx = dx * c + dy * s, ly = -dx * s + dy * c;
    var nx = lx / (sp.length / 2), ny = ly / (sp.width / 2);
    var ax = Math.abs(nx), ay = Math.abs(ny);
    // softmax-ish blend: the dominant axis gets most of it, corners split
    var fx = Math.pow(ax, 3), fy = Math.pow(ay, 3) * 1.15, tot = fx + fy || 1;
    var w = { front: 0, rear: 0, left: 0, right: 0 };
    if (nx >= 0) w.front = fx / tot; else w.rear = fx / tot;
    if (ny >= 0) w.left = fy / tot; else w.right = fy / tot;
    var zone = w.front >= w.rear && w.front >= w.left && w.front >= w.right ? 'front' : w.rear >= w.left && w.rear >= w.right ? 'rear' : w.left >= w.right ? 'left' : 'right';
    // nearest wheel and how much a corner hit loads it
    var wf = nx >= 0, wl = ny >= 0;
    var wheel = wf ? (wl ? 0 : 1) : (wl ? 2 : 3);
    var axleX = wf ? sp.a / (sp.length / 2) : -sp.b / (sp.length / 2);
    var wheelW = clamp(1 - Math.abs(nx - axleX) * 1.6, 0, 1) * clamp((ay - 0.35) / 0.55, 0, 1);
    return { zone: zone, lx: lx, ly: ly, nx: nx, ny: ny, weights: w, wheel: wheel, wheelW: wheelW };
  }
  function engineZone(car) { return car.spec && (car.spec.enginePos === 'mid' || car.spec.enginePos === 'rear') ? 'rear' : 'front'; }

  /** damage points from a contact for this car */
  function impactPoints(vn, share, wall) {
    var v2 = Math.max(0, vn * vn - V0 * V0);
    if (v2 <= 0) return 0;
    // car-car: 0.5 vn^2 * share^2 / K (share = the other's mass fraction); wall: an immovable but energy-absorbing barrier (x0.2)
    return wall ? 0.5 * v2 * 0.2 / K : 0.5 * v2 * share * share / K;
  }

  function pushDent(d, lx, ly, lz, nx, ny, depth, r) {
    // merge into a nearby dent
    for (var i = 0; i < d.dents.length; i++) {
      var q = d.dents[i];
      if (Math.hypot(q.x - lx, q.y - ly) < Math.max(0.35, q.r * 0.6)) {
        q.depth = Math.min(0.42, q.depth + depth * 0.7); q.r = Math.min(1.3, Math.max(q.r, r) + 0.05);
        q.nx = (q.nx + nx) / 2; q.ny = (q.ny + ny) / 2; var l = Math.hypot(q.nx, q.ny) || 1; q.nx /= l; q.ny /= l;
        q.seq = ++d.dentSeq;
        d.dentSeq = q.seq;
        return q;
      }
    }
    var dent = { x: +lx.toFixed(3), y: +ly.toFixed(3), z: +lz.toFixed(3), nx: +nx.toFixed(3), ny: +ny.toFixed(3), nz: 0, depth: +Math.min(0.42, depth).toFixed(3), r: +r.toFixed(3), seq: ++d.dentSeq };
    d.dents.push(dent);
    if (d.dents.length > MAX_DENTS) {
      // drop the shallowest
      var mi = 0; for (var k = 1; k < d.dents.length; k++) if (d.dents[k].depth < d.dents[mi].depth) mi = k;
      d.dents.splice(mi, 1);
    }
    return dent;
  }

  /**
   * Apply a contact to `car`. contact: {px, py, nx, ny (from car outward toward the other / the wall), vn}.
   * opts: {share, mult, wall, t, rng, zoneMult(zone)->mult}
   */
  function apply(car, contact, opts) {
    opts = opts || {};
    var d = car.dmg, evs = [];
    var pts = impactPoints(contact.vn, num(opts.share, 0.5), !!opts.wall) * num(opts.mult, 1);
    if (!(pts > 0.004)) return { pts: 0, zone: null, events: evs };
    var z = zoneOf(car, contact.px, contact.py);
    var total = 0, overflow = 0;
    ZONES.forEach(function (k) {
      var w = z.weights[k];
      if (w < 0.02) return;
      var zm = typeof opts.zoneMult === 'function' ? num(opts.zoneMult(k), 1) : 1;
      var inc = pts * w * zm / TOUGH[k];
      var before = d.zones[k];
      d.zones[k] = Math.min(1, before + inc);
      overflow += Math.max(0, before + inc - 1);
      total += pts * w * zm;
    });
    // wheels: corner hits bend / burst / rip off the nearest wheel
    if (z.wheelW > 0.05) {
      var wi = z.wheel, winc = pts * z.wheelW * 1.35 * num(opts.wheelMult, 1);
      var wb = d.wheels[wi];
      d.wheels[wi] = Math.min(1, wb + winc);
      if (wb < PUNCT && d.wheels[wi] >= PUNCT && !d.punct[wi]) { d.punct[wi] = true; evs.push({ type: 'puncture', wheel: wi }); }
      if (!d.wheelLost[wi] && d.wheels[wi] >= 0.999) { d.wheelLost[wi] = true; d.health = Math.max(0, d.health - 0.05); evs.push({ type: 'wheel-off', wheel: wi }); }
    }
    var hl = total * HEALTH_PER_PT + overflow * OVERFLOW_HPP;
    // convex in closing speed: parking-lot bumps barely count, a 70 km/h T-bone is decisive
    hl *= clamp(Math.pow(num(contact.vn, 0) / 13, 1.35), 0.3, 1.9);
    // per-hit soft cap (fun pass: boosted 80 km/h head-ons are the norm now) — one hit crumples a zone but never
    // deletes a car: health lost above HIT_KNEE is compressed, max HIT_MAX per impact
    if (hl > HIT_KNEE) hl = Math.min(HIT_MAX, HIT_KNEE + (hl - HIT_KNEE) * 0.35);
    hl *= IMPACT_SCALE;
    d.health = Math.max(0, d.health - hl);
    d.taken += hl;
    // parts fall off / lights break
    var P = d.parts, Z = d.zones;
    function off(k, cond) { if (!P[k] && cond) { P[k] = true; evs.push({ type: k.indexOf('light') === 0 ? 'light' : 'part-off', part: k }); } }
    off('lightFL', Z.front > 0.28 && z.ly >= -0.2 && z.nx > 0.3);
    off('lightFR', Z.front > 0.28 && z.ly <= 0.2 && z.nx > 0.3);
    off('lightRL', Z.rear > 0.28 && z.ly >= -0.2 && z.nx < -0.3);
    off('lightRR', Z.rear > 0.28 && z.ly <= 0.2 && z.nx < -0.3);
    off('bumperF', Z.front > 0.55);
    off('bumperR', Z.rear > 0.55);
    off('hood', Z.front > 0.82);
    off('trunk', Z.rear > 0.85);
    off('doorL', Z.left > 0.8);
    off('doorR', Z.right > 0.8);
    // fuel tank (rear) leaks
    if (Z.rear > 0.6) d.fuelLeak = Math.max(d.fuelLeak, clamp((Z.rear - 0.6) * 2.5, 0, 1));
    // a big hit on a leaking tank or a burning engine can ignite
    var rng = opts.rng || function () { return 0.5; };
    if (pts > 0.12 && (d.fuelLeak > 0.3 || d.engine.temp > 0.8) && rng() < 0.18 + pts) { if (d.onFire < 0.5) evs.push({ type: 'fire' }); d.onFire = Math.max(d.onFire, 0.6); d.burnT = Math.max(d.burnT, 6); }
    // dent (car-local sim frame, push inward = -contact normal in local)
    var c = Math.cos(car.heading), s = Math.sin(car.heading);
    var inx = -(contact.nx * c + contact.ny * s), iny = -(-contact.nx * s + contact.ny * c);
    var depth = clamp(0.03 + pts * 0.55, 0.03, 0.34), r = clamp(0.38 + pts * 1.4, 0.38, 1.1);
    var lz = clamp(num(opts.hitZ, 0.55), 0.2, car.spec.height * 0.9);
    pushDent(d, clamp(z.lx, -car.spec.length / 2, car.spec.length / 2), clamp(z.ly, -car.spec.width / 2, car.spec.width / 2), lz, inx, iny, depth, r);
    updateEngine(car);
    return { pts: pts, healthLoss: hl, zone: z.zone, weights: z.weights, events: evs, lx: z.lx, ly: z.ly };
  }

  /** direct zone damage (flame, hammer, saws, crusher, fire pits); returns health lost */
  function addZone(car, zone, amount, opts) {
    opts = opts || {};
    var d = car.dmg;
    if (!(amount > 0)) return 0;
    var hl = 0;
    if (zone === 'all') {
      ZONES.forEach(function (k) { d.zones[k] = Math.min(1, d.zones[k] + amount * 0.25 / TOUGH[k]); });
      hl = amount * ZONE_HPP * num(opts.healthMult, 1);
    } else if (zone === 'wheels') {
      for (var i = 0; i < 4; i++) {
        if (opts.wheel != null && opts.wheel !== i) continue;
        var b = d.wheels[i]; d.wheels[i] = Math.min(1, b + amount);
        if (b < PUNCT && d.wheels[i] >= PUNCT) d.punct[i] = true;
      }
      hl = amount * 0.075;
    } else {
      var before = d.zones[zone];
      d.zones[zone] = Math.min(1, before + amount / TOUGH[zone]);
      hl = amount * ZONE_HPP * num(opts.healthMult, 1) + Math.max(0, before + amount - 1) * 0.5;
    }
    d.health = Math.max(0, d.health - hl);
    d.taken += hl;
    updateEngine(car);
    return hl;
  }

  function updateEngine(car) {
    var d = car.dmg, ez = d.zones[engineZone(car)];
    d.engine.hp = clamp(1 - Math.pow(ez, 1.35) * 0.92 - (ez >= 0.999 && d.health < 0.4 ? 1 : 0), 0, 1);
    d.engine.smoke = clamp((ez - 0.3) / 0.6, 0, 1) + d.engine.fire * 0.5;
    d.engine.black = clamp((ez - 0.65) / 0.3, 0, 1);
  }

  /** handling effects of the current damage */
  function effects(car) {
    var d = car.dmg, Z = d.zones, sp = car.spec || {};
    var ez = Z[engineZone(car)];
    var eng = d.engine;
    var power = (1 - 0.62 * Math.pow(ez, 1.4)) * (eng.temp > 0.85 ? 0.7 : 1) * (eng.stalled ? 0 : 1);
    // drive axle: RWD rear damage hurts the drive, FWD front (already the engine zone for front engines)
    if (sp.drive === 'rwd') power *= 1 - 0.45 * Math.pow(Z.rear, 1.5);
    else if (sp.drive === 'fwd') power *= 1 - 0.25 * Math.pow(Z.front, 1.5);
    else power *= 1 - 0.22 * Math.pow(Math.max(Z.front, Z.rear), 1.5);
    var grip = [1, 1, 1, 1], drag = [0, 0, 0, 0], vib = 0, lostN = 0, wavg = 0;
    for (var i = 0; i < 4; i++) {
      var w = d.wheels[i];
      wavg += w / 4;
      if (d.wheelLost[i]) { grip[i] = 0.3; drag[i] = 0.32; lostN++; vib = Math.max(vib, 1); }   // sparks on the hub: limps, never stops
      else if (d.punct[i] || w >= PUNCT) { grip[i] = 0.55; drag[i] = 0.16; vib = Math.max(vib, 0.7); }
      else if (w >= BENT) { grip[i] = 0.86; drag[i] = 0.05; vib = Math.max(vib, 0.4); }
      else grip[i] = 1 - 0.12 * w;
    }
    // steering pull toward the damaged side (+ = left): a crumpled left side drags the car left
    var pull = (Z.left - Z.right) * 0.07 + (d.wheels[0] - d.wheels[1]) * 0.06 + (d.wheels[2] - d.wheels[3]) * 0.03;
    if (d.wheelLost[0] !== d.wheelLost[1]) pull += d.wheelLost[0] ? 0.06 : -0.06;
    var lockMult = 1 - 0.42 * Math.pow(Math.max(Z.left, Z.right, (d.wheels[0] + d.wheels[1]) / 2), 1.2);
    var wobble = 0.05 * Math.max(d.wheels[0] >= BENT ? d.wheels[0] : 0, d.wheels[1] >= BENT ? d.wheels[1] : 0) + 0.028 * Math.max(Z.left, Z.right);
    vib = Math.max(vib, ez > 0.6 ? (ez - 0.6) * 1.5 : 0);
    return {
      // LIMP FLOOR (fun pass): damage alone never parks a car — at least 38 % power, 60 % lock, 58 % top speed remain
      // until the car is eliminated (a stalled engine has no drive and is eliminated within seconds by the session)
      powerMult: eng.stalled ? 0 : clamp(power, LIMP.power, 1), topMult: clamp(1 - 0.22 * wavg - 0.08 * lostN - 0.12 * ez, LIMP.top, 1), gripMult: [Math.max(grip[0], LIMP.grip), Math.max(grip[1], LIMP.grip), Math.max(grip[2], LIMP.grip), Math.max(grip[3], LIMP.grip)],
      cornerDrag: drag[0] + drag[1] + drag[2] + drag[3] > 0 ? drag : null, steerPull: clamp(pull, -0.14, 0.14), steerLockMult: clamp(lockMult, LIMP.lock, 1),
      wobble: wobble, brakeMult: clamp(1 - 0.3 * wavg, 0.6, 1), vibration: clamp(vib, 0, 1), noDrive: !!eng.stalled, dragAdd: 0.01 * lostN
    };
  }

  /** per-step: engine temperature, fires, smoke, stall. opts {throttle, dt, rng, burnDps}. Returns events. */
  function tick(car, dt, opts) {
    opts = opts || {};
    var d = car.dmg, e = d.engine, evs = [];
    var ez = d.zones[engineZone(car)];
    // overheating: a crumpled radiator / engine bay heats up under throttle
    var heat = ez > 0.5 ? (ez - 0.5) * 0.11 * (0.3 + num(opts.throttle, 0)) : 0;
    e.temp = clamp(e.temp + (heat - 0.025 * (1 - ez)) * dt + (d.onFire > 0 ? 0.03 * dt : 0), 0, 1);
    if (e.temp >= 1 && e.fire < 0.3) { e.fire = 0.4; evs.push({ type: 'fire', engine: true }); }
    if (e.fire > 0) {
      e.fire = clamp(e.fire + (ez > 0.75 ? 0.04 : -0.06) * dt, 0, 1);
      d.health = Math.max(0, d.health - (0.004 + 0.006 * e.fire) * dt);
    }
    if (d.onFire > 0) {
      d.burnT -= dt;
      var dps = 0.008 + 0.01 * d.onFire;
      d.health = Math.max(0, d.health - dps * dt);
      d.taken += dps * dt;
      d.zones.front = Math.min(1, d.zones.front + 0.004 * dt); d.zones.rear = Math.min(1, d.zones.rear + 0.004 * dt);
      if (d.burnT <= 0) d.onFire = Math.max(0, d.onFire - 0.35 * dt);
    }
    if (d.fuelLeak > 0.6 && d.onFire <= 0 && opts.rng && opts.rng() < 0.0006 * d.fuelLeak) { d.onFire = 0.5; d.burnT = 5; evs.push({ type: 'fire' }); }
    // stall: a dead engine (crumpled engine zone and low health)
    var wasStalled = e.stalled;
    updateEngine(car);
    e.stalled = e.hp <= 0.01;
    if (e.stalled && !wasStalled) evs.push({ type: 'stall' });
    e.smoke = clamp(e.smoke + e.fire * 0.4 + (e.temp > 0.7 ? (e.temp - 0.7) : 0), 0, 1);
    return evs;
  }

  function repair(car, amount) {
    var d = car.dmg, a = num(amount, 0.35);
    d.health = Math.min(1, d.health + a);
    ZONES.forEach(function (k) { d.zones[k] = Math.max(0, d.zones[k] - 0.4); });
    for (var i = 0; i < 4; i++) { if (!d.wheelLost[i]) { d.wheels[i] = Math.max(0, d.wheels[i] - 0.6); if (d.wheels[i] < PUNCT) d.punct[i] = false; } }
    d.onFire = 0; d.burnT = 0; d.engine.fire = 0; d.engine.temp = Math.min(d.engine.temp, 0.3); d.fuelLeak = Math.max(0, d.fuelLeak - 0.5);
    updateEngine(car);
    d.engine.stalled = d.engine.hp <= 0.01;
  }

  function serialize(d) { return JSON.parse(JSON.stringify(d)); }
  function restore(o) { var d = create(); if (o) { for (var k in o) d[k] = JSON.parse(JSON.stringify(o[k])); } return d; }

  CB.derby.damage = {
    ZONES: ZONES, TOUGH: TOUGH, K: K, LIMP: LIMP, HIT_KNEE: HIT_KNEE, HIT_MAX: HIT_MAX, V0: V0, BENT: BENT, PUNCT: PUNCT, WHEELS: WHEEL, HEALTH_PER_PT: HEALTH_PER_PT, ZONE_HPP: ZONE_HPP,
    create: create, zoneOf: zoneOf, engineZone: engineZone, impactPoints: impactPoints, apply: apply, addZone: addZone,
    effects: effects, tick: tick, repair: repair, serialize: serialize, restore: restore, _: { pushDent: pushDent, updateEngine: updateEngine }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.damage;
})();

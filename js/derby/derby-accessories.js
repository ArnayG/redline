/* ==========================================================================
   Redline — js/derby/derby-accessories.js
   CB.derby.accessories : Demolition Derby accessories (docs/DERBY-SPEC.md §6) — definitions, loadout rules and the
   runtime behaviour (flamethrower, front ramp, hammer, bull-bar, ram, armour, nitro, caltrops, oil, magnet,
   wrecking ball, wheel saws, shield, repair kit, rear spikes).

     DEFS {id: def}  LIST [def]  BUDGET  SLOTS {front:1, rear:1, roof:1, side:1, util:2}  MAX_ACTIVE 2  PRESETS [...]
     validate(ids) -> {ok, points, budget, errors[], actives[], mass, slots}
     massOf(ids) -> kg     reachOf(ids) -> {front, rear}
     create(car, ids)      sets car.acc = [state...], car.actives = [i1, i2] (indices into car.acc)
     step(world, car, input, dt)          per fixed step (input.action1 / action2 held flags; edges detected here)
     driveMods(car, mods) -> mods          nitro / oil / magnet effects merged into the handling mods
     modifier(car, zone, role) -> mult     role 'dealt' | 'taken' (zone = the zone of `car` involved)
     onContact(world, car, other, info)   car-car contact hook (ramp launch, bull-bar punctures, saws, ram shove, shield)
     view(car) -> [{id, slot, active, charge, ammo, cooldown, ready, ...}]   snapshot / HUD
     describe(id) -> def
   world (from CB.derby.session): { t, arena, cars, rng(), emit(ev), feed(text, kind, a, b), addEntity(e), entities,
     hurt(target, zone, amount, byCar, kind, opts), impulse(car, jx, jy, px, py), damage (CB.derby.damage) }
   Deterministic: all randomness through world.rng. Node-loadable.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function wrap(a) { if (!(a > -Math.PI && a <= Math.PI)) { if (!isFinite(a)) return 0; a = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI)); } return a; }

  var BUDGET = 12, MAX_ACTIVE = 2;
  var SLOTS = { front: 1, rear: 1, roof: 1, side: 1, util: 2 };
  var SLOT_NAMES = { front: 'Front', rear: 'Rear', roof: 'Roof', side: 'Side', util: 'Utility' };

  var LIST = [
    { id: 'flamethrower', name: 'Flamethrower', slot: 'roof', points: 4, active: 'hold', mass: 70, icon: 'flame', color: '#ff7a1a',
      short: 'Hold to torch whatever is in front of you.',
      desc: 'Roof-mounted napalm cannon. Hold ACTION: a 10 m cone ahead burns and ignites targets. 6 s of fuel, refills slowly.', stats: { range_m: 10, cone_deg: 26, fuel_s: 6 } },
    { id: 'ramp', name: 'Front Ramp', slot: 'front', points: 3, active: false, mass: 90, icon: 'ramp', color: '#d9d2c3',
      short: 'Head-on hits launch and flip the other car.',
      desc: 'A steel wedge bolted to the nose. Ram a car head-on and it rides up the ramp — airborne, often onto its roof. Front damage taken ×0.8.', stats: { taken_front: 0.8 } },
    { id: 'hammer', name: 'Swing Hammer', slot: 'side', points: 3, active: 'press', mass: 110, icon: 'hammer', color: '#a8adb5',
      short: 'Press to slam a car alongside you.',
      desc: 'Hydraulic sledge on a roof boom. Press ACTION: it swings to the side of the nearest car within 5.5 m for a huge lateral hit. 2.2 s cooldown.', stats: { range_m: 5.5, cooldown_s: 2.2 } },
    { id: 'bullbar', name: 'Spiked Bull-bar', slot: 'front', points: 2, active: false, mass: 60, icon: 'spikes', color: '#c0c4ca',
      short: 'Front hits deal more, take less, pop tyres.',
      desc: 'Welded pipe bar with spikes. Front damage dealt ×1.45, front damage taken ×0.7, and corner hits puncture tyres.', stats: { dealt_front: 1.45, taken_front: 0.7 } },
    { id: 'ram', name: 'Battering Ram', slot: 'front', points: 3, active: false, mass: 140, icon: 'ram', color: '#8a6a4a',
      short: 'Long reach, brutal front hits.',
      desc: 'A 1 m steel ram. Reaches further, front impulse ×1.3, front damage dealt ×1.6, front damage taken ×0.6. Heavy (+140 kg).', stats: { reach_m: 1.0, dealt_front: 1.6, taken_front: 0.6 } },
    { id: 'armour', name: 'Armour Plating', slot: 'util', points: 3, active: false, mass: 220, icon: 'shield', color: '#6d737c',
      short: 'All damage taken ×0.65. Heavy.',
      desc: 'Bolted steel plates all round. All damage taken ×0.65, but +220 kg: slower to accelerate and turn.', stats: { taken_all: 0.65 } },
    { id: 'nitro', name: 'Nitro Booster', slot: 'util', points: 2, active: 'hold', mass: 30, icon: 'bolt', color: '#3aa0ff',
      short: 'Hold for a charge attack.',
      desc: 'Hold ACTION: +65 % drive and +20 % top speed; rams while boosting deal ×1.3. 4 s tank, refills over time.', stats: { tank_s: 4 } },
    { id: 'caltrops', name: 'Caltrop Dropper', slot: 'rear', points: 2, active: 'press', mass: 25, icon: 'caltrops', color: '#9aa0a6',
      short: 'Drop spikes behind you.',
      desc: 'Press ACTION: drops a 3.2 m patch of caltrops behind you that punctures tyres. 4 drops.', stats: { ammo: 4 } },
    { id: 'oil', name: 'Oil Slick', slot: 'rear', points: 1, active: 'press', mass: 25, icon: 'drop', color: '#222630',
      short: 'Drop an oil slick to spin chasers.',
      desc: 'Press ACTION: dumps a slick behind you (grip ×0.18 for 12 s). Chasers slide and spin. 3 drops.', stats: { ammo: 3 } },
    { id: 'magnet', name: 'Electro-Magnet', slot: 'roof', points: 3, active: 'press', mass: 80, icon: 'magnet', color: '#d24a4a',
      short: 'Yank the nearest car toward you.',
      desc: 'Press ACTION: a crane magnet pulls the nearest car within 22 m toward you for 2.2 s — line it up for a T-bone. 9 s cooldown.', stats: { range_m: 22, cooldown_s: 9 } },
    { id: 'wrecking-ball', name: 'Wrecking Ball', slot: 'rear', points: 4, active: false, mass: 120, icon: 'ball', color: '#3c3f44',
      short: 'Tow a 260 kg ball on a chain.',
      desc: 'A 260 kg ball on a 4.5 m chain swings behind you. Whip it into cars by turning hard; damage scales with ball speed.', stats: { ball_kg: 260, chain_m: 4.5 } },
    { id: 'saws', name: 'Wheel Saws', slot: 'side', points: 2, active: false, mass: 50, icon: 'saw', color: '#e8e8e8',
      short: 'Side contact grinds their panels and tyres.',
      desc: 'Spinning blades on the wheel hubs. Side-by-side contact grinds the other car’s side and tyres.', stats: {} },
    { id: 'shield', name: 'Shield Generator', slot: 'util', points: 3, active: 'press', mass: 40, icon: 'bubble', color: '#7ad7ff',
      short: '2.5 s of invulnerability.',
      desc: 'Press ACTION: a 2.5 s force field — no damage taken and hits bounce off. 14 s cooldown.', stats: { duration_s: 2.5, cooldown_s: 14 } },
    { id: 'repair', name: 'Repair Kit', slot: 'util', points: 2, active: 'press', mass: 15, icon: 'wrench', color: '#5fd18b',
      short: 'One-time field repair.',
      desc: 'Press ACTION once: +35 % health, every zone −40 %, fires out, tyres re-inflated (lost wheels stay lost).', stats: { heal: 0.35 } },
    { id: 'spikes', name: 'Rear Spike Plough', slot: 'rear', points: 2, active: false, mass: 60, icon: 'plough', color: '#b0b4ba',
      short: 'Reverse-ram build: rear dealt ×1.5.',
      desc: 'The old derby trick — back into them. Rear damage dealt ×1.5, rear damage taken ×0.75 (protects a front-mounted engine).', stats: { dealt_rear: 1.5, taken_rear: 0.75 } }
  ];
  var DEFS = {};
  LIST.forEach(function (d) { DEFS[d.id] = d; });

  var PRESETS = [
    { id: 'brawler', name: 'Brawler', items: ['ram', 'armour', 'nitro'] },
    { id: 'pyro', name: 'Pyromaniac', items: ['flamethrower', 'bullbar', 'oil'] },
    { id: 'tank', name: 'Tank', items: ['ramp', 'spikes', 'armour', 'repair'] },
    { id: 'trickster', name: 'Trickster', items: ['ramp', 'magnet', 'nitro', 'armour'] },
    { id: 'juggernaut', name: 'Juggernaut', items: ['wrecking-ball', 'bullbar', 'armour', 'repair'] },
    { id: 'hammer-time', name: 'Hammer Time', items: ['hammer', 'bullbar', 'nitro', 'armour'] },
    { id: 'grinder', name: 'Grinder', items: ['saws', 'ram', 'caltrops', 'shield'] },
    { id: 'stock', name: 'Stock', items: [] }
  ];

  function validate(ids) {
    ids = Array.isArray(ids) ? ids : [];
    var errors = [], points = 0, used = {}, actives = [], mass = 0, seen = {};
    ids.forEach(function (id) {
      var d = DEFS[id];
      if (!d) { errors.push('Unknown accessory: ' + id); return; }
      if (seen[id]) { errors.push(d.name + ' fitted twice'); return; }
      seen[id] = 1;
      points += d.points; mass += d.mass;
      used[d.slot] = (used[d.slot] || 0) + 1;
      if (d.active) actives.push(id);
    });
    Object.keys(used).forEach(function (s) { if (used[s] > SLOTS[s]) errors.push(SLOT_NAMES[s] + ' slot: only ' + SLOTS[s] + ' allowed'); });
    if (points > BUDGET) errors.push('Over budget: ' + points + ' / ' + BUDGET + ' points');
    if (actives.length > MAX_ACTIVE) errors.push('At most ' + MAX_ACTIVE + ' ACTION accessories (' + actives.length + ' fitted)');
    return { ok: !errors.length, points: points, budget: BUDGET, errors: errors, actives: actives, mass: mass, slots: used };
  }
  /** keep the valid prefix of a loadout (drops what does not fit) */
  function sanitize(ids) {
    var out = [];
    (Array.isArray(ids) ? ids : []).forEach(function (id) { if (DEFS[id] && validate(out.concat([id])).ok) out.push(id); });
    return out;
  }
  function massOf(ids) { var m = 0; (ids || []).forEach(function (id) { if (DEFS[id]) m += DEFS[id].mass; }); return m; }
  function reachOf(ids) { ids = ids || []; return { front: ids.indexOf('ram') >= 0 ? 1.0 : ids.indexOf('ramp') >= 0 ? 0.45 : ids.indexOf('bullbar') >= 0 ? 0.22 : 0, rear: ids.indexOf('spikes') >= 0 ? 0.25 : 0 }; }
  function has(car, id) { return !!(car.accIndex && car.accIndex[id] != null); }
  function get(car, id) { return car.accIndex && car.accIndex[id] != null ? car.acc[car.accIndex[id]] : null; }

  function create(car, ids) {
    ids = sanitize(ids);
    car.acc = []; car.accIndex = {}; car.actives = [];
    ids.forEach(function (id) {
      var d = DEFS[id];
      var st = { id: id, slot: d.slot, charge: 1, ammo: 0, cooldown: 0, active: false, t: 0, held: false };
      if (id === 'caltrops') st.ammo = 4;
      if (id === 'oil') st.ammo = 3;
      if (id === 'repair') st.ammo = 1;
      if (id === 'hammer') { st.swing = 0; st.side = 1; st.hit = false; st.target = null; }
      if (id === 'magnet') { st.targetId = null; }
      if (id === 'wrecking-ball') {
        var b = rearAnchor(car, 4.0);
        st.ball = { x: b.x, y: b.y, z: 0.5, vx: 0, vy: 0, vz: 0 }; st.hitCd = {};
      }
      car.accIndex[id] = car.acc.length;
      car.acc.push(st);
      if (d.active && car.actives.length < MAX_ACTIVE) car.actives.push(car.acc.length - 1);
    });
    car.shieldT = 0; car.boostT = 0; car.boosting = false; car.magnetT = 0;
    return car.acc;
  }
  function rearAnchor(car, back) {
    var c = Math.cos(car.heading), s = Math.sin(car.heading), L = car.spec ? car.spec.length / 2 : 2.2;
    return { x: car.x - c * (L + (back || 0.2)), y: car.y - s * (L + (back || 0.2)) };
  }
  function frontPoint(car, ahead) {
    var c = Math.cos(car.heading), s = Math.sin(car.heading), L = car.spec.length / 2 + num(car.spec.reachF, 0);
    return { x: car.x + c * (L + (ahead || 0)), y: car.y + s * (L + (ahead || 0)) };
  }
  function local(car, x, y) {
    var c = Math.cos(car.heading), s = Math.sin(car.heading), dx = x - car.x, dy = y - car.y;
    return { lx: dx * c + dy * s, ly: -dx * s + dy * c };
  }
  /** the zone of `target` that faces point (x, y) */
  function facingZone(target, x, y) {
    var q = local(target, x, y);
    var nx = q.lx / (target.spec.length / 2), ny = q.ly / (target.spec.width / 2);
    return Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'front' : 'rear') : (ny > 0 ? 'left' : 'right');
  }
  function alive(c) { return c && c.alive && !c.out; }

  /* ------------------------------------------------------------------ per-step behaviour */
  function step(world, car, input, dt) {
    if (!car.acc || !car.acc.length) return;
    input = input || {};
    var dead = !alive(car);
    var held = [!!input.action1, !!input.action2];
    // map ACTION buttons to the active accessories (loadout order)
    car.acc.forEach(function (st) { st.prevHeld = st.held; st.held = false; });
    if (!dead && !car.flipped) car.actives.forEach(function (ai, k) { if (car.acc[ai]) car.acc[ai].held = held[k]; });
    car.boosting = false;
    if (car.shieldT > 0) car.shieldT = Math.max(0, car.shieldT - dt);
    if (car.magnetT > 0) car.magnetT = Math.max(0, car.magnetT - dt);
    for (var i = 0; i < car.acc.length; i++) {
      var st = car.acc[i];
      var press = st.held && !st.prevHeld;
      if (st.cooldown > 0) st.cooldown = Math.max(0, st.cooldown - dt);
      st.t += dt;
      switch (st.id) {
        case 'flamethrower': flame(world, car, st, dt, dead); break;
        case 'nitro':
          if (st.held && st.charge > 0.02 && !dead) { st.active = true; st.charge = Math.max(0, st.charge - dt / 4); car.boosting = true; if (!st.wasOn) world.emit({ type: 'nitro', carId: car.id }); }
          else { st.active = false; st.charge = Math.min(1, st.charge + dt * (st.held ? 0 : 0.15)); }
          st.wasOn = st.active;
          break;
        case 'hammer': hammer(world, car, st, dt, press && !dead); break;
        case 'caltrops':
        case 'oil':
          if (press && st.ammo > 0 && st.cooldown <= 0 && !dead) {
            st.ammo--; st.cooldown = 1.2;
            var p = rearAnchor(car, st.id === 'oil' ? 2.6 : 2.2);
            world.addEntity({ type: st.id, x: p.x, y: p.y, z: car.z, r: st.id === 'oil' ? 3.6 : 3.2, life: st.id === 'oil' ? 12 : 25, owner: car.id, heading: car.heading, armT: 0.8, hit: {} });
            world.emit({ type: st.id, carId: car.id, x: p.x, y: p.y });
          }
          st.charge = st.ammo / (st.id === 'oil' ? 3 : 4);
          break;
        case 'magnet': magnet(world, car, st, dt, press && !dead); break;
        case 'shield':
          if (press && st.cooldown <= 0 && !dead) { car.shieldT = 2.5; st.cooldown = 14; world.emit({ type: 'shield', carId: car.id }); }
          st.active = car.shieldT > 0; st.charge = st.cooldown > 0 ? 1 - st.cooldown / 14 : 1;
          break;
        case 'repair':
          if (press && st.ammo > 0 && !dead) {
            st.ammo = 0; world.damage.repair(car, 0.35); world.emit({ type: 'repair', carId: car.id });
            if (car.isPlayer) world.feed('Field repair: +35 % health', 'info', car.id);
          }
          st.charge = st.ammo;
          break;
        case 'wrecking-ball': ball(world, car, st, dt); break;
        default: break;
      }
    }
  }

  function flame(world, car, st, dt, dead) {
    var on = st.held && st.charge > 0.01 && !dead;
    if (on && !st.active && st.charge < 0.12) on = false;   // needs a little fuel to relight
    st.active = on;
    if (!on) { st.charge = Math.min(1, st.charge + dt * 0.12); st.burnAcc = 0; return; }
    st.charge = Math.max(0, st.charge - dt / 6);
    var nz = frontPoint(car, 0.2), fx = Math.cos(car.heading), fy = Math.sin(car.heading);
    var range = 10, cosCone = Math.cos(26 * Math.PI / 180);
    st.burnAcc = (st.burnAcc || 0) + dt;
    var hitAny = false;
    world.cars.forEach(function (o) {
      if (o === car || o.out) return;
      var dx = o.x - nz.x, dy = o.y - nz.y, d = Math.hypot(dx, dy);
      if (d > range + o.spec.length / 2 || d < 0.01) return;
      var cosA = (dx * fx + dy * fy) / d;
      // generous near the nozzle (the car body is wide)
      if (cosA < cosCone - clamp(2.2 / Math.max(d, 1), 0, 0.5)) return;
      if (Math.abs(o.z - car.z) > 2.5) return;
      var fall = clamp(1.15 - d / range, 0.25, 1);
      hitAny = true;
      var zone = facingZone(o, nz.x, nz.y);
      var lost = world.hurt(o, zone, 0.27 * fall * dt, car, 'flame', { healthMult: 1 });
      car.stats.flameDmg += lost;
      if (alive(o)) {
        if (o.dmg.onFire < 0.6 && o.shieldT <= 0) { o.dmg.onFire = 0.7; o.dmg.burnT = Math.max(o.dmg.burnT, 3.5); if (!o.fireFrom || world.t - (o.fireT || 0) > 3) world.emit({ type: 'fire', carId: o.id, otherId: car.id }); o.fireFrom = car.id; o.fireT = world.t; }
        else o.dmg.burnT = Math.max(o.dmg.burnT, 3.5);
      }
    });
    if (st.burnAcc > 0.25) { st.burnAcc = 0; world.emit({ type: 'flame', carId: car.id, hit: hitAny }); }
  }

  function hammer(world, car, st, dt, press) {
    if (st.swing > 0) {
      st.swing += dt / 0.5;
      if (!st.hit && st.swing >= 0.36) {
        st.hit = true;
        var tgt = st.target != null ? world.byId(st.target) : null;
        // the hammer head position (beside the car, 3 m out on the swing side)
        var c = Math.cos(car.heading), s = Math.sin(car.heading);
        var hx = car.x - s * 3.0 * st.side + c * 0.4, hy = car.y + c * 3.0 * st.side + s * 0.4;
        var best = null, bd = 3.4;
        world.cars.forEach(function (o) {
          if (o === car || o.out) return;
          var d = Math.hypot(o.x - hx, o.y - hy) - o.spec.width / 2;
          if (d < bd) { bd = d; best = o; }
        });
        if (!best && tgt && !tgt.out && Math.hypot(tgt.x - car.x, tgt.y - car.y) < 6.5) best = tgt;
        if (best) {
          var dx = best.x - car.x, dy = best.y - car.y, l = Math.hypot(dx, dy) || 1;
          var J = 7600 * (best.shieldT > 0 ? 0.4 : 1);
          // hit high on the body: shove + spin + a roll kick
          world.impulse(best, dx / l * J, dy / l * J, best.x - dx / l * best.spec.width * 0.4 + c * 0.6, best.y - dy / l * best.spec.width * 0.4 + s * 0.6);
          best.rollV += (st.side > 0 ? 1 : -1) * 2.4 * (1500 / best.spec.mass);
          var zone = facingZone(best, car.x, car.y);
          var lost = world.hurt(best, zone, 0.34, car, 'hammer', { healthMult: 1 });
          car.stats.hits++; if (lost > 0.08) car.stats.bigHits++;
          world.emit({ type: 'hammer', carId: car.id, otherId: best.id, x: best.x, y: best.y, z: best.z + 1, zone: zone, big: true, energy: 60000 });
          if (car.isPlayer) world.feed('HAMMER! You smashed ' + best.short, 'hit', car.id, best.id);
          else if (best.isPlayer) world.feed(car.short + ' hammered you', 'hit', car.id, best.id);
        } else world.emit({ type: 'hammer', carId: car.id, miss: true });
      }
      if (st.swing >= 1) { st.swing = 0; st.hit = false; st.target = null; }
    } else if (press && st.cooldown <= 0) {
      // pick the side of the nearest car
      var bestT = null, bdist = 7.5;
      world.cars.forEach(function (o) {
        if (o === car || o.out) return;
        var d = Math.hypot(o.x - car.x, o.y - car.y);
        if (d < bdist) { bdist = d; bestT = o; }
      });
      st.side = 1;
      if (bestT) { var q = local(car, bestT.x, bestT.y); st.side = q.ly >= 0 ? 1 : -1; st.target = bestT.id; }
      st.swing = 0.001; st.hit = false; st.cooldown = 2.2;
      world.emit({ type: 'hammer-swing', carId: car.id, side: st.side });
    }
    st.active = st.swing > 0;
    st.charge = st.cooldown > 0 ? 1 - st.cooldown / 2.2 : 1;
  }

  function magnet(world, car, st, dt, press) {
    if (press && st.cooldown <= 0) {
      var best = null, bd = 22;
      world.cars.forEach(function (o) {
        if (o === car || o.out) return;
        var d = Math.hypot(o.x - car.x, o.y - car.y);
        if (d < bd) { bd = d; best = o; }
      });
      st.cooldown = 9;
      if (best) { st.targetId = best.id; car.magnetT = 2.2; world.emit({ type: 'magnet', carId: car.id, otherId: best.id }); if (best.isPlayer) world.feed(car.short + ' grabbed you with a magnet!', 'hit', car.id, best.id); }
      else world.emit({ type: 'magnet', carId: car.id, miss: true });
    }
    if (car.magnetT > 0 && st.targetId != null) {
      var t = world.byId(st.targetId);
      if (!t || t.out) { car.magnetT = 0; }
      else {
        var dx = car.x - t.x, dy = car.y - t.y, d = Math.hypot(dx, dy) || 1;
        if (d > 3.2) {
          var F = t.spec.mass * 10.5 * (t.shieldT > 0 ? 0.3 : 1) * clamp(d / 8, 0.6, 1.2);
          t.vx += dx / d * F / t.spec.mass * dt; t.vy += dy / d * F / t.spec.mass * dt;
          car.vx -= dx / d * F * 0.25 / car.spec.mass * dt; car.vy -= dy / d * F * 0.25 / car.spec.mass * dt;
        }
      }
    }
    if (car.magnetT <= 0) st.targetId = car.magnetT > 0 ? st.targetId : null;
    st.active = car.magnetT > 0;
    st.charge = st.cooldown > 0 ? 1 - st.cooldown / 9 : 1;
  }

  function ball(world, car, st, dt) {
    var b = st.ball, L = 4.5, mB = 260;
    var anc = rearAnchor(car, 0.25);
    // ball: gravity, ground, friction
    b.vz -= 9.81 * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    var gz = (CB.derby.arenas ? CB.derby.arenas.heightAt(world.arena, b.x, b.y).z : 0) + 0.45;
    if (b.z < gz) { b.z = gz; if (b.vz < 0) b.vz = -b.vz * 0.25; var fr = 1 - Math.min(1, 0.55 * dt); b.vx *= fr; b.vy *= fr; }   // rolls: keeps its swing
    // chain: inelastic rope constraint (tension pulls the car back a little)
    var dx = b.x - anc.x, dy = b.y - anc.y, d = Math.hypot(dx, dy) || 1e-6;
    if (d > L) {
      var nx = dx / d, ny = dy / d;
      b.x = anc.x + nx * L; b.y = anc.y + ny * L;
      var pv = { x: car.vx - car.w * (anc.y - car.y), y: car.vy + car.w * (anc.x - car.x) };
      var rel = (b.vx - pv.x) * nx + (b.vy - pv.y) * ny;
      if (rel > 0) {
        // shared impulse between ball and car (car much heavier)
        var mc = car.spec.mass, j = rel / (1 / mB + 1 / mc);
        b.vx -= j / mB * nx; b.vy -= j / mB * ny;
        world.impulse(car, j * nx, j * ny, anc.x, anc.y);
      }
    }
    // wall
    var AR = CB.derby.arenas;
    if (AR) {
      var bd = AR.sdBoundary(world.arena, b.x, b.y);
      if (bd.d < 0.45 && !bd.open) { var vn = b.vx * bd.nx + b.vy * bd.ny; if (vn < 0) { b.vx -= 1.4 * vn * bd.nx; b.vy -= 1.4 * vn * bd.ny; } b.x += bd.nx * (0.45 - bd.d); b.y += bd.ny * (0.45 - bd.d); }
    }
    // cars
    var bs = Math.hypot(b.vx, b.vy);
    world.cars.forEach(function (o) {
      if (o === car) return;
      st.hitCd[o.id] = Math.max(0, num(st.hitCd[o.id], 0) - dt);
      var q = local(o, b.x, b.y);
      var ex = Math.abs(q.lx) - o.spec.length / 2 - 0.45, ey = Math.abs(q.ly) - o.spec.width / 2 - 0.45;
      if (ex > 0 || ey > 0 || Math.abs(b.z - (o.z + 0.6)) > 1.4) return;
      // push out + exchange momentum
      var c = Math.cos(o.heading), s = Math.sin(o.heading), nlx = 0, nly = 0;
      if (ex > ey) nlx = q.lx > 0 ? 1 : -1; else nly = q.ly > 0 ? 1 : -1;
      var nwx = nlx * c - nly * s, nwy = nlx * s + nly * c;
      var pv2 = world.pointVel ? world.pointVel(o, b.x, b.y) : { x: o.vx, y: o.vy };
      var rv = (b.vx - pv2.x) * nwx + (b.vy - pv2.y) * nwy;   // < 0 closing (normal points out of o)
      if (rv < 0) {
        var jj = -(1.3) * rv / (1 / mB + 1 / o.spec.mass);
        b.vx += jj / mB * nwx; b.vy += jj / mB * nwy;
        world.impulse(o, -jj * nwx, -jj * nwy, b.x, b.y);
        if (-rv > 4 && st.hitCd[o.id] <= 0) {
          st.hitCd[o.id] = 0.5;
          var zone = Math.abs(nlx) > 0 ? (nlx > 0 ? 'front' : 'rear') : (nly > 0 ? 'left' : 'right');
          var amt = clamp((rv * rv - 16) / 900, 0.02, 0.5);
          var lost = world.hurt(o, zone, amt, car, 'ball');
          car.stats.hits++; if (lost > 0.08) car.stats.bigHits++;
          world.emit({ type: 'impact', carId: car.id, otherId: o.id, x: b.x, y: b.y, z: b.z, energy: 0.5 * mB * rv * rv, zone: zone, big: lost > 0.08, ball: true });
          if (car.isPlayer && lost > 0.06) world.feed('Wrecking ball hit ' + o.short + '!', 'hit', car.id, o.id);
        }
      }
      b.x += nwx * 0.05; b.y += nwy * 0.05;
    });
    st.speed = bs;
    st.anchor = anc;
  }

  /* ------------------------------------------------------------------ handling mods */
  function driveMods(car, mods) {
    var n = get(car, 'nitro');
    if (n && n.active) {
      mods.accelMult = num(mods.accelMult, 1) * 1.65; mods.topMult = num(mods.topMult, 1) * 1.2;
      // rocket thrust on top of the tyres (works even when the launch is traction-limited), fading near the boosted top speed
      var top = car.spec.topSpeed * 1.2, u = car.vx * Math.cos(car.heading) + car.vy * Math.sin(car.heading);
      var F = car.spec.mass * 3.2 * clamp(1 - u / top, 0, 1);
      var ef = mods.extraForce || { x: 0, y: 0 };
      mods.extraForce = { x: ef.x + Math.cos(car.heading) * F, y: ef.y + Math.sin(car.heading) * F };
    }
    return mods;
  }

  /* ------------------------------------------------------------------ damage modifiers */
  function modifier(car, zone, role) {
    var m = 1;
    if (!car.accIndex) return 1;
    if (role === 'taken') {
      if (car.shieldT > 0) return 0;
      if (has(car, 'armour')) m *= 0.65;
      if (zone === 'front') { if (has(car, 'ram')) m *= 0.6; else if (has(car, 'bullbar')) m *= 0.7; else if (has(car, 'ramp')) m *= 0.8; }
      if (zone === 'rear' && has(car, 'spikes')) m *= 0.75;
    } else {
      if (zone === 'front') { if (has(car, 'ram')) m *= 1.6; else if (has(car, 'bullbar')) m *= 1.45; else if (has(car, 'ramp')) m *= 1.1; }
      if (zone === 'rear' && has(car, 'spikes')) m *= 1.5;
      if (car.boosting) m *= 1.3;
    }
    return m;
  }

  /**
   * Car-car contact hook, called for both cars. info: {contact, myZone, otherZone, attacker (bool: car drove in),
   * vn, nx, ny (unit from car toward other)}
   */
  function onContact(world, car, other, info) {
    if (!car.accIndex) return;
    var vn = info.vn;
    // front ramp: head-on / nose hits launch the other car
    if (has(car, 'ramp') && info.myZone === 'front' && vn > 5 && (info.attacker || vn > 9)) {
      var st = get(car, 'ramp');
      if (st.cooldown <= 0 && !other.airborne && world.t - (other.launchedT == null ? -99 : other.launchedT) > (other.isPlayer ? 4 : 2)) {
        st.cooldown = 0.7; other.launchedT = world.t;
        var lift = clamp(0.32 * vn + 1.5, 3, other.isPlayer ? 6.5 : 8.5) * Math.sqrt(1500 / other.spec.mass);
        other.airborne = true; other.vz = lift; other.airT = 0;
        var side = info.otherZone === 'left' ? -1 : info.otherZone === 'right' ? 1 : (world.rng() < 0.5 ? -1 : 1);
        // a sideways roll kick: usually it lands on its wheels, big hits put it on its roof (~1 in 4 overall)
        other.rollV += side * clamp(0.4 + vn * 0.07, 0.7, 2.2) * (0.55 + 0.9 * world.rng()) * (other.isPlayer ? 0.55 : 1);   // a launched human usually lands on its wheels   // harder hits flip more often
        other.pitchV += (info.otherZone === 'front' ? 1 : info.otherZone === 'rear' ? -1 : 0) * 1.4;
        // keep some forward momentum: the ramp throws them up and over
        other.vx += info.nx * vn * 0.25; other.vy += info.ny * vn * 0.25;
        world.emit({ type: 'launch', carId: car.id, otherId: other.id, x: other.x, y: other.y, z: other.z, big: true });
        if (car.isPlayer) world.feed('LAUNCHED ' + other.short + '!', 'hit', car.id, other.id);
        else if (other.isPlayer) world.feed(car.short + ' launched you!', 'hit', car.id, other.id);
      }
    }
    // battering ram: extra shove
    if (has(car, 'ram') && info.myZone === 'front' && vn > 4 && info.attacker) {
      var J = vn * other.spec.mass * 0.12;
      world.impulse(other, info.nx * J, info.ny * J, info.contact.px, info.contact.py);
    }
    // bull-bar / ram spikes puncture the tyre nearest to the hit
    if ((has(car, 'bullbar') || has(car, 'ram')) && info.myZone === 'front' && vn > 4) {
      var Dm = world.damage, z = Dm.zoneOf(other, info.contact.px, info.contact.py);
      if (z.wheelW > 0.15) world.hurt(other, 'wheels', 0.35 * z.wheelW, car, 'spikes', { wheel: z.wheel });
    }
    // wheel saws: side-by-side grinding (called every step while touching)
    if (has(car, 'saws') && (info.myZone === 'left' || info.myZone === 'right')) {
      var sst = get(car, 'saws');
      var amt = 0.0045 * clamp(0.4 + info.vt / 6, 0.4, 1.8);
      world.hurt(other, info.otherZone === 'front' || info.otherZone === 'rear' ? info.otherZone : info.otherZone, amt, car, 'saws');
      var zw = world.damage.zoneOf(other, info.contact.px, info.contact.py);
      if (zw.wheelW > 0.05) world.hurt(other, 'wheels', 0.008, car, 'saws', { wheel: zw.wheel });
      sst.active = true; sst.t = 0;
      if (!sst.lastEv || world.t - sst.lastEv > 0.2) { sst.lastEv = world.t; world.emit({ type: 'scrape', carId: car.id, otherId: other.id, x: info.contact.px, y: info.contact.py, z: car.z + 0.4, saws: true }); }
    }
    // shield: the hit bounces off
    if (car.shieldT > 0 && vn > 2) {
      var Js = other.spec.mass * Math.min(6, vn * 0.5);
      world.impulse(other, info.nx * Js, info.ny * Js, other.x, other.y);
    }
  }

  function view(car) {
    return (car.acc || []).map(function (st, i) {
      var d = DEFS[st.id], o = { id: st.id, slot: st.slot, name: d.name, kind: d.active || 'passive', active: !!st.active, charge: +num(st.charge, 1).toFixed(3),
        ammo: st.ammo, cooldown: +num(st.cooldown, 0).toFixed(2), button: car.actives.indexOf(i) >= 0 ? car.actives.indexOf(i) + 1 : 0 };
      o.ready = d.active ? (st.id === 'nitro' || st.id === 'flamethrower' ? st.charge > 0.12 : (st.ammo > 0 || (st.id !== 'caltrops' && st.id !== 'oil' && st.id !== 'repair')) && st.cooldown <= 0) : true;
      if (st.id === 'repair' || st.id === 'caltrops' || st.id === 'oil') o.ready = st.ammo > 0 && st.cooldown <= 0;
      if (st.id === 'hammer') { o.swing = +st.swing.toFixed(3); o.side = st.side; }
      if (st.id === 'magnet') o.targetId = car.magnetT > 0 ? st.targetId : null;
      if (st.id === 'wrecking-ball') o.ball = { x: +st.ball.x.toFixed(3), y: +st.ball.y.toFixed(3), z: +st.ball.z.toFixed(3) };
      if (st.id === 'saws') { o.active = st.t < 0.15; }
      return o;
    });
  }

  CB.derby.accessories = {
    LIST: LIST, DEFS: DEFS, PRESETS: PRESETS, BUDGET: BUDGET, SLOTS: SLOTS, SLOT_NAMES: SLOT_NAMES, MAX_ACTIVE: MAX_ACTIVE,
    validate: validate, sanitize: sanitize, massOf: massOf, reachOf: reachOf, create: create, step: step, driveMods: driveMods,
    modifier: modifier, onContact: onContact, view: view, has: has, get: get, describe: function (id) { return DEFS[id] || null; },
    _: { facingZone: facingZone, rearAnchor: rearAnchor, frontPoint: frontPoint, wrap: wrap }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.accessories;
})();

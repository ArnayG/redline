/* ==========================================================================
   Redline — js/derby/derby-pickups.js
   CB.derby.pickups : arena pickups that pull cars through the middle (docs/DERBY-SPEC.md §2.1).

     KINDS {repair, boost, ammo, armor, bomb}   COLLECT_R 2.4
     create(arena, rng) -> P
       P.step(world, dt)        world facade: {t, cars, emit(ev), feed(text, kind, a, b), damage, arena, byId, suddenDeath?}
       P.entities() -> [{id, type: 'pickup', kind, x, y, z, active, respawn}]
       P.serialize() -> JSON     P.restore(o)     P.spots -> [{x, y}]
       P.apply(car, kind, world) applies a pickup to a car directly (tests / debug)

   Pickup spots come from arena.pickupSpots (centre / contested lines). Spots fill one by one after the countdown
   (t >= 3.5 s), a collected pickup comes back after 10–15 s (5–8 s in sudden death, when every spot is active).
   Effects: repair +25 % health, zones -15 %, fires out · boost: full ram meter (car.ram.charge) + nitro accessory full ·
   ammo: accessory ammo / fuel refilled, cooldowns cleared · armor: car.pickupArmorT = 6 (damage taken x0.5 while > 0) ·
   bomb: car.bombT = 8 (the next car this one hits takes a big blast; the sim consumes it).
   Deterministic: randomness only through the rng given to create(). Node-loadable.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.derby = CB.derby || {};

(function () {
  'use strict';
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  var COLLECT_R = 2.4;
  var KINDS = {
    repair: { id: 'repair', name: 'Repair', weight: 3, color: '#3fd17a', text: 'REPAIR +25 %' },
    boost: { id: 'boost', name: 'Boost', weight: 3, color: '#3aa0ff', text: 'BOOST — ram meter full' },
    ammo: { id: 'ammo', name: 'Ammo', weight: 2, color: '#ff9a1a', text: 'AMMO — accessories reloaded' },
    armor: { id: 'armor', name: 'Armor', weight: 2, color: '#d8dde4', text: 'ARMOR — half damage for 6 s' },
    bomb: { id: 'bomb', name: 'Sticky bomb', weight: 1.4, color: '#ff3030', text: 'STICKY BOMB — hit someone within 8 s!' }
  };
  var ORDER = ['repair', 'boost', 'ammo', 'armor', 'bomb'];
  var AMMO_MAX = { caltrops: 4, oil: 3 };

  function pickKind(rng, prev) {
    var tot = 0, i;
    for (i = 0; i < ORDER.length; i++) tot += KINDS[ORDER[i]].weight * (ORDER[i] === prev ? 0.4 : 1);
    var r = rng() * tot;
    for (i = 0; i < ORDER.length; i++) { r -= KINDS[ORDER[i]].weight * (ORDER[i] === prev ? 0.4 : 1); if (r <= 0) return ORDER[i]; }
    return ORDER[0];
  }

  function apply(car, kind, world) {
    var d = car.dmg;
    if (kind === 'repair') {
      if (d) {
        d.health = Math.min(1, num(d.health, 1) + 0.25);
        d.onFire = 0; d.burnT = 0; if (d.engine) { d.engine.fire = 0; d.engine.temp = Math.min(num(d.engine.temp, 0), 0.4); }
        if (d.zones) for (var z in d.zones) d.zones[z] = Math.max(0, d.zones[z] - 0.15);
        var Dm = (world && world.damage) || CB.derby.damage;
        if (Dm && Dm._ && Dm._.updateEngine) Dm._.updateEngine(car);
        if (d.engine && d.engine.stalled && d.engine.hp > 0.01) d.engine.stalled = false;
      }
    } else if (kind === 'boost') {
      if (car.ram && typeof car.ram === 'object') car.ram.charge = 1;
      (car.acc || []).forEach(function (st) { if (st.id === 'nitro') st.charge = 1; });
      car.pickupBoostT = 0.8;
    } else if (kind === 'ammo') {
      (car.acc || []).forEach(function (st) {
        if (AMMO_MAX[st.id]) st.ammo = AMMO_MAX[st.id];
        if (st.id === 'flamethrower' || st.id === 'nitro') st.charge = 1;
        st.cooldown = 0;
      });
      if (car.ram && typeof car.ram === 'object') car.ram.charge = Math.max(num(car.ram.charge, 0), 0.5);
    } else if (kind === 'armor') {
      car.pickupArmorT = 6;
    } else if (kind === 'bomb') {
      car.bombT = 8;
    }
  }

  function create(arena, rng) {
    rng = rng || function () { return 0.5; };
    var spots = (arena && arena.pickupSpots ? arena.pickupSpots : []).map(function (p, i) { return { x: p[0], y: p[1], i: i }; });
    var P = {
      spots: spots.map(function (s) { return { x: s.x, y: s.y }; }),
      items: spots.map(function (s, i) { return { id: 'pk' + i, kind: null, x: s.x, y: s.y, z: 0, active: false, respawn: 3.5 + i * 1.3, last: null }; })
    };
    function zAt(x, y) { var A = CB.derby.arenas; return A && arena ? A.heightAt(arena, x, y).z : 0; }
    P.items.forEach(function (it) { it.z = zAt(it.x, it.y); });

    P.step = function (world, dt) {
      var t = num(world && world.t, 0), sd = world && world.suddenDeath && world.suddenDeath.on;
      var cars = (world && world.cars) || [];
      P.items.forEach(function (it) {
        if (!it.active) {
          if (t >= it.respawn) { it.active = true; it.kind = pickKind(rng, it.last); it.spawnT = t; if (world && world.emit) world.emit({ type: 'pickup-spawn', kind: it.kind, x: it.x, y: it.y, pickupId: it.id }); }
          else if (sd && it.respawn - t > 8) it.respawn = t + 2 + rng() * 2;   // sudden death: everything comes back fast
          return;
        }
        for (var k = 0; k < cars.length; k++) {
          var c = cars[k];
          if (!c || c.out || c.alive === false) continue;
          if (Math.abs(num(c.z, 0) - it.z) > 1.6) continue;
          var r = COLLECT_R + (c.spec ? c.spec.width * 0.35 : 0.6);
          if ((c.x - it.x) * (c.x - it.x) + (c.y - it.y) * (c.y - it.y) > r * r) continue;
          apply(c, it.kind, world);
          if (world && world.emit) world.emit({ type: 'pickup', carId: c.id, kind: it.kind, x: it.x, y: it.y, pickupId: it.id });
          if (world && world.feed && c.isPlayer) world.feed(KINDS[it.kind].text, 'info', c.id);
          else if (world && world.feed && it.kind === 'bomb' && cars.some(function (o) { return o.isPlayer && !o.out; })) world.feed((c.short || c.name) + ' grabbed a STICKY BOMB!', 'info', c.id);
          it.active = false; it.last = it.kind; it.kind = null;
          it.respawn = t + (sd ? 5 + rng() * 3 : 10 + rng() * 5);
          if (c.stats) c.stats.pickups = num(c.stats.pickups, 0) + 1;
          break;
        }
      });
    };
    P.entities = function () {
      return P.items.map(function (it) { return { id: it.id, type: 'pickup', kind: it.kind || it.last || 'repair', x: it.x, y: it.y, z: it.z, active: it.active, respawn: it.respawn }; });
    };
    P.active = function () { return P.items.filter(function (it) { return it.active; }).map(function (it) { return { id: it.id, kind: it.kind, x: it.x, y: it.y, z: it.z }; }); };
    P.serialize = function () { return JSON.parse(JSON.stringify({ items: P.items })); };
    P.restore = function (o) { if (o && Array.isArray(o.items)) P.items = JSON.parse(JSON.stringify(o.items)); };
    P.apply = function (car, kind, world) { apply(car, kind, world); };
    return P;
  }

  CB.derby.pickups = { create: create, KINDS: KINDS, ORDER: ORDER, COLLECT_R: COLLECT_R, apply: apply, _: { pickKind: pickKind } };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.derby.pickups;
})();

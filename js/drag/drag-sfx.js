/* ==========================================================================
   Redline — js/drag/drag-sfx.js
   CB.drag.sfx : sound for Drag Racing. Drives the shared procedural race audio (CB.race.audio: per-layout engine
   voices tied to rpm / throttle / gear, turbo spool, shift dips + exhaust crackle, tyre squeal / wheelspin, the
   opponent's engine as a spatialised AI voice) through an adapter snapshot, and maps the drag events onto it:
   tree ambers = countdown beeps, green = lights-out tone, red light = buzzer, finish = chime.

     create({ muted }) -> { start() (user gesture), frame(snap, dt), setMuted(b), isMuted(), destroy(), adapt(snap) }
     adapt(snap) is PURE (Node tests): the race-audio view of a drag snapshot.
   Safe without WebAudio / without CB.race.audio (every call is a no-op).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.drag = CB.drag || {};

(function () {
  'use strict';
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  /** drag snapshot -> CB.race.audio snapshot (cars with ids, countdown, mapped events) */
  function adapt(snap) {
    if (!snap) return null;
    var pl = snap.playerLane != null ? snap.playerLane : 0;
    var cars = (snap.lanes || []).map(function (l, i) {
      if (!l || l.kind === 'none') return null;
      return { id: 'lane' + i, isPlayer: i === pl, x: num(l.x, 0), y: num(l.y, 0), heading: num(l.heading, 0), speed: Math.abs(num(l.speed, num(l.vx, 0))),
        rpm: num(l.rpm, 900), redline: num(l.redline, 7000), throttle: num(l.throttle, 0), brake: num(l.brake, 0), gear: num(l.gear, 1),
        wheelspin: Math.max(num(l.wheelspin, 0), l.burnout ? 1 : 0), skidding: l.burnout ? 0.8 : num(l.wheelspin, 0) * 0.6, build: l.build || null, surface: 'asphalt' };
    }).filter(Boolean);
    var tr = snap.tree || {}, lt = (tr.lanes || [])[pl] || {}, am = lt.amber || [];
    var lit = 0; for (var a = 0; a < am.length; a++) if (am[a]) lit = a + 1;
    if (snap.treeType === 'pro' && lit) lit = 3;
    var phase = snap.phase === 'tree' ? 'countdown' : snap.phase === 'run' || snap.phase === 'shutdown' ? 'racing' : snap.phase === 'done' ? 'finished' : 'grid';
    var evs = [];
    (snap.events || []).forEach(function (e) {
      if (!e) return;
      var id = 'lane' + (e.lane != null ? e.lane : pl);
      if (e.type === 'red') evs.push({ type: 'jumpstart', carId: id });
      else if (e.type === 'finish') evs.push({ type: 'finish', carId: id });
      else if (e.type === 'split' && e.lane === pl) evs.push({ type: 'sector', carId: id });
    });
    return { t: snap.t, phase: phase, playerId: 'lane' + pl, cars: cars, events: evs, weather: snap.surface === 'wet' ? 'wet' : 'dry',
      countdown: { lightsOn: lit, lightsOut: !!lt.green || (snap.treeType === 'flag' && tr.flag === 'drop') } };
  }

  function create(opts) {
    opts = opts || {};
    var A = null, muted = !!opts.muted;
    try { if (CB.race && CB.race.audio && typeof CB.race.audio.create === 'function') A = CB.race.audio.create(); } catch (e) { A = null; }
    if (A && A.isMuted && A.isMuted() !== muted && A.setMuted) A.setMuted(muted);
    return {
      start: function () { if (A && A.start) try { A.start(); } catch (e) { /* ignore */ } },
      frame: function (snap) { if (!A || !A.update) return; var s = adapt(snap); if (s) try { A.update(s); } catch (e) { /* ignore */ } },
      setMuted: function (b) { muted = !!b; if (A && A.setMuted) A.setMuted(muted); },
      isMuted: function () { return muted; },
      destroy: function () { if (A && A.destroy) try { A.destroy(); } catch (e) { /* ignore */ } A = null; },
      adapt: adapt
    };
  }

  CB.drag.sfx = { create: create, adapt: adapt };
  if (typeof module !== 'undefined' && module.exports) module.exports = CB.drag.sfx;
})();

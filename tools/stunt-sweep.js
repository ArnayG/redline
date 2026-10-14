#!/usr/bin/env node
/* ==========================================================================
   Redline — tools/stunt-sweep.js
   Human-driver fuzz / sweep harness for the Arcade STUNT tracks (js/arcade/stunt-*.js). Drives the PLAYER car through
   the real CB.arcade.mode session (gameplay extension, CB.race.vehicle arcadeResponse drive model) with scripted input
   profiles — speed sweeps (coasting .. Mega Nitro), lateral offsets across the whole road, air steering, throttle
   lifts, handbrake, item hits, car builds, frame-rate / dt-spike profiles — with the single arcade handling model (no
   steering assist; the stunt 'player' safety helpers + mercy rule) — and flags:
     fallThrough   the car ended up just below a road surface it was over (lateral within the road) and then fell /
                   respawned — i.e. it tunnelled through the road instead of landing
     roadUnder     a fall / lost respawn started while a road surface was right under the car
     wrongAttach   a landing re-attached to a different section (track progress jump != distance flown)
     launched      car left the world bounds (far above / beside the map)
     stuck         stuck / wrong-way respawns, or no lap progress
     loopDrop      dropped off a loop / corkscrew / wall while faster than the adhesion speed
     unfinished    lap not completed within the time budget
   Usage: node tools/stunt-sweep.js [--map id] [--quick] [--verbose] [--json]
   As a module: require('./tools/stunt-sweep.js') -> { load, runCase, profiles, sweep, summarize }
   ========================================================================== */
'use strict';
var path = require('path');
var fs = require('fs');

var ROOT = path.join(__dirname, '..');
var FILES = ['js/util.js', 'js/data.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/vehicle.js', 'js/race/ai.js',
  'js/race/engine.js', 'js/arcade/mode.js', 'js/arcade/stunt-track.js', 'js/arcade/stunt-maps.js', 'js/arcade/stunt-physics.js',
  'js/arcade/stunt-ai.js', 'js/arcade/stunt-session.js', 'js/arcade/items.js', 'js/arcade/nitro.js', 'js/arcade/gameplay.js', 'js/arcade/arcade-hud.js',
  'js/arcade/arcade-layer.js'];
var loaded = false;
function load() {
  if (loaded) return globalThis.CB;
  FILES.forEach(function (f) { var p = path.join(ROOT, f); if (fs.existsSync(p)) require(p); });
  loaded = true;
  var CB = globalThis.CB;
  if (CB.arcade.layer && CB.arcade.layer.register) CB.arcade.layer.register();
  return CB;
}

var MAPS = ['loop-rush', 'canyon-leap', 'corkscrew-carnival', 'neon-wallride', 'mega-drop', 'figure-8'];
/** preset index -> label (light hatch, heavy SUV / pickup / van, hypercars, slow commuter) */
var BUILDS = { hatch: 3, suv: 4, pickup: 12, van: 13, hyper: 8, ehyper: 2, eco: 6, touge: 14, gt: 0 };
var DT = {
  hz30: function () { return 1 / 30; }, hz60: function () { return 1 / 60; }, hz120: function () { return 1 / 120; }, hz144: function () { return 1 / 144; },
  /** jittery browser frames 6..40 ms with a 100 ms hitch every ~1.5 s */
  spiky: function (k, r) { return k % 90 === 47 ? 0.1 : 0.006 + r() * 0.034; },
  /** sustained 100 ms frames (background tab / slow phone) */
  slow: function () { return 0.1; }
};

function mulberry(a) { return function () { a = (a + 0x6D2B79F5) | 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/**
 * One scripted run. o {
 *   map, build (BUILDS key), lat (-1..1 fraction of the usable half width),
 *   wobble (m amplitude of a slow weave), throttle (0..1), speed 'full'|'slow'|'crawl'|'lift'|'brakeGap'|'coast',
 *   boost 'none'|'nitro'|'mega'|'megaGap'|'pads'|'hit', air 'none'|'left'|'right'|'lift'|'brake'|'handbrake'|'wiggle',
 *   keyboard (digital steering), dt (DT key), laps (1), timeout_s, seed }
 */
function runCase(o) {
  var CB = load();
  o = Object.assign({ map: 'loop-rush', build: 'hatch', lat: 0, wobble: 0, throttle: 1, speed: 'full', boost: 'none', air: 'none',
    keyboard: false, dt: 'hz60', laps: 1, timeout_s: 0, seed: 7 }, o || {});
  var S = CB.arcade.stunt, P = S.physics, V = S._vec;
  var track = S.get(o.map), L = track.length, F = track.FLAGS;
  var preset = CB.data.presets[BUILDS[o.build] != null ? BUILDS[o.build] : 3];
  var build = JSON.parse(JSON.stringify(preset.build || preset));
  var rep = { map: o.map, falls: 0, fallThrough: [], roadUnder: [], wrongAttach: [], launched: [], stuck: [], loopDrop: [], respawns: [], landings: 0, finished: false, time: null, maxV: 0, events: [] };
  var air = null, lastLandEv = null;
  var B = track.bounds;
  var obs = {
    name: 'stunt-sweep-observer',
    onEvent: function (e) {
      if (!e.isPlayer) return;
      if (e.type === 'takeoff' || e.type === 'drop') {
        if (e.type === 'drop' && e.speed > P.V_ADHERE + 3) rep.loopDrop.push({ s: +e.s.toFixed(1), v: +e.speed.toFixed(1) });
      } else if (e.type === 'land') { rep.landings++; lastLandEv = e; }
      else if (e.type === 'respawnStart') {
        var c = sess.player();
        var why = e.why;
        rep.respawns.push({ why: why, s: +c.s.toFixed(1), t: +e.t.toFixed(2) });
        if (why === 'fall' || why === 'lost') {
          rep.falls++;
          if (air && air.under) rep.fallThrough.push({ s: air.under.s, h: air.under.h, lat: air.under.lat, from: +air.s0.toFixed(1), v0: air.v0 });
          var pr = track.project([c.px, c.py, c.pz], { surfaceOnly: true, maxDist: 6, lateralMargin: 0 });
          if (pr && pr.height < 0.5 && pr.height > -3) rep.roadUnder.push({ s: +pr.s.toFixed(1), h: +pr.height.toFixed(2), lat: +pr.lateral.toFixed(2) });
        } else if (why === 'stuck' || why === 'wrongWay') rep.stuck.push({ why: why, s: +c.s.toFixed(1) });
      }
    },
    postStep: function (c, dt) {
      if (!c.isPlayer) return;
      if (Math.abs(c.v) > rep.maxV) rep.maxV = Math.abs(c.v);
      if (c.mode === 'air') {
        if (!air) air = { s0: c.takeoffS, d0: c.dist, path: 0, under: null, v0: +Math.abs(c.v).toFixed(1), p: [c.px, c.py, c.pz] };
        air.path += Math.hypot(c.px - air.p[0], c.py - air.p[1], c.pz - air.p[2]); air.p = [c.px, c.py, c.pz];
        var pr = track.project(air.p, { surfaceOnly: true, maxDist: 5, lateralMargin: 0, hintS: c.airS, window: 420 });
        if (pr && pr.height < -0.35 && pr.height > -4 && Math.abs(pr.lateral) < track.sample(pr.s).halfWidth - 0.3 && !air.under) {
          // just below a road we were above a moment ago (the previous sample was above it)
          if (air.prevAbove && air.prevAbove.index != null && Math.abs(V.wrapD(air.prevAbove.s - pr.s, L)) < 12) air.under = { s: +pr.s.toFixed(1), h: +pr.height.toFixed(2), lat: +pr.lateral.toFixed(2) };
        }
        air.prevAbove = pr && pr.height >= 0 ? pr : (air.prevAbove || null);
        if (c.py > B.max[1] + 60 || c.px < B.min[0] - 150 || c.px > B.max[0] + 150 || c.pz < B.min[2] - 150 || c.pz > B.max[2] + 150) {
          if (!air.launched) { air.launched = true; rep.launched.push({ s: +air.s0.toFixed(1), y: +c.py.toFixed(1) }); }
        }
      } else if (air) {
        if (c.mode === 'ground' && lastLandEv) {
          var dd = c.dist - air.d0;
          if (Math.abs(dd - air.path) > Math.max(25, air.path * 0.5)) rep.wrongAttach.push({ from: +air.s0.toFixed(1), to: +c.s.toFixed(1), flown: +air.path.toFixed(1), progress: +dd.toFixed(1) });
        }
        air = null; lastLandEv = null;
      }
    }
  };
  var sess = CB.arcade.mode.createSession({
    trackId: o.map, laps: o.laps, mode: 'race', opponents: 0, countdown: false, seed: o.seed, playerBuild: build, build: build,
    hooks: [obs], arcade: { options: { items: true, nitro: true } }
  });
  var gpInst = (sess.arcade.instances || []).filter(function (i) { return i.id === 'gameplay'; })[0];
  var gp = gpInst ? gpInst.gameplay : null;
  var plan = S.ai.plan(track), drive = P.resolveDrive({});
  var rng = mulberry(o.seed * 7919 + 1), dtf = DT[o.dt] || DT.hz60;
  var budget = o.timeout_s || (track.def.estLap_s || 55) * o.laps * (o.speed === 'crawl' ? 4 : o.speed === 'slow' || o.speed === 'coast' ? 2.6 : 2.0) + 20;
  var t = 0, k = 0, lastGapUsed = -1, lastHit = -1;
  var phaseOffset = rng() * 100;
  while (t < budget) {
    var c = sess.player();
    var sm = track.sample(c.s), v = c.v;
    var hwUse = Math.max(0, sm.halfWidth - P.HALF_W - 0.15);
    var latT = clamp(o.lat, -1, 1) * hwUse + (o.wobble ? o.wobble * Math.sin((c.dist + phaseOffset) / 23) : 0);
    latT = clamp(latT, -hwUse, hwUse);
    var gapA = track.gapAhead(c.s, 70);
    var inp = { throttle: o.throttle, brake: 0, steer: 0, nitro: false, handbrake: false };
    // ---- speed profile
    var pi = Math.round(c.s / track.DS) % track.N;
    if (o.speed === 'slow') { if (v > 24) inp.throttle = 0; }
    else if (o.speed === 'crawl') { if (v > 13) inp.throttle = 0; }
    else if (o.speed === 'coast') { if (gapA && gapA.dist < 45) inp.throttle = 0; }
    else if (o.speed === 'lift') { if (gapA && gapA.dist < 25) inp.throttle = 0; }
    else if (o.speed === 'brakeGap') { if (gapA && gapA.dist < 60 && v > 20) { inp.throttle = 0; inp.brake = 1; } }
    else if (o.speed === 'human') { if (v > plan.speed[pi] * 1.08) { inp.throttle = 0; if (v > plan.speed[pi] * 1.2) inp.brake = 0.7; } }
    // ---- boosts / items
    if (o.boost === 'nitro') inp.nitro = true;
    if (gp && o.boost === 'mega' && k % 400 === 50) { gp.giveItem('player', 'mega'); gp.useItem('player'); }
    if (gp && (o.boost === 'megaGap' || o.boost === 'hit') && gapA && gapA.dist < 55 && gapA.dist > 20 && lastGapUsed !== gapA.gap.s0) {
      lastGapUsed = gapA.gap.s0;
      if (o.boost === 'megaGap') { gp.giveItem('player', 'mega'); gp.useItem('player'); inp.nitro = true; }
      else gp.hitCar('player', ['rocket', 'oil', 'lightning'][lastHit = (lastHit + 1) % 3], 'ai1');
    }
    if (o.boost === 'megaGap' && gapA && gapA.dist < 55) inp.nitro = true;
    // ---- steering
    if (c.mode === 'ground') {
      var psiDes = clamp(0.22 * (latT - c.lat), -0.35, 0.35);
      var yawDes = sm.kLeft * v + 3.2 * (psiDes - c.psi);
      var st = drive.steerFor ? drive.steerFor(c.drive, yawDes, v, { bank: sm.bank }) : clamp(yawDes * 0.2, -1, 1);
      if (o.keyboard) st = Math.abs(st) > 0.35 ? (st > 0 ? 1 : -1) : 0;
      inp.steer = st;
    } else if (c.mode === 'air') {
      if (o.air === 'left') inp.steer = 1;
      else if (o.air === 'right') inp.steer = -1;
      else if (o.air === 'wiggle') inp.steer = Math.sin(t * 9) > 0 ? 1 : -1;
      else if (o.air === 'lift') inp.throttle = 0;
      else if (o.air === 'brake') { inp.throttle = 0; inp.brake = 1; }
      else if (o.air === 'handbrake') inp.handbrake = true;
    }
    if (gpInst && gpInst._layer) { gpInst._layer.keys.nitro = inp.nitro; }
    if (gp) gp.setInput({ nitro: inp.nitro });
    var dt = dtf(k, rng);
    sess.update(dt, inp);
    t += dt; k++;
    if (sess.getPhase() === 'finished') { rep.finished = true; rep.time = +t.toFixed(1); break; }
  }
  var pc = sess.player();
  rep.progress = +(pc.dist / (L * o.laps)).toFixed(3);
  rep.maxV = +rep.maxV.toFixed(1);
  return rep;
}

/** Profile list: full sweep (quick = a reduced deterministic subset for CI). */
function profiles(map, quick) {
  var out = [];
  var lats = quick ? [-0.9, 0, 0.9] : [-1, -0.6, -0.25, 0, 0.3, 0.65, 1];
  var speeds = quick ? [['full', 'none'], ['full', 'megaGap'], ['lift', 'none']] :
    [['full', 'none'], ['full', 'nitro'], ['full', 'mega'], ['full', 'megaGap'], ['full', 'hit'], ['human', 'none'], ['lift', 'none'], ['coast', 'none'], ['slow', 'none'], ['brakeGap', 'none'], ['full', 'pads']];
  var airs = quick ? ['none', 'left', 'right'] : ['none', 'left', 'right', 'lift', 'brake', 'handbrake', 'wiggle'];
  var builds = quick ? ['hatch', 'pickup', 'hyper'] : ['hatch', 'suv', 'pickup', 'van', 'hyper', 'ehyper', 'eco', 'touge'];
  var dts = quick ? ['hz60', 'spiky'] : ['hz30', 'hz60', 'hz120', 'hz144', 'spiky', 'slow'];
  var n = 0;
  // a structured cartesian core (lateral x speed) plus rotating secondary dimensions so every value is covered
  lats.forEach(function (lat) {
    speeds.forEach(function (sp) {
      var i = n++;
      out.push({ map: map, lat: lat, speed: sp[0], boost: sp[1], air: airs[(i * 3 + 1) % airs.length],
        build: builds[(i * 5 + 2) % builds.length], dt: dts[(i * 7 + 3) % dts.length], keyboard: i % 3 === 0, wobble: i % 4 === 1 ? 2.5 : 0, seed: 11 + i });
    });
  });
  return out;
}

function summarize(reps) {
  var s = { runs: reps.length, falls: 0, fallThrough: 0, roadUnder: 0, wrongAttach: 0, launched: 0, stuck: 0, loopDrop: 0, unfinished: 0 };
  reps.forEach(function (r) {
    s.falls += r.falls; s.fallThrough += r.fallThrough.length; s.roadUnder += r.roadUnder.length; s.wrongAttach += r.wrongAttach.length;
    s.launched += r.launched.length; s.stuck += r.stuck.length; s.loopDrop += r.loopDrop.length; if (!r.finished) s.unfinished++;
  });
  return s;
}
function bad(r) { return r.fallThrough.length || r.roadUnder.length || r.wrongAttach.length || r.launched.length || r.stuck.length || r.loopDrop.length || !r.finished; }

function sweep(maps, quick, onRun) {
  var all = {};
  maps.forEach(function (m) {
    all[m] = profiles(m, quick).map(function (p) { var r = runCase(p); r.profile = p; if (onRun) onRun(r); return r; });
  });
  return all;
}

if (require.main === module) {
  var args = process.argv.slice(2);
  var mi = args.indexOf('--map'), maps = mi >= 0 ? args[mi + 1].split(',') : MAPS;
  var quick = args.indexOf('--quick') >= 0, verbose = args.indexOf('--verbose') >= 0, asJson = args.indexOf('--json') >= 0;
  var t0 = Date.now();
  var res = sweep(maps, quick, function (r) {
    if (verbose || bad(r)) {
      var p = r.profile;
      console.log((bad(r) ? 'BAD ' : 'ok  ') + p.map + ' lat=' + p.lat + ' ' + p.speed + '/' + p.boost + ' air=' + p.air + ' ' + p.build + ' ' + p.dt + (p.keyboard ? ' kb' : '') +
        ' | fin=' + r.finished + ' t=' + r.time + ' prog=' + r.progress + ' falls=' + r.falls + ' maxV=' + r.maxV +
        (r.fallThrough.length ? ' FT=' + JSON.stringify(r.fallThrough) : '') + (r.roadUnder.length ? ' RU=' + JSON.stringify(r.roadUnder) : '') +
        (r.wrongAttach.length ? ' WA=' + JSON.stringify(r.wrongAttach) : '') + (r.launched.length ? ' LA=' + JSON.stringify(r.launched) : '') +
        (r.stuck.length ? ' ST=' + JSON.stringify(r.stuck) : '') + (r.loopDrop.length ? ' LD=' + JSON.stringify(r.loopDrop) : '') +
        (r.falls ? ' RS=' + JSON.stringify(r.respawns.filter(function (x) { return x.why === 'fall' || x.why === 'lost'; })) : ''));
    }
  });
  console.log('\nsummary (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  Object.keys(res).forEach(function (m) { console.log('  ' + m.padEnd(20) + JSON.stringify(summarize(res[m]))); });
  if (asJson) fs.writeFileSync(asJson && args[args.indexOf('--json') + 1] || 'sweep.json', JSON.stringify(res));
}

module.exports = { load: load, runCase: runCase, profiles: profiles, sweep: sweep, summarize: summarize, bad: bad, MAPS: MAPS, BUILDS: BUILDS, DT: DT };

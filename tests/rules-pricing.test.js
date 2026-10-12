/* FORGE Atelier — CB.rules + CB.pricing tests. Run: node tests/run.js rules */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

require('../js/util.js');
const D = require('../js/data.js');
const S = require('../js/state.js');
const R = require('../js/rules.js');
const PR = require('../js/pricing.js');
const U = globalThis.CB.util;

const SECTIONS = ['base', 'body', 'engine', 'transmission', 'drivetrain', 'suspension', 'brakes', 'wheels', 'aero', 'weight', 'exterior', 'interior', 'tech'];

/** Same semantics as CB.state.patch(). */
function applyPatch(build, patch) {
  return S.normalize(U.deepMerge(build, patch), { paths: S.leafPaths(patch), prev: build });
}
/** Normalized build from a partial (deep-merged onto the default build). */
/* Rule scenarios are calibrated on the front-engined 4.0 V8 reference coupe (CB.data.referenceBuild), not on whatever
   the catalog default is (now a 3.0 flat-six 911). */
function refBuild() { return (D.referenceBuild || D.defaultBuild)(); }
function nb(partial) { return S.normalize(U.deepMerge(refBuild(), partial || {})); }
/** Raw (un-normalized) build: default normalized build with raw overrides — exercises integrity rules. */
function raw(partial) { return U.deepMerge(S.normalize(refBuild()), partial || {}); }

/** Seeded PRNG (mulberry32) for reproducible fuzzing. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomBuild(rand) {
  let b = D.defaultBuild();
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  Object.keys(D.pathCollections).forEach((path) => {
    if (rand() < 0.55) b = U.set(b, path, pick(D.list(D.pathCollections[path])).id);
  });
  Object.keys(D.ranges).forEach((path) => {
    if (path === 'transmission.ratio' || rand() < 0.5) return;
    const r = D.ranges[path];
    const steps = Math.round((r.max - r.min) / r.step);
    b = U.set(b, path, U.round(r.min + Math.floor(rand() * (steps + 1)) * r.step, 3));
  });
  ['transmission.launchControl', 'drivetrain.torqueVectoring', 'aero.canards', 'aero.sideSkirts', 'aero.activeAero', 'weight.soundDeadening',
    'weight.rearSeats', 'weight.spareTire', 'wheels.staggered', 'interior.ambientLighting', 'interior.harness', 'tech.digitalCluster', 'tech.hud',
    'tech.telemetry', 'tech.liftSystem', 'tech.nightVision'].forEach((p) => { if (rand() < 0.4) b = U.set(b, p, rand() < 0.5); });
  if (rand() < 0.3) b = U.set(b, 'exterior.livery_number', String(Math.floor(rand() * 99)));
  return S.normalize(b);
}

/* ======================================================================
   RULES — catalogue
   ====================================================================== */
test('rules: catalogue has 50+ uniquely-identified rules covering every section', () => {
  const list = R.list();
  assert.ok(list.length >= 50, 'only ' + list.length + ' rules');
  assert.equal(new Set(list.map((r) => r.id)).size, list.length, 'duplicate rule ids');
  const secs = new Set(list.map((r) => r.section));
  ['body', 'engine', 'transmission', 'drivetrain', 'suspension', 'brakes', 'wheels', 'aero', 'weight', 'exterior', 'interior', 'tech']
    .forEach((s) => assert.ok(secs.has(s), 'no rules for section ' + s));
  list.forEach((r) => assert.ok(['error', 'warning', 'info'].includes(r.severity), r.id));
  assert.equal(R.count, list.length);
});

test('rules: issues have the contract shape', () => {
  const issues = R.validate(nb({ tires: { compound: 'slick' }, brakes: { abs: 'off' } }));
  assert.ok(issues.length > 0);
  issues.forEach((i) => {
    assert.equal(typeof i.id, 'string');
    assert.ok(['error', 'warning', 'info'].includes(i.severity));
    assert.ok(SECTIONS.includes(i.section) && i.section !== 'base', 'bad section ' + i.section);
    assert.equal(typeof i.message, 'string');
    assert.ok(i.message.length > 10);
    if (i.fix) { assert.equal(typeof i.fix.label, 'string'); assert.ok(U.isPlainObject(i.fix.patch)); }
  });
  // sorted errors → warnings → info
  const rank = { error: 0, warning: 1, info: 2 };
  for (let k = 1; k < issues.length; k++) assert.ok(rank[issues[k - 1].severity] <= rank[issues[k].severity]);
});

/* ======================================================================
   RULES — presets and default
   ====================================================================== */
test('rules: the default build has no errors and is street legal', () => {
  const b = S.normalize(D.defaultBuild());
  const errs = R.validate(b).filter((i) => i.severity === 'error');
  assert.deepEqual(errs.map((e) => e.id), []);
  assert.equal(R.legality(b).streetLegal, true);
});

test('rules: no preset in data.js has a validation error', () => {
  const report = [];
  D.presets.forEach((p) => {
    const b = S.normalize(D.presetBuild(p.id));
    R.validate(b).filter((i) => i.severity === 'error').forEach((e) => report.push(p.id + ': ' + e.id + ' — ' + e.message));
  });
  assert.deepEqual(report, [], 'preset errors:\n' + report.join('\n'));
});

test('rules: track presets are flagged not street legal, road presets are legal', () => {
  const tw = R.legality(S.normalize(D.presetBuild('track-weapon')));
  assert.equal(tw.streetLegal, false);
  assert.ok(tw.reasons.length >= 1 && tw.reasons.every((r) => typeof r === 'string'));
  assert.ok(tw.reasons.some((r) => /tyre|tire|slick/i.test(r)));
  assert.equal(tw.trackOnly, true);
  ['alpine-gt', 'hot-hatch', 'overland', 'eco-commuter', 'super-wagon', 'atelier-shuttle'].forEach((id) => {
    const l = R.legality(S.normalize(D.presetBuild(id)));
    assert.equal(l.streetLegal, true, id + ': ' + l.reasons.join('; '));
  });
});

/* ======================================================================
   RULES — targeted scenarios: each triggers its rule and the fix resolves it
   ====================================================================== */
const SCENARIOS = [
  // spec examples
  ['body.w16-chassis', () => raw({ body: { style: 'sedan' }, engine: { layout: 'W16', displacement_l: 8.0, position: 'front' } })],
  ['engine.w16-position', () => nb({ engine: { layout: 'W16', displacement_l: 8.0, aspiration: 'quad-turbo', position: 'front' }, transmission: { type: 'auto' } })],
  ['body.hatch-big-engine', () => nb({ body: { style: 'hatchback', doors: 3, seats: 4 }, engine: { layout: 'V12', displacement_l: 6.0, aspiration: 'na', boost_bar: 0, compression: 11 } })],
  ['drivetrain.fwd-torque-steer', () => nb({ body: { style: 'hatchback', doors: 5, seats: 5 }, drivetrain: { layout: 'fwd' }, transmission: { type: 'auto' } })],
  ['engine.diesel-redline', () => raw({ engine: { fuel: 'diesel', redline_rpm: 7000, compression: 14 } })],
  ['engine.e85-low-compression', () => nb({ engine: { fuel: 'e85', aspiration: 'na', boost_bar: 0, compression: 10 } })],
  ['tires.slicks', () => nb({ tires: { compound: 'slick' } })],
  ['suspension.macpherson-ride-height', () => raw({ suspension: { type: 'macpherson', rideHeight_mm: 60 } })],
  ['brakes.material-wheel', () => nb({ brakes: { material: 'carbon-ceramic', frontRotor_mm: 330, rearRotor_mm: 300 }, wheels: { diameter_in: 18, widthFront_in: 9, widthRear_in: 10.5 } })],
  ['brakes.front-rotor-fit', () => nb({ brakes: { frontRotor_mm: 400, rearRotor_mm: 300 }, wheels: { diameter_in: 17 }, tires: { profileFront: 45, profileRear: 40 } })],
  ['brakes.rear-rotor-fit', () => nb({ brakes: { frontRotor_mm: 330, rearRotor_mm: 330 }, wheels: { diameter_in: 15 }, tires: { profileFront: 50, profileRear: 50 } })],
  ['wheels.tire-rim-front', () => nb({ wheels: { widthFront_in: 6, staggered: true }, tires: { widthFront_mm: 305 } })],
  ['wheels.tire-rim-rear', () => nb({ wheels: { widthRear_in: 13, staggered: true }, tires: { widthRear_mm: 225 } })],
  ['weight.cage-rear-seats', () => nb({ weight: { rollCage: 'full' }, body: { seats: 4 } })],
  ['engine.ev-exhaust', () => nb({ engine: { type: 'ev', exhaust: 'titanium' }, transmission: { type: 'single-speed' } })],
  ['body.engine-position', () => raw({ body: { style: 'pickup', doors: 4, seats: 5, wheelbase_mm: 3400 }, engine: { position: 'mid' } })],
  // body
  ['body.doors', () => raw({ body: { doors: 5 } })],
  ['body.seats', () => raw({ body: { seats: 7 } })],
  ['body.wheelbase-range', () => raw({ body: { wheelbase_mm: 3500 } })],
  ['body.hypercar-chassis', () => nb({ body: { style: 'hypercar', chassisMaterial: 'steel' } })],
  ['body.rollover-track', () => nb({ body: { style: 'suv', doors: 5, seats: 5, trackWidth_mm: 1450 } })],
  ['body.short-wheelbase-mid', () => nb({ body: { style: 'roadster', wheelbase_mm: 2300 }, engine: { position: 'mid' } })],
  ['body.monocoque-cage', () => nb({ body: { chassisMaterial: 'carbon-monocoque', seats: 2 }, weight: { rollCage: 'full' }, interior: { harness: true } })],
  ['catalog.unknown-option:engine.layout', () => raw({ engine: { layout: 'V20' } })],
  ['catalog.unknown-option:exterior.finish', () => raw({ exterior: { finish: 'velvet' } })],
  // engine
  ['engine.displacement-range', () => raw({ engine: { displacement_l: 9.9 } })],
  ['engine.boost-na', () => raw({ engine: { aspiration: 'na', boost_bar: 1.0, compression: 10 } })],
  ['engine.boost-max', () => raw({ engine: { aspiration: 'supercharged', boost_bar: 2.5, compression: 8 } })],
  ['engine.rotary-diesel', () => nb({ engine: { layout: 'rotary-2', displacement_l: 1.3, fuel: 'diesel', compression: 14, redline_rpm: 5000 }, body: { seats: 2 } })],
  ['engine.diesel-compression', () => nb({ engine: { fuel: 'diesel', compression: 10, redline_rpm: 5000, aspiration: 'turbo' } })],
  ['engine.knock', () => nb({ engine: { compression: 13, boost_bar: 1.5, fuel: 'regular' } })],
  ['engine.knock', () => nb({ engine: { compression: 14, aspiration: 'quad-turbo', boost_bar: 3.0, fuel: 'premium' } })],
  ['engine.knock-margin', () => nb({ engine: { compression: 10.2, boost_bar: 1.25, fuel: 'premium' } })],
  ['engine.redline-valvetrain', () => nb({ engine: { layout: 'I4', displacement_l: 2.0, redline_rpm: 9500, aspiration: 'na', boost_bar: 0 } })],
  ['engine.supercharger-rpm', () => nb({ engine: { aspiration: 'supercharged', boost_bar: 0.6, redline_rpm: 8800 } })],
  ['engine.tune-fuel', () => nb({ engine: { tune: 'stage2', fuel: 'regular', compression: 9, boost_bar: 0.8 } })],
  ['engine.tune-cooling', () => nb({ engine: { tune: 'stage3', cooling: 'standard' } })],
  ['engine.tune-cooling', () => nb({ engine: { tune: 'time-attack', cooling: 'uprated' } })],
  ['engine.power-cooling', () => nb({ engine: { layout: 'V12', displacement_l: 7.3, aspiration: 'twin-turbo', boost_bar: 1.5, compression: 9, cooling: 'standard' }, transmission: { type: 'auto' } })],
  ['engine.tune-na', () => nb({ engine: { aspiration: 'na', boost_bar: 0, tune: 'stage2', compression: 11 } })],
  ['engine.straight-pipe', () => nb({ engine: { exhaust: 'straight-pipe' } })],
  ['engine.diesel-tune', () => nb({ engine: { fuel: 'diesel', compression: 14, redline_rpm: 5000, tune: 'time-attack', cooling: 'race' } })],
  ['engine.w16-aspiration', () => nb({ body: { style: 'hypercar' }, engine: { layout: 'W16', displacement_l: 8.0, aspiration: 'na', boost_bar: 0, position: 'mid', compression: 11 }, transmission: { type: 'auto' } })],
  ['engine.battery-power', () => nb({ engine: { type: 'ev', motors: 4, motorPower_kw: 500, battery_kwh: 60, chemistry: 'lfp' }, transmission: { type: 'single-speed' }, drivetrain: { layout: 'awd' } })],
  ['engine.battery-power', () => nb({ engine: { type: 'hybrid', motors: 2, motorPower_kw: 500, battery_kwh: 2, chemistry: 'lfp' } })],
  ['engine.ev-voltage', () => nb({ engine: { type: 'ev', motors: 4, motorPower_kw: 200, battery_kwh: 150, chemistry: 'nca', voltage: 400 }, transmission: { type: 'single-speed' }, drivetrain: { layout: 'awd' } })],
  ['engine.battery-range', () => raw({ engine: { type: 'hybrid', battery_kwh: 80 }, transmission: { type: 'dct' } })],
  ['engine.motors-range', () => raw({ engine: { type: 'hybrid', motors: 4, battery_kwh: 8 } })],
  ['engine.ev-small-pack', () => nb({ body: { style: 'suv', doors: 5, seats: 7 }, engine: { type: 'ev', battery_kwh: 35, motors: 2 }, transmission: { type: 'single-speed' }, weight: { ballast_kg: 100 } })],
  ['engine.battery-peak', () => nb({ engine: { type: 'ev', motors: 2, motorPower_kw: 200, battery_kwh: 45, chemistry: 'nmc' }, transmission: { type: 'single-speed' } })],
  // transmission
  ['transmission.single-speed-ice', () => raw({ transmission: { type: 'single-speed', gears: 1, ratios: [2.65] } })],
  ['transmission.gears-range', () => raw({ transmission: { gears: 12 } })],
  ['transmission.ratios', () => raw({ transmission: { ratios: [3.8, 2.6, 2.9, 1.45, 1.15, 0.95, 0.78] } })],
  ['transmission.torque-limit', () => nb({ transmission: { type: 'manual' }, engine: { tune: 'stage1' } })],
  ['transmission.torque-overload', () => nb({ engine: { type: 'ice', layout: 'V8', displacement_l: 4.0, aspiration: 'twin-turbo', boost_bar: 1.8, compression: 8.5, fuel: 'race', tune: 'stage3', cooling: 'race' }, transmission: { type: 'cvt' } })],
  ['transmission.ev-gearbox', () => nb({ engine: { type: 'ev' }, transmission: { type: 'dct' } })],
  ['transmission.tall-first', () => nb({ transmission: { finalDrive: 2.5, ratios: [2.6, 2.0, 1.6, 1.3, 1.1, 0.95, 0.78] } })],
  ['transmission.gearing-top-speed', () => nb({ transmission: { finalDrive: 5.5 } })],
  ['transmission.manual-autonomy', () => nb({ transmission: { type: 'manual' }, tech: { adas: 'pilot' }, engine: { tune: 'eco' } })],
  ['transmission.sequential-comfort', () => nb({ transmission: { type: 'sequential' }, interior: { seatType: 'comfort' } })],
  ['transmission.launch-manual', () => nb({ transmission: { type: 'manual', launchControl: true } })],
  // drivetrain
  ['drivetrain.fwd-engine-position', () => nb({ engine: { position: 'mid' }, drivetrain: { layout: 'fwd' } })],
  ['drivetrain.ev-single-motor-awd', () => nb({ engine: { type: 'ev', motors: 1, motorPower_kw: 150, battery_kwh: 75 }, drivetrain: { layout: 'awd' } })],
  ['drivetrain.ev-multi-motor-2wd', () => nb({ engine: { type: 'ev', motors: 3, motorPower_kw: 150, battery_kwh: 100 }, drivetrain: { layout: 'rwd' } })],
  ['drivetrain.torque-vectoring', () => nb({ drivetrain: { torqueVectoring: true, rearDiff: 'open' } })],
  ['drivetrain.driven-axle-diff:rear', () => raw({ drivetrain: { rearDiff: 'none' } })],
  ['drivetrain.driven-axle-diff:center', () => raw({ drivetrain: { layout: 'awd', torqueSplitFront_pct: 40, centerDiff: 'none' } })],
  ['drivetrain.split-range', () => raw({ drivetrain: { torqueSplitFront_pct: 30 } })],
  ['drivetrain.locking-road:rearDiff', () => nb({ drivetrain: { rearDiff: 'locking' } })],
  ['drivetrain.open-diff-power:rear', () => nb({ drivetrain: { rearDiff: 'open' }, engine: { tune: 'stage1' } })],
  ['drivetrain.tc-off', () => nb({ drivetrain: { tractionControl: 0 }, engine: { tune: 'stage2' }, transmission: { type: 'auto' } })],
  ['drivetrain.rwd-power', () => nb({ engine: { tune: 'stage3', cooling: 'uprated' }, transmission: { type: 'auto' }, drivetrain: { tractionControl: 1 } })],
  ['drivetrain.awd-bias', () => nb({ engine: { position: 'mid' }, drivetrain: { layout: 'awd', torqueSplitFront_pct: 70 } })],
  // suspension
  ['suspension.ride-height-range', () => raw({ suspension: { type: 'pushrod', rideHeight_mm: 200 } })],
  ['suspension.offroad-clearance', () => nb({ body: { style: 'suv', doors: 5, seats: 5 }, suspension: { type: 'coilover-track', rideHeight_mm: 100 } })],
  ['suspension.low-ride', () => nb({ suspension: { type: 'pushrod', rideHeight_mm: 60 } })],
  ['suspension.camber-extreme:front', () => nb({ suspension: { camberFront_deg: -4.5 } })],
  ['suspension.camber-extreme:rear', () => nb({ suspension: { camberRear_deg: -4.0 } })],
  ['suspension.positive-camber:front', () => nb({ suspension: { camberFront_deg: 0.5 } })],
  ['suspension.rear-toe-out', () => nb({ suspension: { toeRear_deg: -0.2 } })],
  ['suspension.toe-wear', () => nb({ suspension: { toeFront_deg: 0.45 } })],
  ['suspension.soft-heavy', () => nb({ body: { style: 'suv', doors: 5, seats: 7 }, suspension: { type: 'multilink', springFront_nmm: 30, springRear_nmm: 30 } })],
  ['suspension.underdamped', () => nb({ suspension: { damping: 1, springFront_nmm: 200, springRear_nmm: 200 } })],
  ['suspension.lift-air', () => nb({ suspension: { type: 'air' }, tech: { liftSystem: true } })],
  ['suspension.track-offroad', () => nb({ body: { style: 'pickup', doors: 4, seats: 5 }, suspension: { type: 'pushrod', rideHeight_mm: 140 } })],
  ['suspension.spring-balance', () => nb({ suspension: { springFront_nmm: 200, springRear_nmm: 60 } })],
  ['suspension.aero-springs', () => nb({ aero: { splitter: 'race', wing: 'biplane', wingAngle_deg: 12, diffuser: 'race' }, suspension: { springFront_nmm: 40, springRear_nmm: 45 } })],
  // brakes
  ['brakes.rear-bias', () => nb({ brakes: { frontRotor_mm: 330, rearRotor_mm: 380 } })],
  ['brakes.piston-bias', () => nb({ brakes: { frontPistons: 2, rearPistons: 6 } })],
  ['brakes.undersized', () => nb({ brakes: { frontRotor_mm: 300, rearRotor_mm: 290 } })],
  ['brakes.fade', () => nb({ tires: { compound: 'track' } })],
  ['brakes.abs-off', () => nb({ brakes: { abs: 'off' }, tech: { adas: 'none' } })],
  ['brakes.ceramic-winter', () => nb({ brakes: { material: 'carbon-ceramic' }, tires: { compound: 'winter' } })],
  // wheels & tyres
  ['wheels.arch-clearance', () => nb({ wheels: { diameter_in: 22 }, tires: { profileFront: 50, profileRear: 50 } })],
  ['wheels.rolling-diameter-awd', () => nb({ drivetrain: { layout: 'awd' }, tires: { profileFront: 45, profileRear: 30 } })],
  ['tires.grip-power', () => nb({ tires: { compound: 'eco' } })],
  ['wheels.fwd-stagger', () => nb({ body: { style: 'hatchback', doors: 5, seats: 5 }, engine: { layout: 'I4', displacement_l: 2.0, aspiration: 'turbo' }, drivetrain: { layout: 'fwd' }, wheels: { staggered: true } })],
  ['wheels.steel-size', () => nb({ wheels: { material: 'steel', diameter_in: 20 } })],
  ['wheels.beadlock', () => nb({ wheels: { design: 'beadlock' } })],
  ['wheels.centerlock-material', () => nb({ wheels: { design: 'centerlock-race', material: 'cast' } })],
  ['wheels.rubber-band', () => nb({ wheels: { diameter_in: 22 }, tires: { profileFront: 25, profileRear: 25 } })],
  ['wheels.aero-cooling', () => nb({ wheels: { design: 'aero-disc' }, tires: { compound: 'track' } })],
  // aero
  ['aero.wing-no-splitter', () => nb({ aero: { wing: 'gt-wing', splitter: 'none' } })],
  ['aero.balance', () => nb({ aero: { wing: 'biplane', wingAngle_deg: 14, splitter: 'lip' } })],
  ['aero.wing-angle', () => nb({ aero: { wing: 'gt-wing', splitter: 'race', wingAngle_deg: 19 } })],
  ['aero.canards-no-splitter', () => nb({ aero: { canards: true, splitter: 'none' } })],
  ['aero.active-without-wing', () => nb({ aero: { activeAero: true, wing: 'none' } })],
  ['aero.ev-drag', () => nb({ engine: { type: 'ev' }, aero: { wing: 'gt-wing', splitter: 'race' } })],
  ['aero.utility-wing', () => nb({ body: { style: 'van', doors: 5, seats: 7 }, aero: { wing: 'biplane', splitter: 'race' } })],
  // weight
  ['weight.cage-harness', () => nb({ weight: { rollCage: 'full' }, body: { seats: 2 }, interior: { harness: false } })],
  ['weight.ballast-front', () => nb({ weight: { ballast_kg: 60, ballastPosition: 'front' } })],
  ['weight.lithium-diesel', () => nb({ engine: { fuel: 'diesel', compression: 14, redline_rpm: 5000 }, weight: { battery: 'lithium' } })],
  ['weight.gross-mass', () => nb({ body: { style: 'van', doors: 5, seats: 9, wheelbase_mm: 3700 }, engine: { type: 'ev', battery_kwh: 200, chemistry: 'lfp', motors: 4, motorPower_kw: 150 }, drivetrain: { layout: 'awd' }, interior: { seatType: 'lounge' }, tech: { audio: 'concert' }, weight: { ballast_kg: 100 } })],
  ['weight.polycarbonate-tint', () => nb({ weight: { glass: 'polycarbonate' }, exterior: { windowTint_pct: 70 } })],
  ['weight.deadening-luxury', () => nb({ weight: { soundDeadening: false }, interior: { upholstery: 'semi-aniline' } })],
  // exterior
  ['exterior.tint', () => nb({ exterior: { windowTint_pct: 80 } })],
  ['exterior.contrast-roof-same', () => nb({ exterior: { roof: 'contrast', roofColor: '#b3121f' } })],
  ['exterior.stripe-invisible', () => nb({ exterior: { stripe: 'center', stripeColor: '#b3121f' } })],
  ['exterior.chrome-glare', () => nb({ exterior: { finish: 'chrome' } })],
  ['exterior.open-top-roof', () => nb({ body: { style: 'roadster', seats: 2 }, exterior: { roof: 'carbon' } })],
  ['exterior.livery-number', () => nb({ exterior: { livery_number: '7', stripe: 'hood' } })],
  ['exterior.halogen-power', () => nb({ exterior: { lights: 'halogen' } })],
  ['exterior.caliper-hidden', () => nb({ wheels: { design: 'aero-disc' }, exterior: { caliperColor: '#00d5ff' } })],
  // interior
  ['interior.harness-seats', () => nb({ interior: { harness: true, seatType: 'comfort' } })],
  ['interior.race-shell-harness', () => nb({ interior: { seatType: 'race-shell', harness: false } })],
  ['interior.lounge-fit', () => nb({ interior: { seatType: 'lounge' } })],
  ['interior.quick-release-airbag', () => nb({ interior: { steering: 'race-quick-release' } })],
  ['interior.yoke-manual', () => nb({ interior: { steering: 'yoke' }, transmission: { type: 'manual' }, engine: { tune: 'eco' } })],
  ['interior.open-top-headliner', () => nb({ body: { style: 'roadster', seats: 2 }, interior: { headliner: 'alcantara' } })],
  // tech
  ['tech.screen-delete-adas', () => nb({ tech: { screen_in: 0, adas: 'pilot' } })],
  ['tech.adas-abs', () => nb({ brakes: { abs: 'off' }, tech: { adas: 'assist' } })],
  ['tech.climate-zones', () => raw({ body: { seats: 2 }, tech: { climateZones: 4 } })],
  ['tech.lift-unnecessary', () => nb({ suspension: { rideHeight_mm: 180 }, tech: { liftSystem: true } })],
  ['tech.telemetry-suggest', () => nb({ tires: { compound: 'track' }, tech: { telemetry: false } })],
  ['tech.night-vision-halogen', () => nb({ exterior: { lights: 'halogen' }, tech: { nightVision: true } })],
  ['tech.l3-open-top', () => nb({ body: { style: 'roadster', seats: 2 }, tech: { adas: 'autonomous-l3' } })],
  ['tech.audio-straight-pipe', () => nb({ engine: { exhaust: 'straight-pipe' }, tech: { audio: 'concert' } })],
  ['tech.ev-no-display', () => nb({ engine: { type: 'ev' }, tech: { screen_in: 0, digitalCluster: false, hud: false, adas: 'assist' } })]
];

test('rules: ' + SCENARIOS.length + ' targeted scenarios trigger their rule; errors carry fixes that resolve them', () => {
  const triggered = new Set();
  SCENARIOS.forEach(([id, make]) => {
    const b = make();
    const issues = R.validate(b);
    const hit = issues.find((i) => i.id === id);
    assert.ok(hit, 'scenario did not trigger ' + id + ' — got ' + issues.map((i) => i.id).join(', '));
    triggered.add(hit.rule);
    if (hit.severity === 'error') assert.ok(hit.fix, 'error ' + id + ' has no fix');
    if (hit.fix) {
      const after = applyPatch(b, hit.fix.patch);
      const again = R.validate(after).map((i) => i.id);
      assert.ok(!again.includes(id), 'fix "' + hit.fix.label + '" did not resolve ' + id);
      // CB.rules.applyFix agrees with CB.state.patch semantics
      assert.deepEqual(R.applyFix(b, hit), after);
    }
  });
  assert.ok(triggered.size >= 100, 'scenarios cover only ' + triggered.size + ' rules');
});

test('rules: every rule in the catalogue is exercised by a scenario', () => {
  const covered = new Set(SCENARIOS.map(([id]) => id.split(':')[0]));
  const missing = R.list().map((r) => r.id).filter((id) => !covered.has(id));
  assert.deepEqual(missing, []);
});

test('rules: CB.state.patch applies a fix end-to-end', () => {
  S.replace(nb({ weight: { rollCage: 'full' }, body: { seats: 4 } }), { resetHistory: true });
  const iss = R.validate(S.get()).find((i) => i.id === 'weight.cage-rear-seats');
  assert.ok(iss && iss.fix);
  S.patch(iss.fix.patch, { label: 'Fix' });
  assert.ok(!R.validate(S.get()).some((i) => i.id === 'weight.cage-rear-seats'));
  assert.equal(S.get().body.seats, 2);
  S.reset({ resetHistory: true });
});

/* ======================================================================
   RULES — fuzzing: random valid builds and raw corruptions
   ====================================================================== */
test('rules: fuzz 300 random builds — every error has a fix, and every fix resolves its issue', () => {
  const rand = rng(20261003);
  let errors = 0, fixes = 0;
  const failures = [];
  for (let k = 0; k < 300; k++) {
    const b = randomBuild(rand);
    const issues = R.validate(b);
    issues.forEach((i) => {
      if (i.severity === 'error') { errors++; if (!i.fix) failures.push('#' + k + ' ' + i.id + ' has no fix: ' + i.message); }
      if (i.fix) {
        fixes++;
        const after = applyPatch(b, i.fix.patch);
        if (R.validate(after, null, { verifyFixes: false }).some((j) => j.id === i.id)) failures.push('#' + k + ' fix "' + i.fix.label + '" does not resolve ' + i.id);
      }
    });
  }
  assert.deepEqual(failures.slice(0, 15), [], failures.length + ' failures');
  assert.ok(errors > 20, 'fuzz produced too few errors (' + errors + ') to be meaningful');
  assert.ok(fixes > 200);
});

test('rules: fuzz raw (un-normalized) corruptions — integrity errors are always fixable', () => {
  const rand = rng(77);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const corruptions = [
    () => ({ body: { doors: pick([1, 3, 6]) } }), () => ({ body: { seats: pick([0, 3, 11]) } }), () => ({ body: { wheelbase_mm: pick([1800, 4200]) } }),
    () => ({ engine: { displacement_l: pick([0.2, 12]) } }), () => ({ engine: { aspiration: 'na', boost_bar: 2 } }),
    () => ({ engine: { fuel: 'diesel', redline_rpm: 9000 } }), () => ({ transmission: { gears: pick([0, 3, 14]) } }),
    () => ({ transmission: { ratios: [1, 2, 3] } }), () => ({ drivetrain: { torqueSplitFront_pct: pick([-10, 55, 120]) } }),
    () => ({ drivetrain: { rearDiff: 'none' } }), () => ({ suspension: { rideHeight_mm: pick([20, 400]) } }),
    () => ({ tech: { climateZones: pick([0, 9]) } }), () => ({ wheels: { design: 'hubcap' } }), () => ({ tires: { compound: 'balloon' } }),
    () => ({ body: { style: pick(['wagon', 'van', 'pickup']) }, engine: { position: 'mid' } }),
    () => ({ engine: { type: 'ev', motors: pick([0, 6]), battery_kwh: pick([5, 400]) } })
  ];
  const failures = [];
  for (let k = 0; k < 120; k++) {
    let b = randomBuild(rand);
    const n = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < n; j++) b = U.deepMerge(b, pick(corruptions)());
    const errs = R.validate(b).filter((i) => i.severity === 'error');
    errs.forEach((i) => {
      if (!i.fix) { failures.push(i.id + ' has no fix'); return; }
      const after = applyPatch(b, i.fix.patch);
      if (R.validate(after, null, { verifyFixes: false }).some((x) => x.id === i.id)) failures.push(i.id + ' unresolved by ' + i.fix.label);
    });
  }
  assert.deepEqual(failures.slice(0, 15), [], failures.length + ' failures');
});

test('rules: validate is defensive (garbage input never throws) and fast', () => {
  [null, undefined, 42, 'x', [], {}, { engine: null }, { body: { style: 'spaceship' } }].forEach((x) => {
    assert.doesNotThrow(() => R.validate(x));
    assert.doesNotThrow(() => R.legality(x));
    assert.ok(Array.isArray(R.validate(x)));
  });
  const b = S.normalize(D.presetBuild('track-weapon'));
  const t0 = Date.now();
  for (let k = 0; k < 50; k++) R.validate(b);
  assert.ok((Date.now() - t0) / 50 < 25, 'validate too slow');
});

test('rules: options filter by severity and section', () => {
  const b = nb({ tires: { compound: 'slick' }, weight: { rollCage: 'full' }, body: { seats: 4 } });
  const errs = R.validate(b, null, { severity: 'error' });
  assert.ok(errs.length && errs.every((i) => i.severity === 'error'));
  const wheels = R.validate(b, null, { section: 'wheels' });
  assert.ok(wheels.length && wheels.every((i) => i.section === 'wheels'));
});

/* ======================================================================
   LEGALITY
   ====================================================================== */
test('legality: each road-law violation is reported with a reason', () => {
  const cases = [
    [{ tires: { compound: 'slick' } }, /tyre/i],
    [{ engine: { exhaust: 'straight-pipe' } }, /noise|dB/i],
    [{ brakes: { abs: 'off' }, tech: { adas: 'none' } }, /anti-lock/i],
    [{ interior: { steering: 'race-quick-release' } }, /airbag/i],
    [{ exterior: { windowTint_pct: 70 } }, /tint/i],
    [{ engine: { tune: 'time-attack', cooling: 'race' } }, /emission/i]
  ];
  cases.forEach(([p, re]) => {
    const l = R.legality(nb(p));
    assert.equal(l.streetLegal, false, JSON.stringify(p));
    assert.ok(l.reasons.some((r) => re.test(r)), JSON.stringify(p) + ' → ' + l.reasons.join('; '));
    assert.ok(l.details.every((d) => d.id && d.message && d.section));
  });
  // EV ignores the exhaust entirely
  assert.equal(R.legality(nb({ engine: { type: 'ev', exhaust: 'straight-pipe' }, transmission: { type: 'single-speed' } })).streetLegal, true);
});

/* ======================================================================
   COMPATIBLE OPTIONS
   ====================================================================== */
test('compatibleOptions: returns a Set with per-option reasons', () => {
  const hatch = nb({ body: { style: 'hatchback', doors: 5, seats: 5 }, engine: { layout: 'I4', displacement_l: 2.0, aspiration: 'turbo', boost_bar: 1.2 } });
  const s = R.compatibleOptions(hatch, 'engine.layout');
  assert.ok(s instanceof Set);
  assert.ok(s.has('I4') && s.has('V6'));
  assert.ok(!s.has('V12') && !s.has('V10'));
  assert.equal(typeof s.V12, 'string');
  assert.ok(/hatchback/i.test(s.V12));
  assert.equal(s.I4, true);
  // collection-key form and swapped argument order
  const s2 = R.compatibleOptions(hatch, 'engineLayouts');
  assert.deepEqual([...s2].sort(), [...s].sort());
  const s3 = R.compatibleOptions('engine.layout', hatch);
  assert.deepEqual([...s3].sort(), [...s].sort());
});

test('compatibleOptions: gearbox, body and seat choices', () => {
  const ice = S.normalize(D.defaultBuild());
  const tr = R.compatibleOptions(ice, 'transmission.type');
  assert.ok(!tr.has('single-speed') && tr.has('dct') && tr.has('auto'));
  assert.equal(typeof tr['single-speed'], 'string');
  const ev = nb({ engine: { type: 'ev' }, transmission: { type: 'single-speed' } });
  assert.ok(R.compatibleOptions(ev, 'transmission.type').has('single-speed'));
  const w16 = nb({ body: { style: 'hypercar' }, engine: { layout: 'W16', displacement_l: 8.0, aspiration: 'quad-turbo', boost_bar: 1.8, position: 'mid' }, transmission: { type: 'auto' } });
  const bodies = R.compatibleOptions(w16, 'body.style');
  assert.ok(bodies.has('hypercar') && bodies.has('coupe'));
  assert.ok(!bodies.has('sedan') && !bodies.has('suv'));
  const caged = nb({ weight: { rollCage: 'full' }, body: { seats: 2 }, interior: { harness: true } });
  const seats = R.compatibleOptions(caged, 'body.seats');
  assert.ok(seats.has(2) && !seats.has(4));
  const st = R.optionStatus(ice, 'aero.wings');
  assert.equal(st.length, D.aero.wings.length);
  assert.ok(st.every((o) => typeof o.ok === 'boolean' && o.name));
});

/* ======================================================================
   PRICING
   ====================================================================== */
function checkPricing(p, label) {
  assert.ok(p && Array.isArray(p.lines) && p.lines.length > 40, label + ': lines');
  let sum = 0;
  const secs = {};
  p.lines.forEach((l) => {
    assert.ok(SECTIONS.includes(l.section), label + ': bad section ' + l.section);
    assert.equal(typeof l.label, 'string');
    assert.ok(Number.isInteger(l.amount), label + ': non-integer amount for ' + l.label);
    sum += l.amount; secs[l.section] = (secs[l.section] || 0) + l.amount;
  });
  assert.equal(p.subtotal, sum, label + ': subtotal != sum(lines)');
  assert.deepEqual(p.sections, secs);
  assert.equal(p.base + p.options, p.subtotal);
  assert.equal(p.msrp, p.subtotal + p.destination);
  assert.equal(p.total, Math.round(p.subtotal + p.destination + p.gasGuzzlerTax + p.luxuryTax - p.evCredit), label + ': total identity');
  assert.ok(p.evCredit >= 0 && p.gasGuzzlerTax >= 0 && p.luxuryTax >= 0 && p.destination > 0);
  assert.ok(Number.isInteger(p.buildTime_weeks) && p.buildTime_weeks >= 4 && p.buildTime_weeks <= 60);
  assert.ok(Number.isInteger(p.insuranceGroup) && p.insuranceGroup >= 1 && p.insuranceGroup <= 50);
  assert.equal(p.currency, 'USD');
  assert.doesNotThrow(() => JSON.stringify(p));
}

test('pricing: totals equal the sum of lines for the default build and every preset', () => {
  checkPricing(PR.compute(S.normalize(D.defaultBuild())), 'default');
  D.presets.forEach((pr) => checkPricing(PR.compute(S.normalize(D.presetBuild(pr.id))), pr.id));
});

test('pricing: totals identity holds over 200 random builds', () => {
  const rand = rng(4242);
  for (let k = 0; k < 200; k++) checkPricing(PR.compute(randomBuild(rand)), 'fuzz#' + k);
});

test('pricing: every option of the build is itemised', () => {
  const b = S.normalize(D.defaultBuild());
  const p = PR.compute(b);
  const paths = new Set(p.lines.map((l) => l.path));
  ['body.style', 'body.chassisMaterial', 'engine.layout', 'engine.aspiration', 'engine.fuel', 'engine.tune', 'engine.exhaust', 'engine.cooling',
    'transmission.type', 'drivetrain.layout', 'drivetrain.rearDiff', 'suspension.type', 'brakes.material', 'brakes.abs', 'wheels.design',
    'wheels.material', 'wheels.diameter_in', 'tires.widthFront_mm', 'aero.splitter', 'aero.wing', 'aero.diffuser', 'weight.glass', 'weight.battery',
    'weight.rollCage', 'exterior.paint', 'exterior.finish', 'exterior.roof', 'exterior.stripe', 'exterior.windowTint_pct', 'exterior.lights',
    'exterior.mirrors', 'exterior.badge', 'interior.seatType', 'interior.upholstery', 'interior.trim', 'interior.steering', 'interior.headliner',
    'tech.screen_in', 'tech.audio', 'tech.adas', 'tech.climateZones'].forEach((path) => assert.ok(paths.has(path), 'no line for ' + path));
  const base = p.lines.find((l) => l.section === 'base');
  assert.equal(base.amount, D.find('bodyStyles', 'coupe').basePrice);
  // selecting a priced option adds exactly its catalog price
  const p2 = PR.compute(S.set ? S.normalize(U.set(b, 'aero.wing', 'gt-wing'), { paths: ['aero.wing'], prev: b }) : b);
  assert.equal(p2.subtotal - p.subtotal, D.find('aero.wings', 'gt-wing').price);
  const p3 = PR.compute(applyPatch(b, { tech: { hud: true } }));
  assert.equal(p3.subtotal - p.subtotal, D.options.hud);
});

test('pricing: EV ignores exhaust and fuel; battery priced per kWh by chemistry', () => {
  const ev = nb({ engine: { type: 'ev', exhaust: 'titanium', fuel: 'race', battery_kwh: 100, chemistry: 'nmc', motors: 2, motorPower_kw: 200 }, transmission: { type: 'single-speed' } });
  const p = PR.compute(ev);
  assert.ok(!p.lines.some((l) => l.path === 'engine.exhaust' || l.path === 'engine.fuel'));
  const batt = p.lines.find((l) => l.path === 'engine.battery_kwh');
  assert.equal(batt.amount, 100 * D.find('batteryChemistries', 'nmc').pricePerKwh);
  assert.equal(p.gasGuzzlerTax, 0);
  assert.equal(p.fuelEconomy_mpg, null);
});

test('pricing: gas-guzzler schedule, light-truck exemption, luxury tax', () => {
  assert.equal(PR.gasGuzzlerFor(30), 0);
  assert.equal(PR.gasGuzzlerFor(22.5), 0);
  assert.equal(PR.gasGuzzlerFor(22.0), 1000);
  assert.equal(PR.gasGuzzlerFor(18.9), 2100);
  assert.equal(PR.gasGuzzlerFor(10), 7700);
  // thirsty coupe pays, the same drivetrain in an SUV is exempt
  const coupe = PR.compute(nb({ engine: { layout: 'V12', displacement_l: 7.3, aspiration: 'na', boost_bar: 0, compression: 11 } }));
  assert.ok(coupe.gasGuzzlerTax > 0);
  assert.equal(coupe.gasGuzzlerTax, PR.gasGuzzlerFor(coupe.fuelEconomy_mpg));
  const suv = PR.compute(nb({ body: { style: 'suv', doors: 5, seats: 5 }, engine: { layout: 'V12', displacement_l: 7.3, aspiration: 'na', boost_bar: 0, compression: 11 }, transmission: { type: 'auto' } }));
  assert.equal(suv.gasGuzzlerTax, 0);
  // physics metrics, when supplied, drive the tax
  const thirsty = PR.compute(S.normalize(D.defaultBuild()), { fuelEconomy_mpg: 12, power_hp: 600, weight_kg: 1600 });
  assert.equal(thirsty.gasGuzzlerTax, 7700);
  // luxury tax: 10% of MSRP above the threshold
  const C = PR.constants;
  [coupe, suv].forEach((p) => assert.equal(p.luxuryTax, Math.round(Math.max(0, p.msrp - C.luxuryThreshold) * C.luxuryRate)));
  const cheap = PR.compute(S.normalize(D.presetBuild('hot-hatch')));
  assert.equal(cheap.luxuryTax, 0);
});

test('pricing: clean-vehicle credit for an affordable EV, none above the cap', () => {
  const cheapEV = nb({
    body: { style: 'hatchback', doors: 5, seats: 5 },
    engine: { type: 'ev', motors: 1, motorPower_kw: 110, battery_kwh: 45, chemistry: 'lfp', voltage: 400, exhaust: 'stock', cooling: 'standard' },
    transmission: { type: 'single-speed', launchControl: false }, drivetrain: { layout: 'fwd', frontDiff: 'open' },
    suspension: { type: 'macpherson' }, brakes: { frontRotor_mm: 300, rearRotor_mm: 280, frontPistons: 1, rearPistons: 1, abs: 'standard' },
    wheels: { diameter_in: 17, widthFront_in: 7, widthRear_in: 7, staggered: false, material: 'cast' }, tires: { compound: 'eco', widthFront_mm: 205, widthRear_mm: 205, profileFront: 55, profileRear: 55 },
    aero: { splitter: 'none', diffuser: 'none', sideSkirts: false }, exterior: { finish: 'solid', lights: 'halogen', windowTint_pct: 0, paint: '#d40000' },
    interior: { seatType: 'comfort', upholstery: 'cloth', headliner: 'cloth', ambientLighting: false }, tech: { screen_in: 8, digitalCluster: false, audio: 'standard', climateZones: 1 }
  });
  const p = PR.compute(cheapEV);
  assert.ok(p.msrp <= PR.constants.creditCapCar, 'test EV too expensive: ' + p.msrp);
  assert.equal(p.evCredit, PR.constants.evCredit);
  checkPricing(p, 'cheap EV');
  const hyper = PR.compute(S.normalize(D.presetBuild('electric-hyper')));
  assert.equal(hyper.evCredit, 0);
  assert.ok(hyper.notes.some((n) => /cap/.test(n)));
});

test('pricing: hypercars take longer to build and insure higher than commuters', () => {
  const hyper = PR.compute(S.normalize(D.presetBuild('electric-hyper')));
  const eco = PR.compute(S.normalize(D.presetBuild('eco-commuter')));
  assert.ok(hyper.buildTime_weeks > eco.buildTime_weeks);
  assert.ok(hyper.insuranceGroup > eco.insuranceGroup + 15);
  assert.ok(hyper.total > eco.total * 3);
  assert.equal(hyper.buildTimeBreakdown.reduce((a, x) => a + x.weeks, 0) >= hyper.buildTime_weeks || hyper.buildTime_weeks === 60, true);
});

test('pricing: compute is defensive', () => {
  [undefined, null, {}, { engine: { type: 'warp' } }].forEach((x) => {
    const p = PR.compute(x);
    assert.ok(p && isFinite(p.total));
  });
});

/* ======================================================================
   FINANCE & LEASE
   ====================================================================== */
test('finance: known amortisation example ($30,000 at 6% APR over 60 months)', () => {
  const f = PR.finance(30000, { apr: 6, months: 60 });
  assert.ok(Math.abs(f.monthly - 579.98) < 0.01, 'monthly ' + f.monthly);
  assert.ok(Math.abs(f.totalInterest - 4799.04) < 0.05, 'interest ' + f.totalInterest);
  assert.equal(f.schedule.length, 60);
  assert.ok(Math.abs(f.schedule[0].interest - 150) < 1e-9);          // 30000 × 0.5%
  assert.ok(Math.abs(f.schedule[0].principal - 429.98) < 0.01);
  assert.equal(f.schedule[59].balance, 0);
  const sumP = f.schedule.reduce((a, r) => a + r.principal, 0);
  const sumI = f.schedule.reduce((a, r) => a + r.interest, 0);
  assert.ok(Math.abs(sumP - 30000) < 1e-6);
  assert.ok(Math.abs(sumI - f.totalInterest) < 1e-6);
  for (let i = 1; i < 60; i++) {
    assert.ok(f.schedule[i].balance < f.schedule[i - 1].balance);
    assert.ok(f.schedule[i].interest < f.schedule[i - 1].interest);
  }
  assert.ok(Math.abs(f.totalCost - 34799.04) < 0.05);
});

test('finance: tax, down payment, trade-in, zero APR', () => {
  const f = PR.finance(50000, { apr: 0, months: 50, down: 5000, tradeIn: 5000, taxRate: 10 });
  assert.equal(f.principal, 45000);
  assert.equal(f.taxes, 5000);
  assert.equal(f.monthly, 900);
  assert.equal(f.totalInterest, 0);
  assert.equal(f.totalCost, 45000 + 10000);
  const none = PR.finance(10000, { apr: 5, months: 24, down: 20000 });
  assert.equal(none.principal, 0);
  assert.equal(none.monthly, 0);
  // agrees with the app's reference amortisation formula (percent conventions)
  const total = 143215, o = { apr: 6.9, months: 60, down: 15000, tradeIn: 0, taxRate: 7.25 };
  const P = total * 1.0725 - 15000, r = 0.069 / 12;
  const ref = P * r / (1 - Math.pow(1 + r, -60));
  assert.ok(Math.abs(PR.finance(total, o).monthly - ref) < 1e-6);
});

test('lease: standard money-factor lease maths', () => {
  const l = PR.lease(60000, { months: 36, residual_pct: 55, moneyFactor: 0.0025, down: 5000 });
  assert.equal(l.residual, 33000);
  assert.equal(l.capCost, 55000);
  assert.ok(Math.abs(l.depreciation - 22000 / 36) < 1e-9);
  assert.ok(Math.abs(l.financeCharge - 220) < 1e-9);
  assert.ok(Math.abs(l.monthly - 831.111) < 0.001);
  assert.ok(Math.abs(l.apr - 6) < 1e-9);
  assert.ok(Math.abs(l.totalCost - (l.monthly * 36 + 5000)) < 1e-6);
  assert.equal(l.schedule.length, 36);
  assert.ok(Math.abs(l.schedule[35].bookValue - 33000) < 1e-6);
  const taxed = PR.lease(60000, { months: 36, residual_pct: 55, moneyFactor: 0.0025, down: 5000, taxRate: 10 });
  assert.ok(Math.abs(taxed.monthly - l.monthly * 1.1) < 1e-9);
});

test('pricing: optionDelta and diff', () => {
  const b = S.normalize(D.defaultBuild());
  const d = PR.optionDelta(b, 'tech.nightVision', true);
  assert.ok(d >= D.options.nightVision);
  const b2 = applyPatch(b, { exterior: { finish: 'chrome' } });
  const rows = PR.diff(b, b2);
  const fin = rows.find((r) => r.section === 'exterior' && /Finish/.test(r.label));
  assert.ok(fin);
  assert.equal(fin.delta, D.find('paintFinishes', 'chrome').price - D.find('paintFinishes', 'metallic').price);
});

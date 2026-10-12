/* FORGE Atelier — data integrity + state store tests. Run: node tests/run.js */
'use strict';
const assert = require('node:assert/strict');
const test = globalThis.test || ((name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n  ' + e.stack); process.exitCode = 1; } });

require('../js/util.js');
const D = require('../js/data.js');
const S = require('../js/state.js');
const U = globalThis.CB.util;

const strip = (b) => { const c = U.deepClone(b); delete c.meta.id; delete c.meta.created; delete c.meta.modified; return c; };

/* ------------------------------------------------------------------ util */
test('util: set is immutable with structural sharing', () => {
  const a = { x: { y: 1 }, z: { k: 2 }, arr: [1, 2, 3] };
  const b = U.set(a, 'x.y', 5);
  assert.equal(a.x.y, 1); assert.equal(b.x.y, 5); assert.equal(b.z, a.z);
  const c = U.set(a, 'arr.1', 9);
  assert.deepEqual(c.arr, [1, 9, 3]); assert.deepEqual(a.arr, [1, 2, 3]); assert.ok(Array.isArray(c.arr));
});
test('util: deepMerge, get, clamp, round, fmtMoney, colors', () => {
  assert.deepEqual(U.deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { b: 3 }, l: [4, 5] }), { a: { b: 3, c: 2 }, l: [4, 5] });
  assert.equal(U.get({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  assert.equal(U.get({}, 'a.b', 'fb'), 'fb');
  assert.equal(U.clamp(12, 0, 10), 10);
  assert.equal(U.round(1.005, 2), 1.01);
  assert.equal(U.fmtMoney(1234567), '$1,234,567');
  assert.equal(U.fmtMoney(-1200), '-$1,200');
  assert.deepEqual(U.hexToRgb('#ff8000'), { r: 255, g: 128, b: 0 });
  assert.equal(U.rgbToHex(255, 128, 0), '#ff8000');
  assert.equal(U.shade('#808080', -100), '#000000');
  assert.equal(U.mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(U.b64urlDecode(U.b64urlEncode('Ünïcødé 🚗 “quotes”')), 'Ünïcødé 🚗 “quotes”');
});

/* ------------------------------------------------------------------ data */
const COLLECTIONS = ['bodyStyles', 'chassisMaterials', 'engineTypes', 'enginePositions', 'engineLayouts', 'aspirations', 'fuels', 'tunes',
  'exhausts', 'coolings', 'batteryChemistries', 'voltages', 'transmissions', 'differentials', 'drivetrainLayouts', 'suspensionTypes',
  'brakeMaterials', 'absModes', 'wheelDesigns', 'wheelMaterials', 'tireCompounds', 'aero.splitters', 'aero.wings', 'aero.diffusers',
  'glassTypes', 'batteryTypes', 'rollCages', 'ballastPositions', 'paintFinishes', 'stripes', 'roofTypes', 'lightTypes', 'mirrorTypes',
  'badgeTypes', 'seatTypes', 'upholsteries', 'trims', 'steeringTypes', 'headliners', 'screenSizes', 'audioSystems', 'adasLevels'];

test('data: every collection non-empty, ids unique, names/desc present, prices numeric', () => {
  for (const c of COLLECTIONS) {
    const list = D.list(c);
    assert.ok(Array.isArray(list) && list.length, c + ' missing');
    const ids = new Set();
    for (const o of list) {
      assert.ok(o.id !== undefined && o.id !== '', c + ' item without id');
      assert.ok(!ids.has(o.id), c + ' duplicate id ' + o.id);
      ids.add(o.id);
      assert.equal(typeof o.name, 'string', c + '.' + o.id + ' name');
      assert.equal(typeof o.desc, 'string', c + '.' + o.id + ' desc');
      assert.equal(typeof o.price, 'number', c + '.' + o.id + ' price');
      assert.ok(Number.isFinite(o.price));
      if ('weight_kg' in o) assert.ok(Number.isFinite(o.weight_kg), c + '.' + o.id + ' weight');
    }
  }
  for (const k of Object.keys(D.options)) assert.ok(Number.isFinite(D.options[k]), 'options.' + k);
});

test('data: spec-mandated ids exist', () => {
  const need = {
    bodyStyles: ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'],
    chassisMaterials: ['steel', 'high-strength-steel', 'aluminum', 'carbon-tub', 'carbon-monocoque'],
    engineLayouts: ['I3', 'I4', 'I5', 'I6', 'V6', 'V8', 'V10', 'V12', 'W16', 'flat-4', 'flat-6', 'rotary-2'],
    aspirations: ['na', 'turbo', 'twin-turbo', 'quad-turbo', 'supercharged', 'twincharged', 'electric-turbo'],
    fuels: ['regular', 'premium', 'e85', 'race', 'diesel'],
    tunes: ['eco', 'stock', 'stage1', 'stage2', 'stage3', 'time-attack'],
    exhausts: ['stock', 'sport', 'titanium', 'straight-pipe', 'valvetronic'],
    coolings: ['standard', 'uprated', 'race'],
    batteryChemistries: ['lfp', 'nmc', 'nca', 'solid-state'],
    transmissions: ['manual', 'dct', 'auto', 'cvt', 'sequential', 'single-speed'],
    differentials: ['none', 'open', 'lsd-viscous', 'lsd-clutch', 'lsd-torsen', 'e-diff', 'locking'],
    suspensionTypes: ['macpherson', 'double-wishbone', 'multilink', 'pushrod', 'air', 'magnetic', 'coilover-track'],
    brakeMaterials: ['iron', 'drilled-slotted', 'two-piece', 'carbon-ceramic'],
    wheelMaterials: ['steel', 'cast', 'flow-formed', 'forged', 'magnesium', 'carbon'],
    tireCompounds: ['eco', 'all-season', 'winter', 'touring', 'performance', 'super-sport', 'track', 'slick'],
    'aero.splitters': ['none', 'lip', 'carbon', 'race'],
    'aero.wings': ['none', 'ducktail', 'lip-spoiler', 'swan-neck', 'gt-wing', 'active', 'biplane'],
    'aero.diffusers': ['none', 'mild', 'carbon', 'race'],
    paintFinishes: ['solid', 'metallic', 'pearl', 'matte', 'satin', 'chrome', 'candy', 'chameleon'],
    stripes: ['none', 'racing-dual', 'center', 'side-skirt', 'le-mans', 'hood', 'pinstripe', 'gradient']
  };
  for (const c of Object.keys(need)) for (const id of need[c]) assert.ok(D.find(c, id), c + ':' + id);
  assert.ok(D.wheelDesigns.length >= 12, '12+ wheel designs');
  assert.ok(D.paintSwatches.length >= 30, '30+ swatches');
  const hexes = new Set();
  for (const s of D.paintSwatches) { assert.ok(U.isHex(s.hex), s.name); assert.ok(!hexes.has(s.hex.toLowerCase()), 'dup swatch ' + s.hex); hexes.add(s.hex.toLowerCase()); }
  assert.ok(D.presets.length >= 8);
});

test('data: module-specific fields are sane', () => {
  for (const b of D.bodyStyles) {
    assert.ok(b.wheelbaseRange[0] < b.wheelbaseRange[1]);
    assert.ok(b.defaultWheelbase >= b.wheelbaseRange[0] && b.defaultWheelbase <= b.wheelbaseRange[1], b.id);
    assert.ok(b.doorOptions.length && b.seatOptions.length && b.allowedEnginePositions.length);
    assert.ok(b.cd > 0.2 && b.cd < 0.5 && b.frontalArea_m2 > 1.5);
    for (const k of ['length_mm', 'height_mm', 'hoodLength', 'cabinStart', 'cabinEnd', 'roofHeight', 'tailStyle']) assert.ok(b.svg[k] !== undefined, b.id + ' svg.' + k);
    assert.ok(b.svg.cabinStart < b.svg.roofStart && b.svg.roofStart < b.svg.roofEnd && b.svg.roofEnd <= b.svg.cabinEnd, b.id + ' svg ordering');
  }
  for (const l of D.engineLayouts) assert.ok(l.displacementRange[0] <= l.displacementRange[1] && l.cylinders > 0);
  for (const t of D.tireCompounds) assert.ok(t.mu >= 0.7 && t.mu <= 1.6);
  for (const s of D.suspensionTypes) assert.ok(s.rideHeightRange[0] >= 50 && s.rideHeightRange[1] <= 300);
});

test('data: defaultRatios produce realistic descending geometric-ish progressions', () => {
  for (const t of D.transmissions) {
    for (let g = t.gearRange[0]; g <= t.gearRange[1]; g++) {
      const r = t.defaultRatios(g);
      assert.equal(r.length, g, t.id + ' ' + g);
      r.forEach((x) => assert.ok(x >= 0.4 && x <= 6, t.id + ' ratio ' + x));
      for (let i = 1; i < r.length; i++) assert.ok(r[i] < r[i - 1], t.id + ' descending');
      if (g > 2) {
        const steps = r.slice(1).map((x, i) => r[i] / x);
        // progressive: first step gap >= last step gap
        assert.ok(steps[0] >= steps[steps.length - 1] - 0.02, t.id + ' progressive');
        steps.forEach((s) => assert.ok(s > 1.05 && s < 1.9, t.id + ' step ' + s));
      }
    }
  }
});

test('data: defaultBuild references only catalog ids and normalizes to itself', () => {
  const b = D.defaultBuild();
  for (const p of Object.keys(D.pathCollections)) {
    assert.ok(D.find(D.pathCollections[p], U.get(b, p)), 'default ' + p + '=' + U.get(b, p));
  }
  assert.equal(b.transmission.ratios.length, b.transmission.gears);
  assert.deepEqual(U.diff(b, S.normalize(b)), []);
  assert.notEqual(D.defaultBuild(), D.defaultBuild());
  assert.notEqual(D.defaultBuild().meta.id, D.defaultBuild().meta.id);
});

test('data: every preset deep-merged onto default normalizes cleanly (no preset value altered)', () => {
  for (const p of D.presets) {
    assert.ok(p.id && p.name && p.tagline, 'preset meta ' + p.id);
    const merged = U.deepMerge(D.defaultBuild(), p.build);
    const norm = S.normalize(merged);
    const altered = S.leafPaths(p.build).filter((k) => !U.equal(U.get(merged, k), U.get(norm, k)));
    assert.deepEqual(altered, [], p.id + ' altered: ' + altered.join(', '));
    for (const path of Object.keys(D.pathCollections)) assert.ok(D.find(D.pathCollections[path], U.get(norm, path)), p.id + ' ' + path);
    // obvious physical compatibility
    const wheelMm = norm.wheels.diameter_in * 25.4;
    assert.ok(norm.brakes.frontRotor_mm + 60 <= wheelMm, p.id + ' front rotor fits wheel');
    assert.ok(norm.brakes.rearRotor_mm + 60 <= wheelMm, p.id + ' rear rotor fits wheel');
    const ccMin = D.find('brakeMaterials', norm.brakes.material).minWheel_in;
    assert.ok(norm.wheels.diameter_in >= ccMin, p.id + ' brake material wheel min');
    for (const ax of ['Front', 'Rear']) {
      const rim = norm.wheels['width' + ax + '_in'] * 25.4, tire = norm.tires['width' + ax + '_mm'];
      assert.ok(tire - rim >= 0 && tire - rim <= 65, p.id + ' tyre/rim ' + ax + ' ' + tire + ' on ' + rim);
    }
    if (norm.engine.type === 'ice' || norm.engine.type === 'hybrid') {
      const fuel = D.find('fuels', norm.engine.fuel);
      assert.ok(D.effectiveCompression(norm.engine.compression, norm.engine.boost_bar) <= fuel.knockLimit, p.id + ' knock');
      const lay = D.find('engineLayouts', norm.engine.layout);
      if (lay.id === 'V12') assert.notEqual(norm.body.style, 'hatchback');
    }
    const style = D.find('bodyStyles', norm.body.style);
    assert.ok(style.allowedEnginePositions.includes(norm.engine.position), p.id + ' engine position');
    if (norm.weight.rollCage === 'full') assert.equal(norm.weight.rearSeats, false, p.id + ' cage vs rear seats');
    if (norm.engine.type === 'ev') assert.equal(norm.transmission.type, 'single-speed');
    if (norm.drivetrain.layout === 'fwd') assert.equal(norm.engine.position, 'front');
    assert.equal(norm.transmission.ratios.length, norm.transmission.gears);
    assert.equal(D.presetBuild(p.id).meta.presetId, p.id);
  }
});

/* ------------------------------------------------------------------ normalize */
test('normalize: clamps, snaps and enforces per-type ranges', () => {
  const b = D.defaultBuild();
  const bad = U.deepMerge(b, {
    body: { wheelbase_mm: 9999, doors: 3, seats: 7, trackWidth_mm: 10 },
    engine: { layout: 'V8', displacement_l: 12.34, compression: 30, redline_rpm: 12000 },
    suspension: { rideHeight_mm: 20, camberFront_deg: -9, toeRear_deg: 3 },
    brakes: { frontPistons: 5, frontRotor_mm: 1000 },
    tires: { widthFront_mm: 261, profileRear: 33 },
    wheels: { widthFront_in: 9.3, diameter_in: 30, finish: 'red' },
    exterior: { livery_number: 'ab-12x', windowTint_pct: 200 },
    tech: { screen_in: 13, climateZones: 9 }
  });
  const n = S.normalize(bad);
  assert.equal(n.body.wheelbase_mm, 2800);
  assert.equal(n.body.doors, 2);
  assert.equal(n.body.seats, 4);
  assert.equal(n.body.trackWidth_mm, 1450);
  assert.equal(n.engine.displacement_l, 7.0);
  assert.equal(n.engine.compression, 14);
  assert.equal(n.engine.redline_rpm, 9500);
  assert.equal(n.suspension.rideHeight_mm, 80); // double-wishbone min
  assert.equal(n.suspension.camberFront_deg, -5);
  assert.equal(n.suspension.toeRear_deg, 0.5);
  assert.ok([4, 6].includes(n.brakes.frontPistons));
  assert.equal(n.brakes.frontRotor_mm, 440);
  assert.equal(n.tires.widthFront_mm % 10, 5);
  assert.equal(n.tires.profileRear % 5, 0);
  assert.equal(n.wheels.widthFront_in, 9.5);
  assert.equal(n.wheels.diameter_in, 23);
  assert.equal(n.wheels.finish, '#2b2b2b');
  assert.equal(n.exterior.livery_number, 'AB1');
  assert.equal(n.exterior.windowTint_pct, 85);
  assert.equal(n.tech.screen_in, 12);
  assert.equal(n.tech.climateZones, 4);
});

test('normalize: unknown ids fall back, unknown keys dropped, garbage input survives', () => {
  const n = S.normalize({ body: { style: 'spaceship' }, engine: { layout: 'V42' }, junk: 1, wheels: { bogus: true } });
  assert.equal(n.body.style, 'coupe');
  assert.equal(n.engine.layout, D.defaultBuild().engine.layout, 'unknown layout falls back to the default build');
  assert.equal(n.junk, undefined);
  assert.equal(n.wheels.bogus, undefined);
  assert.ok(S.normalize(null).body);
  assert.ok(S.normalize('nope').engine);
});

test('normalize: drivetrain invariants', () => {
  const b = D.defaultBuild();
  let n = S.normalize(U.deepMerge(b, { drivetrain: { layout: 'fwd', torqueSplitFront_pct: 20, centerDiff: 'lsd-torsen', frontDiff: 'none' } }));
  assert.equal(n.drivetrain.torqueSplitFront_pct, 100);
  assert.equal(n.drivetrain.centerDiff, 'none');
  assert.equal(n.drivetrain.frontDiff, 'open');
  n = S.normalize(U.deepMerge(b, { drivetrain: { layout: 'rwd', torqueSplitFront_pct: 50 } }));
  assert.equal(n.drivetrain.torqueSplitFront_pct, 0);
  n = S.normalize(U.deepMerge(b, { drivetrain: { layout: 'awd', torqueSplitFront_pct: 100, centerDiff: 'none' } }));
  assert.equal(n.drivetrain.torqueSplitFront_pct, 90);
  assert.notEqual(n.drivetrain.centerDiff, 'none');
});

test('normalize: engine invariants (na boost, diesel redline, hybrid/ev limits, positions)', () => {
  const b = D.defaultBuild();
  let n = S.normalize(U.deepMerge(b, { engine: { aspiration: 'na', boost_bar: 2 } }));
  assert.equal(n.engine.boost_bar, 0);
  n = S.normalize(U.deepMerge(b, { engine: { aspiration: 'supercharged', boost_bar: 2.9 } }));
  assert.equal(n.engine.boost_bar, 1.2);
  n = S.normalize(U.deepMerge(b, { engine: { fuel: 'diesel', redline_rpm: 8000 } }));
  assert.equal(n.engine.redline_rpm, 5200);
  n = S.normalize(U.deepMerge(b, { engine: { type: 'hybrid', motors: 4, battery_kwh: 85 } }));
  assert.equal(n.engine.motors, 2);
  assert.equal(n.engine.battery_kwh, 30);
  n = S.normalize(U.deepMerge(b, { engine: { type: 'ev', motors: 6, battery_kwh: 10, motorPower_kw: 900 } }));
  assert.equal(n.engine.motors, 4);
  assert.equal(n.engine.battery_kwh, 30);
  assert.equal(n.engine.motorPower_kw, 500);
  n = S.normalize(U.deepMerge(b, { body: { style: 'hypercar' }, engine: { position: 'front' } }));
  assert.equal(n.engine.position, 'mid');
  n = S.normalize(U.deepMerge(b, { engine: { layout: 'I3', displacement_l: 4.0 } }));
  assert.equal(n.engine.displacement_l, 1.6);
  n = S.normalize(U.deepMerge(b, { transmission: { type: 'single-speed' } }));
  assert.equal(n.transmission.type, 'dct', 'ICE cannot use single-speed');
});

test('normalize: transmission gears/ratios', () => {
  const b = D.defaultBuild();
  let n = S.normalize(U.deepMerge(b, { transmission: { type: 'auto', gears: 12, ratios: [1, 2] } }));
  assert.equal(n.transmission.gears, 10);
  assert.equal(n.transmission.ratios.length, 10);
  n = S.normalize(U.deepMerge(b, { transmission: { ratios: [3.8, 4.0, 1.9, 1.45, 1.15, 0.95, 0.78] } }));
  for (let i = 1; i < 7; i++) assert.ok(n.transmission.ratios[i] < n.transmission.ratios[i - 1]);
  n = S.normalize(U.deepMerge(b, { transmission: { type: 'cvt', gears: 7 } }));
  assert.equal(n.transmission.gears, 1);
  assert.equal(n.transmission.ratios.length, 1);
});

test('normalize: square wheel/tyre setups when not staggered; seats & rear seats', () => {
  const b = D.defaultBuild();
  let n = S.normalize(U.deepMerge(b, { wheels: { staggered: false } }));
  assert.equal(n.wheels.widthRear_in, n.wheels.widthFront_in);
  assert.equal(n.tires.widthRear_mm, n.tires.widthFront_mm);
  assert.equal(n.tires.profileRear, n.tires.profileFront);
  n = S.normalize(U.deepMerge(b, { body: { seats: 2 } }));
  assert.equal(n.weight.rearSeats, false);
  n = S.normalize(U.deepMerge(b, { body: { style: 'suv', seats: 7, doors: 5 } }));
  assert.equal(n.body.doors, 5);
  assert.equal(n.body.wheelbase_mm, D.find('bodyStyles', 'suv').wheelbaseRange[0], 'wheelbase clamped into suv range');
});

/* ------------------------------------------------------------------ store */
/** The store tests drive a front-engined 4.0 V8 coupe (the default build is a rear-engined 3.0 flat-six 911). */
function frontV8() { return U.deepMerge(D.defaultBuild(), { engine: { layout: 'V8', displacement_l: 4.0, position: 'front' } }); }
test('state: set / undo / redo / history labels', () => {
  S.replace(frontV8(), { resetHistory: true });
  const start = S.get();
  assert.equal(S.canUndo(), false);
  assert.equal(S.set('engine.layout', 'V12'), true);
  assert.equal(S.get().engine.layout, 'V12');
  assert.equal(start.engine.layout, 'V8', 'previous build untouched');
  assert.equal(S.set('engine.layout', 'V12'), false, 'no-op when unchanged');
  assert.ok(S.canUndo());
  assert.match(S.history().slice(-1)[0], /V12/);
  S.undo();
  assert.equal(S.get().engine.layout, 'V8');
  assert.ok(S.canRedo());
  S.redo();
  assert.equal(S.get().engine.layout, 'V12');
  S.set('body.style', 'sedan');
  assert.equal(S.canRedo(), false, 'new change clears redo');
});

test('state: rapid same-path changes coalesce into one undo step; other paths do not', () => {
  S.replace(frontV8(), { resetHistory: true });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (let i = 0; i <= 7; i++) { S.set('engine.displacement_l', U.round(3.6 + i * 0.2, 1)); now += 100; }
    assert.equal(S.history().length, 1, 'slider drag = one step');
    now += 700;
    S.set('engine.displacement_l', 6.0);
    assert.equal(S.history().length, 2, 'after 600ms a new step starts');
    now += 50;
    S.set('engine.redline_rpm', 7000);
    assert.equal(S.history().length, 3, 'different path is its own step');
    S.undo(); S.undo();
    assert.ok(Math.abs(S.get().engine.displacement_l - 5.0) < 1e-9);
    S.undo();
    assert.equal(S.get().engine.displacement_l, 4.0);
  } finally { Date.now = realNow; }
});

test('state: history capped at 100', () => {
  S.replace(D.defaultBuild(), { resetHistory: true });
  for (let i = 0; i < 130; i++) S.set('exterior.windowTint_pct', i % 80, { noCoalesce: true });
  assert.equal(S.history().length, 100);
});

test('state: subscribe receives change info and unsubscribe works', () => {
  S.replace(D.defaultBuild(), { resetHistory: true });
  const seen = [];
  const off = S.subscribe((b, c) => seen.push([c.type, c.path, b.suspension.rideHeight_mm]));
  S.set('suspension.rideHeight_mm', 100);
  S.patch({ suspension: { damping: 7 } });
  S.undo();
  off();
  S.set('suspension.rideHeight_mm', 140);
  assert.deepEqual(seen.map((s) => s[0]), ['set', 'patch', 'undo']);
  assert.equal(seen[0][1], 'suspension.rideHeight_mm');
  assert.equal(seen[0][2], 100);
});

test('state: context-aware normalize on set()', () => {
  S.replace(frontV8(), { resetHistory: true });
  S.set('engine.type', 'ev');
  assert.equal(S.get().transmission.type, 'single-speed');
  assert.equal(S.get().transmission.ratios.length, 1);
  S.set('transmission.type', 'dct');
  assert.equal(S.get().transmission.type, 'dct', 'user may pick a multi-speed box for an EV');
  assert.equal(S.get().transmission.ratios.length, S.get().transmission.gears);
  S.set('engine.type', 'ice');
  S.set('transmission.gears', 6);
  assert.equal(S.get().transmission.ratios.length, 6);
  S.set('transmission.type', 'sequential');
  assert.deepEqual(S.get().transmission.ratios, D.find('transmissions', 'sequential').defaultRatios(S.get().transmission.gears));
  S.set('engine.aspiration', 'na');
  assert.equal(S.get().engine.boost_bar, 0);
  S.set('engine.aspiration', 'turbo');
  assert.equal(S.get().engine.boost_bar, D.find('aspirations', 'turbo').typicalBoost_bar);
  S.set('drivetrain.layout', 'awd');
  assert.equal(S.get().drivetrain.torqueSplitFront_pct, 40);
  S.set('weight.rearSeats', false);
  assert.equal(S.get().body.seats, 2);
  S.set('weight.rearSeats', true);
  assert.equal(S.get().body.seats, 4);
  S.set('body.style', 'suv');
  // with CB.shapes loaded a body-style change adopts the style's default real model dimensions (CB.state.realDims)
  const suvDims = S.realDims && S.realDims({ body: { style: 'suv' } });
  if (suvDims) assert.equal(S.get().body.wheelbase_mm, S.normalize(U.deepMerge(S.get(), suvDims)).body.wheelbase_mm);
  else assert.equal(S.get().body.wheelbase_mm, D.find('bodyStyles', 'suv').defaultWheelbase);
  S.set('suspension.type', 'pushrod');
  assert.ok(S.get().suspension.rideHeight_mm <= 140);
});

test('state: patch deep-merges and replace loads a full build', () => {
  S.replace(D.defaultBuild(), { resetHistory: true });
  S.patch({ exterior: { paint: '#004225', finish: 'pearl' } }, { label: 'Paint' });
  assert.equal(S.get().exterior.paint, '#004225');
  assert.equal(S.get().exterior.stripe, 'none');
  assert.equal(S.history().slice(-1)[0], 'Paint');
  S.replace(D.presetBuild('electric-hyper'));
  assert.equal(S.get().engine.type, 'ev');
  assert.equal(S.get().meta.presetId, 'electric-hyper');
  S.undo();
  assert.equal(S.get().engine.type, 'ice');
});

/* ------------------------------------------------------------------ encode / decode */
test('encode/decode roundtrip (default, every preset, unicode names)', () => {
  const builds = [D.defaultBuild(), ...D.presets.map((p) => D.presetBuild(p.id))];
  const uni = S.normalize(D.defaultBuild()); uni.meta.name = 'Ångström “GT” — 速い 🚗';
  builds.push(uni);
  for (const b of builds) {
    const n = S.normalize(b);
    const code = S.encode(n);
    assert.match(code, /^v1\.[A-Za-z0-9_-]+$/, 'url-safe');
    const back = S.decode(code);
    assert.ok(back, 'decodes');
    assert.deepEqual(strip(back), strip(n));
    assert.deepEqual(strip(S.decode('#b=' + code)), strip(n), 'accepts hash form');
  }
  assert.ok(S.encode(D.defaultBuild()).length < 60, 'default build encodes compactly');
});

test('decode rejects garbage', () => {
  assert.equal(S.decode(''), null);
  assert.equal(S.decode('v1.%%%'), null);
  assert.equal(S.decode('v1.' + U.b64urlEncode('[1,2]')), null);
  assert.equal(S.decode(null), null);
});

/* ------------------------------------------------------------------ garage (memory storage in Node) */
test('garage: save / list / load / rename / duplicate / delete', () => {
  const b = S.normalize(D.presetBuild('muscle'));
  const e = S.saveLocal(b);
  assert.equal(e.id, b.meta.id);
  assert.ok(S.listLocal().some((x) => x.id === b.meta.id));
  assert.equal(S.loadLocal(b.meta.id).engine.aspiration, 'supercharged');
  S.saveLocal(U.set(b, 'meta.name', 'Muscle v2'));
  assert.equal(S.listLocal().filter((x) => x.id === b.meta.id).length, 1, 'save overwrites same id');
  assert.ok(S.renameLocal(b.meta.id, 'Renamed'));
  assert.equal(S.loadLocal(b.meta.id).meta.name, 'Renamed');
  const dup = S.duplicateLocal(b.meta.id);
  assert.notEqual(dup.id, b.meta.id);
  assert.ok(S.deleteLocal(b.meta.id));
  assert.equal(S.loadLocal(b.meta.id), null);
  assert.equal(S.deleteLocal('nope'), false);
  assert.ok(S.importJSON(S.exportJSON(b)));
  assert.equal(S.importJSON('{bad'), null);
});

test('boot falls back to default in Node', () => {
  const info = S.boot({ force: true });
  assert.ok(['default', 'autosave'].includes(info.source));
  assert.ok(S.get().body);
});

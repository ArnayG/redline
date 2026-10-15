/* ==========================================================================
   FORGE Atelier — js/data.js
   CB.data : the complete parts catalog, presets and defaultBuild().

   Conventions
   -----------
   * Every option: { id, name, desc, price (USD delta added to base), weight_kg? (delta) } + module fields.
   * Prices are per vehicle unless stated (tireCompounds.price is PER TIRE; wheel prices are PER SET of 4).
   * Pure data + small pure helpers; runs in Node (tests) and the browser.

   Body-style SVG hints (bodyStyles[].svg) — consumed by CB.render
   ----------------------------------------------------------------
   All fractional values are 0..1 along the car LENGTH measured from the front bumper (x) or along the
   HEIGHT measured from the ground (y), unless the key ends in a unit.
     length_mm        overall length at defaultWheelbase (renderer may stretch by wheelbase delta)
     height_mm        overall height (roof / top of windscreen frame for roadsters)
     width_mm         overall body width (excl. mirrors) — used by front/rear/top views
     frontOverhang_mm bumper → front axle centre;  rearOverhang_mm  rear axle centre → rear bumper
     noseHeight       y of the front bumper top edge (fraction of height)
     hoodLength       x where the bonnet meets the windscreen base
     cabinStart       x of the A-pillar base (≈ hoodLength, can differ for cab-forward shapes)
     roofStart        x where the windscreen meets the roof
     roofEnd          x where the flat roof ends / rear glass begins
     cabinEnd         x where the rear glass / C-pillar meets the deck, tailgate or bed
     roofHeight       y of the roof (normally 1.0; < 1 for low-roof shapes with a tall element elsewhere)
     beltline         y of the side-window sill
     deckHeight       y of the rear deck / boot lid / bed rail
     tailHeight       y of the top of the rear bumper/tail panel
     windshieldRake_deg  windscreen angle from vertical
     tailStyle        'fastback' | 'notchback' | 'hatch' | 'wagon' | 'kammback' | 'bed' | 'box' | 'open' | 'longtail'
     noseStyle        'long' | 'short' | 'blunt' | 'wedge' | 'low' | 'tall'
     archStyle        'round' | 'flared' | 'squared'
     openTop          true for roadsters (no roof panel; roll hoops drawn instead)
     bedLength_mm     pickup bed length (pickup only)
     sideWindows      number of side glass panes (2..4) for the side-view window graphics
     pillarStyle      'thin' | 'thick' | 'floating' (floating = blacked-out C pillar)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';
  var U = CB.util || {};
  var uid = U.uid || function (p) { return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  /* ======================================================================
     BODY
     ====================================================================== */
  var bodyStyles = [
    {
      id: 'coupe', name: 'Coupé', desc: 'Two-door fastback with a low roof and a long bonnet — the quintessential driver\'s shape.',
      price: 0, basePrice: 68000, baseWeight_kg: 1420, cd: 0.31, frontalArea_m2: 2.05,
      wheelbaseRange: [2450, 2800], defaultWheelbase: 2650, doorOptions: [2], seatOptions: [2, 4],
      cgHeight_mm: 480, allowedEnginePositions: ['front', 'mid', 'rear'], cargo_l: 300, tank_l: 64,
      svg: { length_mm: 4550, height_mm: 1300, width_mm: 1930, frontOverhang_mm: 930, rearOverhang_mm: 970,
        noseHeight: 0.46, hoodLength: 0.40, cabinStart: 0.40, roofStart: 0.52, roofEnd: 0.66, cabinEnd: 0.84,
        roofHeight: 1.0, beltline: 0.68, deckHeight: 0.72, tailHeight: 0.60, windshieldRake_deg: 62,
        tailStyle: 'fastback', noseStyle: 'long', archStyle: 'flared', openTop: false, sideWindows: 2, pillarStyle: 'thin' }
    },
    {
      id: 'sedan', name: 'Sport Sedan', desc: 'Four-door saloon with a formal notchback boot — executive comfort, autobahn pace.',
      price: 0, basePrice: 52000, baseWeight_kg: 1560, cd: 0.27, frontalArea_m2: 2.25,
      wheelbaseRange: [2700, 3100], defaultWheelbase: 2900, doorOptions: [4], seatOptions: [4, 5],
      cgHeight_mm: 520, allowedEnginePositions: ['front'], cargo_l: 480, tank_l: 68,
      svg: { length_mm: 4950, height_mm: 1440, width_mm: 1900, frontOverhang_mm: 960, rearOverhang_mm: 1090,
        noseHeight: 0.50, hoodLength: 0.33, cabinStart: 0.33, roofStart: 0.45, roofEnd: 0.66, cabinEnd: 0.80,
        roofHeight: 1.0, beltline: 0.66, deckHeight: 0.70, tailHeight: 0.62, windshieldRake_deg: 60,
        tailStyle: 'notchback', noseStyle: 'long', archStyle: 'round', openTop: false, sideWindows: 3, pillarStyle: 'thin' }
    },
    {
      id: 'hatchback', name: 'Hatchback', desc: 'Compact, upright and agile — the hot-hatch and rally-homologation canvas.',
      price: 0, basePrice: 32000, baseWeight_kg: 1280, cd: 0.32, frontalArea_m2: 2.15,
      wheelbaseRange: [2450, 2750], defaultWheelbase: 2600, doorOptions: [3, 5], seatOptions: [2, 4, 5],
      cgHeight_mm: 510, allowedEnginePositions: ['front', 'mid'], cargo_l: 380, tank_l: 50,
      svg: { length_mm: 4250, height_mm: 1450, width_mm: 1800, frontOverhang_mm: 880, rearOverhang_mm: 770,
        noseHeight: 0.52, hoodLength: 0.27, cabinStart: 0.27, roofStart: 0.40, roofEnd: 0.80, cabinEnd: 0.94,
        roofHeight: 1.0, beltline: 0.64, deckHeight: 0.66, tailHeight: 0.62, windshieldRake_deg: 58,
        tailStyle: 'hatch', noseStyle: 'short', archStyle: 'flared', openTop: false, sideWindows: 3, pillarStyle: 'thick' }
    },
    {
      id: 'wagon', name: 'Estate / Avant', desc: 'Long-roof family hauler with a squared tail — the sleeper of choice.',
      price: 0, basePrice: 56000, baseWeight_kg: 1650, cd: 0.29, frontalArea_m2: 2.30,
      wheelbaseRange: [2700, 3050], defaultWheelbase: 2880, doorOptions: [5], seatOptions: [5],
      cgHeight_mm: 540, allowedEnginePositions: ['front'], cargo_l: 620, tank_l: 70,
      svg: { length_mm: 4980, height_mm: 1470, width_mm: 1950, frontOverhang_mm: 960, rearOverhang_mm: 1140,
        noseHeight: 0.50, hoodLength: 0.32, cabinStart: 0.32, roofStart: 0.44, roofEnd: 0.88, cabinEnd: 0.96,
        roofHeight: 1.0, beltline: 0.65, deckHeight: 0.66, tailHeight: 0.62, windshieldRake_deg: 60,
        tailStyle: 'wagon', noseStyle: 'long', archStyle: 'flared', openTop: false, sideWindows: 4, pillarStyle: 'floating' }
    },
    {
      id: 'suv', name: 'SUV', desc: 'Tall, commanding and capable — seven seats, wading depth and a towbar.',
      price: 0, basePrice: 64000, baseWeight_kg: 2050, cd: 0.35, frontalArea_m2: 2.75,
      wheelbaseRange: [2750, 3150], defaultWheelbase: 2950, doorOptions: [5], seatOptions: [5, 7],
      cgHeight_mm: 680, allowedEnginePositions: ['front'], cargo_l: 820, tank_l: 85,
      svg: { length_mm: 4950, height_mm: 1760, width_mm: 2000, frontOverhang_mm: 930, rearOverhang_mm: 1070,
        noseHeight: 0.56, hoodLength: 0.30, cabinStart: 0.30, roofStart: 0.40, roofEnd: 0.90, cabinEnd: 0.97,
        roofHeight: 1.0, beltline: 0.62, deckHeight: 0.62, tailHeight: 0.58, windshieldRake_deg: 54,
        tailStyle: 'box', noseStyle: 'tall', archStyle: 'squared', openTop: false, sideWindows: 3, pillarStyle: 'thick' }
    },
    {
      id: 'roadster', name: 'Roadster', desc: 'Open two-seater with a low cowl — wind in the hair, nothing in the way.',
      price: 0, basePrice: 58000, baseWeight_kg: 1250, cd: 0.36, frontalArea_m2: 1.85,
      wheelbaseRange: [2300, 2600], defaultWheelbase: 2450, doorOptions: [2], seatOptions: [2],
      cgHeight_mm: 440, allowedEnginePositions: ['front', 'mid'], cargo_l: 150, tank_l: 50,
      svg: { length_mm: 4100, height_mm: 1240, width_mm: 1780, frontOverhang_mm: 820, rearOverhang_mm: 830,
        noseHeight: 0.44, hoodLength: 0.42, cabinStart: 0.42, roofStart: 0.50, roofEnd: 0.62, cabinEnd: 0.70,
        roofHeight: 0.92, beltline: 0.70, deckHeight: 0.72, tailHeight: 0.62, windshieldRake_deg: 64,
        tailStyle: 'open', noseStyle: 'long', archStyle: 'round', openTop: true, sideWindows: 1, pillarStyle: 'thin' }
    },
    {
      id: 'pickup', name: 'Pickup', desc: 'Crew-cab truck with an open bed — tow, haul, or jump dunes at 100 mph.',
      price: 0, basePrice: 48000, baseWeight_kg: 2150, cd: 0.42, frontalArea_m2: 3.10,
      wheelbaseRange: [3100, 3700], defaultWheelbase: 3400, doorOptions: [2, 4], seatOptions: [2, 3, 5, 6],
      cgHeight_mm: 720, allowedEnginePositions: ['front'], cargo_l: 1500, tank_l: 98,
      svg: { length_mm: 5900, height_mm: 1960, width_mm: 2080, frontOverhang_mm: 1000, rearOverhang_mm: 1500,
        noseHeight: 0.58, hoodLength: 0.24, cabinStart: 0.24, roofStart: 0.32, roofEnd: 0.52, cabinEnd: 0.56,
        roofHeight: 1.0, beltline: 0.60, deckHeight: 0.58, tailHeight: 0.58, windshieldRake_deg: 52,
        tailStyle: 'bed', noseStyle: 'blunt', archStyle: 'squared', openTop: false, bedLength_mm: 1700, sideWindows: 2, pillarStyle: 'thick' }
    },
    {
      id: 'hypercar', name: 'Hypercar', desc: 'Mid-engined, cab-forward carbon wedge sculpted by the wind tunnel.',
      price: 0, basePrice: 280000, baseWeight_kg: 1250, cd: 0.30, frontalArea_m2: 1.90,
      wheelbaseRange: [2550, 2800], defaultWheelbase: 2700, doorOptions: [2], seatOptions: [1, 2],
      cgHeight_mm: 400, allowedEnginePositions: ['mid'], cargo_l: 90, tank_l: 72,
      svg: { length_mm: 4700, height_mm: 1150, width_mm: 2050, frontOverhang_mm: 1000, rearOverhang_mm: 1000,
        noseHeight: 0.38, hoodLength: 0.26, cabinStart: 0.26, roofStart: 0.42, roofEnd: 0.54, cabinEnd: 0.70,
        roofHeight: 1.0, beltline: 0.70, deckHeight: 0.80, tailHeight: 0.68, windshieldRake_deg: 68,
        tailStyle: 'longtail', noseStyle: 'wedge', archStyle: 'flared', openTop: false, sideWindows: 1, pillarStyle: 'floating' }
    },
    {
      id: 'shooting-brake', name: 'Shooting Brake', desc: 'A coupé with a long roof — three doors, two-plus-two, endless glamour.',
      price: 0, basePrice: 78000, baseWeight_kg: 1520, cd: 0.30, frontalArea_m2: 2.10,
      wheelbaseRange: [2600, 2900], defaultWheelbase: 2750, doorOptions: [3], seatOptions: [2, 4],
      cgHeight_mm: 490, allowedEnginePositions: ['front', 'mid'], cargo_l: 450, tank_l: 70,
      svg: { length_mm: 4800, height_mm: 1360, width_mm: 1950, frontOverhang_mm: 940, rearOverhang_mm: 1110,
        noseHeight: 0.46, hoodLength: 0.38, cabinStart: 0.38, roofStart: 0.50, roofEnd: 0.84, cabinEnd: 0.95,
        roofHeight: 1.0, beltline: 0.67, deckHeight: 0.68, tailHeight: 0.60, windshieldRake_deg: 62,
        tailStyle: 'kammback', noseStyle: 'long', archStyle: 'flared', openTop: false, sideWindows: 2, pillarStyle: 'floating' }
    },
    {
      id: 'van', name: 'Grand Van', desc: 'One-box people mover — lounge seating for nine and a cathedral of space.',
      price: 0, basePrice: 42000, baseWeight_kg: 2100, cd: 0.36, frontalArea_m2: 3.40,
      wheelbaseRange: [3000, 3700], defaultWheelbase: 3300, doorOptions: [4, 5], seatOptions: [2, 3, 7, 8, 9],
      cgHeight_mm: 800, allowedEnginePositions: ['front', 'rear'], cargo_l: 2200, tank_l: 80,
      svg: { length_mm: 5300, height_mm: 1950, width_mm: 2000, frontOverhang_mm: 880, rearOverhang_mm: 1120,
        noseHeight: 0.50, hoodLength: 0.14, cabinStart: 0.12, roofStart: 0.22, roofEnd: 0.96, cabinEnd: 0.99,
        roofHeight: 1.0, beltline: 0.55, deckHeight: 0.50, tailHeight: 0.48, windshieldRake_deg: 40,
        tailStyle: 'box', noseStyle: 'blunt', archStyle: 'round', openTop: false, sideWindows: 4, pillarStyle: 'thin' }
    }
  ];

  var chassisMaterials = [
    { id: 'steel', name: 'Pressed Steel', desc: 'Conventional unibody — robust, repairable and inexpensive.', price: 0, weight_kg: 0, weightFactor: 1.0, stiffness: 0.55 },
    { id: 'high-strength-steel', name: 'Boron High-Strength Steel', desc: 'Hot-stamped boron steel in the crash structures; thinner gauges, stiffer shell.', price: 3500, weight_kg: 0, weightFactor: 0.94, stiffness: 0.65 },
    { id: 'aluminum', name: 'Bonded Aluminium Spaceframe', desc: 'Extruded and cast aluminium nodes, riveted and bonded — light and torsionally rigid.', price: 12000, weight_kg: 0, weightFactor: 0.82, stiffness: 0.74 },
    { id: 'carbon-tub', name: 'Carbon Passenger Tub', desc: 'Pre-preg carbon cell with aluminium subframes front and rear — supercar-grade rigidity.', price: 48000, weight_kg: 0, weightFactor: 0.70, stiffness: 0.88 },
    { id: 'carbon-monocoque', name: 'Full Carbon Monocoque', desc: 'Autoclaved one-piece carbon chassis with integrated roof — Le Mans prototype construction.', price: 120000, weight_kg: 0, weightFactor: 0.60, stiffness: 0.97 }
  ];

  /* Body construction: gauge / insulation / reinforcement of the shell on top of the chassis material. weightFactor
     scales the glider (BIW + closures) mass; stiffness adds to the chassis material's; comfort / noise nudge the cabin
     (comfort index points, cabin dB). 'standard' is neutral — builds saved before this option existed load as it. */
  var constructions = [
    { id: 'classic', name: 'Period Construction', desc: 'Pre-2000 thin-gauge shell — no side-impact beams, airbag structure or crash cans. Feather-light, period-correct, rattly.', price: 0, weightFactor: 0.66, stiffness: -0.06, comfort: -4, noise: 3, unlockLevel: 1 },
    { id: 'lightweight', name: 'Lightweight', desc: 'Thin-gauge steel, minimal sound deadening, lightweight closures and carpets — the clubsport recipe.', price: 2500, weightFactor: 0.82, stiffness: -0.02, comfort: -2, noise: 2, unlockLevel: 2 },
    { id: 'standard', name: 'Standard', desc: 'Modern crash structure, full insulation and trim — the factory norm.', price: 0, weightFactor: 1.0, stiffness: 0, comfort: 0, noise: 0, unlockLevel: 1 },
    { id: 'reinforced', name: 'Reinforced / Luxury', desc: 'Thicker gauges, laminated acoustic glass, double-skin floors and soft-close everything — heavy, solid and silent.', price: 3000, weightFactor: 1.15, stiffness: 0.03, comfort: 3, noise: -2, unlockLevel: 2 },
    { id: 'armoured', name: 'Armoured Exoskeleton', desc: 'Ultra-hard cold-rolled stainless exoskeleton or heavy-duty ladder frame — dent-proof and enormously heavy.', price: 9000, weightFactor: 1.45, stiffness: 0.06, comfort: -1, noise: 0, unlockLevel: 6 }
  ];

  /* ======================================================================
     ENGINE
     ====================================================================== */
  var engineTypes = [
    { id: 'ice', name: 'Combustion', desc: 'Pure internal-combustion — fuel, fire and a soundtrack.', price: 0 },
    { id: 'hybrid', name: 'Hybrid', desc: 'Combustion engine plus 1–2 electric motors and a buffer battery for torque fill and efficiency.', price: 9500 },
    { id: 'ev', name: 'Full Electric', desc: 'Battery-electric — 1 to 4 motors, instant torque, silent speed.', price: 0 }
  ];

  var enginePositions = [
    { id: 'front', name: 'Front', desc: 'Engine ahead of the cabin; front-mid when mounted behind the front axle line.', price: 0 },
    { id: 'mid', name: 'Mid', desc: 'Engine behind the seats, ahead of the rear axle — lowest polar moment of inertia.', price: 6500 },
    { id: 'rear', name: 'Rear', desc: 'Engine behind the rear axle — monstrous traction, lively at the limit.', price: 3000 }
  ];

  var engineLayouts = [
    { id: 'I3', name: 'Inline-3', desc: 'Compact three-cylinder with a characterful off-beat thrum.', cylinders: 3, config: 'inline', displacementRange: [0.9, 1.6], basePrice: 3500, price: 3500, baseWeight_kg: 95, weight_kg: 95, smoothness: 0.45, length_mm: 420, soundProfile: 'thrum-triple', firingOrder: '1-2-3', specificOutputNA_hpPerL: 85, typicalRedline: 6500 },
    { id: 'I4', name: 'Inline-4', desc: 'The world\'s workhorse — light, compact, eager to be turbocharged.', cylinders: 4, config: 'inline', displacementRange: [1.4, 2.5], basePrice: 5000, price: 5000, baseWeight_kg: 130, weight_kg: 130, smoothness: 0.60, length_mm: 520, soundProfile: 'rasp-four', firingOrder: '1-3-4-2', specificOutputNA_hpPerL: 95, typicalRedline: 7000 },
    { id: 'I5', name: 'Inline-5', desc: 'Five cylinders, 1-2-4-5-3 firing — the legendary rally warble.', cylinders: 5, config: 'inline', displacementRange: [2.0, 2.8], basePrice: 9000, price: 9000, baseWeight_kg: 155, weight_kg: 155, smoothness: 0.72, length_mm: 620, soundProfile: 'warble-five', firingOrder: '1-2-4-5-3', specificOutputNA_hpPerL: 90, typicalRedline: 6800 },
    { id: 'I6', name: 'Inline-6', desc: 'Perfect primary and secondary balance — silk-smooth straight-six.', cylinders: 6, config: 'inline', displacementRange: [2.5, 4.0], basePrice: 14000, price: 14000, baseWeight_kg: 185, weight_kg: 185, smoothness: 0.98, length_mm: 750, soundProfile: 'silk-six', firingOrder: '1-5-3-6-2-4', specificOutputNA_hpPerL: 100, typicalRedline: 7200 },
    { id: 'V6', name: 'V6', desc: 'Short and stiff 60° or 90° vee — packages anywhere, loves boost.', cylinders: 6, config: 'v', bankAngle_deg: 60, displacementRange: [2.5, 4.0], basePrice: 12000, price: 12000, baseWeight_kg: 170, weight_kg: 170, smoothness: 0.78, length_mm: 560, soundProfile: 'snarl-v6', firingOrder: '1-2-3-4-5-6', specificOutputNA_hpPerL: 100, typicalRedline: 7200 },
    { id: 'V8', name: 'V8', desc: '90° V8 — cross-plane burble or flat-plane shriek, the cornerstone of performance.', cylinders: 8, config: 'v', bankAngle_deg: 90, displacementRange: [3.5, 7.0], basePrice: 22000, price: 22000, baseWeight_kg: 210, weight_kg: 210, smoothness: 0.85, length_mm: 640, soundProfile: 'burble-v8', firingOrder: '1-8-4-3-6-5-7-2', specificOutputNA_hpPerL: 105, typicalRedline: 7500 },
    { id: 'V10', name: 'V10', desc: 'Ten-cylinder screamer derived from endurance racing — 8,500 rpm of fury.', cylinders: 10, config: 'v', bankAngle_deg: 90, displacementRange: [4.8, 8.4], basePrice: 48000, price: 48000, baseWeight_kg: 245, weight_kg: 245, smoothness: 0.92, length_mm: 720, soundProfile: 'shriek-v10', firingOrder: '1-6-5-10-2-7-3-8-4-9', specificOutputNA_hpPerL: 115, typicalRedline: 8500 },
    { id: 'V12', name: 'V12', desc: '65° V12 — the pinnacle of mechanical refinement and operatic sound.', cylinders: 12, config: 'v', bankAngle_deg: 65, displacementRange: [5.0, 7.3], basePrice: 85000, price: 85000, baseWeight_kg: 280, weight_kg: 280, smoothness: 1.0, length_mm: 820, soundProfile: 'aria-v12', firingOrder: '1-7-5-11-3-9-6-12-2-8-4-10', specificOutputNA_hpPerL: 120, typicalRedline: 8700 },
    { id: 'W16', name: 'W16', desc: 'Two narrow-angle VR8s on one crank — sixteen cylinders, four turbos, absurd.', cylinders: 16, config: 'w', bankAngle_deg: 90, displacementRange: [8.0, 8.4], basePrice: 420000, price: 420000, baseWeight_kg: 400, weight_kg: 400, smoothness: 0.97, length_mm: 710, soundProfile: 'thunder-w16', firingOrder: 'W16', specificOutputNA_hpPerL: 100, typicalRedline: 6800 },
    { id: 'flat-4', name: 'Flat-4 Boxer', desc: 'Horizontally-opposed four — low centre of gravity, unmistakable rumble.', cylinders: 4, config: 'flat', bankAngle_deg: 180, displacementRange: [1.6, 2.5], basePrice: 7000, price: 7000, baseWeight_kg: 125, weight_kg: 125, smoothness: 0.70, length_mm: 450, soundProfile: 'rumble-boxer', firingOrder: '1-3-2-4', specificOutputNA_hpPerL: 95, typicalRedline: 7200 },
    { id: 'flat-6', name: 'Flat-6 Boxer', desc: 'Iconic opposed six — a 9,000 rpm motorsport howl in a compact, low package.', cylinders: 6, config: 'flat', bankAngle_deg: 180, displacementRange: [3.0, 4.2], basePrice: 26000, price: 26000, baseWeight_kg: 175, weight_kg: 175, smoothness: 0.90, length_mm: 560, soundProfile: 'howl-flat6', firingOrder: '1-6-2-4-3-5', specificOutputNA_hpPerL: 125, typicalRedline: 9000 },
    { id: 'rotary-2', name: 'Twin-Rotor Wankel', desc: 'Two triangular rotors, almost no reciprocating mass — buzzing 9,000 rpm. Displacement is piston-equivalent.', cylinders: 2, rotors: 2, config: 'rotary', displacementRange: [1.3, 2.6], basePrice: 18000, price: 18000, baseWeight_kg: 110, weight_kg: 110, smoothness: 0.95, length_mm: 400, soundProfile: 'brap-rotary', firingOrder: 'rotary', specificOutputNA_hpPerL: 120, typicalRedline: 9000 }
  ];

  var aspirations = [
    { id: 'na', name: 'Naturally Aspirated', desc: 'Atmospheric breathing — razor throttle response, power rises with rpm.', price: 0, weight_kg: 0, lag: 0.0, powerMult: 1.0, maxBoost_bar: 0, typicalBoost_bar: 0, torqueShape: 'peaky' },
    { id: 'turbo', name: 'Single Turbo', desc: 'One exhaust-driven turbocharger — big midrange, some spool lag.', price: 4500, weight_kg: 18, lag: 0.45, powerMult: 1.35, maxBoost_bar: 2.0, typicalBoost_bar: 1.2, torqueShape: 'plateau' },
    { id: 'twin-turbo', name: 'Twin Turbo', desc: 'One turbo per bank or sequential pair — quicker spool, broad plateau.', price: 8500, weight_kg: 30, lag: 0.30, powerMult: 1.45, maxBoost_bar: 2.2, typicalBoost_bar: 1.2, torqueShape: 'plateau' },
    { id: 'quad-turbo', name: 'Quad Turbo', desc: 'Four sequential turbos — hypercar power with surprisingly little lag.', price: 28000, weight_kg: 55, lag: 0.25, powerMult: 1.60, maxBoost_bar: 3.0, typicalBoost_bar: 1.8, torqueShape: 'plateau' },
    { id: 'supercharged', name: 'Supercharger', desc: 'Crank-driven positive-displacement blower — instant, linear, whining.', price: 6500, weight_kg: 25, lag: 0.0, powerMult: 1.35, maxBoost_bar: 1.2, typicalBoost_bar: 0.8, torqueShape: 'linear' },
    { id: 'twincharged', name: 'Twincharged', desc: 'Supercharger fills the bottom end, turbo takes over up top — no hole anywhere.', price: 14000, weight_kg: 40, lag: 0.10, powerMult: 1.50, maxBoost_bar: 2.5, typicalBoost_bar: 1.5, torqueShape: 'plateau' },
    { id: 'electric-turbo', name: 'E-Turbo (MGU-H)', desc: '48V motor on the turbo shaft — zero-lag spool and energy recovery, F1-derived.', price: 18000, weight_kg: 28, lag: 0.05, powerMult: 1.45, maxBoost_bar: 2.5, typicalBoost_bar: 1.5, torqueShape: 'plateau' }
  ];

  /**
   * Effective compression = static CR × sqrt(1 + boost_bar). Compared against fuels[].knockLimit.
   * e.g. 10.0:1 at 1.2 bar → 14.8 (safe on premium, 15.5).
   */
  function effectiveCompression(cr, boost_bar) {
    return Number(cr) * Math.sqrt(1 + Math.max(0, Number(boost_bar) || 0));
  }

  var fuels = [
    { id: 'regular', name: 'Regular 91 RON', desc: 'Pump regular (87 AKI). Cheap, knock-limited under boost.', price: 0, octane: 91, knockLimit: 13.5, energyFactor: 1.0, powerPotential: 0.97, co2Factor: 2.31, pricePerUnit: 0.95, unit: 'L' },
    { id: 'premium', name: 'Premium 98 RON', desc: 'Super-unleaded (93 AKI) — the reference fuel for performance engines.', price: 0, octane: 98, knockLimit: 15.5, energyFactor: 1.0, powerPotential: 1.0, co2Factor: 2.31, pricePerUnit: 1.15, unit: 'L' },
    { id: 'e85', name: 'E85 Ethanol', desc: '85% ethanol — huge knock resistance and charge cooling, 30% more fuel burned.', price: 1200, octane: 105, knockLimit: 18.5, energyFactor: 0.72, powerPotential: 1.08, co2Factor: 1.60, pricePerUnit: 0.85, unit: 'L' },
    { id: 'race', name: 'Race Fuel 102 RON', desc: 'Leaded-free race gasoline — maximum timing advance, eye-watering price.', price: 800, octane: 102, knockLimit: 20.0, energyFactor: 1.02, powerPotential: 1.10, co2Factor: 2.40, pricePerUnit: 3.50, unit: 'L' },
    { id: 'diesel', name: 'Diesel', desc: 'Compression ignition — massive low-rpm torque and range, 5,200 rpm ceiling.', price: 2500, octane: 0, cetane: 51, knockLimit: 99, energyFactor: 1.13, powerPotential: 0.85, co2Factor: 2.68, pricePerUnit: 1.05, unit: 'L', redlineCap_rpm: 5200 }
  ];

  var tunes = [
    { id: 'eco', name: 'Eco Map', desc: 'Lean cruise, early upshifts, softened throttle — maximum mpg and longevity.', price: 0, powerMult: 0.90, reliabilityHit: -0.05, efficiencyMult: 1.08 },
    { id: 'stock', name: 'Factory Calibration', desc: 'Factory-validated map with full warranty and emissions compliance.', price: 0, powerMult: 1.0, reliabilityHit: 0, efficiencyMult: 1.0 },
    { id: 'stage1', name: 'Stage 1', desc: 'ECU reflash: more boost and timing on stock hardware. ~+12%.', price: 1200, powerMult: 1.12, reliabilityHit: 0.05, efficiencyMult: 0.98 },
    { id: 'stage2', name: 'Stage 2', desc: 'Intake, downpipe, intercooler and map — ~+25%, needs premium fuel.', price: 3800, powerMult: 1.25, reliabilityHit: 0.12, efficiencyMult: 0.95 },
    { id: 'stage3', name: 'Stage 3', desc: 'Hybrid turbo, forged internals, injectors — ~+40%, track-day hero.', price: 9500, powerMult: 1.40, reliabilityHit: 0.25, efficiencyMult: 0.90 },
    { id: 'time-attack', name: 'Time Attack', desc: 'Qualifying-spec map with anti-lag and launch rev-limiter — ~+60%, rebuild intervals measured in hours.', price: 24000, powerMult: 1.60, reliabilityHit: 0.45, efficiencyMult: 0.82 }
  ];

  var exhausts = [
    { id: 'stock', name: 'Factory Exhaust', desc: 'Twin-catalyst system with resonators — quiet, compliant.', price: 0, weight_kg: 0, powerMult: 1.0, loudness_db: 82, tipStyle: 'hidden', tipCount: 2 },
    { id: 'sport', name: 'Sport Exhaust', desc: 'Freer-flowing cat-back with dual round tips and a crisper bark.', price: 2800, weight_kg: -4, powerMult: 1.03, loudness_db: 92, tipStyle: 'round', tipCount: 2 },
    { id: 'titanium', name: 'Titanium Race', desc: 'Hand-welded grade-2 titanium with heat-blued quad tips — 12 kg lighter.', price: 9500, weight_kg: -12, powerMult: 1.05, loudness_db: 96, tipStyle: 'blued', tipCount: 4 },
    { id: 'straight-pipe', name: 'Straight Pipe', desc: 'Catless, muffler-delete centre exit. Glorious. Absolutely not street legal.', price: 1800, weight_kg: -15, powerMult: 1.07, loudness_db: 112, tipStyle: 'center', tipCount: 1 },
    { id: 'valvetronic', name: 'Valvetronic Active', desc: 'Electrically actuated bypass valves — whisper at dawn, roar at the redline.', price: 5200, weight_kg: -2, powerMult: 1.04, loudness_db: 98, loudnessQuiet_db: 84, tipStyle: 'oval', tipCount: 4 }
  ];

  var coolings = [
    { id: 'standard', name: 'Standard Cooling', desc: 'OEM radiator and oil cooler sized for road use.', price: 0, weight_kg: 0, heatCapacity: 1.0 },
    { id: 'uprated', name: 'Uprated Cooling', desc: 'Larger aluminium radiator, auxiliary oil and transmission coolers.', price: 1800, weight_kg: 4, heatCapacity: 1.3 },
    { id: 'race', name: 'Endurance Race Cooling', desc: 'Twin side radiators, dry-sump oil cooler, ducted brake cooling — 24-hour proven.', price: 5200, weight_kg: 9, heatCapacity: 1.7 }
  ];

  var batteryChemistries = [
    { id: 'lfp', name: 'LFP (Lithium Iron Phosphate)', desc: 'Cobalt-free, very durable and safe; heavier per kWh.', price: 0, whPerKg: 140, pricePerKwh: 95, cRate: 3, cycleLife: 4000, coldPerformance: 0.75 },
    { id: 'nmc', name: 'NMC 811', desc: 'Nickel-manganese-cobalt — the balanced performance chemistry.', price: 0, whPerKg: 180, pricePerKwh: 135, cRate: 4, cycleLife: 1500, coldPerformance: 0.85 },
    { id: 'nca', name: 'NCA High-Power', desc: 'Nickel-cobalt-aluminium cylindrical cells — highest discharge rates.', price: 0, whPerKg: 200, pricePerKwh: 150, cRate: 5, cycleLife: 1200, coldPerformance: 0.82 },
    { id: 'solid-state', name: 'Solid-State', desc: 'Ceramic electrolyte, lithium-metal anode — 320 Wh/kg at pack level, 10-minute charging.', price: 0, whPerKg: 320, pricePerKwh: 320, cRate: 8, cycleLife: 3000, coldPerformance: 0.92 }
  ];

  var voltages = [
    { id: 400, name: '400 V', desc: 'Conventional architecture, up to ~150 kW DC charging.', price: 0 },
    { id: 800, name: '800 V', desc: 'Silicon-carbide inverters, thinner cabling, 350 kW charging.', price: 3500 }
  ];

  /* ======================================================================
     TRANSMISSION
     ====================================================================== */
  function r2(n) { return Math.round(n * 100) / 100; }

  /**
   * Build a defaultRatios(gears) function that yields a realistic progressive geometric series:
   * ln(r_i) = ln(first) + (ln(top) - ln(first)) * (i/(n-1))^p,  p < 1 makes upper gears closer (like real boxes).
   * First/top ratios widen as gear count grows.
   */
  function ratioFn(cfg) {
    return function defaultRatios(gears) {
      var n = Math.round(Number(gears) || cfg.ref);
      n = Math.max(cfg.range[0], Math.min(cfg.range[1], n));
      if (n <= 1) return [cfg.single];
      var first = cfg.first + (n - cfg.ref) * cfg.firstPerGear;
      var top = Math.max(0.5, cfg.top - (n - cfg.ref) * cfg.topPerGear);
      var out = [];
      for (var i = 0; i < n; i++) {
        var t = Math.pow(i / (n - 1), cfg.p);
        out.push(r2(Math.exp(Math.log(first) + (Math.log(top) - Math.log(first)) * t)));
      }
      for (var j = 1; j < out.length; j++) if (out[j] >= out[j - 1]) out[j] = r2(out[j - 1] - 0.01);
      return out;
    };
  }

  var transmissions = [
    { id: 'manual', name: 'Manual Gearbox', desc: 'H-pattern with a twin-plate clutch and rev-matching — maximum involvement.', gearRange: [5, 7], shiftTime_s: 0.45, efficiency: 0.95, price: 0, weight_kg: 55, torqueLimit_nm: 800, clutchPedal: true,
      defaultRatios: ratioFn({ range: [5, 7], ref: 6, first: 3.45, top: 0.78, firstPerGear: 0.12, topPerGear: 0.05, p: 0.80 }) },
    { id: 'dct', name: 'Dual-Clutch (DCT)', desc: 'Wet twin-clutch with pre-selected gears — 80 ms shifts without interruption.', gearRange: [6, 9], shiftTime_s: 0.08, efficiency: 0.93, price: 4500, weight_kg: 82, torqueLimit_nm: 1100,
      defaultRatios: ratioFn({ range: [6, 9], ref: 7, first: 3.80, top: 0.78, firstPerGear: 0.15, topPerGear: 0.04, p: 0.82 }) },
    { id: 'auto', name: 'Torque-Converter Automatic', desc: 'Planetary automatic with lock-up clutch — silky, tough, tow-rated.', gearRange: [6, 10], shiftTime_s: 0.25, efficiency: 0.90, price: 3200, weight_kg: 95, torqueLimit_nm: 1500,
      defaultRatios: ratioFn({ range: [6, 10], ref: 8, first: 4.70, top: 0.67, firstPerGear: 0.15, topPerGear: 0.02, p: 0.78 }) },
    { id: 'cvt', name: 'CVT', desc: 'Steel-belt continuously variable transmission — always in the efficient band. Ratio shown is the lowest pulley ratio.', gearRange: [1, 1], shiftTime_s: 0, efficiency: 0.87, price: 1800, weight_kg: 70, torqueLimit_nm: 400, ratioSpan: [2.63, 0.40],
      defaultRatios: ratioFn({ range: [1, 1], ref: 1, single: 2.63 }) },
    { id: 'sequential', name: 'Sequential Dog-Box', desc: 'Straight-cut dog engagement, paddle or lever — 50 ms shifts, race-close ratios, loud whine.', gearRange: [5, 8], shiftTime_s: 0.05, efficiency: 0.94, price: 18000, weight_kg: 60, torqueLimit_nm: 1000,
      defaultRatios: ratioFn({ range: [5, 8], ref: 6, first: 2.90, top: 0.95, firstPerGear: 0.10, topPerGear: 0.04, p: 0.90 }) },
    { id: 'single-speed', name: 'Single-Speed Reduction', desc: 'Fixed planetary reduction for electric motors — seamless to top speed.', gearRange: [1, 1], shiftTime_s: 0, efficiency: 0.97, price: 0, weight_kg: 35, torqueLimit_nm: 3000,
      defaultRatios: ratioFn({ range: [1, 1], ref: 1, single: 2.65 }) }
  ];

  var differentials = [
    { id: 'none', name: 'None', desc: 'No differential on this axle (undriven).', price: 0, weight_kg: 0, lockFactor: 0 },
    { id: 'open', name: 'Open Differential', desc: 'Simple bevel gearset — smooth, but sends torque to the wheel with least grip.', price: 0, weight_kg: 0, lockFactor: 0 },
    { id: 'lsd-viscous', name: 'Viscous LSD', desc: 'Silicone-fluid coupling locks progressively with speed difference.', price: 900, weight_kg: 2, lockFactor: 0.35 },
    { id: 'lsd-clutch', name: 'Clutch-Pack LSD', desc: 'Ramp-and-plate mechanical LSD — adjustable preload, the track favourite.', price: 1800, weight_kg: 3, lockFactor: 0.60 },
    { id: 'lsd-torsen', name: 'Torsen Helical LSD', desc: 'Worm-gear torque-sensing diff — seamless, maintenance-free bias.', price: 1500, weight_kg: 3, lockFactor: 0.50 },
    { id: 'e-diff', name: 'Electronic e-Diff', desc: 'Hydraulically controlled multi-plate — 0–100% lock in milliseconds, map-adjustable.', price: 3500, weight_kg: 5, lockFactor: 0.75 },
    { id: 'locking', name: 'Locking Differential', desc: 'Selectable 100% mechanical lock for rock crawling and deep mud.', price: 1200, weight_kg: 4, lockFactor: 1.0 }
  ];

  var drivetrainLayouts = [
    { id: 'fwd', name: 'Front-Wheel Drive', desc: 'Light and space-efficient; traction limited under hard acceleration.', price: 0, weight_kg: 0 },
    { id: 'rwd', name: 'Rear-Wheel Drive', desc: 'Pure steering, throttle adjustability, classic balance.', price: 0, weight_kg: 0 },
    { id: 'awd', name: 'All-Wheel Drive', desc: 'Torque to all four corners — all-weather launches, extra mass and losses.', price: 4500, weight_kg: 70 }
  ];

  /* ======================================================================
     CHASSIS
     ====================================================================== */
  var suspensionTypes = [
    { id: 'macpherson', name: 'MacPherson Strut', desc: 'Compact strut — cost-effective, used in WRC, camber gain is limited.', price: 0, weight_kg: 0, gripMult: 0.96, comfortMult: 0.88, rideHeightRange: [90, 220], adjustable: false },
    { id: 'double-wishbone', name: 'Double Wishbone', desc: 'Unequal-length arms keep the tyre flat under roll — sports car staple.', price: 2500, weight_kg: 6, gripMult: 1.02, comfortMult: 0.86, rideHeightRange: [80, 300], adjustable: false },
    { id: 'multilink', name: 'Five-Link Multilink', desc: 'Separates longitudinal and lateral compliance — refined yet precise.', price: 1800, weight_kg: 8, gripMult: 1.00, comfortMult: 0.95, rideHeightRange: [90, 240], adjustable: false },
    { id: 'pushrod', name: 'Inboard Pushrod', desc: 'Dampers mounted inboard via rockers — minimal unsprung mass, race-car kinematics.', price: 14000, weight_kg: -4, gripMult: 1.08, comfortMult: 0.60, rideHeightRange: [50, 140], adjustable: true },
    { id: 'air', name: 'Adaptive Air', desc: 'Self-levelling air springs with lift and kneel modes — magic-carpet ride.', price: 6500, weight_kg: 22, gripMult: 0.97, comfortMult: 1.00, rideHeightRange: [60, 250], adjustable: true },
    { id: 'magnetic', name: 'Magnetorheological', desc: 'Iron-particle fluid dampers re-tuned 1,000 times a second.', price: 7800, weight_kg: 10, gripMult: 1.03, comfortMult: 0.95, rideHeightRange: [80, 180], adjustable: true },
    { id: 'coilover-track', name: 'Track Coilovers', desc: 'Three-way adjustable coilovers with spherical bearings — firm, precise, height-adjustable.', price: 5500, weight_kg: -2, gripMult: 1.06, comfortMult: 0.55, rideHeightRange: [55, 160], adjustable: true }
  ];

  var brakeMaterials = [
    { id: 'iron', name: 'Cast Iron', desc: 'Vented grey-iron rotors — strong initial bite, fades under repeated stops.', price: 0, weightPerRotor_kg: 11, fadeResistance: 0.45, frictionMult: 1.0, minWheel_in: 15 },
    { id: 'drilled-slotted', name: 'Drilled & Slotted', desc: 'Cross-drilled, slotted iron for degassing and wet-weather bite.', price: 1600, weightPerRotor_kg: 10.5, fadeResistance: 0.60, frictionMult: 1.03, minWheel_in: 16 },
    { id: 'two-piece', name: 'Two-Piece Floating', desc: 'Iron rings on aluminium bells — less unsprung mass, no coning when hot.', price: 4800, weightPerRotor_kg: 8.5, fadeResistance: 0.75, frictionMult: 1.05, minWheel_in: 17 },
    { id: 'carbon-ceramic', name: 'Carbon-Ceramic', desc: 'Silicon-carbide reinforced carbon — half the weight, no fade, 300,000 km life.', price: 12500, weightPerRotor_kg: 5, fadeResistance: 0.95, frictionMult: 1.10, minWheel_in: 19 }
  ];

  var pistonOptions = [1, 2, 4, 6, 8, 10];

  var absModes = [
    { id: 'standard', name: 'Standard ABS', desc: 'Conservative intervention tuned for wet roads.', price: 0 },
    { id: 'sport', name: 'Sport ABS', desc: 'Allows more slip for trail-braking.', price: 600 },
    { id: 'race', name: 'Race ABS', desc: 'Motorsport-calibrated, 12-position adjustable map.', price: 2400 },
    { id: 'off', name: 'ABS Off', desc: 'No anti-lock — pure pedal feel. Not road legal in most markets.', price: 0 }
  ];

  var wheelDesigns = [
    { id: 'y-spoke', name: 'Vortice Y-Spoke', desc: 'Five twisted Y-spokes — a signature Redline design.', price: 0, spokes: 5, style: 'y', concavity: 0.4 },
    { id: 'split-10', name: 'Gemini Split 10', desc: 'Ten split spokes with a deep concave face.', price: 1200, spokes: 10, style: 'split', concavity: 0.7 },
    { id: 'twin-7', name: 'Sette Twin-7', desc: 'Seven pairs of slender spokes for a jewel-like look.', price: 1400, spokes: 7, style: 'split', concavity: 0.5 },
    { id: 'mesh-bbs', name: 'Cross-Mesh', desc: 'Classic cross-spoke mesh with polished lip — 90s touring car icon.', price: 1800, spokes: 20, style: 'mesh', concavity: 0.3 },
    { id: 'multi-spoke', name: 'Filigrana 20', desc: 'Twenty fine spokes radiating from a small hub.', price: 1600, spokes: 20, style: 'mesh', concavity: 0.45 },
    { id: 'turbine', name: 'Turbina', desc: 'Curved fan blades that pump air through the brakes.', price: 2200, spokes: 12, style: 'turbine', concavity: 0.35 },
    { id: 'fan-blade', name: 'Ventola Fan', desc: 'Retro rotary "fan" disc from 1980s Group B.', price: 1500, spokes: 9, style: 'turbine', concavity: 0.2 },
    { id: 'monoblock-5', name: 'Monoblocco 5', desc: 'Chunky five-spoke monoblock — timeless and easy to clean.', price: 600, spokes: 5, style: 'monoblock', concavity: 0.25 },
    { id: 'monoblock-6', name: 'Sei Monoblock', desc: 'Six-spoke rally-style monoblock with motorsport hex hub.', price: 900, spokes: 6, style: 'monoblock', concavity: 0.3 },
    { id: 'classic-5', name: 'Stella Five-Star', desc: 'Polished five-star in the 1960s Gran Turismo idiom.', price: 1000, spokes: 5, style: 'monoblock', concavity: 0.15 },
    { id: 'deep-dish', name: 'Profondo Dish', desc: 'Stepped deep-dish lip with eight short spokes — pure stance.', price: 2600, spokes: 8, style: 'dish', concavity: 0.9 },
    { id: 'beadlock', name: 'Dune Beadlock', desc: 'Bolted beadlock ring clamps the tyre for airing-down off-road.', price: 2900, spokes: 8, style: 'dish', concavity: 0.6 },
    { id: 'centerlock-race', name: 'Corsa Centre-Lock', desc: 'Single-nut centre-lock race wheel with ten spokes.', price: 4800, spokes: 10, style: 'centerlock', concavity: 0.6 },
    { id: 'aero-disc', name: 'Aero Disc', desc: 'Flush carbon aero cover — up to 2% less drag.', price: 3200, spokes: 0, style: 'aero-disc', concavity: 0.0, dragDelta: -0.004 },
    { id: 'aero-blade', name: 'Lamina Aero Blade', desc: 'Closed-face efficiency blades, ideal for EVs and hybrids.', price: 1400, spokes: 5, style: 'aero-disc', concavity: 0.1, dragDelta: -0.003 }
  ];

  var wheelMaterials = [
    { id: 'steel', name: 'Pressed Steel', desc: 'Nearly indestructible; heavy.', price: -800, weightFactor: 1.35 },
    { id: 'cast', name: 'Cast Aluminium', desc: 'Low-pressure cast alloy — the default.', price: 0, weightFactor: 1.0 },
    { id: 'flow-formed', name: 'Flow-Formed', desc: 'Barrel spun under pressure for forged-like strength.', price: 1600, weightFactor: 0.90 },
    { id: 'forged', name: 'Forged Aluminium', desc: 'Machined from 6061-T6 billet forgings — strong and light.', price: 5800, weightFactor: 0.78 },
    { id: 'magnesium', name: 'Forged Magnesium', desc: 'Racing magnesium alloy — another 13% lighter than forged aluminium.', price: 11000, weightFactor: 0.68 },
    { id: 'carbon', name: 'One-Piece Carbon', desc: 'Monocoque carbon-fibre wheels — the lightest rolling stock money can buy.', price: 16000, weightFactor: 0.55 }
  ];

  var tireCompounds = [
    { id: 'eco', name: 'Low-Rolling-Resistance Eco', desc: 'Silica-rich, hard compound — minimises energy loss, longest tread life.', price: 160, mu: 0.82, wetMu: 0.75, snowMu: 0.25, rollingResistance: 0.0070, treadwear: 700, noise: 66, streetLegal: true },
    { id: 'all-season', name: 'All-Season / All-Terrain', desc: 'Siped tread for rain, light snow and gravel.', price: 190, mu: 0.88, wetMu: 0.78, snowMu: 0.45, rollingResistance: 0.0090, treadwear: 600, noise: 68, streetLegal: true },
    { id: 'winter', name: 'Nordic Winter', desc: 'Soft compound, 3PMSF rated with thousands of sipes.', price: 230, mu: 0.80, wetMu: 0.82, snowMu: 0.75, rollingResistance: 0.0110, treadwear: 400, noise: 70, streetLegal: true },
    { id: 'touring', name: 'Grand Touring', desc: 'Quiet, comfortable and long-lasting with good wet grip.', price: 220, mu: 0.92, wetMu: 0.82, snowMu: 0.30, rollingResistance: 0.0085, treadwear: 500, noise: 67, streetLegal: true },
    { id: 'performance', name: 'Max Performance', desc: 'Summer UHP tyre — sharp turn-in, strong wet braking.', price: 290, mu: 1.02, wetMu: 0.85, snowMu: 0.10, rollingResistance: 0.0100, treadwear: 300, noise: 70, streetLegal: true },
    { id: 'super-sport', name: 'Super Sport', desc: 'Bespoke OE supercar tyre — two-compound tread, track capable.', price: 380, mu: 1.12, wetMu: 0.82, snowMu: 0.05, rollingResistance: 0.0110, treadwear: 200, noise: 72, streetLegal: true },
    { id: 'track', name: 'Semi-Slick Cup', desc: 'DOT-legal R-compound with minimal tread — needs heat to work.', price: 450, mu: 1.28, wetMu: 0.65, snowMu: 0.0, rollingResistance: 0.0120, treadwear: 100, noise: 75, streetLegal: true },
    { id: 'slick', name: 'Racing Slick', desc: 'Treadless race tyre — sensational dry grip, lethal in the wet. Track use only.', price: 600, mu: 1.55, wetMu: 0.25, snowMu: 0.0, rollingResistance: 0.0130, treadwear: 40, noise: 78, streetLegal: false }
  ];

  /* Tyre speed rating (top-speed certification). 'compound' = the compound's own rating (TYRE_SPEED_RATING in
     CB.physics: eco / all-season 210, winter 240, touring 270, performance & track 300, super-sport 360, slick 420).
     Prices are per vehicle. Builds saved before this option existed load as 'compound'. */
  var tireSpeedRatings = [
    { id: 'compound', name: 'Compound default', desc: 'The rating the chosen compound is normally sold with.', price: 0, kph: null, unlockLevel: 1 },
    { id: 'H', name: 'H — 210 km/h', desc: 'Comfort-oriented sidewall for family cars and vans.', price: 0, kph: 210, unlockLevel: 1 },
    { id: 'V', name: 'V — 240 km/h', desc: 'Everyday sporty saloons and SUVs.', price: 0, kph: 240, unlockLevel: 1 },
    { id: 'W', name: 'W — 270 km/h', desc: 'Fast GTs and hot hatches.', price: 0, kph: 270, unlockLevel: 1 },
    { id: 'Y', name: 'Y — 300 km/h', desc: 'Autobahn-proof ultra-high-performance construction.', price: 0, kph: 300, unlockLevel: 1 },
    { id: 'Y+', name: '(Y) — 360 km/h', desc: 'Manufacturer-certified above 300 km/h — supercar OE fitment.', price: 900, kph: 360, unlockLevel: 6 },
    { id: 'hyper', name: 'Hypercar — 450 km/h', desc: 'Cup-style bespoke construction validated beyond 400 km/h (Chiron / Jesko class). Needs a Super Sport or Cup compound.', price: 9000, kph: 450, unlockLevel: 14 }
  ];

  /* Electronic speed limiter (ECU top-speed cap). 0 = off. German makers' 250 km/h agreement, Japan's 180, van / truck
     governors. Builds saved before this option existed load with the limiter off. */
  var speedLimiters = [
    { id: 0, name: 'Off', desc: 'No electronic cap — drag, gearing or tyres decide the top speed.', price: 0 },
    { id: 150, name: '150 km/h', desc: 'Range-saving cap of an electric van.', price: 0 },
    { id: 160, name: '160 km/h', desc: 'Fleet / van governor.', price: 0 },
    { id: 170, name: '170 km/h', desc: 'Off-road-tyre pickup governor.', price: 0 },
    { id: 180, name: '180 km/h', desc: 'Japanese-market cap and off-roader governor.', price: 0 },
    { id: 190, name: '190 km/h', desc: 'Utility cap.', price: 0 },
    { id: 200, name: '200 km/h', desc: 'All-terrain-tyre governor.', price: 0 },
    { id: 210, name: '210 km/h', desc: 'Electric-truck cap.', price: 0 },
    { id: 230, name: '230 km/h', desc: 'Hot-hatch cap.', price: 0 },
    { id: 240, name: '240 km/h', desc: 'Electric GT cap.', price: 0 },
    { id: 250, name: '250 km/h', desc: 'The German manufacturers\' gentlemen\'s agreement.', price: 0 },
    { id: 260, name: '260 km/h', desc: 'Sports-car cap.', price: 0 },
    { id: 270, name: '270 km/h', desc: 'Raised limiter of a driver\'s package.', price: 0 },
    { id: 280, name: '280 km/h', desc: 'AMG / M driver\'s package.', price: 0 },
    { id: 290, name: '290 km/h', desc: 'Raised super-saloon limiter.', price: 0 },
    { id: 305, name: '305 km/h', desc: 'Track-package limiter.', price: 0 },
    { id: 320, name: '320 km/h', desc: 'Supercar cap.', price: 0 },
    { id: 350, name: '350 km/h', desc: 'Hybrid-hypercar cap.', price: 0 },
    { id: 420, name: '420 km/h', desc: 'Hypercar "speed key" cap.', price: 0 }
  ];

  var aero = {
    splitters: [
      { id: 'none', name: 'No Splitter', desc: 'Clean factory front bumper.', price: 0, downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0 },
      { id: 'lip', name: 'Front Lip', desc: 'Subtle body-colour lip that trims front lift.', price: 900, downforce_kg_at_200: 15, dragDelta: 0.002, weight_kg: 2 },
      { id: 'carbon', name: 'Carbon Splitter', desc: 'Exposed-weave carbon splitter with endplates.', price: 3200, downforce_kg_at_200: 35, dragDelta: 0.004, weight_kg: 3 },
      { id: 'race', name: 'Race Splitter', desc: 'Extended flat splitter with support rods and dive planes ready.', price: 6800, downforce_kg_at_200: 70, dragDelta: 0.010, weight_kg: 6 }
    ],
    wings: [
      { id: 'none', name: 'No Wing', desc: 'Uncluttered tail.', price: 0, downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0, adjustable: false },
      { id: 'ducktail', name: 'Ducktail', desc: 'Upswept integrated tail in the 1973 Carrera RS tradition.', price: 1500, downforce_kg_at_200: 20, dragDelta: 0.002, weight_kg: 4, adjustable: false },
      { id: 'lip-spoiler', name: 'Lip Spoiler', desc: 'Small trunk-lid spoiler for high-speed stability.', price: 800, downforce_kg_at_200: 12, dragDelta: 0.0, weight_kg: 2, adjustable: false },
      { id: 'swan-neck', name: 'Swan-Neck Wing', desc: 'Top-mounted wing keeps the efficient underside clean — GTE practice.', price: 9500, downforce_kg_at_200: 150, dragDelta: 0.030, weight_kg: 9, adjustable: true },
      { id: 'gt-wing', name: 'GT Wing', desc: 'Pedestal-mounted chassis wing with adjustable element.', price: 6500, downforce_kg_at_200: 180, dragDelta: 0.040, weight_kg: 11, adjustable: true },
      { id: 'active', name: 'Active Aero Wing', desc: 'Hydraulic wing — flat for top speed, steep for corners, airbrake under braking.', price: 14000, downforce_kg_at_200: 120, dragDelta: 0.010, weight_kg: 14, adjustable: true, active: true },
      { id: 'biplane', name: 'Biplane Wing', desc: 'Twin-element stacked wing — maximum downforce, maximum drag.', price: 12000, downforce_kg_at_200: 260, dragDelta: 0.060, weight_kg: 16, adjustable: true }
    ],
    diffusers: [
      { id: 'none', name: 'No Diffuser', desc: 'Plain rear valance.', price: 0, downforce_kg_at_200: 0, dragDelta: 0, weight_kg: 0 },
      { id: 'mild', name: 'Sport Diffuser', desc: 'Three-strake diffuser that tidies under-body flow.', price: 1200, downforce_kg_at_200: 15, dragDelta: -0.003, weight_kg: 3 },
      { id: 'carbon', name: 'Carbon Diffuser', desc: 'Five-strake carbon diffuser with flat under-tray.', price: 4500, downforce_kg_at_200: 40, dragDelta: -0.005, weight_kg: 5 },
      { id: 'race', name: 'Race Venturi Diffuser', desc: 'Full-width venturi tunnels — ground-effect downforce.', price: 9000, downforce_kg_at_200: 85, dragDelta: 0.0, weight_kg: 9 }
    ]
  };

  /* ======================================================================
     WEIGHT / ACCESSORY OPTIONS
     ====================================================================== */
  var glassTypes = [
    { id: 'standard', name: 'Laminated Glass', desc: 'Acoustic laminated windscreen and side glass.', price: 0, weight_kg: 0 },
    { id: 'thin', name: 'Thin Gorilla Glass', desc: 'Chemically strengthened thin glass — 8 kg saving.', price: 1900, weight_kg: -8 },
    { id: 'polycarbonate', name: 'Polycarbonate', desc: 'Race-spec Lexan side and rear windows — 18 kg saving.', price: 4200, weight_kg: -18 }
  ];
  var batteryTypes = [
    { id: 'lead', name: 'Lead-Acid 12V', desc: 'Standard AGM starter battery.', price: 0, weight_kg: 0 },
    { id: 'lithium', name: 'Lithium 12V', desc: 'Motorsport lithium-iron starter battery — 12 kg lighter.', price: 1600, weight_kg: -12 }
  ];
  var rollCages = [
    { id: 'none', name: 'No Cage', desc: 'Factory safety cell only.', price: 0, weight_kg: 0, stiffnessGain: 0 },
    { id: 'half', name: 'Bolt-in Half Cage', desc: 'Main hoop and rear stays — club track days.', price: 3800, weight_kg: 22, stiffnessGain: 0.05 },
    { id: 'full', name: 'FIA Welded Full Cage', desc: 'Seam-welded multipoint cage tied into the strut towers.', price: 7900, weight_kg: 45, stiffnessGain: 0.12 }
  ];
  var ballastPositions = [
    { id: 'front', name: 'Front', desc: 'Ahead of the front axle line.', price: 0 },
    { id: 'center', name: 'Centre', desc: 'Passenger footwell — neutral.', price: 0 },
    { id: 'rear', name: 'Rear', desc: 'Boot floor, over the rear axle.', price: 0 }
  ];

  /* ======================================================================
     EXTERIOR
     ====================================================================== */
  var paintFinishes = [
    { id: 'solid', name: 'Solid Gloss', desc: 'Single-stage solid colour with clear coat.', price: 0, gloss: 0.85, metallic: 0, flake: false },
    { id: 'metallic', name: 'Metallic', desc: 'Aluminium flake suspended in the base coat.', price: 1200, gloss: 0.90, metallic: 0.5, flake: true },
    { id: 'pearl', name: 'Tri-Coat Pearl', desc: 'Mica pearlescent mid-coat that shifts with light.', price: 2800, gloss: 0.92, metallic: 0.35, flake: true },
    { id: 'matte', name: 'Matte', desc: 'Flat clear coat — sinister, but requires careful care.', price: 5500, gloss: 0.10, metallic: 0.2, flake: false },
    { id: 'satin', name: 'Satin', desc: 'Silk-sheen clear between gloss and matte.', price: 4200, gloss: 0.40, metallic: 0.3, flake: false },
    { id: 'chrome', name: 'Liquid Chrome', desc: 'Mirror-finish vacuum-metallised paint. Show-stopping.', price: 22000, gloss: 1.0, metallic: 1.0, flake: false },
    { id: 'candy', name: 'Candy', desc: 'Tinted translucent clear over a silver base — deep, glowing colour.', price: 7500, gloss: 0.97, metallic: 0.6, flake: true },
    { id: 'chameleon', name: 'Chameleon Flip', desc: 'Multi-layer interference pigment flipping through three hues.', price: 15000, gloss: 0.95, metallic: 0.7, flake: true, hueShift_deg: 70 }
  ];

  var paintSwatches = [
    { name: 'Rosso Corsa', hex: '#d40000', family: 'red' },
    { name: 'Rosso Mugello', hex: '#7b0d12', family: 'red' },
    { name: 'Guards Red', hex: '#c8102e', family: 'red' },
    { name: 'Soul Red Crystal', hex: '#9b111e', family: 'red' },
    { name: 'Redline Garnet', hex: '#b3121f', family: 'red' },
    { name: 'Bordeaux', hex: '#5c0f1e', family: 'red' },
    { name: 'Giallo Modena', hex: '#f6c200', family: 'yellow' },
    { name: 'Speed Yellow', hex: '#f9d71c', family: 'yellow' },
    { name: 'Arancio Borealis', hex: '#ff6a13', family: 'orange' },
    { name: 'Gulf Orange', hex: '#f37021', family: 'orange' },
    { name: 'Hugger Orange', hex: '#ff6f1a', family: 'orange' },
    { name: 'Lava Orange', hex: '#ff4f00', family: 'orange' },
    { name: 'British Racing Green', hex: '#004225', family: 'green' },
    { name: 'Verde Mantis', hex: '#6dbf2c', family: 'green' },
    { name: 'Python Green', hex: '#5fb33b', family: 'green' },
    { name: 'Sublime Green', hex: '#a8d82c', family: 'green' },
    { name: 'Mint Green', hex: '#8fd1b0', family: 'green' },
    { name: 'Pangea Green', hex: '#4f5b3a', family: 'green' },
    { name: 'Gulf Blue', hex: '#7fb2e5', family: 'blue' },
    { name: 'Miami Blue', hex: '#00a3d9', family: 'blue' },
    { name: 'Riviera Blue', hex: '#1f8ac0', family: 'blue' },
    { name: 'Grabber Blue', hex: '#1a6fc2', family: 'blue' },
    { name: 'Bayside Blue', hex: '#1f3e8c', family: 'blue' },
    { name: 'Blu Le Mans', hex: '#1b3d8f', family: 'blue' },
    { name: 'Mulsanne Blue', hex: '#1a3a6d', family: 'blue' },
    { name: 'Midnight Blue', hex: '#0f1c3f', family: 'blue' },
    { name: 'Azzurro California', hex: '#8ec1e4', family: 'blue' },
    { name: 'Plum Crazy', hex: '#5a2d82', family: 'purple' },
    { name: 'Ultra Violet', hex: '#4b2c7a', family: 'purple' },
    { name: 'Midnight Purple', hex: '#2b1b3d', family: 'purple' },
    { name: 'Champagne Gold', hex: '#c9b37e', family: 'gold' },
    { name: 'Sahara Beige', hex: '#c2a878', family: 'gold' },
    { name: 'Chalk', hex: '#cfcbc1', family: 'white' },
    { name: 'Bianco Avus', hex: '#f2f1ec', family: 'white' },
    { name: 'Championship White', hex: '#f4f3ef', family: 'white' },
    { name: 'Arctic Silver', hex: '#c5c8cc', family: 'silver' },
    { name: 'Silver Arrow', hex: '#b7bcc2', family: 'silver' },
    { name: 'Nardo Grey', hex: '#7d7f7d', family: 'grey' },
    { name: 'Grigio Telesto', hex: '#6e7175', family: 'grey' },
    { name: 'Graphite', hex: '#3a3d41', family: 'grey' },
    { name: 'Nero Daytona', hex: '#0d0d0f', family: 'black' }
  ];

  var stripes = [
    { id: 'none', name: 'No Stripe', desc: 'Clean, uninterrupted paint.', price: 0 },
    { id: 'racing-dual', name: 'Dual Racing Stripes', desc: 'Twin stripes nose-to-tail over the roof — Shelby style.', price: 2800 },
    { id: 'center', name: 'Centre Stripe', desc: 'A single wide stripe along the centreline.', price: 2200 },
    { id: 'side-skirt', name: 'Sill Stripe', desc: 'Lettered stripe along the lower sills.', price: 1200 },
    { id: 'le-mans', name: 'Le Mans Livery', desc: 'Offset endurance-racing stripe with a roundel for your number.', price: 3500 },
    { id: 'hood', name: 'Bonnet Stripe', desc: 'Matte anti-glare panel across the bonnet.', price: 900 },
    { id: 'pinstripe', name: 'Hand Pinstripe', desc: 'Coachline hand-painted with a squirrel-hair brush — 14 hours.', price: 1800 },
    { id: 'gradient', name: 'Gradient Fade', desc: 'Airbrushed fade from stripe colour to paint along the flank.', price: 4200 }
  ];

  var roofTypes = [
    { id: 'body', name: 'Body Colour', desc: 'Roof painted to match.', price: 0, weight_kg: 0 },
    { id: 'black', name: 'Gloss Black', desc: 'Contrasting gloss black roof.', price: 900, weight_kg: 0 },
    { id: 'carbon', name: 'Exposed Carbon', desc: 'Visible-weave carbon roof panel lowers the centre of gravity.', price: 5800, weight_kg: -6 },
    { id: 'glass', name: 'Panoramic Glass', desc: 'Electrochromic panoramic glass roof.', price: 2200, weight_kg: 12 },
    { id: 'contrast', name: 'Contrast Colour', desc: 'Two-tone roof in your choice of colour.', price: 1500, weight_kg: 0 }
  ];
  var lightTypes = [
    { id: 'halogen', name: 'Halogen', desc: 'Classic warm halogen projectors.', price: 0, weight_kg: 0 },
    { id: 'led', name: 'Full LED', desc: 'LED low/high beam with signature DRL.', price: 1200, weight_kg: -1 },
    { id: 'matrix', name: 'Matrix LED', desc: '84-segment adaptive high beam that masks oncoming traffic.', price: 3200, weight_kg: 0 },
    { id: 'laser', name: 'Laser High Beam', desc: 'Laser-phosphor high beam with 600 m reach.', price: 6500, weight_kg: 0 }
  ];
  var mirrorTypes = [
    { id: 'body', name: 'Body Colour', desc: 'Mirror caps painted to match.', price: 0, weight_kg: 0 },
    { id: 'black', name: 'Gloss Black', desc: 'Black mirror caps.', price: 450, weight_kg: 0 },
    { id: 'carbon', name: 'Carbon Fibre', desc: 'Carbon caps on slim aero stalks.', price: 1900, weight_kg: -1 }
  ];
  var badgeTypes = [
    { id: 'chrome', name: 'Chrome', desc: 'Polished chrome REDLINE script.', price: 0 },
    { id: 'black', name: 'Shadow Black', desc: 'Gloss black badging.', price: 300 },
    { id: 'delete', name: 'Badge Delete', desc: 'Debadged for the ultimate sleeper.', price: 0 }
  ];

  /* ======================================================================
     INTERIOR
     ====================================================================== */
  var seatTypes = [
    { id: 'comfort', name: 'Comfort Seats', desc: '18-way power, heated & ventilated, memory.', price: 0, weight_kg: 6, support: 0.35 },
    { id: 'sport', name: 'Sport Seats', desc: 'Bolstered 14-way sport seats with adjustable side support.', price: 2200, weight_kg: 0, support: 0.60 },
    { id: 'lounge', name: 'Lounge Massage', desc: 'Reclining massage thrones with neck-level warmth and hot-stone mode.', price: 6500, weight_kg: 18, support: 0.25 },
    { id: 'bucket', name: 'Sport Buckets', desc: 'Fixed-back buckets with a folding mechanism.', price: 4200, weight_kg: -8, support: 0.80 },
    { id: 'carbon-bucket', name: 'Carbon Buckets', desc: 'Carbon-shell buckets with thin Alcantara pads — 13 kg per pair saved.', price: 7900, weight_kg: -14, support: 0.88 },
    { id: 'race-shell', name: 'FIA Race Shells', desc: 'Homologated fixed race shells with HANS cut-outs.', price: 7500, weight_kg: -22, support: 0.98 }
  ];
  var upholsteries = [
    { id: 'cloth', name: 'Technical Cloth', desc: 'Breathable woven cloth.', price: -1200, weight_kg: -2, luxury: 0.20 },
    { id: 'tartan', name: 'Heritage Tartan', desc: 'Clark plaid inserts with leather bolsters — a hot-hatch hallmark.', price: 900, weight_kg: 0, luxury: 0.40 },
    { id: 'vegan', name: 'Vegan Microfibre', desc: 'Recycled-PET suede and bio-based leather alternative.', price: 800, weight_kg: -1, luxury: 0.50 },
    { id: 'leather', name: 'Leather', desc: 'Full-grain leather seating surfaces.', price: 0, weight_kg: 0, luxury: 0.60 },
    { id: 'alcantara', name: 'Alcantara', desc: 'Grippy suede-like microfibre on seats, wheel and dash.', price: 2400, weight_kg: -1, luxury: 0.65 },
    { id: 'nappa', name: 'Extended Nappa', desc: 'Soft Nappa on every surface, quilted and perforated.', price: 3500, weight_kg: 1, luxury: 0.80 },
    { id: 'carbon-weave', name: 'Carbon-Weave Leather', desc: 'Leather with woven carbon-thread inserts.', price: 4200, weight_kg: 0, luxury: 0.75 },
    { id: 'semi-aniline', name: 'Semi-Aniline Bespoke', desc: 'Hand-selected bull hides, 600 hours of stitching. The Redline signature.', price: 6800, weight_kg: 1, luxury: 1.0 }
  ];
  var trims = [
    { id: 'aluminum', name: 'Knurled Aluminium', desc: 'Machined aluminium with knurled details.', price: 0, weight_kg: 0 },
    { id: 'piano-black', name: 'Piano Black', desc: 'Deep gloss black lacquer.', price: 400, weight_kg: 0 },
    { id: 'gloss-walnut', name: 'Gloss Burr Walnut', desc: 'Book-matched burr walnut veneer.', price: 2400, weight_kg: 1 },
    { id: 'open-pore-wood', name: 'Open-Pore Ash', desc: 'Matte open-pore ash with metal inlays.', price: 1800, weight_kg: 1 },
    { id: 'carbon', name: 'Twill Carbon', desc: 'Gloss 2x2 twill carbon fibre.', price: 3800, weight_kg: -1 },
    { id: 'forged-carbon', name: 'Forged Carbon', desc: 'Marbled chopped-fibre forged composite.', price: 5200, weight_kg: -1 },
    { id: 'brushed-titanium', name: 'Brushed Titanium', desc: 'Grade-5 titanium, hand-brushed.', price: 4500, weight_kg: 0 }
  ];
  var steeringTypes = [
    { id: 'round', name: 'Round Rim', desc: 'Classic round three-spoke wheel.', price: 0 },
    { id: 'flat-bottom', name: 'Flat-Bottom', desc: 'D-shaped rim with 12 o\'clock marker.', price: 650 },
    { id: 'yoke', name: 'Yoke', desc: 'Aviation-style yoke with variable-ratio steer-by-wire.', price: 2400 },
    { id: 'race-quick-release', name: 'Race Quick-Release', desc: '330 mm suede race wheel on a quick-release hub.', price: 1900 }
  ];
  var headliners = [
    { id: 'cloth', name: 'Cloth', desc: 'Acoustic fabric headliner.', price: 0 },
    { id: 'alcantara', name: 'Alcantara', desc: 'Alcantara headliner and pillars.', price: 1800 },
    { id: 'leather', name: 'Perforated Leather', desc: 'Perforated leather with starlight option.', price: 1400 }
  ];

  /* ======================================================================
     TECH
     ====================================================================== */
  var screenSizes = [
    { id: 0, name: 'Delete', desc: 'No centre screen — analogue purist.', price: -800, weight_kg: -3 },
    { id: 8, name: '8"', desc: 'Compact touchscreen.', price: 0, weight_kg: 0 },
    { id: 10, name: '10"', desc: 'Widescreen touch display.', price: 600, weight_kg: 0.3 },
    { id: 12, name: '12.3"', desc: 'High-resolution OLED.', price: 1200, weight_kg: 0.5 },
    { id: 15, name: '15"', desc: 'Portrait OLED command centre.', price: 2400, weight_kg: 0.9 },
    { id: 17, name: '17"', desc: 'Curved pillar-to-pillar hyperscreen.', price: 3600, weight_kg: 1.4 }
  ];
  var audioSystems = [
    { id: 'delete', name: 'Audio Delete', desc: 'No speakers, no head unit — the engine is the soundtrack.', price: -900, weight_kg: -14 },
    { id: 'track', name: 'Track Lightweight', desc: 'Four speakers and a tiny amplifier.', price: -400, weight_kg: -8 },
    { id: 'standard', name: 'Standard Audio', desc: 'Eight-speaker 180 W system.', price: 0, weight_kg: 0 },
    { id: 'premium', name: 'Premium Surround', desc: '16 speakers, 900 W, 3D surround.', price: 2800, weight_kg: 6 },
    { id: 'reference', name: 'Reference Hi-Fi', desc: '1,400 W, 21 speakers with diamond tweeters.', price: 7500, weight_kg: 12 },
    { id: 'concert', name: 'Concert Hall', desc: '2,200 W, 25 speakers, active noise and in-seat transducers.', price: 12000, weight_kg: 16 }
  ];
  var adasLevels = [
    { id: 'none', name: 'No Assistance', desc: 'Mandatory AEB only.', price: -800, weight_kg: -3 },
    { id: 'assist', name: 'Driver Assist', desc: 'Lane-keep, blind-spot and adaptive cruise.', price: 0, weight_kg: 0 },
    { id: 'plus', name: 'Assist Plus (L2)', desc: 'Stop-and-go lane-centring, 360° cameras, auto park.', price: 2200, weight_kg: 2 },
    { id: 'pilot', name: 'Highway Pilot (L2+)', desc: 'Hands-free highway driving with automatic lane changes.', price: 5500, weight_kg: 4 },
    { id: 'autonomous-l3', name: 'Autonomous L3', desc: 'Lidar-equipped eyes-off traffic jam pilot to 130 km/h.', price: 9500, weight_kg: 8 }
  ];

  /* Flat price table for toggles / small items (USD). */
  var options = {
    launchControl: 900, torqueVectoring: 2800, hud: 1400, telemetry: 2400, liftSystem: 3200, nightVision: 2600,
    ambientLighting: 500, harness: 1200, digitalCluster: 900, perClimateZone: 650,
    canards: 1800, sideSkirts: 1400, activeAero: 8500,
    rollCageHalf: 3800, rollCageFull: 7900, polycarbonate: 4200, thinGlass: 1900, lithiumBattery: 1600,
    ledLights: 1200, matrixLights: 3200, laserLights: 6500,
    blackRoof: 900, contrastRoof: 1500, carbonRoof: 5800, glassRoof: 2200,
    blackMirrors: 450, carbonMirrors: 1900, blackBadge: 300, badgeDelete: 0,
    windowTintPerPct: 8, liveryNumber: 600, stripeColorMatch: 0, customPaint: 2500, customCaliper: 650,
    staggeredWheels: 400, spareTire: 250, soundDeadeningDelete: -200, rearSeatDelete: -500, ballastPerKg: 6,
    flatBottomWheel: 650, yokeWheel: 2400, quickReleaseWheel: 1900,
    alcantaraHeadliner: 1800, leatherHeadliner: 1400,
    absSport: 600, absRace: 2400, voltage800: 3500, hybridSystem: 9500, perMotor: 4500, perMotorKw: 22,
    awd: 4500, centerDiffUpgrade: 1200, midEngine: 6500, rearEngine: 3000, perCylinderBalance: 0,
    perRotorMm: 18, perPiston: 220, perInchDiameter: 350, perHalfInchWidth: 120
  };
  var optionWeights = {
    sideSkirts: 4, canards: 1.5, activeAero: 12, spareTire: 18, soundDeadening: 22, rearSeats: 28,
    harness: 2, hud: 1, telemetry: 1.5, liftSystem: 9, nightVision: 2, ambientLighting: 0.5,
    perClimateZone: 2, torqueVectoring: 8, perMotor: 45
  };

  /* Central numeric ranges used by normalize() and by panel sliders. */
  var ranges = {
    'body.wheelbase_mm': { min: 2300, max: 3700, step: 5, unit: 'mm', label: 'Wheelbase' },
    'body.trackWidth_mm': { min: 1450, max: 1750, step: 5, unit: 'mm', label: 'Track width' },
    'engine.displacement_l': { min: 0.9, max: 8.4, step: 0.1, unit: 'L', label: 'Displacement' },
    'engine.boost_bar': { min: 0, max: 3.0, step: 0.05, unit: 'bar', label: 'Boost pressure' },
    'engine.compression': { min: 8.0, max: 14.0, step: 0.1, unit: ':1', label: 'Compression ratio' },
    'engine.redline_rpm': { min: 5000, max: 9500, step: 100, unit: 'rpm', label: 'Redline' },
    'engine.motors': { min: 1, max: 4, step: 1, unit: '', label: 'Motors' },
    'engine.motorPower_kw': { min: 50, max: 500, step: 5, unit: 'kW', label: 'Power per motor' },
    'engine.battery_kwh': { min: 1, max: 200, step: 0.1, unit: 'kWh', label: 'Battery capacity' },
    'engine.regen': { min: 0, max: 3, step: 1, unit: '', label: 'Regeneration' },
    'transmission.gears': { min: 1, max: 10, step: 1, unit: '', label: 'Gears' },
    'transmission.ratio': { min: 0.40, max: 6.00, step: 0.01, unit: ':1', label: 'Gear ratio' },
    'transmission.finalDrive': { min: 2.5, max: 5.5, step: 0.01, unit: ':1', label: 'Final drive' },
    'drivetrain.torqueSplitFront_pct': { min: 0, max: 100, step: 1, unit: '%', label: 'Front torque share', awdMin: 10, awdMax: 90 },
    'drivetrain.tractionControl': { min: 0, max: 3, step: 1, unit: '', label: 'Traction control' },
    'suspension.springFront_nmm': { min: 20, max: 250, step: 1, unit: 'N/mm', label: 'Front spring rate' },
    'suspension.springRear_nmm': { min: 20, max: 250, step: 1, unit: 'N/mm', label: 'Rear spring rate' },
    'suspension.damping': { min: 1, max: 10, step: 1, unit: '', label: 'Damping' },
    'suspension.rideHeight_mm': { min: 50, max: 300, step: 1, unit: 'mm', label: 'Ride height' },
    'suspension.camberFront_deg': { min: -5, max: 1, step: 0.1, unit: '°', label: 'Front camber' },
    'suspension.camberRear_deg': { min: -5, max: 1, step: 0.1, unit: '°', label: 'Rear camber' },
    'suspension.toeFront_deg': { min: -0.5, max: 0.5, step: 0.05, unit: '°', label: 'Front toe' },
    'suspension.toeRear_deg': { min: -0.5, max: 0.5, step: 0.05, unit: '°', label: 'Rear toe' },
    'suspension.arbFront': { min: 1, max: 10, step: 1, unit: '', label: 'Front anti-roll bar' },
    'suspension.arbRear': { min: 1, max: 10, step: 1, unit: '', label: 'Rear anti-roll bar' },
    'brakes.frontRotor_mm': { min: 280, max: 440, step: 2, unit: 'mm', label: 'Front rotor' },
    'brakes.rearRotor_mm': { min: 280, max: 440, step: 2, unit: 'mm', label: 'Rear rotor' },
    'wheels.diameter_in': { min: 15, max: 23, step: 1, unit: 'in', label: 'Wheel diameter' },
    'wheels.widthFront_in': { min: 6.0, max: 13.0, step: 0.5, unit: 'in', label: 'Front rim width' },
    'wheels.widthRear_in': { min: 6.0, max: 13.0, step: 0.5, unit: 'in', label: 'Rear rim width' },
    'tires.widthFront_mm': { min: 175, max: 355, step: 10, base: 5, unit: 'mm', label: 'Front tyre width' },
    'tires.widthRear_mm': { min: 175, max: 355, step: 10, base: 5, unit: 'mm', label: 'Rear tyre width' },
    'tires.profileFront': { min: 25, max: 70, step: 5, unit: '%', label: 'Front aspect ratio' },
    'tires.profileRear': { min: 25, max: 70, step: 5, unit: '%', label: 'Rear aspect ratio' },
    'aero.wingAngle_deg': { min: 0, max: 20, step: 1, unit: '°', label: 'Wing angle' },
    'weight.ballast_kg': { min: 0, max: 100, step: 5, unit: 'kg', label: 'Ballast' },
    'exterior.windowTint_pct': { min: 0, max: 85, step: 1, unit: '%', label: 'Window tint' },
    'tech.climateZones': { min: 1, max: 4, step: 1, unit: '', label: 'Climate zones' }
  };

  var batteryRanges = { ev: [30, 200], hybrid: [1, 30] };
  var motorRanges = { ev: [1, 4], hybrid: [1, 3] };   // hybrid: P2 motor + up to two front e-axle motors (SF90 / NSX)

  var constants = {
    airDensity: 1.225, g: 9.81, fuelTank_l: 60, idleRpm: 850, evMaxRpm: 16000,
    lapLength_km: 5.8, lapName: 'Redline Ring', destinationFee: 1995
  };

  /* ======================================================================
     DEFAULT BUILD
     ====================================================================== */
  // The default build is the coupe style's default model (Porsche 911, 992) in Carrera S trim: rear-mounted 3.0
  // twin-turbo flat-six (~440 hp), rear-wheel drive and an 8-speed PDK-style dual-clutch.
  function defaultBuild() {
    var now = Date.now();
    return {
      version: 1,
      meta: { name: 'Untitled Build', id: uid('b'), created: now, modified: now, presetId: null },
      body: { style: 'coupe', model: null, chassisMaterial: 'steel', construction: 'standard', modelPhysics: false, wheelbase_mm: 2450, trackWidth_mm: 1590, doors: 2, seats: 4 },   // model: CB.shapes id (null = style default, bodyStyles[].defaultModel); state.normalize keeps it valid
      engine: {
        type: 'ice', layout: 'flat-6', displacement_l: 3.0, aspiration: 'twin-turbo', boost_bar: 0.7, compression: 10.0,
        fuel: 'premium', redline_rpm: 7500, position: 'rear', tune: 'stock', exhaust: 'sport', cooling: 'standard', speedLimiter_kph: 0,
        motors: 2, motorPower_kw: 200, battery_kwh: 85, chemistry: 'nmc', voltage: 800, regen: 2
      },
      transmission: { type: 'dct', gears: 8, ratios: [4.89, 3.17, 2.15, 1.56, 1.18, 0.94, 0.78, 0.64], finalDrive: 3.62, launchControl: true },
      drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 2 },
      suspension: {
        type: 'double-wishbone', springFront_nmm: 60, springRear_nmm: 70, damping: 5, rideHeight_mm: 120,
        camberFront_deg: -1.5, camberRear_deg: -1.0, toeFront_deg: 0.0, toeRear_deg: 0.1, arbFront: 5, arbRear: 4
      },
      brakes: { material: 'iron', frontRotor_mm: 360, rearRotor_mm: 330, frontPistons: 6, rearPistons: 4, abs: 'sport' },
      wheels: { design: 'y-spoke', material: 'cast', diameter_in: 19, widthFront_in: 9.0, widthRear_in: 10.5, finish: '#2b2b2b', staggered: true },
      tires: { compound: 'performance', speedRating: 'compound', widthFront_mm: 255, widthRear_mm: 295, profileFront: 35, profileRear: 30 },
      aero: { splitter: 'lip', wing: 'none', wingAngle_deg: 6, diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
      weight: { soundDeadening: true, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lead', rollCage: 'none', ballast_kg: 0, ballastPosition: 'center' },
      exterior: {
        paint: '#b3121f', finish: 'metallic', roof: 'body', roofColor: '#111111', stripe: 'none', stripeColor: '#ffffff',
        caliperColor: '#f2c200', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'chrome', livery_number: ''
      },
      interior: {
        seatType: 'sport', upholstery: 'leather', primaryColor: '#1a1a1a', accentColor: '#b3121f', stitchColor: '#b3121f',
        trim: 'aluminum', steering: 'round', headliner: 'alcantara', ambientLighting: true, ambientColor: '#ff3344', harness: false
      },
      tech: { screen_in: 12, digitalCluster: true, hud: false, audio: 'premium', adas: 'assist', climateZones: 2, telemetry: false, liftSystem: false, nightVision: false }
    };
  }

  /**
   * referenceBuild() — the calibration fixture: a front-engined 4.0 twin-turbo V8 coupe (~645 hp, RWD, 7-speed DCT).
   * It was the catalog default before the default became a 911 Carrera S; physics sanity bands and AI / drift tuning
   * tests are calibrated on it, so they pin this fixture instead of whatever the default build happens to be.
   */
  function referenceBuild() {
    var b = defaultBuild();
    b.meta.name = 'Reference V8 Coupe';
    b.body.wheelbase_mm = 2650; b.body.trackWidth_mm = 1600;
    b.engine.layout = 'V8'; b.engine.displacement_l = 4.0; b.engine.boost_bar = 1.2; b.engine.position = 'front';
    b.transmission = { type: 'dct', gears: 7, ratios: [3.80, 2.60, 1.90, 1.45, 1.15, 0.95, 0.78], finalDrive: 3.42, launchControl: true };
    return b;
  }

  /* ======================================================================
     PRESETS — partial builds deep-merged onto defaultBuild()
     ====================================================================== */
  var presets = [
    {
      id: 'alpine-gt', name: 'Alpine GT', tagline: 'The V12 Vantage formula: a naturally aspirated V12 mounted front-mid in a short two-seat body, for crossing the Alps at dawn.',
      tags: ['GT', 'V12', 'Luxury'],
      build: {
        meta: { name: 'Alpine GT' },
        body: { style: 'coupe', model: 'aston-martin-vantage-2018', chassisMaterial: 'aluminum', wheelbase_mm: 2705, trackWidth_mm: 1640, doors: 2, seats: 2 },
        engine: { type: 'ice', layout: 'V12', displacement_l: 5.9, aspiration: 'na', boost_bar: 0, compression: 11.0, fuel: 'premium', redline_rpm: 7000, position: 'front', tune: 'stock', exhaust: 'valvetronic', cooling: 'uprated' },
        transmission: { type: 'auto', gears: 8, finalDrive: 2.93, launchControl: true },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'e-diff', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: true, tractionControl: 2 },
        suspension: { type: 'magnetic', springFront_nmm: 55, springRear_nmm: 62, damping: 4, rideHeight_mm: 115, camberFront_deg: -1.2, camberRear_deg: -0.9, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 5, arbRear: 4 },
        brakes: { material: 'carbon-ceramic', frontRotor_mm: 398, rearRotor_mm: 360, frontPistons: 6, rearPistons: 4, abs: 'sport' },
        wheels: { design: 'split-10', material: 'forged', diameter_in: 21, widthFront_in: 9.5, widthRear_in: 11.5, finish: '#3a3a3a', staggered: true },
        tires: { compound: 'super-sport', widthFront_mm: 265, widthRear_mm: 315, profileFront: 35, profileRear: 30 },
        aero: { splitter: 'lip', wing: 'none', diffuser: 'carbon', canards: false, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: true, rearSeats: false, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#004225', finish: 'metallic', roof: 'body', stripe: 'none', caliperColor: '#c9b37e', windowTint_pct: 15, lights: 'matrix', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'comfort', upholstery: 'semi-aniline', primaryColor: '#b0814f', accentColor: '#3b2a1e', stitchColor: '#f2e8d5', trim: 'open-pore-wood', steering: 'round', headliner: 'alcantara', ambientLighting: true, ambientColor: '#ffb366', harness: false },
        tech: { screen_in: 12, digitalCluster: true, hud: true, audio: 'reference', adas: 'plus', climateZones: 2 }
      }
    },
    {
      id: 'track-weapon', name: 'Track Weapon', tagline: '718 Spyder RS recipe: mid-mounted 9,000 rpm flat-six, seven-speed PDK, slicks and a GT wing. Road-legal is optional.',
      tags: ['Track', 'Flat-6', 'Aero'],
      build: {
        meta: { name: 'Track Weapon' },
        body: { style: 'roadster', model: 'porsche-718-boxster-982', chassisMaterial: 'aluminum', wheelbase_mm: 2480, trackWidth_mm: 1590, doors: 2, seats: 2 },
        engine: { type: 'ice', layout: 'flat-6', displacement_l: 4.0, aspiration: 'na', boost_bar: 0, compression: 13.3, fuel: 'premium', redline_rpm: 9000, position: 'mid', tune: 'stage1', exhaust: 'titanium', cooling: 'race' },
        transmission: { type: 'dct', gears: 7, finalDrive: 4.47, launchControl: true },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 1 },
        suspension: { type: 'pushrod', springFront_nmm: 180, springRear_nmm: 200, damping: 8, rideHeight_mm: 70, camberFront_deg: -3.5, camberRear_deg: -2.5, toeFront_deg: -0.1, toeRear_deg: 0.2, arbFront: 8, arbRear: 6 },
        brakes: { material: 'carbon-ceramic', frontRotor_mm: 410, rearRotor_mm: 390, frontPistons: 6, rearPistons: 4, abs: 'race' },
        wheels: { design: 'centerlock-race', material: 'magnesium', diameter_in: 20, widthFront_in: 10.0, widthRear_in: 12.5, finish: '#c9b37e', staggered: true },
        tires: { compound: 'slick', widthFront_mm: 285, widthRear_mm: 335, profileFront: 30, profileRear: 30 },
        aero: { splitter: 'race', wing: 'gt-wing', wingAngle_deg: 12, diffuser: 'race', canards: true, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: false, rearSeats: false, spareTire: false, glass: 'polycarbonate', battery: 'lithium', rollCage: 'full', ballast_kg: 15, ballastPosition: 'front' },
        exterior: { paint: '#7fb2e5', finish: 'solid', roof: 'body', stripe: 'le-mans', stripeColor: '#f37021', caliperColor: '#f37021', windowTint_pct: 0, lights: 'led', mirrors: 'carbon', badge: 'black', livery_number: '9' },
        interior: { seatType: 'race-shell', upholstery: 'alcantara', primaryColor: '#111111', accentColor: '#f37021', stitchColor: '#f37021', trim: 'carbon', steering: 'race-quick-release', headliner: 'alcantara', ambientLighting: false, harness: true },
        tech: { screen_in: 8, digitalCluster: true, hud: false, audio: 'delete', adas: 'none', climateZones: 1, telemetry: true, liftSystem: true }
      }
    },
    {
      id: 'electric-hyper', name: 'Electric Hyper', tagline: 'Four motors, 1,440 kW, torque-vectored to every corner. Silence has never been this violent.',
      tags: ['EV', 'Hypercar', 'AWD'],
      build: {
        meta: { name: 'Electric Hyper' },
        body: { style: 'hypercar', model: 'ferrari-sf90-stradale', chassisMaterial: 'carbon-monocoque', wheelbase_mm: 2745, trackWidth_mm: 1700, doors: 2, seats: 2 },
        engine: { type: 'ev', position: 'mid', motors: 4, motorPower_kw: 360, battery_kwh: 120, chemistry: 'nca', voltage: 800, regen: 3, exhaust: 'stock', tune: 'stock', cooling: 'race' },
        transmission: { type: 'single-speed', gears: 1, ratios: [2.65], finalDrive: 3.60, launchControl: true },
        drivetrain: { layout: 'awd', frontDiff: 'e-diff', rearDiff: 'e-diff', centerDiff: 'e-diff', torqueSplitFront_pct: 45, torqueVectoring: true, tractionControl: 2 },
        suspension: { type: 'pushrod', springFront_nmm: 140, springRear_nmm: 160, damping: 6, rideHeight_mm: 95, camberFront_deg: -2.5, camberRear_deg: -2.0, toeFront_deg: 0, toeRear_deg: 0.15, arbFront: 6, arbRear: 5 },
        brakes: { material: 'carbon-ceramic', frontRotor_mm: 420, rearRotor_mm: 400, frontPistons: 10, rearPistons: 6, abs: 'sport' },
        wheels: { design: 'aero-disc', material: 'carbon', diameter_in: 21, widthFront_in: 10.0, widthRear_in: 12.0, finish: '#1a1a1a', staggered: true },
        tires: { compound: 'super-sport', widthFront_mm: 275, widthRear_mm: 325, profileFront: 35, profileRear: 30 },
        aero: { splitter: 'carbon', wing: 'active', wingAngle_deg: 8, diffuser: 'race', canards: false, sideSkirts: true, activeAero: true },
        weight: { soundDeadening: true, rearSeats: false, spareTire: false, glass: 'thin', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#1b1f3b', finish: 'pearl', roof: 'carbon', stripe: 'none', caliperColor: '#00d5ff', windowTint_pct: 35, lights: 'laser', mirrors: 'carbon', badge: 'black' },
        interior: { seatType: 'carbon-bucket', upholstery: 'alcantara', primaryColor: '#111111', accentColor: '#00d5ff', stitchColor: '#00d5ff', trim: 'forged-carbon', steering: 'yoke', headliner: 'alcantara', ambientLighting: true, ambientColor: '#00d5ff', harness: false },
        tech: { screen_in: 15, digitalCluster: true, hud: true, audio: 'reference', adas: 'pilot', climateZones: 2, telemetry: true, liftSystem: true }
      }
    },
    {
      id: 'hot-hatch', name: 'Hot Hatch', tagline: 'Turbo four, six-speed manual, Torsen diff and tartan seats. Joy per dollar, maximised.',
      tags: ['FWD', 'I4', 'Manual'],
      build: {
        meta: { name: 'Hot Hatch' },
        body: { style: 'hatchback', model: 'vw-golf-gti-mk8', chassisMaterial: 'high-strength-steel', wheelbase_mm: 2630, trackWidth_mm: 1560, doors: 5, seats: 5 },
        engine: { type: 'ice', layout: 'I4', displacement_l: 2.0, aspiration: 'turbo', boost_bar: 1.5, compression: 9.6, fuel: 'premium', redline_rpm: 6800, position: 'front', tune: 'stage1', exhaust: 'sport', cooling: 'uprated' },
        transmission: { type: 'manual', gears: 6, finalDrive: 3.65, launchControl: false },
        drivetrain: { layout: 'fwd', frontDiff: 'lsd-torsen', rearDiff: 'none', centerDiff: 'none', torqueSplitFront_pct: 100, torqueVectoring: false, tractionControl: 2 },
        suspension: { type: 'macpherson', springFront_nmm: 45, springRear_nmm: 40, damping: 6, rideHeight_mm: 125, camberFront_deg: -1.5, camberRear_deg: -1.2, toeFront_deg: 0, toeRear_deg: 0.15, arbFront: 6, arbRear: 7 },
        brakes: { material: 'drilled-slotted', frontRotor_mm: 344, rearRotor_mm: 310, frontPistons: 4, rearPistons: 1, abs: 'sport' },
        wheels: { design: 'turbine', material: 'flow-formed', diameter_in: 19, widthFront_in: 8.0, widthRear_in: 8.0, finish: '#2b2b2b', staggered: false },
        tires: { compound: 'performance', widthFront_mm: 235, widthRear_mm: 235, profileFront: 35, profileRear: 35 },
        aero: { splitter: 'lip', wing: 'lip-spoiler', diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
        exterior: { paint: '#c8102e', finish: 'solid', roof: 'black', stripe: 'side-skirt', stripeColor: '#111111', caliperColor: '#d40000', windowTint_pct: 30, lights: 'led', mirrors: 'black', badge: 'chrome' },
        interior: { seatType: 'sport', upholstery: 'tartan', primaryColor: '#1a1a1a', accentColor: '#c8102e', stitchColor: '#c8102e', trim: 'piano-black', steering: 'flat-bottom', headliner: 'cloth', ambientLighting: true, ambientColor: '#ff2a2a' },
        tech: { screen_in: 10, digitalCluster: true, hud: false, audio: 'standard', adas: 'assist', climateZones: 2 }
      }
    },
    {
      id: 'overland', name: 'Overland', tagline: 'Straight-six diesel, triple lockers and air suspension that lifts to 240 mm. Go anywhere, in comfort.',
      tags: ['SUV', 'Diesel', 'Off-road'],
      build: {
        meta: { name: 'Overland' },
        body: { style: 'suv', model: 'range-rover-sport-l461', chassisMaterial: 'high-strength-steel', wheelbase_mm: 2980, trackWidth_mm: 1680, doors: 5, seats: 7 },
        engine: { type: 'ice', layout: 'I6', displacement_l: 3.0, aspiration: 'turbo', boost_bar: 2.0, compression: 14.0, fuel: 'diesel', redline_rpm: 5000, position: 'front', tune: 'stock', exhaust: 'stock', cooling: 'uprated' },
        transmission: { type: 'auto', gears: 8, finalDrive: 3.73, launchControl: false },
        drivetrain: { layout: 'awd', frontDiff: 'locking', rearDiff: 'locking', centerDiff: 'locking', torqueSplitFront_pct: 50, torqueVectoring: false, tractionControl: 3 },
        suspension: { type: 'air', springFront_nmm: 70, springRear_nmm: 80, damping: 3, rideHeight_mm: 240, camberFront_deg: -0.3, camberRear_deg: -0.2, toeFront_deg: 0.05, toeRear_deg: 0.1, arbFront: 3, arbRear: 2 },
        brakes: { material: 'iron', frontRotor_mm: 380, rearRotor_mm: 350, frontPistons: 4, rearPistons: 2, abs: 'standard' },
        wheels: { design: 'monoblock-6', material: 'cast', diameter_in: 18, widthFront_in: 9.0, widthRear_in: 9.0, finish: '#3a3d41', staggered: false },
        tires: { compound: 'all-season', widthFront_mm: 275, widthRear_mm: 275, profileFront: 65, profileRear: 65 },
        aero: { splitter: 'none', wing: 'none', diffuser: 'none', canards: false, sideSkirts: false, activeAero: false },
        weight: { soundDeadening: true, rearSeats: true, spareTire: true, glass: 'standard', battery: 'lead', rollCage: 'none' },
        exterior: { paint: '#4f5b3a', finish: 'satin', roof: 'black', stripe: 'none', caliperColor: '#2b2b2b', windowTint_pct: 25, lights: 'led', mirrors: 'black', badge: 'black' },
        interior: { seatType: 'comfort', upholstery: 'leather', primaryColor: '#5a4632', accentColor: '#2b2b2b', stitchColor: '#c9b37e', trim: 'open-pore-wood', steering: 'round', headliner: 'cloth', ambientLighting: true, ambientColor: '#ffb366' },
        tech: { screen_in: 12, digitalCluster: true, hud: false, audio: 'premium', adas: 'plus', climateZones: 3, nightVision: true }
      }
    },
    {
      id: 'muscle', name: 'Muscle', tagline: 'Camaro ZL1 recipe: supercharged 6.2-litre V8, six-speed stick and dual stripes. Burnouts included.',
      tags: ['V8', 'RWD', 'Manual'],
      build: {
        meta: { name: 'Muscle' },
        body: { style: 'coupe', model: 'chevrolet-camaro-zl1-2019', chassisMaterial: 'steel', wheelbase_mm: 2800, trackWidth_mm: 1600, doors: 2, seats: 4 },
        engine: { type: 'ice', layout: 'V8', displacement_l: 6.2, aspiration: 'supercharged', boost_bar: 0.8, compression: 9.5, fuel: 'premium', redline_rpm: 6600, position: 'front', tune: 'stage1', exhaust: 'sport', cooling: 'uprated' },
        transmission: { type: 'manual', gears: 6, finalDrive: 3.73, launchControl: true },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 2 },
        suspension: { type: 'multilink', springFront_nmm: 75, springRear_nmm: 85, damping: 5, rideHeight_mm: 125, camberFront_deg: -1.0, camberRear_deg: -0.5, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 6, arbRear: 5 },
        brakes: { material: 'two-piece', frontRotor_mm: 394, rearRotor_mm: 350, frontPistons: 6, rearPistons: 4, abs: 'sport' },
        wheels: { design: 'classic-5', material: 'forged', diameter_in: 20, widthFront_in: 10.0, widthRear_in: 11.0, finish: '#1a1a1a', staggered: true },
        tires: { compound: 'performance', widthFront_mm: 285, widthRear_mm: 305, profileFront: 30, profileRear: 30 },
        aero: { splitter: 'lip', wing: 'ducktail', diffuser: 'none', canards: false, sideSkirts: false, activeAero: false },
        exterior: { paint: '#ff6f1a', finish: 'solid', roof: 'body', stripe: 'racing-dual', stripeColor: '#111111', caliperColor: '#d40000', windowTint_pct: 35, lights: 'led', mirrors: 'body', badge: 'black' },
        interior: { seatType: 'sport', upholstery: 'leather', primaryColor: '#111111', accentColor: '#ff6f1a', stitchColor: '#ff6f1a', trim: 'aluminum', steering: 'round', headliner: 'cloth', ambientLighting: false },
        tech: { screen_in: 12, digitalCluster: true, hud: true, audio: 'premium', adas: 'assist', climateZones: 2 }
      }
    },
    {
      id: 'eco-commuter', name: 'Eco Commuter', tagline: 'Plug-in hybrid estate: a frugal turbo four up front, an electric rear axle and aero wheels. 80 km of silent commuting, 800 km per tank.',
      tags: ['Hybrid', 'Efficiency', 'Wagon'],
      build: {
        meta: { name: 'Eco Commuter' },
        body: { style: 'wagon', model: 'volvo-v60-polestar-engineered', chassisMaterial: 'steel', wheelbase_mm: 2870, trackWidth_mm: 1580, doors: 5, seats: 5 },
        engine: { type: 'hybrid', layout: 'I4', displacement_l: 2.0, aspiration: 'turbo', boost_bar: 1.0, compression: 9.5, fuel: 'premium', redline_rpm: 6000, position: 'front', tune: 'eco', exhaust: 'stock', cooling: 'standard', motors: 1, motorPower_kw: 105, battery_kwh: 18.8, chemistry: 'nmc', voltage: 400, regen: 3 },
        transmission: { type: 'auto', gears: 8, finalDrive: 3.08, launchControl: false },
        drivetrain: { layout: 'awd', frontDiff: 'open', rearDiff: 'open', centerDiff: 'e-diff', torqueSplitFront_pct: 45, torqueVectoring: false, tractionControl: 3 },
        suspension: { type: 'macpherson', springFront_nmm: 48, springRear_nmm: 52, damping: 3, rideHeight_mm: 140, camberFront_deg: -0.5, camberRear_deg: -0.8, toeFront_deg: 0.05, toeRear_deg: 0.1, arbFront: 3, arbRear: 2 },
        brakes: { material: 'iron', frontRotor_mm: 296, rearRotor_mm: 280, frontPistons: 1, rearPistons: 1, abs: 'standard' },
        wheels: { design: 'aero-blade', material: 'cast', diameter_in: 17, widthFront_in: 7.0, widthRear_in: 7.0, finish: '#c5c8cc', staggered: false },
        tires: { compound: 'eco', widthFront_mm: 205, widthRear_mm: 205, profileFront: 55, profileRear: 55 },
        aero: { splitter: 'none', wing: 'none', diffuser: 'mild', canards: false, sideSkirts: false, activeAero: false },
        weight: { soundDeadening: true, rearSeats: true, spareTire: true, glass: 'standard', battery: 'lead', rollCage: 'none' },
        exterior: { paint: '#c5c8cc', finish: 'metallic', roof: 'glass', stripe: 'none', caliperColor: '#3a3d41', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'comfort', upholstery: 'vegan', primaryColor: '#3a3d41', accentColor: '#8fd1b0', stitchColor: '#8fd1b0', trim: 'piano-black', steering: 'round', headliner: 'cloth', ambientLighting: true, ambientColor: '#4fd1c5' },
        tech: { screen_in: 12, digitalCluster: true, hud: false, audio: 'standard', adas: 'plus', climateZones: 2 }
      }
    },
    {
      id: 'rally-legend', name: 'Rally Legend', tagline: 'Group-B spirit: 1.6 turbo triple on E85, sequential box, all-wheel drive and a full cage.',
      tags: ['Rally', 'AWD', 'Turbo'],
      build: {
        meta: { name: 'Rally Legend' },
        body: { style: 'hatchback', model: 'toyota-gr-yaris', chassisMaterial: 'high-strength-steel', wheelbase_mm: 2520, trackWidth_mm: 1590, doors: 3, seats: 2 },
        engine: { type: 'ice', layout: 'I3', displacement_l: 1.6, aspiration: 'turbo', boost_bar: 1.8, compression: 9.0, fuel: 'e85', redline_rpm: 7300, position: 'front', tune: 'stage2', exhaust: 'titanium', cooling: 'race' },
        transmission: { type: 'sequential', gears: 6, finalDrive: 4.20, launchControl: true },
        drivetrain: { layout: 'awd', frontDiff: 'lsd-clutch', rearDiff: 'lsd-clutch', centerDiff: 'lsd-clutch', torqueSplitFront_pct: 45, torqueVectoring: false, tractionControl: 0 },
        suspension: { type: 'macpherson', springFront_nmm: 60, springRear_nmm: 55, damping: 7, rideHeight_mm: 150, camberFront_deg: -1.0, camberRear_deg: -0.8, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 4, arbRear: 4 },
        brakes: { material: 'two-piece', frontRotor_mm: 356, rearRotor_mm: 330, frontPistons: 4, rearPistons: 4, abs: 'race' },
        wheels: { design: 'monoblock-6', material: 'flow-formed', diameter_in: 18, widthFront_in: 8.0, widthRear_in: 8.0, finish: '#f2f1ec', staggered: false },
        tires: { compound: 'all-season', widthFront_mm: 225, widthRear_mm: 225, profileFront: 45, profileRear: 45 },
        aero: { splitter: 'carbon', wing: 'gt-wing', wingAngle_deg: 10, diffuser: 'carbon', canards: false, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: false, rearSeats: false, spareTire: true, glass: 'polycarbonate', battery: 'lithium', rollCage: 'full', ballast_kg: 0 },
        exterior: { paint: '#f4f3ef', finish: 'solid', roof: 'body', stripe: 'le-mans', stripeColor: '#1b3d8f', caliperColor: '#d40000', windowTint_pct: 0, lights: 'led', mirrors: 'black', badge: 'black', livery_number: '4' },
        interior: { seatType: 'race-shell', upholstery: 'alcantara', primaryColor: '#111111', accentColor: '#1b3d8f', stitchColor: '#ffffff', trim: 'carbon', steering: 'race-quick-release', headliner: 'cloth', ambientLighting: false, harness: true },
        tech: { screen_in: 8, digitalCluster: true, hud: false, audio: 'delete', adas: 'none', climateZones: 1, telemetry: true }
      }
    },
    {
      id: 'le-mans-hybrid', name: 'Le Mans Hypercar', tagline: 'P1 GTR recipe: mid twin-turbo V8 plus an electric boost motor, slicks and endurance cooling. 24 hours, flat out.',
      tags: ['Hybrid', 'Endurance', 'Track'],
      build: {
        meta: { name: 'Le Mans Hypercar' },
        body: { style: 'hypercar', model: 'mclaren-p1', chassisMaterial: 'carbon-monocoque', wheelbase_mm: 2780, trackWidth_mm: 1740, doors: 2, seats: 2 },
        engine: { type: 'hybrid', layout: 'V8', displacement_l: 3.8, aspiration: 'twin-turbo', boost_bar: 0.9, compression: 8.8, fuel: 'race', redline_rpm: 8500, position: 'mid', tune: 'stage2', exhaust: 'titanium', cooling: 'race', motors: 1, motorPower_kw: 150, battery_kwh: 4.7, chemistry: 'nca', voltage: 800, regen: 3 },
        transmission: { type: 'dct', gears: 7, finalDrive: 3.31, launchControl: true },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'e-diff', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: true, tractionControl: 1 },
        suspension: { type: 'pushrod', springFront_nmm: 220, springRear_nmm: 240, damping: 9, rideHeight_mm: 60, camberFront_deg: -3.8, camberRear_deg: -2.8, toeFront_deg: -0.1, toeRear_deg: 0.2, arbFront: 9, arbRear: 8 },
        brakes: { material: 'carbon-ceramic', frontRotor_mm: 420, rearRotor_mm: 400, frontPistons: 6, rearPistons: 6, abs: 'race' },
        wheels: { design: 'centerlock-race', material: 'magnesium', diameter_in: 20, widthFront_in: 12.0, widthRear_in: 13.0, finish: '#111111', staggered: true },
        tires: { compound: 'slick', widthFront_mm: 325, widthRear_mm: 355, profileFront: 30, profileRear: 30 },
        aero: { splitter: 'race', wing: 'gt-wing', wingAngle_deg: 14, diffuser: 'race', canards: true, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: false, rearSeats: false, spareTire: false, glass: 'polycarbonate', battery: 'lithium', rollCage: 'full', ballast_kg: 20, ballastPosition: 'center' },
        exterior: { paint: '#d40000', finish: 'satin', roof: 'carbon', stripe: 'gradient', stripeColor: '#111111', caliperColor: '#f6c200', windowTint_pct: 0, lights: 'laser', mirrors: 'carbon', badge: 'black', livery_number: '50' },
        interior: { seatType: 'race-shell', upholstery: 'alcantara', primaryColor: '#111111', accentColor: '#d40000', stitchColor: '#f6c200', trim: 'carbon', steering: 'race-quick-release', headliner: 'alcantara', ambientLighting: false, harness: true },
        tech: { screen_in: 8, digitalCluster: true, hud: false, audio: 'delete', adas: 'none', climateZones: 1, telemetry: true, liftSystem: true }
      }
    },
    {
      id: 'super-wagon', name: 'Super Wagon', tagline: 'Twin-turbo V8 estate with carbon-ceramics and room for the Labrador. The ultimate sleeper.',
      tags: ['Wagon', 'V8', 'AWD'],
      build: {
        meta: { name: 'Super Wagon' },
        body: { style: 'wagon', model: 'audi-rs6-avant-c8', chassisMaterial: 'aluminum', wheelbase_mm: 2930, trackWidth_mm: 1670, doors: 5, seats: 5 },
        engine: { type: 'ice', layout: 'V8', displacement_l: 4.0, aspiration: 'twin-turbo', boost_bar: 1.3, compression: 10.0, fuel: 'premium', redline_rpm: 6800, position: 'front', tune: 'stock', exhaust: 'valvetronic', cooling: 'uprated' },
        transmission: { type: 'auto', gears: 8, finalDrive: 3.20, launchControl: true },
        drivetrain: { layout: 'awd', frontDiff: 'open', rearDiff: 'e-diff', centerDiff: 'lsd-torsen', torqueSplitFront_pct: 40, torqueVectoring: true, tractionControl: 2 },
        suspension: { type: 'air', springFront_nmm: 65, springRear_nmm: 70, damping: 5, rideHeight_mm: 125, camberFront_deg: -1.0, camberRear_deg: -1.0, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 5, arbRear: 5 },
        brakes: { material: 'carbon-ceramic', frontRotor_mm: 440, rearRotor_mm: 370, frontPistons: 10, rearPistons: 4, abs: 'sport' },
        wheels: { design: 'y-spoke', material: 'forged', diameter_in: 22, widthFront_in: 10.0, widthRear_in: 10.0, finish: '#2b2b2b', staggered: false },
        tires: { compound: 'super-sport', widthFront_mm: 285, widthRear_mm: 285, profileFront: 30, profileRear: 30 },
        aero: { splitter: 'lip', wing: 'lip-spoiler', diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
        exterior: { paint: '#7d7f7d', finish: 'solid', roof: 'black', stripe: 'none', caliperColor: '#b3121f', windowTint_pct: 40, lights: 'matrix', mirrors: 'black', badge: 'black' },
        interior: { seatType: 'sport', upholstery: 'nappa', primaryColor: '#1a1a1a', accentColor: '#b3121f', stitchColor: '#7d7f7d', trim: 'carbon', steering: 'flat-bottom', headliner: 'alcantara', ambientLighting: true, ambientColor: '#ff3344' },
        tech: { screen_in: 12, digitalCluster: true, hud: true, audio: 'reference', adas: 'pilot', climateZones: 4 }
      }
    },
    {
      id: 'lusso-brake', name: 'Lusso Shooting Brake', tagline: 'Naturally aspirated V12 up front, four seats, four-wheel drive and a long glass roof. Grand touring for the whole family.',
      tags: ['GT', 'V12', 'AWD'],
      build: {
        meta: { name: 'Lusso Shooting Brake' },
        body: { style: 'shooting-brake', model: 'ferrari-gtc4lusso', chassisMaterial: 'aluminum', wheelbase_mm: 2900, trackWidth_mm: 1660, doors: 3, seats: 4 },
        engine: { type: 'ice', layout: 'V12', displacement_l: 6.3, aspiration: 'na', boost_bar: 0, compression: 13.5, fuel: 'premium', redline_rpm: 8200, position: 'front', tune: 'stock', exhaust: 'valvetronic', cooling: 'uprated' },
        transmission: { type: 'dct', gears: 7, finalDrive: 3.40, launchControl: true },
        drivetrain: { layout: 'awd', frontDiff: 'open', rearDiff: 'e-diff', centerDiff: 'lsd-torsen', torqueSplitFront_pct: 20, torqueVectoring: true, tractionControl: 2 },
        suspension: { type: 'magnetic', springFront_nmm: 58, springRear_nmm: 64, damping: 4, rideHeight_mm: 120, camberFront_deg: -1.2, camberRear_deg: -1.0, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 5, arbRear: 4 },
        brakes: { material: 'carbon-ceramic', frontRotor_mm: 398, rearRotor_mm: 360, frontPistons: 6, rearPistons: 4, abs: 'sport' },
        wheels: { design: 'split-10', material: 'forged', diameter_in: 20, widthFront_in: 8.5, widthRear_in: 10.5, finish: '#3a3a3a', staggered: true },
        tires: { compound: 'super-sport', widthFront_mm: 245, widthRear_mm: 295, profileFront: 35, profileRear: 35 },
        aero: { splitter: 'lip', wing: 'none', diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: true, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#8a1c1c', finish: 'metallic', roof: 'body', stripe: 'none', caliperColor: '#f2c200', windowTint_pct: 20, lights: 'matrix', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'comfort', upholstery: 'semi-aniline', primaryColor: '#c8a27a', accentColor: '#2a1d14', stitchColor: '#f2e8d5', trim: 'carbon', steering: 'round', headliner: 'alcantara', ambientLighting: true, ambientColor: '#ffb366', harness: false },
        tech: { screen_in: 12, digitalCluster: true, hud: false, audio: 'reference', adas: 'plus', climateZones: 4 }
      }
    },
    {
      id: 'lightweight-roadster', name: 'Lightweight Roadster', tagline: 'Featherweight open two-seater with a revvy NA four. Simplify, then add lightness.',
      tags: ['Roadster', 'NA', 'Manual'],
      build: {
        meta: { name: 'Lightweight Roadster' },
        body: { style: 'roadster', model: 'mazda-mx5-nd', chassisMaterial: 'aluminum', wheelbase_mm: 2310, trackWidth_mm: 1500, doors: 2, seats: 2 },
        engine: { type: 'ice', layout: 'I4', displacement_l: 2.0, aspiration: 'na', boost_bar: 0, compression: 13.0, fuel: 'premium', redline_rpm: 7500, position: 'front', tune: 'stock', exhaust: 'sport', cooling: 'standard' },
        transmission: { type: 'manual', gears: 6, finalDrive: 3.90, launchControl: false },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-torsen', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 1 },
        suspension: { type: 'double-wishbone', springFront_nmm: 40, springRear_nmm: 35, damping: 4, rideHeight_mm: 125, camberFront_deg: -1.2, camberRear_deg: -1.6, toeFront_deg: 0, toeRear_deg: 0.15, arbFront: 5, arbRear: 3 },
        brakes: { material: 'iron', frontRotor_mm: 290, rearRotor_mm: 280, frontPistons: 2, rearPistons: 1, abs: 'sport' },
        wheels: { design: 'mesh-bbs', material: 'forged', diameter_in: 17, widthFront_in: 7.5, widthRear_in: 7.5, finish: '#c5c8cc', staggered: false },
        tires: { compound: 'performance', widthFront_mm: 215, widthRear_mm: 215, profileFront: 45, profileRear: 45 },
        aero: { splitter: 'none', wing: 'none', diffuser: 'none', canards: false, sideSkirts: false, activeAero: false },
        weight: { soundDeadening: false, rearSeats: false, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#9b111e', finish: 'candy', roof: 'black', stripe: 'pinstripe', stripeColor: '#c9b37e', caliperColor: '#c5c8cc', windowTint_pct: 10, lights: 'led', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'sport', upholstery: 'leather', primaryColor: '#8b5a2b', accentColor: '#1a1a1a', stitchColor: '#f2e8d5', trim: 'aluminum', steering: 'round', headliner: 'cloth', ambientLighting: false },
        tech: { screen_in: 8, digitalCluster: false, hud: false, audio: 'standard', adas: 'assist', climateZones: 1 }
      }
    },
    {
      id: 'desert-runner', name: 'Desert Runner', tagline: 'Supercharged V8 crew-cab with 280 mm of clearance and beadlocks. Baja is calling.',
      tags: ['Pickup', 'Off-road', 'V8'],
      build: {
        meta: { name: 'Desert Runner' },
        body: { style: 'pickup', model: 'ford-f150-raptor-gen3', chassisMaterial: 'high-strength-steel', wheelbase_mm: 3680, trackWidth_mm: 1740, doors: 4, seats: 5 },
        engine: { type: 'ice', layout: 'V8', displacement_l: 5.2, aspiration: 'supercharged', boost_bar: 0.9, compression: 9.5, fuel: 'premium', redline_rpm: 7000, position: 'front', tune: 'stage1', exhaust: 'sport', cooling: 'race' },
        transmission: { type: 'auto', gears: 10, finalDrive: 3.55, launchControl: false },
        drivetrain: { layout: 'awd', frontDiff: 'locking', rearDiff: 'locking', centerDiff: 'lsd-torsen', torqueSplitFront_pct: 40, torqueVectoring: false, tractionControl: 2 },
        suspension: { type: 'double-wishbone', springFront_nmm: 50, springRear_nmm: 60, damping: 4, rideHeight_mm: 280, camberFront_deg: 0, camberRear_deg: 0, toeFront_deg: 0.05, toeRear_deg: 0.05, arbFront: 2, arbRear: 1 },
        brakes: { material: 'drilled-slotted', frontRotor_mm: 380, rearRotor_mm: 350, frontPistons: 6, rearPistons: 2, abs: 'standard' },
        wheels: { design: 'beadlock', material: 'forged', diameter_in: 18, widthFront_in: 10.0, widthRear_in: 10.0, finish: '#1a1a1a', staggered: false },
        tires: { compound: 'all-season', widthFront_mm: 285, widthRear_mm: 285, profileFront: 70, profileRear: 70 },
        aero: { splitter: 'none', wing: 'none', diffuser: 'none', canards: false, sideSkirts: false, activeAero: false },
        weight: { soundDeadening: true, rearSeats: true, spareTire: true, glass: 'standard', battery: 'lead', rollCage: 'none' },
        exterior: { paint: '#ff4f00', finish: 'satin', roof: 'black', stripe: 'side-skirt', stripeColor: '#111111', caliperColor: '#111111', windowTint_pct: 30, lights: 'led', mirrors: 'black', badge: 'black' },
        interior: { seatType: 'sport', upholstery: 'leather', primaryColor: '#1a1a1a', accentColor: '#ff4f00', stitchColor: '#ff4f00', trim: 'carbon', steering: 'round', headliner: 'cloth', ambientLighting: true, ambientColor: '#ff7a1a' },
        tech: { screen_in: 12, digitalCluster: true, hud: false, audio: 'premium', adas: 'plus', climateZones: 2, nightVision: true }
      }
    },
    {
      id: 'atelier-shuttle', name: 'Redline Shuttle', tagline: 'Rear-motored electric grand van with lounge seats for seven and a 110 kWh LFP pack.',
      tags: ['EV', 'Van', 'Luxury'],
      build: {
        meta: { name: 'Redline Shuttle' },
        body: { style: 'van', model: 'vw-id-buzz', chassisMaterial: 'aluminum', wheelbase_mm: 3300, trackWidth_mm: 1660, doors: 5, seats: 7 },
        engine: { type: 'ev', position: 'rear', motors: 2, motorPower_kw: 150, battery_kwh: 110, chemistry: 'lfp', voltage: 400, regen: 2, exhaust: 'stock', tune: 'stock', cooling: 'standard' },
        transmission: { type: 'single-speed', gears: 1, ratios: [2.65], finalDrive: 3.40, launchControl: false },
        drivetrain: { layout: 'awd', frontDiff: 'open', rearDiff: 'open', centerDiff: 'e-diff', torqueSplitFront_pct: 30, torqueVectoring: false, tractionControl: 3 },
        suspension: { type: 'air', springFront_nmm: 55, springRear_nmm: 65, damping: 2, rideHeight_mm: 150, camberFront_deg: -0.5, camberRear_deg: -0.5, toeFront_deg: 0.05, toeRear_deg: 0.1, arbFront: 3, arbRear: 3 },
        brakes: { material: 'iron', frontRotor_mm: 350, rearRotor_mm: 330, frontPistons: 4, rearPistons: 1, abs: 'standard' },
        wheels: { design: 'aero-blade', material: 'cast', diameter_in: 19, widthFront_in: 8.0, widthRear_in: 8.0, finish: '#c5c8cc', staggered: false },
        tires: { compound: 'touring', widthFront_mm: 235, widthRear_mm: 235, profileFront: 55, profileRear: 55 },
        aero: { splitter: 'none', wing: 'none', diffuser: 'none', canards: false, sideSkirts: false, activeAero: false },
        weight: { soundDeadening: true, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#1a3a6d', finish: 'pearl', roof: 'contrast', roofColor: '#f2f1ec', stripe: 'none', caliperColor: '#3a3d41', windowTint_pct: 50, lights: 'matrix', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'lounge', upholstery: 'nappa', primaryColor: '#e8dfd0', accentColor: '#1a3a6d', stitchColor: '#1a3a6d', trim: 'gloss-walnut', steering: 'round', headliner: 'leather', ambientLighting: true, ambientColor: '#9ec9ff' },
        tech: { screen_in: 17, digitalCluster: true, hud: true, audio: 'concert', adas: 'autonomous-l3', climateZones: 4 }
      }
    },
    {
      id: 'touge-legend', name: 'Touge Legend', tagline: 'Featherweight 3-door with a high-revving NA twin-cam four, a five-speed stick and a clutch diff. Delivering tofu since 1983.',
      tags: ['JDM', 'NA', 'RWD'],
      build: {
        meta: { name: 'Touge Legend' },
        body: { style: 'hatchback', model: 'toyota-sprinter-trueno-ae86', chassisMaterial: 'steel', wheelbase_mm: 2450, trackWidth_mm: 1450, doors: 3, seats: 4 },
        engine: { type: 'ice', layout: 'I4', displacement_l: 1.6, aspiration: 'na', boost_bar: 0, compression: 11.0, fuel: 'premium', redline_rpm: 8000, position: 'front', tune: 'stage1', exhaust: 'sport', cooling: 'uprated' },
        transmission: { type: 'manual', gears: 5, finalDrive: 4.30, launchControl: false },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 0 },
        suspension: { type: 'macpherson', springFront_nmm: 40, springRear_nmm: 35, damping: 5, rideHeight_mm: 120, camberFront_deg: -2.0, camberRear_deg: -0.5, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 5, arbRear: 3 },
        brakes: { material: 'iron', frontRotor_mm: 280, rearRotor_mm: 280, frontPistons: 2, rearPistons: 1, abs: 'off' },
        wheels: { design: 'mesh-bbs', material: 'forged', diameter_in: 15, widthFront_in: 7.0, widthRear_in: 7.0, finish: '#c5c8cc', staggered: false },
        tires: { compound: 'performance', widthFront_mm: 195, widthRear_mm: 195, profileFront: 50, profileRear: 50 },
        aero: { splitter: 'none', wing: 'none', diffuser: 'none', canards: false, sideSkirts: false, activeAero: false },
        weight: { soundDeadening: false, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'half' },
        exterior: { paint: '#f2f1ec', finish: 'solid', roof: 'body', stripe: 'side-skirt', stripeColor: '#111111', caliperColor: '#3a3d41', windowTint_pct: 10, lights: 'halogen', mirrors: 'black', badge: 'black' },
        interior: { seatType: 'bucket', upholstery: 'cloth', primaryColor: '#1a1a1a', accentColor: '#c8102e', stitchColor: '#c8102e', trim: 'aluminum', steering: 'round', headliner: 'cloth', ambientLighting: false, harness: false },
        tech: { screen_in: 8, digitalCluster: false, hud: false, audio: 'standard', adas: 'none', climateZones: 1 }
      }
    },
    {
      id: 's15-drift-spec', name: 'S15 Drift Spec', tagline: 'Turbo four on a big single, clutch-type LSD, hydraulic-style angle and coilovers. Built to go sideways.',
      tags: ['JDM', 'Drift', 'Turbo'],
      build: {
        meta: { name: 'S15 Drift Spec' },
        body: { style: 'coupe', model: 'nissan-silvia-s15', chassisMaterial: 'steel', wheelbase_mm: 2525, trackWidth_mm: 1500, doors: 2, seats: 2 },
        engine: { type: 'ice', layout: 'I4', displacement_l: 2.0, aspiration: 'turbo', boost_bar: 1.4, compression: 8.5, fuel: 'premium', redline_rpm: 7800, position: 'front', tune: 'stage2', exhaust: 'straight-pipe', cooling: 'race' },
        transmission: { type: 'manual', gears: 6, finalDrive: 4.10, launchControl: false },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 0 },
        suspension: { type: 'coilover-track', springFront_nmm: 90, springRear_nmm: 70, damping: 6, rideHeight_mm: 95, camberFront_deg: -3.5, camberRear_deg: -1.0, toeFront_deg: 0.1, toeRear_deg: 0.05, arbFront: 7, arbRear: 3 },
        brakes: { material: 'two-piece', frontRotor_mm: 330, rearRotor_mm: 300, frontPistons: 4, rearPistons: 2, abs: 'off' },
        wheels: { design: 'deep-dish', material: 'forged', diameter_in: 18, widthFront_in: 9.5, widthRear_in: 10.0, finish: '#1a1a1a', staggered: true },
        tires: { compound: 'performance', widthFront_mm: 245, widthRear_mm: 265, profileFront: 40, profileRear: 35 },
        aero: { splitter: 'lip', wing: 'swan-neck', wingAngle_deg: 6, diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: false, rearSeats: false, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'full' },
        exterior: { paint: '#f6c200', finish: 'solid', roof: 'carbon', stripe: 'none', caliperColor: '#d40000', windowTint_pct: 20, lights: 'led', mirrors: 'carbon', badge: 'black', livery_number: '15' },
        interior: { seatType: 'race-shell', upholstery: 'alcantara', primaryColor: '#111111', accentColor: '#f6c200', stitchColor: '#f6c200', trim: 'carbon', steering: 'race-quick-release', headliner: 'cloth', ambientLighting: false, harness: true },
        tech: { screen_in: 8, digitalCluster: true, hud: false, audio: 'delete', adas: 'none', climateZones: 1, telemetry: true }
      }
    },
    {
      id: 'r34-godzilla', name: 'R34 Godzilla', tagline: 'Twin-turbo straight-six, ATTESA-style AWD and a Getrag six-speed. Bayside Blue, obviously.',
      tags: ['JDM', 'I6', 'AWD'],
      build: {
        meta: { name: 'R34 Godzilla' },
        body: { style: 'coupe', model: 'nissan-skyline-gtr-r34', chassisMaterial: 'high-strength-steel', wheelbase_mm: 2665, trackWidth_mm: 1500, doors: 2, seats: 4 },
        engine: { type: 'ice', layout: 'I6', displacement_l: 2.6, aspiration: 'twin-turbo', boost_bar: 1.3, compression: 8.5, fuel: 'premium', redline_rpm: 8000, position: 'front', tune: 'stage2', exhaust: 'titanium', cooling: 'race' },
        transmission: { type: 'manual', gears: 6, finalDrive: 3.55, launchControl: true },
        drivetrain: { layout: 'awd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'lsd-clutch', torqueSplitFront_pct: 25, torqueVectoring: false, tractionControl: 1 },
        suspension: { type: 'multilink', springFront_nmm: 85, springRear_nmm: 75, damping: 6, rideHeight_mm: 115, camberFront_deg: -2.0, camberRear_deg: -1.5, toeFront_deg: 0, toeRear_deg: 0.15, arbFront: 6, arbRear: 5 },
        brakes: { material: 'two-piece', frontRotor_mm: 356, rearRotor_mm: 324, frontPistons: 6, rearPistons: 4, abs: 'sport' },
        wheels: { design: 'monoblock-6', material: 'forged', diameter_in: 18, widthFront_in: 9.5, widthRear_in: 9.5, finish: '#3a3a3a', staggered: false },
        tires: { compound: 'super-sport', widthFront_mm: 265, widthRear_mm: 265, profileFront: 35, profileRear: 35 },
        aero: { splitter: 'carbon', wing: 'gt-wing', wingAngle_deg: 8, diffuser: 'carbon', canards: false, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: true, rearSeats: true, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#1f4fa8', finish: 'pearl', roof: 'body', stripe: 'none', caliperColor: '#d40000', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'bucket', upholstery: 'alcantara', primaryColor: '#1a1a1a', accentColor: '#1f4fa8', stitchColor: '#c5c8cc', trim: 'carbon', steering: 'round', headliner: 'cloth', ambientLighting: false, harness: false },
        tech: { screen_in: 8, digitalCluster: true, hud: false, audio: 'standard', adas: 'none', climateZones: 1, telemetry: true }
      }
    },
    {
      id: 'fd-rotary', name: 'FD Rotary', tagline: 'Sequential-turbo twin-rotor, 50:50 balance and the curviest roof of the nineties. Brap brap.',
      tags: ['JDM', 'Rotary', 'Turbo'],
      build: {
        meta: { name: 'FD Rotary' },
        body: { style: 'coupe', model: 'mazda-rx7-fd3s', chassisMaterial: 'aluminum', wheelbase_mm: 2450, trackWidth_mm: 1460, doors: 2, seats: 2 },
        engine: { type: 'ice', layout: 'rotary-2', displacement_l: 1.3, aspiration: 'twin-turbo', boost_bar: 0.9, compression: 9.0, fuel: 'premium', redline_rpm: 8500, position: 'front', tune: 'stage1', exhaust: 'titanium', cooling: 'race' },
        transmission: { type: 'manual', gears: 5, finalDrive: 4.10, launchControl: false },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-torsen', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 1 },
        suspension: { type: 'double-wishbone', springFront_nmm: 70, springRear_nmm: 60, damping: 5, rideHeight_mm: 110, camberFront_deg: -2.0, camberRear_deg: -1.5, toeFront_deg: 0, toeRear_deg: 0.1, arbFront: 6, arbRear: 4 },
        brakes: { material: 'drilled-slotted', frontRotor_mm: 330, rearRotor_mm: 300, frontPistons: 4, rearPistons: 2, abs: 'sport' },
        wheels: { design: 'multi-spoke', material: 'forged', diameter_in: 18, widthFront_in: 9.0, widthRear_in: 9.5, finish: '#c9b37e', staggered: true },
        tires: { compound: 'super-sport', widthFront_mm: 245, widthRear_mm: 265, profileFront: 40, profileRear: 35 },
        aero: { splitter: 'lip', wing: 'swan-neck', wingAngle_deg: 5, diffuser: 'mild', canards: false, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: false, rearSeats: false, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#9b111e', finish: 'metallic', roof: 'body', stripe: 'none', caliperColor: '#c5c8cc', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'bucket', upholstery: 'leather', primaryColor: '#1a1a1a', accentColor: '#9b111e', stitchColor: '#9b111e', trim: 'aluminum', steering: 'round', headliner: 'cloth', ambientLighting: false, harness: false },
        tech: { screen_in: 8, digitalCluster: false, hud: false, audio: 'standard', adas: 'none', climateZones: 1 }
      }
    },
    {
      id: 'huracan-evo', name: 'Huracán EVO', tagline: 'Naturally aspirated V10 screaming to 8,500 rpm behind your ears, four-wheel drive and predictive torque vectoring.',
      tags: ['V10', 'AWD', 'Supercar'],
      build: {
        meta: { name: 'Huracán EVO' },
        body: { style: 'hypercar', model: 'lamborghini-huracan-evo', chassisMaterial: 'aluminum', wheelbase_mm: 2620, trackWidth_mm: 1645, doors: 2, seats: 2 },
        engine: { type: 'ice', layout: 'V10', displacement_l: 5.2, aspiration: 'na', boost_bar: 0, compression: 12.7, fuel: 'premium', redline_rpm: 8500, position: 'mid', tune: 'stock', exhaust: 'valvetronic', cooling: 'uprated' },
        transmission: { type: 'dct', gears: 7, finalDrive: 3.40, launchControl: true },
        drivetrain: { layout: 'awd', frontDiff: 'open', rearDiff: 'e-diff', centerDiff: 'e-diff', torqueSplitFront_pct: 30, torqueVectoring: true, tractionControl: 2 },
        suspension: { type: 'magnetic', springFront_nmm: 110, springRear_nmm: 125, damping: 6, rideHeight_mm: 115, camberFront_deg: -1.8, camberRear_deg: -1.6, toeFront_deg: 0, toeRear_deg: 0.15, arbFront: 6, arbRear: 5 },
        brakes: { material: 'carbon-ceramic', frontRotor_mm: 380, rearRotor_mm: 356, frontPistons: 6, rearPistons: 4, abs: 'sport' },
        wheels: { design: 'y-spoke', material: 'forged', diameter_in: 20, widthFront_in: 8.5, widthRear_in: 11.0, finish: '#1a1a1a', staggered: true },
        tires: { compound: 'super-sport', widthFront_mm: 245, widthRear_mm: 305, profileFront: 30, profileRear: 25 },
        aero: { splitter: 'carbon', wing: 'lip-spoiler', diffuser: 'carbon', canards: false, sideSkirts: true, activeAero: false },
        weight: { soundDeadening: true, rearSeats: false, spareTire: false, glass: 'standard', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#8fd14f', finish: 'pearl', roof: 'body', stripe: 'none', caliperColor: '#111111', windowTint_pct: 20, lights: 'led', mirrors: 'body', badge: 'black' },
        interior: { seatType: 'sport', upholstery: 'alcantara', primaryColor: '#111111', accentColor: '#8fd14f', stitchColor: '#8fd14f', trim: 'forged-carbon', steering: 'flat-bottom', headliner: 'alcantara', ambientLighting: true, ambientColor: '#8fd14f', harness: false },
        tech: { screen_in: 8, digitalCluster: true, hud: false, audio: 'premium', adas: 'assist', climateZones: 1, liftSystem: true }
      }
    },
    {
      id: 'jesko-attack', name: 'Jesko Attack', tagline: 'Flat-plane twin-turbo V8 on E85, a nine-speed multi-clutch box and a towering rear wing. Downforce first, questions later.',
      tags: ['Hypercar', 'V8', 'Aero'],
      build: {
        meta: { name: 'Jesko Attack' },
        body: { style: 'hypercar', model: 'koenigsegg-jesko', chassisMaterial: 'carbon-monocoque', wheelbase_mm: 2700, trackWidth_mm: 1675, doors: 2, seats: 2 },
        engine: { type: 'ice', layout: 'V8', displacement_l: 5.0, aspiration: 'twin-turbo', boost_bar: 1.5, compression: 8.6, fuel: 'e85', redline_rpm: 8500, position: 'mid', tune: 'stock', exhaust: 'titanium', cooling: 'race' },
        transmission: { type: 'dct', gears: 9, finalDrive: 2.85, launchControl: true },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'e-diff', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: true, tractionControl: 2 },
        suspension: { type: 'pushrod', springFront_nmm: 200, springRear_nmm: 220, damping: 8, rideHeight_mm: 85, camberFront_deg: -3.0, camberRear_deg: -2.2, toeFront_deg: -0.05, toeRear_deg: 0.2, arbFront: 8, arbRear: 7 },
        brakes: { material: 'carbon-ceramic', frontRotor_mm: 410, rearRotor_mm: 380, frontPistons: 6, rearPistons: 4, abs: 'race' },
        wheels: { design: 'centerlock-race', material: 'carbon', diameter_in: 21, widthFront_in: 10.0, widthRear_in: 12.5, finish: '#111111', staggered: true },
        tires: { compound: 'track', widthFront_mm: 275, widthRear_mm: 335, profileFront: 30, profileRear: 30 },
        aero: { splitter: 'race', wing: 'swan-neck', wingAngle_deg: 14, diffuser: 'race', canards: true, sideSkirts: true, activeAero: true },
        weight: { soundDeadening: false, rearSeats: false, spareTire: false, glass: 'thin', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#f2f1ec', finish: 'pearl', roof: 'carbon', stripe: 'center', stripeColor: '#c8102e', caliperColor: '#c8102e', windowTint_pct: 20, lights: 'laser', mirrors: 'carbon', badge: 'black' },
        interior: { seatType: 'carbon-bucket', upholstery: 'alcantara', primaryColor: '#111111', accentColor: '#c8102e', stitchColor: '#c8102e', trim: 'forged-carbon', steering: 'flat-bottom', headliner: 'alcantara', ambientLighting: true, ambientColor: '#ff2a2a', harness: true },
        tech: { screen_in: 10, digitalCluster: true, hud: true, audio: 'premium', adas: 'none', climateZones: 1, telemetry: true, liftSystem: true }
      }
    },
    {
      id: 'alpine-featherweight', name: 'Alpine Featherweight', tagline: 'Aluminium-bodied mid-engine 1.8 turbo at barely 1,100 kg. Soft springs, tiny tyres, pure balance.',
      tags: ['Lightweight', 'Mid-engine', 'Turbo'],
      build: {
        meta: { name: 'Alpine Featherweight' },
        body: { style: 'coupe', model: 'alpine-a110', chassisMaterial: 'aluminum', wheelbase_mm: 2450, trackWidth_mm: 1555, doors: 2, seats: 2 },
        engine: { type: 'ice', layout: 'I4', displacement_l: 1.8, aspiration: 'turbo', boost_bar: 1.2, compression: 9.0, fuel: 'premium', redline_rpm: 6800, position: 'mid', tune: 'stock', exhaust: 'sport', cooling: 'uprated' },
        transmission: { type: 'dct', gears: 7, finalDrive: 4.20, launchControl: true },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 2 },
        suspension: { type: 'double-wishbone', springFront_nmm: 45, springRear_nmm: 50, damping: 4, rideHeight_mm: 120, camberFront_deg: -1.5, camberRear_deg: -1.6, toeFront_deg: 0, toeRear_deg: 0.15, arbFront: 4, arbRear: 4 },
        brakes: { material: 'two-piece', frontRotor_mm: 320, rearRotor_mm: 320, frontPistons: 4, rearPistons: 1, abs: 'sport' },
        wheels: { design: 'fan-blade', material: 'flow-formed', diameter_in: 18, widthFront_in: 7.5, widthRear_in: 8.5, finish: '#2b2b2b', staggered: true },
        tires: { compound: 'super-sport', widthFront_mm: 215, widthRear_mm: 245, profileFront: 40, profileRear: 40 },
        aero: { splitter: 'lip', wing: 'none', diffuser: 'carbon', canards: false, sideSkirts: false, activeAero: false },
        weight: { soundDeadening: false, rearSeats: false, spareTire: false, glass: 'thin', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#1f5fbf', finish: 'metallic', roof: 'body', stripe: 'none', caliperColor: '#ff6f1a', windowTint_pct: 15, lights: 'led', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'carbon-bucket', upholstery: 'leather', primaryColor: '#1a1a1a', accentColor: '#1f5fbf', stitchColor: '#1f5fbf', trim: 'carbon', steering: 'round', headliner: 'cloth', ambientLighting: false, harness: false },
        tech: { screen_in: 8, digitalCluster: true, hud: false, audio: 'standard', adas: 'assist', climateZones: 1 }
      }
    },
    {
      id: 'e46-m3-csl', name: 'E46 M3 CSL', tagline: '3.2-litre individual-throttle straight-six to 8,000 rpm, carbon roof, ducktail and SMG. The lightweight legend.',
      tags: ['I6', 'NA', 'RWD'],
      build: {
        meta: { name: 'E46 M3 CSL' },
        body: { style: 'coupe', model: 'bmw-m3-e46', chassisMaterial: 'high-strength-steel', wheelbase_mm: 2730, trackWidth_mm: 1515, doors: 2, seats: 4 },
        engine: { type: 'ice', layout: 'I6', displacement_l: 3.2, aspiration: 'na', boost_bar: 0, compression: 11.5, fuel: 'premium', redline_rpm: 8000, position: 'front', tune: 'stage1', exhaust: 'sport', cooling: 'uprated' },
        transmission: { type: 'sequential', gears: 6, finalDrive: 3.62, launchControl: true },
        drivetrain: { layout: 'rwd', frontDiff: 'open', rearDiff: 'lsd-clutch', centerDiff: 'none', torqueSplitFront_pct: 0, torqueVectoring: false, tractionControl: 1 },
        suspension: { type: 'macpherson', springFront_nmm: 60, springRear_nmm: 70, damping: 6, rideHeight_mm: 115, camberFront_deg: -1.8, camberRear_deg: -1.6, toeFront_deg: 0, toeRear_deg: 0.15, arbFront: 6, arbRear: 5 },
        brakes: { material: 'drilled-slotted', frontRotor_mm: 344, rearRotor_mm: 328, frontPistons: 4, rearPistons: 1, abs: 'sport' },
        wheels: { design: 'y-spoke', material: 'forged', diameter_in: 19, widthFront_in: 8.5, widthRear_in: 9.5, finish: '#3a3a3a', staggered: true },
        tires: { compound: 'track', widthFront_mm: 235, widthRear_mm: 265, profileFront: 35, profileRear: 30 },
        aero: { splitter: 'carbon', wing: 'ducktail', diffuser: 'carbon', canards: false, sideSkirts: false, activeAero: false },
        weight: { soundDeadening: false, rearSeats: true, spareTire: false, glass: 'thin', battery: 'lithium', rollCage: 'none' },
        exterior: { paint: '#5c6168', finish: 'metallic', roof: 'carbon', stripe: 'none', caliperColor: '#1b3d8f', windowTint_pct: 15, lights: 'led', mirrors: 'body', badge: 'chrome' },
        interior: { seatType: 'bucket', upholstery: 'alcantara', primaryColor: '#1a1a1a', accentColor: '#3a3d41', stitchColor: '#c8102e', trim: 'carbon', steering: 'round', headliner: 'alcantara', ambientLighting: false, harness: false },
        tech: { screen_in: 8, digitalCluster: false, hud: false, audio: 'standard', adas: 'none', climateZones: 1 }
      }
    }
  ];

  // Give every preset explicit gear ratios generated by its own gearbox (so a 7-speed sequential preset does not
  // inherit the default 7-speed DCT ratios merely because the lengths match).
  presets.forEach(function (p) {
    var t = p.build.transmission;
    if (!t || t.ratios) return;
    for (var i = 0; i < transmissions.length; i++) {
      if (transmissions[i].id === t.type) { t.ratios = transmissions[i].defaultRatios(t.gears); break; }
    }
  });

  /* ======================================================================
     HELPERS
     ====================================================================== */
  var data;

  /** find('bodyStyles', 'coupe') / find('aero.wings', 'gt-wing'). Loose-equal for numeric ids (screenSizes, voltages). */
  function find(collection, id) {
    var list = list_(collection);
    if (!list) return undefined;
    for (var i = 0; i < list.length; i++) {
      // eslint-disable-next-line eqeqeq
      if (list[i].id === id || (typeof list[i].id === 'number' && list[i].id == id)) return list[i];
    }
    return undefined;
  }

  function list_(collection) {
    var parts = String(collection).split('.');
    var cur = data;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return Array.isArray(cur) ? cur : undefined;
  }

  /** Find swatch name for a hex (case-insensitive), or null. */
  function swatchName(hex) {
    if (!hex) return null;
    var h = String(hex).toLowerCase();
    for (var i = 0; i < paintSwatches.length; i++) if (paintSwatches[i].hex.toLowerCase() === h) return paintSwatches[i].name;
    return null;
  }

  function preset(id) {
    for (var i = 0; i < presets.length; i++) if (presets[i].id === id) return presets[i];
    return undefined;
  }

  /** Full (un-normalized) build for a preset: deep-merged onto defaultBuild(), meta.presetId set. */
  function presetBuild(id) {
    var p = preset(id);
    if (!p) return null;
    var merge = (CB.util && CB.util.deepMerge) || function (a, b) { return Object.assign({}, a, b); };
    var b = merge(defaultBuild(), p.build);
    b.meta.presetId = p.id;
    if (!p.build.meta || !p.build.meta.name) b.meta.name = p.name;
    return b;
  }

  /**
   * Map from build path -> catalog collection, used by normalize() and the rules/pricing modules.
   */
  var pathCollections = {
    'body.style': 'bodyStyles', 'body.chassisMaterial': 'chassisMaterials', 'body.construction': 'constructions',
    'engine.type': 'engineTypes', 'engine.layout': 'engineLayouts', 'engine.aspiration': 'aspirations', 'engine.fuel': 'fuels',
    'engine.position': 'enginePositions', 'engine.tune': 'tunes', 'engine.exhaust': 'exhausts', 'engine.cooling': 'coolings',
    'engine.chemistry': 'batteryChemistries', 'engine.voltage': 'voltages', 'engine.speedLimiter_kph': 'speedLimiters',
    'transmission.type': 'transmissions',
    'drivetrain.layout': 'drivetrainLayouts', 'drivetrain.frontDiff': 'differentials', 'drivetrain.rearDiff': 'differentials', 'drivetrain.centerDiff': 'differentials',
    'suspension.type': 'suspensionTypes', 'brakes.material': 'brakeMaterials', 'brakes.abs': 'absModes',
    'wheels.design': 'wheelDesigns', 'wheels.material': 'wheelMaterials', 'tires.compound': 'tireCompounds', 'tires.speedRating': 'tireSpeedRatings',
    'aero.splitter': 'aero.splitters', 'aero.wing': 'aero.wings', 'aero.diffuser': 'aero.diffusers',
    'weight.glass': 'glassTypes', 'weight.battery': 'batteryTypes', 'weight.rollCage': 'rollCages', 'weight.ballastPosition': 'ballastPositions',
    'exterior.finish': 'paintFinishes', 'exterior.roof': 'roofTypes', 'exterior.stripe': 'stripes', 'exterior.lights': 'lightTypes',
    'exterior.mirrors': 'mirrorTypes', 'exterior.badge': 'badgeTypes',
    'interior.seatType': 'seatTypes', 'interior.upholstery': 'upholsteries', 'interior.trim': 'trims',
    'interior.steering': 'steeringTypes', 'interior.headliner': 'headliners',
    'tech.screen_in': 'screenSizes', 'tech.audio': 'audioSystems', 'tech.adas': 'adasLevels'
  };

  /**
   * Real-car shape each body style falls back to (mirrors the `default: true` / first-registered model in js/shapes/models).
   * Lets state.normalize pick a valid body.model for a style even when CB.shapes is not loaded (Node tests, old pages).
   */
  var styleDefaultModels = {
    coupe: 'porsche-911-992', sedan: 'bmw-m3-g80', hatchback: 'vw-golf-gti-mk8', wagon: 'audi-rs6-avant-c8',
    suv: 'porsche-cayenne-e3', roadster: 'mazda-mx5-nd', pickup: 'ford-f150-raptor-gen3', hypercar: 'ferrari-sf90-stradale',
    'shooting-brake': 'porsche-taycan-cross-turismo', van: 'mercedes-sprinter-vs30'
  };
  bodyStyles.forEach(function (s) { if (!s.defaultModel && styleDefaultModels[s.id]) s.defaultModel = styleDefaultModels[s.id]; });

  /**
   * Real-car reference figures per CB.shapes model id: [body style, length m, width m, height m, Cd, kerb kg] — a copy of each
   * model's `ref` (js/shapes/models/*; tests/stock-specs.test.js keeps the two in sync) so CB.physics can scale the
   * glider mass, frontal area and Cd by the real model a build names (build.body.model) without depending on CB.shapes
   * being loaded (only when build.body.modelPhysics is on). body.model null = the generic style car (no scaling).
   */
  var modelRefs = {
    'porsche-911-992': ['coupe', 4.519, 1.852, 1.298, 0.29, 1505],
    'bmw-m4-g82': ['coupe', 4.794, 1.887, 1.393, 0.34, 1725],
    'toyota-gr-supra-a90': ['coupe', 4.379, 1.854, 1.292, 0.31, 1520],
    'vw-golf-gti-mk8': ['hatchback', 4.287, 1.789, 1.457, 0.3, 1463],
    'honda-civic-type-r-fl5': ['hatchback', 4.594, 1.89, 1.405, 0.31, 1446],
    'toyota-gr-yaris': ['hatchback', 3.995, 1.805, 1.455, 0.33, 1280],
    'ferrari-sf90-stradale': ['hypercar', 4.71, 1.972, 1.186, 0.32, 1770],
    'mclaren-p1': ['hypercar', 4.588, 1.946, 1.188, 0.34, 1490],
    'bugatti-chiron': ['hypercar', 4.544, 2.038, 1.212, 0.36, 1995],
    'lamborghini-huracan-evo': ['hypercar', 4.52, 1.933, 1.165, 0.36, 1600],
    'ferrari-296-gtb': ['hypercar', 4.565, 1.958, 1.187, 0.34, 1600],
    'porsche-918-spyder': ['roadster', 4.643, 1.94, 1.167, 0.36, 1674],
    'koenigsegg-jesko': ['hypercar', 4.61, 2.03, 1.21, 0.38, 1420],
    'audi-r8-v10-gen2': ['hypercar', 4.426, 1.94, 1.24, 0.36, 1640],
    'nissan-silvia-s15': ['coupe', 4.445, 1.695, 1.285, 0.3, 1250],
    'nissan-skyline-gtr-r34': ['coupe', 4.6, 1.785, 1.36, 0.34, 1560],
    'toyota-sprinter-trueno-ae86': ['hatchback', 4.205, 1.625, 1.335, 0.35, 940],
    'mazda-rx7-fd3s': ['coupe', 4.285, 1.76, 1.23, 0.31, 1270],
    'nissan-gtr-r35': ['coupe', 4.71, 1.895, 1.37, 0.26, 1752],
    'bmw-m2-g87': ['coupe', 4.58, 1.887, 1.403, 0.35, 1725],
    'bmw-m3-e46': ['coupe', 4.492, 1.78, 1.372, 0.32, 1495],
    'alpine-a110': ['coupe', 4.18, 1.798, 1.252, 0.32, 1103],
    'aston-martin-vantage-2018': ['coupe', 4.465, 1.942, 1.273, 0.34, 1630],
    'lotus-emira': ['coupe', 4.413, 1.895, 1.226, 0.37, 1458],
    'subaru-wrx-sti-va': ['sedan', 4.595, 1.795, 1.475, 0.32, 1540],
    'mitsubishi-lancer-evo-x': ['sedan', 4.505, 1.81, 1.48, 0.36, 1560],
    'ford-mustang-gt-s650': ['coupe', 4.81, 1.915, 1.397, 0.33, 1738],
    'chevrolet-camaro-zl1-2019': ['coupe', 4.783, 1.897, 1.344, 0.35, 1760],
    'dodge-challenger-srt-hellcat': ['coupe', 5.017, 1.923, 1.454, 0.382, 2002],
    'chevrolet-corvette-c8': ['hypercar', 4.63, 1.934, 1.234, 0.35, 1604],
    'ford-gt-2017': ['hypercar', 4.779, 2.003, 1.109, 0.35, 1385],
    'jeep-wrangler-rubicon-jl': ['suv', 4.785, 1.894, 1.848, 0.454, 2018],
    'ford-f150-raptor-gen3': ['pickup', 5.908, 2.2, 2.027, 0.55, 2590],
    'toyota-tacoma-trdpro-2024': ['pickup', 5.441, 2.035, 1.943, 0.47, 2345],
    'tesla-cybertruck': ['pickup', 5.682, 2.032, 1.791, 0.39, 2995],
    'mazda-mx5-nd': ['roadster', 3.915, 1.735, 1.235, 0.33, 1058],
    'bmw-z4-g29': ['roadster', 4.324, 1.864, 1.304, 0.31, 1535],
    'porsche-718-boxster-982': ['roadster', 4.379, 1.801, 1.281, 0.31, 1335],
    'bmw-m3-g80': ['sedan', 4.794, 1.903, 1.433, 0.34, 1730],
    'mercedes-amg-c63-w206': ['sedan', 4.842, 1.9, 1.458, 0.3, 2111],
    'tesla-model-s-2021': ['sedan', 5.021, 1.964, 1.431, 0.208, 2069],
    'porsche-taycan-cross-turismo': ['shooting-brake', 4.974, 1.967, 1.409, 0.26, 2245],
    'ferrari-gtc4lusso': ['shooting-brake', 4.922, 1.98, 1.383, 0.32, 1920],
    'mercedes-cls-shooting-brake-x218': ['shooting-brake', 4.956, 1.881, 1.416, 0.29, 2005],
    'porsche-cayenne-e3': ['suv', 4.93, 1.983, 1.698, 0.36, 2122],
    'range-rover-sport-l461': ['suv', 4.946, 2.047, 1.82, 0.29, 2310],
    'lamborghini-urus': ['suv', 5.112, 2.016, 1.638, 0.33, 2200],
    'mercedes-sprinter-vs30': ['van', 5.932, 2.02, 2.73, 0.31, 2650],
    'vw-id-buzz': ['van', 4.712, 1.985, 1.938, 0.285, 2471],
    'ford-transit-hr': ['van', 5.982, 2.065, 2.804, 0.37, 2540],
    'audi-rs6-avant-c8': ['wagon', 4.995, 1.951, 1.46, 0.35, 2075],
    'mercedes-amg-e63s-estate-s213': ['wagon', 4.995, 1.907, 1.465, 0.32, 2070],
    'volvo-v60-polestar-engineered': ['wagon', 4.761, 1.85, 1.432, 0.29, 2078]
  };

  data = {
    bodyStyles: bodyStyles, chassisMaterials: chassisMaterials, constructions: constructions,
    tireSpeedRatings: tireSpeedRatings, speedLimiters: speedLimiters,
    engineTypes: engineTypes, enginePositions: enginePositions, engineLayouts: engineLayouts, aspirations: aspirations,
    fuels: fuels, tunes: tunes, exhausts: exhausts, coolings: coolings, batteryChemistries: batteryChemistries, voltages: voltages,
    transmissions: transmissions, differentials: differentials, drivetrainLayouts: drivetrainLayouts,
    suspensionTypes: suspensionTypes, brakeMaterials: brakeMaterials, pistonOptions: pistonOptions, absModes: absModes,
    wheelDesigns: wheelDesigns, wheelMaterials: wheelMaterials, tireCompounds: tireCompounds, aero: aero,
    glassTypes: glassTypes, batteryTypes: batteryTypes, rollCages: rollCages, ballastPositions: ballastPositions,
    paintFinishes: paintFinishes, paintSwatches: paintSwatches, stripes: stripes, roofTypes: roofTypes, lightTypes: lightTypes,
    mirrorTypes: mirrorTypes, badgeTypes: badgeTypes,
    seatTypes: seatTypes, upholsteries: upholsteries, trims: trims, steeringTypes: steeringTypes, headliners: headliners,
    screenSizes: screenSizes, audioSystems: audioSystems, adasLevels: adasLevels,
    options: options, optionWeights: optionWeights, ranges: ranges, batteryRanges: batteryRanges, motorRanges: motorRanges,
    constants: constants, presets: presets, pathCollections: pathCollections, modelRefs: modelRefs,
    defaultBuild: defaultBuild, referenceBuild: referenceBuild, find: find, list: list_, swatchName: swatchName, preset: preset, presetBuild: presetBuild,
    effectiveCompression: effectiveCompression
  };

  CB.data = data;
})();

if (typeof module !== 'undefined') module.exports = CB.data;

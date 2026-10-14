/* ==========================================================================
   REDLINE Garage — js/shapes/stock-specs.js
   CB.stock : factory ("stock" / "vanilla") specification for every real model in CB.shapes, and the Garage's
   one-click Auto-config that turns the current build into that car as it left the factory.

   API
     spec(id)              compact factory spec for a model id (null when unknown)
     has(idOrBuild)        true when the model (or the model a build shows) has a stock spec
     title(idOrModel)      'Porsche 911 Carrera S' (make + model + trim)
     build(id, base?)      { build, spec, model, target, metrics } — a full build of the stock car (calibrated: see
                           below). base (optional) only donates meta (id, created, name)
     apply(opts?)          replace the current CB.state build by the stock spec of the model it shows, as ONE undo step
                           labelled 'Stock spec: <title>'. opts: { model: id } to pick another model. Returns the
                           build() result (+ label, changed), or null when no spec / no model.
     run(opts?)            apply() + a toast with an Undo action (the Garage's Auto-config button, F key, model chip)
     isStock(build?)       true when the build is exactly its model's stock spec (meta ignored)
     SPECS                 the raw table (one entry per model id)

   Table fields (per model id) — real-world factory figures for the trim named in `t`:
     t     trim appended to the model's name for the title ('' = model name already is the trim)
     hp    peak (system) power, mechanical hp       nm   peak torque, Nm
     kg    kerb weight (EU-style, no driver)        s    0–100 km/h, s        v   top speed, km/h (governed if so)
     e     ICE: 'layout displacement aspiration redline [fuel]'   (fuel defaults to premium)
     hy    hybrid: [motors (1–2 at the crank / front e-axle), total motor kW, battery kWh]   (with e)
     ev    electric: [motors, total kW, battery kWh, volts, chemistry]
     g     gearbox 'type gears'                     d   drivetrain 'rwd' | 'fwd' | 'awd <front torque %>' | '4wd'
     c     equipment class (CLASS below) — suspension / brakes / tyres / cabin defaults
     p     paint [hex, finish] when the model itself carries no colour
     x     path overrides { 'aero.wing': 'gt-wing', ... }

   Mapping onto the configurator: dimensions (wheelbase, track, ride height, wheel Ø, tyres) come from the model's
   own reference (CB.state.realDims); layout / displacement / aspiration / gearbox / drivetrain are copied;
   the engine's free parameters (boost, or compression for NA engines; motor kW for EVs) are then solved against
   CB.physics so the configurator's power lands on the real figure, the final drive is set so the redline in top
   gear sits just above the real top speed, and a little ballast (max 100 kg) brings a too-light build up to the
   real kerb weight. Everything is snapped to valid catalog options and normalized (CB.state.normalize).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  /* ---------------------------------------------------------------- factory specs (53 models) */
  var SPECS = {
    /* coupés */
    'porsche-911-992': { t: 'S', hp: 443, nm: 530, kg: 1515, s: 3.5, v: 308, e: 'flat-6 3.0 twin-turbo 7500', g: 'dct 8', d: 'rwd', c: 'sport',
      x: { 'aero.wing': 'ducktail', 'suspension.type': 'magnetic', 'interior.trim': 'piano-black' } },
    'bmw-m4-g82': { t: '', hp: 503, nm: 650, kg: 1725, s: 3.9, v: 250, e: 'I6 3.0 twin-turbo 7200', g: 'auto 8', d: 'rwd', c: 'sport',
      p: ['#e3c300', 'metallic'], x: { 'exterior.roof': 'carbon', 'suspension.type': 'magnetic', 'interior.seatType': 'bucket' } },
    'toyota-gr-supra-a90': { t: '3.0', hp: 382, nm: 500, kg: 1520, s: 4.1, v: 250, e: 'I6 3.0 turbo 6500', g: 'auto 8', d: 'rwd', c: 'sport',
      p: ['#c4161c', 'metallic'], x: { 'aero.wing': 'ducktail', 'body.seats': 2 } },
    'nissan-silvia-s15': { t: '', hp: 247, nm: 275, kg: 1250, s: 5.5, v: 240, e: 'I4 2.0 turbo 7200', g: 'manual 6', d: 'rwd', c: 'classic',
      x: { 'aero.wing': 'lip-spoiler' } },
    'nissan-skyline-gtr-r34': { t: '', hp: 276, nm: 392, kg: 1560, s: 4.9, v: 250, e: 'I6 2.6 twin-turbo 8000', g: 'manual 6', d: 'awd 25', c: 'classic',
      x: { 'aero.wing': 'gt-wing', 'aero.splitter': 'lip', 'aero.diffuser': 'mild', 'brakes.material': 'drilled-slotted', 'drivetrain.rearDiff': 'lsd-clutch', 'drivetrain.centerDiff': 'e-diff' } },
    'mazda-rx7-fd3s': { t: '', hp: 276, nm: 314, kg: 1270, s: 5.3, v: 250, e: 'rotary-2 1.3 twin-turbo 8000', g: 'manual 5', d: 'rwd', c: 'classic',
      x: { 'aero.wing': 'lip-spoiler', 'drivetrain.rearDiff': 'lsd-torsen' } },
    'nissan-gtr-r35': { t: '', hp: 565, nm: 633, kg: 1752, s: 2.9, v: 315, e: 'V6 3.8 twin-turbo 7100', g: 'dct 6', d: 'awd 20', c: 'sport',
      x: { 'aero.wing': 'lip-spoiler', 'suspension.type': 'magnetic', 'brakes.material': 'two-piece', 'drivetrain.rearDiff': 'lsd-clutch' } },
    'bmw-m2-g87': { t: '', hp: 453, nm: 550, kg: 1725, s: 4.1, v: 250, e: 'I6 3.0 twin-turbo 7200', g: 'auto 8', d: 'rwd', c: 'sport',
      p: ['#2a6fb5', 'metallic'], x: { 'suspension.type': 'magnetic' } },
    'bmw-m3-e46': { t: '', hp: 338, nm: 365, kg: 1495, s: 5.2, v: 250, e: 'I6 3.2 na 8000', g: 'manual 6', d: 'rwd', c: 'classic',
      p: ['#1f8ac0', 'metallic'], x: { 'drivetrain.rearDiff': 'lsd-viscous', 'interior.upholstery': 'leather', 'tech.screen_in': 0 } },
    'alpine-a110': { t: '', hp: 249, nm: 320, kg: 1103, s: 4.5, v: 250, e: 'I4 1.8 turbo 6750', g: 'dct 7', d: 'rwd', c: 'sport',
      p: ['#1f5aa6', 'metallic'], x: { 'body.chassisMaterial': 'aluminum', 'suspension.type': 'double-wishbone', 'brakes.material': 'iron', 'drivetrain.rearDiff': 'open', 'interior.seatType': 'bucket', 'body.seats': 2 } },
    'aston-martin-vantage-2018': { t: '', hp: 503, nm: 685, kg: 1630, s: 3.6, v: 314, e: 'V8 4.0 twin-turbo 7000', g: 'auto 8', d: 'rwd', c: 'gt',
      p: ['#004225', 'metallic'], x: { 'drivetrain.rearDiff': 'e-diff', 'body.seats': 2 } },
    'lotus-emira': { t: 'V6', hp: 400, nm: 420, kg: 1458, s: 4.3, v: 290, e: 'V6 3.5 supercharged 6800', g: 'manual 6', d: 'rwd', c: 'sport',
      p: ['#e9c400', 'metallic'], x: { 'body.chassisMaterial': 'aluminum', 'suspension.type': 'double-wishbone', 'aero.wing': 'ducktail', 'body.seats': 2 } },
    'ford-mustang-gt-s650': { t: '', hp: 480, nm: 567, kg: 1738, s: 4.3, v: 250, e: 'V8 5.0 na 7500', g: 'manual 6', d: 'rwd', c: 'muscle',
      x: { 'aero.wing': 'lip-spoiler' } },
    'chevrolet-camaro-zl1-2019': { t: '', hp: 650, nm: 881, kg: 1760, s: 3.5, v: 318, e: 'V8 6.2 supercharged 6500', g: 'auto 10', d: 'rwd', c: 'muscle',
      x: { 'aero.wing': 'lip-spoiler', 'aero.splitter': 'lip', 'suspension.type': 'magnetic', 'brakes.material': 'two-piece', 'drivetrain.rearDiff': 'e-diff' } },
    'dodge-challenger-srt-hellcat': { t: '', hp: 717, nm: 889, kg: 2002, s: 3.6, v: 320, e: 'V8 6.2 supercharged 6200', g: 'auto 8', d: 'rwd', c: 'muscle',
      x: { 'brakes.material': 'two-piece', 'aero.wing': 'lip-spoiler', 'exterior.stripe': 'none' } },
    /* hot hatches & sports saloons */
    'vw-golf-gti-mk8': { t: '', hp: 241, nm: 370, kg: 1463, s: 6.3, v: 250, e: 'I4 2.0 turbo 6500', g: 'dct 7', d: 'fwd', c: 'hot',
      p: ['#b1131c', 'solid'], x: { 'interior.upholstery': 'tartan', 'drivetrain.frontDiff': 'e-diff' } },
    'honda-civic-type-r-fl5': { t: '', hp: 315, nm: 420, kg: 1446, s: 5.4, v: 275, e: 'I4 2.0 turbo 7000', g: 'manual 6', d: 'fwd', c: 'hot',
      p: ['#f4f3ef', 'solid'], x: { 'aero.wing': 'gt-wing', 'aero.wingAngle_deg': 4, 'aero.splitter': 'lip', 'aero.diffuser': 'mild', 'brakes.material': 'two-piece', 'drivetrain.frontDiff': 'lsd-clutch', 'interior.seatType': 'bucket', 'interior.upholstery': 'alcantara', 'interior.primaryColor': '#b3121f' } },
    'toyota-gr-yaris': { t: '', hp: 268, nm: 370, kg: 1280, s: 5.5, v: 230, e: 'I3 1.6 turbo 7000', g: 'manual 6', d: 'awd 40', c: 'hot',
      p: ['#f2f1ec', 'pearl'], x: { 'aero.wing': 'lip-spoiler', 'drivetrain.frontDiff': 'lsd-torsen', 'drivetrain.rearDiff': 'lsd-torsen', 'drivetrain.centerDiff': 'e-diff', 'body.chassisMaterial': 'high-strength-steel' } },
    'toyota-sprinter-trueno-ae86': { t: '', hp: 128, nm: 149, kg: 940, s: 8.5, v: 195, e: 'I4 1.6 na 7600', g: 'manual 5', d: 'rwd', c: 'classic',
      x: { 'suspension.type': 'macpherson', 'brakes.frontPistons': 1, 'brakes.rearPistons': 1, 'tires.compound': 'touring', 'interior.seatType': 'sport', 'drivetrain.rearDiff': 'lsd-clutch', 'exterior.roof': 'black', 'body.seats': 4 } },
    'subaru-wrx-sti-va': { t: '', hp: 310, nm: 393, kg: 1540, s: 5.2, v: 255, e: 'flat-4 2.5 turbo 6700', g: 'manual 6', d: 'awd 41', c: 'hot',
      p: ['#1a4fa0', 'pearl'], x: { 'aero.wing': 'gt-wing', 'aero.wingAngle_deg': 4, 'aero.splitter': 'lip', 'wheels.finish': '#c9b37e', 'drivetrain.frontDiff': 'lsd-torsen', 'drivetrain.rearDiff': 'lsd-torsen', 'drivetrain.centerDiff': 'e-diff', 'brakes.material': 'drilled-slotted' } },
    'mitsubishi-lancer-evo-x': { t: 'GSR', hp: 291, nm: 407, kg: 1560, s: 5.0, v: 242, e: 'I4 2.0 turbo 7000', g: 'manual 5', d: 'awd 50', c: 'hot',
      p: ['#c8102e', 'solid'], x: { 'aero.wing': 'gt-wing', 'aero.wingAngle_deg': 3, 'drivetrain.frontDiff': 'lsd-clutch', 'drivetrain.rearDiff': 'e-diff', 'drivetrain.centerDiff': 'e-diff', 'brakes.material': 'two-piece', 'interior.seatType': 'bucket' } },
    'bmw-m3-g80': { t: '', hp: 503, nm: 650, kg: 1730, s: 3.9, v: 250, e: 'I6 3.0 twin-turbo 7200', g: 'auto 8', d: 'rwd', c: 'sport',
      p: ['#1f6b4f', 'metallic'], x: { 'exterior.roof': 'carbon', 'suspension.type': 'magnetic' } },
    'mercedes-amg-c63-w206': { t: '', hp: 671, nm: 1020, kg: 2111, s: 3.4, v: 280, e: 'I4 2.0 electric-turbo 7200', hy: [1, 150, 6.1], g: 'auto 9', d: 'awd 35', c: 'gt',
      p: ['#6e7175', 'metallic'], x: { 'suspension.type': 'magnetic', 'drivetrain.rearDiff': 'e-diff', 'drivetrain.torqueVectoring': true } },
    'tesla-model-s-2021': { t: 'Long Range', hp: 670, nm: 1000, kg: 2069, s: 3.2, v: 250, ev: [2, 500, 100, 400, 'nca'], g: 'single-speed 1', d: 'awd 45', c: 'ev',
      p: ['#f2f1ec', 'pearl'], x: { 'interior.steering': 'yoke', 'tech.screen_in': 17 } },
    /* exotics & hypercars */
    'ferrari-sf90-stradale': { t: '', hp: 986, nm: 800, kg: 1770, s: 2.5, v: 340, e: 'V8 4.0 twin-turbo 8000', hy: [2, 220, 7.9], g: 'dct 8', d: 'awd 30', c: 'hyper',
      p: ['#d40000', 'metallic'], x: { 'body.chassisMaterial': 'aluminum', 'aero.wing': 'none', 'aero.activeAero': true, 'engine.chemistry': 'nca' } },
    'mclaren-p1': { t: '', hp: 903, nm: 900, kg: 1490, s: 2.8, v: 350, e: 'V8 3.8 twin-turbo 8500', hy: [1, 132, 4.7], g: 'dct 7', d: 'rwd', c: 'hyper',
      p: ['#ff6a13', 'metallic'], x: { 'aero.wing': 'active', 'aero.activeAero': true, 'suspension.type': 'pushrod', 'engine.chemistry': 'nca' } },
    'bugatti-chiron': { t: '', hp: 1479, nm: 1600, kg: 1995, s: 2.4, v: 420, e: 'W16 8.0 quad-turbo 6800', g: 'auto 7', d: 'awd 40', c: 'hyper',
      p: ['#1b3d8f', 'metallic'], x: { 'body.chassisMaterial': 'carbon-monocoque', 'aero.wing': 'active', 'aero.activeAero': true, 'interior.seatType': 'comfort', 'interior.upholstery': 'nappa', 'cooling': 'race' } },
    'lamborghini-huracan-evo': { t: '', hp: 631, nm: 600, kg: 1600, s: 2.9, v: 325, e: 'V10 5.2 na 8500', g: 'dct 7', d: 'awd 30', c: 'hyper',
      p: ['#6dbf2c', 'pearl'], x: { 'body.chassisMaterial': 'aluminum', 'aero.wing': 'lip-spoiler', 'suspension.type': 'magnetic', 'drivetrain.torqueVectoring': true } },
    'ferrari-296-gtb': { t: '', hp: 819, nm: 740, kg: 1600, s: 2.9, v: 330, e: 'V6 3.0 twin-turbo 8500', hy: [1, 122, 7.45], g: 'dct 8', d: 'rwd', c: 'hyper',
      p: ['#d40000', 'metallic'], x: { 'body.chassisMaterial': 'aluminum', 'aero.wing': 'active', 'aero.activeAero': true, 'engine.chemistry': 'nca' } },
    // Jesko: flex-fuel; on E85 the configurator's twin-turbo map reaches the 1,280 hp (95 RON) rating within the knock limit
    'koenigsegg-jesko': { t: 'Attack', hp: 1280, nm: 1000, kg: 1420, s: 2.5, v: 350, e: 'V8 5.0 twin-turbo 8500 e85', g: 'dct 9', d: 'rwd', c: 'hyper',
      p: ['#f2f1ec', 'pearl'], x: { 'body.chassisMaterial': 'carbon-monocoque', 'aero.wing': 'swan-neck', 'aero.wingAngle_deg': 8, 'aero.splitter': 'race', 'aero.diffuser': 'race', 'aero.canards': true, 'tires.compound': 'track', 'suspension.type': 'pushrod', 'exterior.roof': 'carbon' } },
    'audi-r8-v10-gen2': { t: '', hp: 562, nm: 550, kg: 1640, s: 3.4, v: 324, e: 'V10 5.2 na 8700', g: 'dct 7', d: 'awd 30', c: 'hyper',
      p: ['#7d7f7d', 'metallic'], x: { 'body.chassisMaterial': 'aluminum', 'brakes.material': 'two-piece', 'aero.wing': 'lip-spoiler', 'drivetrain.centerDiff': 'lsd-clutch', 'interior.seatType': 'sport', 'interior.upholstery': 'leather' } },
    'chevrolet-corvette-c8': { t: 'Z51', hp: 495, nm: 637, kg: 1604, s: 3.0, v: 312, e: 'V8 6.2 na 6600', g: 'dct 8', d: 'rwd', c: 'sport',
      x: { 'body.chassisMaterial': 'aluminum', 'suspension.type': 'magnetic', 'brakes.material': 'two-piece', 'aero.wing': 'lip-spoiler', 'aero.splitter': 'lip', 'drivetrain.rearDiff': 'e-diff', 'body.seats': 2 } },
    'ford-gt-2017': { t: '', hp: 647, nm: 746, kg: 1385, s: 3.0, v: 347, e: 'V6 3.5 twin-turbo 7000', g: 'dct 7', d: 'rwd', c: 'hyper',
      x: { 'aero.wing': 'active', 'aero.activeAero': true, 'aero.splitter': 'race', 'aero.diffuser': 'race', 'suspension.type': 'pushrod', 'exterior.stripe': 'racing-dual', 'exterior.stripeColor': '#f4f3ef' } },
    'porsche-918-spyder': { t: '', hp: 875, nm: 1280, kg: 1674, s: 2.6, v: 345, e: 'V8 4.6 na 9150', hy: [2, 210, 6.8], g: 'dct 7', d: 'awd 25', c: 'hyper',
      p: ['#b7bcc2', 'metallic'], x: { 'body.chassisMaterial': 'carbon-monocoque', 'aero.wing': 'active', 'aero.activeAero': true, 'engine.chemistry': 'nca' } },
    /* roadsters */
    'mazda-mx5-nd': { t: '2.0', hp: 181, nm: 205, kg: 1058, s: 6.5, v: 220, e: 'I4 2.0 na 7500', g: 'manual 6', d: 'rwd', c: 'sport',
      p: ['#9b111e', 'metallic'], x: { 'suspension.type': 'double-wishbone', 'brakes.material': 'iron', 'brakes.frontPistons': 1, 'brakes.rearPistons': 1, 'drivetrain.rearDiff': 'lsd-torsen', 'interior.upholstery': 'cloth', 'tech.screen_in': 8, 'engine.exhaust': 'stock' } },
    'bmw-z4-g29': { t: '', hp: 382, nm: 500, kg: 1535, s: 4.1, v: 250, e: 'I6 3.0 turbo 7000', g: 'auto 8', d: 'rwd', c: 'gt',
      p: ['#1f5fbf', 'metallic'], x: { 'suspension.type': 'magnetic', 'drivetrain.rearDiff': 'e-diff' } },
    'porsche-718-boxster-982': { t: '', hp: 296, nm: 380, kg: 1335, s: 4.9, v: 275, e: 'flat-4 2.0 turbo 7500', g: 'dct 7', d: 'rwd', c: 'sport',
      p: ['#f9d71c', 'solid'], x: { 'suspension.type': 'double-wishbone', 'brakes.material': 'iron', 'drivetrain.rearDiff': 'open', 'aero.wing': 'ducktail' } },
    /* utility */
    'jeep-wrangler-rubicon-jl': { t: '', hp: 285, nm: 353, kg: 2018, s: 7.5, v: 180, e: 'V6 3.6 na 6600 regular', g: 'auto 8', d: '4wd', c: 'utility',
      x: { 'drivetrain.frontDiff': 'locking', 'drivetrain.rearDiff': 'locking', 'drivetrain.centerDiff': 'locking', 'wheels.design': 'beadlock', 'weight.spareTire': true, 'exterior.roof': 'black', 'tech.screen_in': 8 } },
    'ford-f150-raptor-gen3': { t: '', hp: 450, nm: 691, kg: 2590, s: 5.8, v: 172, e: 'V6 3.5 twin-turbo 6000 regular', g: 'auto 10', d: '4wd', c: 'utility',
      x: { 'wheels.design': 'beadlock', 'drivetrain.rearDiff': 'locking', 'tech.screen_in': 12, 'exterior.roof': 'black' } },
    'toyota-tacoma-trdpro-2024': { t: '', hp: 326, nm: 630, kg: 2345, s: 7.0, v: 170, e: 'I4 2.4 turbo 6000 regular', hy: [1, 36, 1.9], g: 'auto 8', d: '4wd', c: 'utility',
      x: { 'drivetrain.rearDiff': 'locking', 'tech.screen_in': 15, 'engine.chemistry': 'nmc' } },
    'tesla-cybertruck': { t: 'Cyberbeast', hp: 845, nm: 1389, kg: 3104, s: 2.9, v: 209, ev: [3, 630, 123, 800, 'nca'], g: 'single-speed 1', d: 'awd 35', c: 'ev',
      x: { 'exterior.finish': 'satin', 'suspension.type': 'air', 'tires.compound': 'all-season', 'wheels.design': 'aero-blade', 'tech.screen_in': 17, 'body.seats': 5, 'body.doors': 4 } },
    'porsche-cayenne-e3': { t: '', hp: 348, nm: 500, kg: 2122, s: 6.0, v: 248, e: 'V6 3.0 turbo 6500', g: 'auto 8', d: 'awd 40', c: 'lux',
      p: ['#f2f1ec', 'solid'], x: { 'suspension.type': 'multilink', 'tires.compound': 'touring', 'exterior.lights': 'matrix' } },
    'range-rover-sport-l461': { t: 'P400', hp: 395, nm: 550, kg: 2310, s: 5.9, v: 242, e: 'I6 3.0 turbo 6500', g: 'auto 8', d: 'awd 50', c: 'lux',
      p: ['#3a3d41', 'metallic'], x: { 'drivetrain.centerDiff': 'e-diff' } },
    'lamborghini-urus': { t: '', hp: 641, nm: 850, kg: 2200, s: 3.6, v: 305, e: 'V8 4.0 twin-turbo 6800', g: 'auto 8', d: 'awd 40', c: 'lux',
      p: ['#f6c200', 'pearl'], x: { 'brakes.material': 'carbon-ceramic', 'tires.compound': 'super-sport', 'drivetrain.rearDiff': 'e-diff', 'drivetrain.torqueVectoring': true, 'interior.seatType': 'sport', 'interior.upholstery': 'alcantara', 'engine.exhaust': 'valvetronic' } },
    /* vans */
    'mercedes-sprinter-vs30': { t: '2.0 diesel', hp: 211, nm: 450, kg: 2650, s: 12.0, v: 160, e: 'I4 2.0 turbo 5000 diesel', g: 'auto 9', d: 'rwd', c: 'van',
      p: ['#f4f3ef', 'solid'] },
    'vw-id-buzz': { t: 'Pro', hp: 201, nm: 310, kg: 2471, s: 10.2, v: 145, ev: [1, 150, 77, 400, 'nmc'], g: 'single-speed 1', d: 'rwd', c: 'ev',
      p: ['#e8d12a', 'metallic'], x: { 'exterior.roof': 'contrast', 'exterior.roofColor': '#f4f3ef', 'suspension.type': 'macpherson', 'tires.compound': 'eco', 'body.seats': 7 } },
    'ford-transit-hr': { t: '3.5 V6', hp: 275, nm: 355, kg: 2540, s: 9.5, v: 160, e: 'V6 3.5 na 6000 regular', g: 'auto 10', d: 'rwd', c: 'van',
      p: ['#f4f3ef', 'solid'] },
    /* wagons & shooting brakes */
    'audi-rs6-avant-c8': { t: '', hp: 591, nm: 800, kg: 2075, s: 3.6, v: 250, e: 'V8 4.0 twin-turbo 6800', g: 'auto 8', d: 'awd 40', c: 'gt',
      x: { 'suspension.type': 'air', 'drivetrain.centerDiff': 'lsd-torsen', 'drivetrain.rearDiff': 'e-diff', 'exterior.lights': 'laser', 'tech.adas': 'plus' } },
    'mercedes-amg-e63s-estate-s213': { t: '', hp: 604, nm: 850, kg: 2070, s: 3.5, v: 250, e: 'V8 4.0 twin-turbo 7000', g: 'auto 9', d: 'awd 35', c: 'gt',
      x: { 'suspension.type': 'air', 'drivetrain.rearDiff': 'e-diff', 'tech.adas': 'plus' } },
    'volvo-v60-polestar-engineered': { t: '', hp: 405, nm: 670, kg: 2078, s: 4.6, v: 250, e: 'I4 2.0 twincharged 6000', hy: [1, 65, 11.6], g: 'auto 8', d: 'awd 50', c: 'lux',
      x: { 'suspension.type': 'multilink', 'brakes.material': 'drilled-slotted', 'brakes.frontPistons': 6, 'tires.compound': 'performance', 'interior.upholstery': 'nappa', 'interior.stitchColor': '#c9a227' } },
    'porsche-taycan-cross-turismo': { t: '', hp: 483, nm: 640, kg: 2245, s: 4.1, v: 240, ev: [2, 360, 79.2, 800, 'nmc'], g: 'single-speed 1', d: 'awd 40', c: 'ev',
      p: ['#6e7175', 'metallic'], x: { 'tires.compound': 'all-season', 'brakes.material': 'iron', 'interior.seatType': 'sport' } },
    'ferrari-gtc4lusso': { t: '', hp: 680, nm: 697, kg: 1920, s: 3.4, v: 335, e: 'V12 6.3 na 8250', g: 'dct 7', d: 'awd 15', c: 'gt',
      p: ['#d40000', 'metallic'], x: { 'body.chassisMaterial': 'aluminum', 'brakes.material': 'carbon-ceramic', 'suspension.type': 'magnetic', 'tires.compound': 'super-sport', 'drivetrain.rearDiff': 'e-diff' } },
    'mercedes-cls-shooting-brake-x218': { t: '', hp: 402, nm: 600, kg: 2005, s: 5.2, v: 250, e: 'V8 4.7 twin-turbo 6300', g: 'auto 7', d: 'awd 45', c: 'lux',
      p: ['#0d0d0f', 'metallic'], x: { 'tires.compound': 'touring' } }
  };

  /* ---------------------------------------------------------------- equipment classes */
  var CLASS = {
    sport: { 'body.chassisMaterial': 'high-strength-steel', 'suspension.type': 'multilink', 'brakes.material': 'two-piece', 'brakes.abs': 'sport',
      'tires.compound': 'performance', 'wheels.material': 'forged', 'wheels.design': 'y-spoke', 'engine.exhaust': 'valvetronic',
      'drivetrain.rearDiff': 'lsd-clutch', 'interior.seatType': 'sport', 'interior.upholstery': 'leather', 'interior.trim': 'carbon', 'interior.steering': 'round',
      'interior.headliner': 'alcantara', 'tech.screen_in': 12, 'tech.audio': 'premium', 'tech.adas': 'assist', 'exterior.lights': 'led', 'aero.splitter': 'none' },
    hot: { 'body.chassisMaterial': 'high-strength-steel', 'suspension.type': 'macpherson', 'brakes.material': 'iron', 'brakes.abs': 'sport',
      'tires.compound': 'performance', 'wheels.material': 'cast', 'wheels.design': 'turbine', 'engine.exhaust': 'sport',
      'interior.seatType': 'sport', 'interior.upholstery': 'cloth', 'interior.trim': 'piano-black', 'interior.steering': 'flat-bottom',
      'interior.headliner': 'cloth', 'tech.screen_in': 10, 'tech.audio': 'standard', 'tech.adas': 'assist', 'exterior.lights': 'led' },
    classic: { 'body.chassisMaterial': 'steel', 'suspension.type': 'double-wishbone', 'brakes.material': 'iron', 'brakes.abs': 'standard',
      'tires.compound': 'performance', 'wheels.material': 'cast', 'wheels.design': 'monoblock-5', 'engine.exhaust': 'stock',
      'interior.seatType': 'sport', 'interior.upholstery': 'cloth', 'interior.trim': 'aluminum', 'interior.steering': 'round', 'interior.headliner': 'cloth',
      'interior.ambientLighting': false, 'tech.screen_in': 0, 'tech.digitalCluster': false, 'tech.audio': 'standard', 'tech.adas': 'none',
      'tech.climateZones': 1, 'exterior.lights': 'halogen', 'exterior.windowTint_pct': 0 },
    muscle: { 'body.chassisMaterial': 'steel', 'suspension.type': 'multilink', 'brakes.material': 'iron', 'brakes.abs': 'sport',
      'tires.compound': 'performance', 'wheels.material': 'forged', 'wheels.design': 'split-10', 'engine.exhaust': 'valvetronic',
      'drivetrain.rearDiff': 'lsd-clutch', 'interior.seatType': 'sport', 'interior.upholstery': 'leather', 'interior.trim': 'aluminum',
      'interior.headliner': 'cloth', 'tech.screen_in': 12, 'tech.audio': 'premium', 'tech.adas': 'assist', 'exterior.lights': 'led' },
    gt: { 'body.chassisMaterial': 'aluminum', 'suspension.type': 'magnetic', 'brakes.material': 'two-piece', 'brakes.abs': 'sport',
      'tires.compound': 'performance', 'wheels.material': 'forged', 'wheels.design': 'twin-7', 'engine.exhaust': 'valvetronic',
      'drivetrain.rearDiff': 'lsd-clutch', 'interior.seatType': 'sport', 'interior.upholstery': 'nappa', 'interior.trim': 'carbon',
      'interior.headliner': 'alcantara', 'tech.screen_in': 12, 'tech.audio': 'reference', 'tech.adas': 'assist', 'exterior.lights': 'matrix' },
    hyper: { 'body.chassisMaterial': 'carbon-tub', 'suspension.type': 'double-wishbone', 'brakes.material': 'carbon-ceramic', 'brakes.abs': 'sport',
      'tires.compound': 'super-sport', 'wheels.material': 'forged', 'wheels.design': 'split-10', 'engine.exhaust': 'valvetronic', 'engine.cooling': 'uprated',
      'drivetrain.rearDiff': 'e-diff', 'aero.splitter': 'carbon', 'aero.diffuser': 'carbon', 'aero.sideSkirts': true,
      'interior.seatType': 'carbon-bucket', 'interior.upholstery': 'alcantara', 'interior.trim': 'carbon', 'interior.steering': 'flat-bottom',
      'interior.headliner': 'alcantara', 'tech.screen_in': 10, 'tech.audio': 'standard', 'tech.adas': 'assist', 'tech.liftSystem': true, 'exterior.lights': 'led',
      'weight.battery': 'lithium' },
    lux: { 'body.chassisMaterial': 'aluminum', 'suspension.type': 'air', 'brakes.material': 'iron', 'brakes.abs': 'standard',
      'tires.compound': 'performance', 'wheels.material': 'cast', 'wheels.design': 'multi-spoke', 'engine.exhaust': 'stock',
      'drivetrain.rearDiff': 'open', 'interior.seatType': 'comfort', 'interior.upholstery': 'nappa', 'interior.trim': 'open-pore-wood',
      'interior.headliner': 'alcantara', 'tech.screen_in': 12, 'tech.audio': 'premium', 'tech.adas': 'plus', 'tech.climateZones': 4, 'exterior.lights': 'matrix',
      'exterior.roof': 'glass' },
    ev: { 'body.chassisMaterial': 'aluminum', 'suspension.type': 'air', 'brakes.material': 'iron', 'brakes.abs': 'standard',
      'tires.compound': 'touring', 'wheels.material': 'cast', 'wheels.design': 'aero-blade', 'engine.exhaust': 'stock', 'engine.regen': 2,
      'drivetrain.frontDiff': 'open', 'drivetrain.rearDiff': 'open', 'interior.seatType': 'comfort', 'interior.upholstery': 'vegan', 'interior.trim': 'piano-black',
      'interior.headliner': 'cloth', 'tech.screen_in': 15, 'tech.audio': 'premium', 'tech.adas': 'plus', 'exterior.lights': 'led', 'exterior.roof': 'glass' },
    utility: { 'body.chassisMaterial': 'steel', 'suspension.type': 'double-wishbone', 'brakes.material': 'iron', 'brakes.abs': 'standard',
      'tires.compound': 'all-season', 'wheels.material': 'cast', 'wheels.design': 'monoblock-6', 'engine.exhaust': 'stock', 'engine.cooling': 'uprated',
      'drivetrain.frontDiff': 'open', 'drivetrain.rearDiff': 'open', 'drivetrain.centerDiff': 'locking', 'drivetrain.tractionControl': 3,
      'interior.seatType': 'comfort', 'interior.upholstery': 'leather', 'interior.trim': 'piano-black', 'interior.headliner': 'cloth',
      'tech.screen_in': 12, 'tech.audio': 'premium', 'tech.adas': 'assist', 'exterior.lights': 'led', 'weight.spareTire': true },
    van: { 'body.chassisMaterial': 'steel', 'suspension.type': 'macpherson', 'brakes.material': 'iron', 'brakes.abs': 'standard',
      'tires.compound': 'all-season', 'wheels.material': 'steel', 'wheels.design': 'monoblock-5', 'engine.exhaust': 'stock',
      'drivetrain.rearDiff': 'open', 'drivetrain.tractionControl': 3, 'interior.seatType': 'comfort', 'interior.upholstery': 'cloth',
      'interior.trim': 'piano-black', 'interior.headliner': 'cloth', 'interior.ambientLighting': false, 'tech.screen_in': 10,
      'tech.audio': 'standard', 'tech.adas': 'assist', 'tech.climateZones': 2, 'exterior.lights': 'halogen', 'weight.spareTire': true }
  };
  /* cabin / misc defaults every stock car starts from (the class and the model then override) */
  var BASE = {
    'engine.tune': 'stock', 'engine.cooling': 'standard', 'engine.exhaust': 'stock', 'transmission.launchControl': false,
    'drivetrain.torqueVectoring': false, 'drivetrain.tractionControl': 2, 'drivetrain.frontDiff': 'open', 'drivetrain.rearDiff': 'open', 'drivetrain.centerDiff': 'none',
    'suspension.damping': 5, 'suspension.camberFront_deg': -1.0, 'suspension.camberRear_deg': -1.2, 'suspension.toeFront_deg': 0, 'suspension.toeRear_deg': 0.1,
    'suspension.arbFront': 5, 'suspension.arbRear': 4, 'brakes.abs': 'standard',
    'aero.splitter': 'none', 'aero.wing': 'none', 'aero.wingAngle_deg': 6, 'aero.diffuser': 'none', 'aero.canards': false, 'aero.sideSkirts': false, 'aero.activeAero': false,
    'weight.soundDeadening': true, 'weight.spareTire': false, 'weight.glass': 'standard', 'weight.battery': 'lead', 'weight.rollCage': 'none',
    'weight.ballast_kg': 0, 'weight.ballastPosition': 'center',
    'exterior.roof': 'body', 'exterior.roofColor': '#111111', 'exterior.stripe': 'none', 'exterior.stripeColor': '#ffffff', 'exterior.windowTint_pct': 10,
    'exterior.mirrors': 'body', 'exterior.badge': 'chrome', 'exterior.livery_number': '',
    'interior.primaryColor': '#1a1a1a', 'interior.accentColor': '#3a3d41', 'interior.stitchColor': '#3a3d41', 'interior.trim': 'aluminum',
    'interior.steering': 'round', 'interior.ambientLighting': true, 'interior.ambientColor': '#ffffff', 'interior.harness': false,
    'tech.digitalCluster': true, 'tech.hud': false, 'tech.climateZones': 2, 'tech.telemetry': false, 'tech.liftSystem': false, 'tech.nightVision': false
  };
  var SEATS = { coupe: 4, sedan: 5, hatchback: 5, wagon: 5, suv: 5, roadster: 2, pickup: 5, hypercar: 2, 'shooting-brake': 4, van: 9 };

  /* ---------------------------------------------------------------- helpers */
  function U() { return CB.util; }
  function D() { return CB.data; }
  function S() { return CB.shapes || null; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function setp(o, path, v) {
    var k = path.split('.'), cur = o;
    for (var i = 0; i < k.length - 1; i++) { if (!cur[k[i]] || typeof cur[k[i]] !== 'object') cur[k[i]] = {}; cur = cur[k[i]]; }
    cur[k[k.length - 1]] = v;
  }
  function getp(o, path) { return path.split('.').reduce(function (c, k) { return c == null ? undefined : c[k]; }, o); }
  function nearestOf(list, v) { return list.reduce(function (a, s) { return Math.abs(s - v) < Math.abs(a - v) ? s : a; }, list[0]); }
  function modelOf(src) {
    var sh = S();
    if (!sh || !sh.models) return null;
    if (typeof src === 'string') return sh.models[src] || null;
    if (src && src.id && src.ref) return src;
    if (src && src.body) {
      if (CB.state && typeof CB.state.modelOf === 'function') { try { return CB.state.modelOf(src); } catch (e) { return null; } }
      try { return sh.getModel(src, { strict: true }); } catch (e2) { return null; }
    }
    return null;
  }
  function spec(id) { return Object.prototype.hasOwnProperty.call(SPECS, id) ? SPECS[id] : null; }
  function has(src) { var m = modelOf(src); return !!(m && spec(m.id)); }
  function title(src) {
    var m = modelOf(src), sp = m && spec(m.id);
    if (!m) return '';
    return [m.make, m.name, sp && sp.t].filter(Boolean).join(' ');
  }
  function physics(b) {
    var P = CB.physics;
    if (!P || typeof P.compute !== 'function') return null;
    try { return P.compute(b); } catch (e) { return null; }
  }
  function norm(b) { return CB.state && typeof CB.state.normalize === 'function' ? CB.state.normalize(b) : b; }

  /* ---------------------------------------------------------------- the stock build */
  function assemble(m, sp, base) {
    var b = U().deepClone(D().defaultBuild());
    var st = m.style, styleObj = D().find('bodyStyles', st) || {};
    var flat = {};
    function put(src) { if (src) Object.keys(src).forEach(function (k) { flat[k] = src[k]; }); }
    put(BASE); put(CLASS[sp.c] || CLASS.sport);

    // body: style + model + the real car's dimensions (and ideal rims for its tyres)
    flat['body.style'] = st; flat['body.model'] = m.id;
    var dims = CB.state && typeof CB.state.realDims === 'function' ? CB.state.realDims(m) : null;
    if (dims) (CB.state.REAL_DIM_PATHS || []).concat(['wheels.widthFront_in', 'wheels.widthRear_in', 'wheels.staggered']).forEach(function (p) {
      var v = getp(dims, p); if (v !== undefined) flat[p] = v;
    });
    var doorOpts = styleObj.doorOptions || [2], seatOpts = styleObj.seatOptions || [2];
    flat['body.doors'] = nearestOf(doorOpts, num(m.doors, doorOpts[doorOpts.length - 1]));
    flat['body.seats'] = nearestOf(seatOpts, SEATS[st] || 4);

    // powertrain
    var dl = String(sp.d || 'rwd').split(' ');
    var layout = dl[0] === '4wd' ? 'awd' : dl[0];
    flat['drivetrain.layout'] = layout;
    flat['drivetrain.torqueSplitFront_pct'] = layout === 'fwd' ? 100 : layout === 'rwd' ? 0 : num(dl[1], dl[0] === '4wd' ? 50 : 40);
    if (layout === 'fwd') { flat['drivetrain.rearDiff'] = 'none'; if (flat['drivetrain.frontDiff'] === 'none') flat['drivetrain.frontDiff'] = 'open'; }
    if (layout === 'rwd') { flat['drivetrain.frontDiff'] = 'open'; flat['drivetrain.centerDiff'] = 'none'; if (flat['drivetrain.rearDiff'] === 'none') flat['drivetrain.rearDiff'] = 'open'; }
    if (layout === 'awd') {
      if (flat['drivetrain.rearDiff'] === 'none') flat['drivetrain.rearDiff'] = 'open';
      if (flat['drivetrain.centerDiff'] === 'none') flat['drivetrain.centerDiff'] = 'e-diff';
    }
    var g = String(sp.g || 'auto 8').split(' ');
    flat['transmission.type'] = g[0]; flat['transmission.gears'] = num(g[1], 8);
    if (sp.ev) {
      flat['engine.type'] = 'ev';
      flat['engine.position'] = m.enginePosition === 'rear' ? 'rear' : m.enginePosition === 'mid' ? 'mid' : 'front';
      flat['engine.motors'] = sp.ev[0];
      flat['engine.motorPower_kw'] = clamp(Math.round(sp.ev[1] / sp.ev[0] / 5) * 5, 50, 500);
      flat['engine.battery_kwh'] = sp.ev[2]; flat['engine.voltage'] = sp.ev[3]; flat['engine.chemistry'] = sp.ev[4] || 'nmc';
      flat['engine.exhaust'] = 'stock'; flat['engine.tune'] = 'stock';
    } else {
      var e = String(sp.e).split(' ');
      flat['engine.type'] = sp.hy ? 'hybrid' : 'ice';
      flat['engine.layout'] = e[0]; flat['engine.displacement_l'] = num(e[1], 3);
      flat['engine.aspiration'] = e[2]; flat['engine.redline_rpm'] = num(e[3], 7000);
      flat['engine.fuel'] = e[4] || 'premium';
      flat['engine.position'] = m.enginePosition || 'front';
      var asp = D().find('aspirations', e[2]) || {};
      flat['engine.boost_bar'] = e[2] === 'na' ? 0 : num(asp.typicalBoost_bar, 1);
      flat['engine.compression'] = flat['engine.fuel'] === 'diesel' ? 14 : e[2] === 'na' ? 12.0 : 9.5;
      if (sp.hy) {
        flat['engine.motors'] = sp.hy[0];
        flat['engine.motorPower_kw'] = clamp(Math.round(sp.hy[1] / sp.hy[0]), 10, 500);
        flat['engine.battery_kwh'] = sp.hy[2]; flat['engine.voltage'] = 800; flat['engine.regen'] = 3;
        if (!flat['engine.chemistry']) flat['engine.chemistry'] = 'nca';
      }
      flat['transmission.launchControl'] = sp.hp >= 380 && g[0] !== 'manual';
    }
    if (sp.ev) flat['transmission.launchControl'] = sp.hp >= 450;

    // suspension: real ride height must sit inside the suspension's range
    var sType = flat['suspension.type'], susp = D().find('suspensionTypes', sType);
    var rh = num(flat['suspension.rideHeight_mm'], 130);
    if (susp && (rh < susp.rideHeightRange[0] || rh > susp.rideHeightRange[1])) {
      var fits = D().suspensionTypes.filter(function (s) { return rh >= s.rideHeightRange[0] && rh <= s.rideHeightRange[1] && !s.adjustable; });
      flat['suspension.type'] = fits.length ? fits[0].id : 'double-wishbone';
    }
    var mass = num(sp.kg, 1500);
    var k = clamp(Math.round(mass / 28 * (sp.c === 'hyper' || sp.c === 'sport' ? 1.25 : sp.c === 'utility' || sp.c === 'van' ? 0.9 : 1)), 30, 180);
    flat['suspension.springFront_nmm'] = k; flat['suspension.springRear_nmm'] = Math.round(k * 1.1);
    if (/^(hyper|sport)$/.test(sp.c)) { flat['suspension.damping'] = 6; flat['suspension.camberFront_deg'] = -1.8; flat['suspension.camberRear_deg'] = -1.5; }
    if (/^(utility|van|lux|ev)$/.test(sp.c)) { flat['suspension.damping'] = 3; flat['suspension.camberFront_deg'] = -0.4; flat['suspension.camberRear_deg'] = -0.6; flat['suspension.arbFront'] = 3; flat['suspension.arbRear'] = 2; }

    // brakes sized by performance and inside the real wheel
    var hp = num(sp.hp, 300), wheel = num(flat['wheels.diameter_in'], 18);
    var maxRotor = Math.floor((wheel * 25.4 - 60) / 2) * 2;
    var fr = clamp(Math.round((300 + hp * 0.12 + mass * 0.01) / 2) * 2, 280, 420);
    if (/^(utility|van)$/.test(sp.c)) fr = clamp(Math.round((300 + mass * 0.025) / 2) * 2, 300, 380);
    flat['brakes.frontRotor_mm'] = Math.min(maxRotor, fr);
    flat['brakes.rearRotor_mm'] = Math.min(maxRotor, Math.max(280, Math.round(fr * 0.9 / 2) * 2));
    if (flat['brakes.frontPistons'] == null) flat['brakes.frontPistons'] = hp >= 450 ? 6 : hp >= 250 ? 4 : 1;
    if (flat['brakes.rearPistons'] == null) flat['brakes.rearPistons'] = hp >= 600 ? 4 : hp >= 450 ? 4 : 1;

    // looks: the model's own colour / wheel / calliper signature, else the spec's factory colour
    var wh = m.wheel || {};
    flat['exterior.paint'] = m.color || (sp.p && sp.p[0]) || '#c5c8cc';
    flat['exterior.finish'] = (sp.p && sp.p[1]) || (m.color ? 'metallic' : 'metallic');
    flat['exterior.caliperColor'] = wh.caliper || (flat['brakes.material'] === 'carbon-ceramic' ? '#e8b100' : '#3a3d41');
    flat['wheels.finish'] = wh.finish || (/^(utility|van|classic)$/.test(sp.c) ? '#8d9196' : '#2b2b2b');
    if (sp.c === 'hyper' || sp.c === 'sport' || sp.c === 'gt') { flat['interior.accentColor'] = flat['exterior.caliperColor']; flat['interior.stitchColor'] = flat['exterior.caliperColor']; }

    put(sp.x || {});
    if (sp.x && sp.x.cooling) { flat['engine.cooling'] = sp.x.cooling; delete flat.cooling; }
    if (flat['brakes.material'] === 'carbon-ceramic' && wheel < 19) flat['brakes.material'] = 'two-piece';
    if (flat['brakes.material'] === 'two-piece' && wheel < 17) flat['brakes.material'] = 'iron';
    var seats = flat['body.seats'];
    flat['weight.rearSeats'] = seats > 2;
    flat['tech.climateZones'] = Math.min(flat['tech.climateZones'], Math.max(1, Math.min(4, seats)));

    Object.keys(flat).forEach(function (p) { setp(b, p, flat[p]); });
    if (!sp.ev) {
      var tr = D().find('transmissions', flat['transmission.type']);
      if (tr && typeof tr.defaultRatios === 'function') b.transmission.ratios = tr.defaultRatios(flat['transmission.gears']);
    } else b.transmission.ratios = [2.65];

    // meta: keep the build's identity; a default / earlier stock name becomes this car's stock name
    var meta = (base && base.meta) || b.meta;
    var nm = String(meta.name || '');
    b.meta = { name: !nm || nm === 'Untitled Build' || /^Stock /.test(nm) ? ('Stock ' + title(m)).slice(0, 60) : nm,
      id: meta.id || b.meta.id, created: meta.created || b.meta.created, modified: Date.now(), presetId: null };
    return b;
  }

  /** Solve the engine's free parameter so the configurator's peak power lands on the real (system) figure. */
  function calibrate(b, sp) {
    var target = num(sp.hp, 0), best = null;
    if (!target || !CB.physics) return b;
    function consider(c) {
      var mx = physics(norm(c));
      if (mx && (!best || Math.abs(mx.power_hp - target) < best.d)) best = { b: c, hp: mx.power_hp, d: Math.abs(mx.power_hp - target) };
    }
    if (b.engine.type === 'ev') return b;   // EV power = motors × kW (already the real figure)
    var e = b.engine, fuel = D().find('fuels', e.fuel) || {}, asp = D().find('aspirations', e.aspiration) || {};
    var diesel = e.fuel === 'diesel', lim = num(fuel.knockLimit, 15.5) - 0.15;
    var c;
    if (e.aspiration !== 'na') {
      var maxB = num(asp.maxBoost_bar, 2), cr0 = diesel ? 14 : 9.5;
      for (var boost = 0.05; boost <= maxB + 1e-9; boost += 0.05) {
        c = U().deepClone(b);
        c.engine.boost_bar = Math.round(boost * 100) / 100;
        c.engine.compression = diesel ? 14 : Math.max(8, Math.min(cr0, Math.floor(lim / Math.sqrt(1 + boost) * 10) / 10));
        consider(c);
      }
    } else {
      for (var cr = 8.0; cr <= Math.min(14, lim) + 1e-9; cr += 0.1) {
        c = U().deepClone(b); c.engine.compression = Math.round(cr * 10) / 10; consider(c);
      }
    }
    // the layout's generic map can sit far from a famous engine (918 / Huracán highs, an understated JDM rating):
    // last resort, move the redline up to ±1,200 rpm from the factory figure
    if (best && best.d > target * 0.03) {
      var base = best.b, r0 = num(b.engine.redline_rpm, 7000), up = best.hp < target ? 1 : -1;
      var rMax = diesel ? 5200 : 9500;
      for (var i = 1; i <= 12; i++) {
        var rl = r0 + up * i * 100;
        if (rl < 5000 || rl > rMax) break;
        c = U().deepClone(base); c.engine.redline_rpm = rl; consider(c);
      }
    }
    return best ? best.b : b;
  }

  /** Final drive: the ratio (2.5–5.5) whose 0–100 km/h and top speed land nearest the real car's. */
  function gearFor(b, sp) {
    var best = null, t100 = num(sp.s, 5), vmax = num(sp.v, 250);
    var first = (b.transmission.ratios || [1])[0];
    var lo = b.engine.type !== 'ev' && (b.transmission.ratios || []).length > 1 ? Math.max(2.5, Math.ceil(7.6 / first * 10) / 10) : 2.5;
    for (var fd = lo; fd <= 5.5 + 1e-9; fd += 0.1) {
      var c = U().deepClone(b); c.transmission.finalDrive = Math.round(fd * 100) / 100;
      var mx = physics(norm(c));
      if (!mx) continue;
      var err = Math.abs(mx.zeroTo100_s - t100) / t100 + 0.6 * Math.abs(mx.topSpeed_kph - vmax) / vmax;
      if (!best || err < best.err - 1e-6) best = { fd: c.transmission.finalDrive, err: err };
    }
    return best ? best.fd : b.transmission.finalDrive;
  }

  /** Mass: a lighter structure (one or two steps, never past aluminium unless the real car is carbon) when the
   *  configurator's mass model comes out heavier than the real car; ballast (5 kg steps, ≤ 100 kg) when lighter. */
  var LADDER = ['steel', 'high-strength-steel', 'aluminum', 'carbon-tub', 'carbon-monocoque'];
  function massFor(b, sp) {
    var mx = physics(norm(b));
    if (!mx) return b;
    var kg = num(sp.kg, 0), c = b;
    var i = LADDER.indexOf(b.body.chassisMaterial), stop = Math.max(i, LADDER.indexOf('aluminum'));
    while (mx.weight_kg - kg > 50 && i >= 0 && i < stop) {
      var t = U().deepClone(c); t.body.chassisMaterial = LADDER[++i];
      var tm = physics(norm(t));
      if (!tm || Math.abs(tm.weight_kg - kg) >= Math.abs(mx.weight_kg - kg)) break;
      c = t; mx = tm;
    }
    var short = kg - mx.weight_kg;
    if (short < 15) return c;
    c = U().deepClone(c);
    c.weight.ballast_kg = clamp(Math.round(short / 5) * 5, 0, 100);
    c.weight.ballastPosition = 'center';
    return c;
  }

  function build(id, base) {
    var m = modelOf(id), sp = m && spec(m.id);
    if (!m || !sp || !D() || !U()) return null;
    var b = assemble(m, sp, base);
    b = calibrate(b, sp);
    b = massFor(b, sp);
    b.transmission.finalDrive = gearFor(b, sp);
    b = norm(b);
    var mx = physics(b);
    return { build: b, spec: sp, model: m, title: title(m),
      target: { hp: sp.hp, nm: sp.nm, kg: sp.kg, zeroTo100_s: sp.s, topSpeed_kph: sp.v },
      metrics: mx ? { hp: mx.power_hp, nm: mx.torque_nm, kg: mx.weight_kg, zeroTo100_s: mx.zeroTo100_s, topSpeed_kph: mx.topSpeed_kph } : null };
  }

  /* stock builds are deterministic per model: cache them (the Garage asks on every frame whether the build is stock) */
  var cache = {};
  function cached(id) {
    if (!Object.prototype.hasOwnProperty.call(cache, id)) cache[id] = build(id);
    return cache[id];
  }
  function strip(b) { var c = U().deepClone(b); delete c.meta; return c; }
  /** True when the build is exactly the factory spec of the model it shows (meta ignored). */
  function isStock(b) {
    b = b || (CB.state && CB.state.get());
    var m = b && modelOf(b), r = m && spec(m.id) && cached(m.id);
    if (!r) return false;
    var eq = U().equal || function (x, y) { return JSON.stringify(x) === JSON.stringify(y); };
    return eq(strip(norm(b)), strip(r.build));
  }

  function apply(opts) {
    opts = opts || {};
    var St = CB.state;
    if (!St || typeof St.replace !== 'function') return null;
    var cur = St.get();
    var m = modelOf(opts.model || cur);
    if (!m || !spec(m.id)) return null;
    var res = cached(m.id);
    if (!res) return null;
    var b = U().deepClone(res.build), meta = cur.meta || {}, nm = String(meta.name || '');
    b.meta = { name: !nm || nm === 'Untitled Build' || /^Stock /.test(nm) ? ('Stock ' + res.title).slice(0, 60) : nm,
      id: meta.id || b.meta.id, created: meta.created || b.meta.created, modified: Date.now(), presetId: null };
    var label = 'Stock spec: ' + res.title;
    var changed = St.replace(b, { label: label });
    return Object.assign({}, res, { label: label, changed: changed !== false, build: St.get() });
  }

  /** UI entry point (Garage button / F key / model chip): apply + a toast with Undo. */
  function run(opts) {
    var ui = CB.ui || {};
    var res = apply(opts);
    if (!res) {
      if (ui.toast) ui.toast('No factory spec is known for this model.', 'warning');
      return null;
    }
    if (ui.toast) {
      var x = res.metrics || {};
      var bits = x.hp ? ' · ' + Math.round(x.hp) + ' hp, ' + Math.round(x.kg) + ' kg, 0–100 ' + (Math.round(x.zeroTo100_s * 10) / 10) + ' s' : '';
      if (res.changed) ui.toast(res.label + bits, 'success', { duration: 6000, action: { label: 'Undo', onClick: function () { CB.state.undo(); } } });
      else ui.toast('Already the stock ' + res.title, 'info', { duration: 2200 });
    }
    return res;
  }

  CB.stock = { SPECS: SPECS, CLASS: CLASS, spec: spec, has: has, title: title, build: build, apply: apply, run: run, isStock: isStock,
    clearCache: function () { cache = {}; } };
})();

if (typeof module !== 'undefined') module.exports = CB.stock;

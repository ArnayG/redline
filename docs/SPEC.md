# FORGE Atelier — Bespoke Car Configurator: Technical Contract

A zero-dependency static website (open `index.html` directly via `file://` — NO ES modules, NO fetch of local
files, NO build step, NO CDN). Every JS file is a classic `<script>` that attaches to the global namespace
`window.CB`. Each file starts with `window.CB = window.CB || {};` and wraps its body in an IIFE.

Pure-logic modules (`data.js`, `state.js` core helpers, `physics.js`, `pricing.js`, `rules.js`) must also run in
Node for tests: end them with
`if (typeof module !== 'undefined') module.exports = CB.<name>;` and guard any DOM/`window`/`localStorage`
access (use `globalThis` instead of `window` at the top: `var CB = (globalThis.CB = globalThis.CB || {});`).
Node tests in `tests/*.test.js` load modules by `require('../js/data.js')` etc. in dependency order
(each file reads its deps from `globalThis.CB`).

## Files & script load order (index.html)

| # | File | Owner | Namespace |
|---|------|-------|-----------|
| 1 | `js/util.js` | foundation | `CB.util` — clamp, lerp, round(n,d), fmtMoney, fmtNum, deepClone, deepMerge, get(obj,'a.b.c'), set(obj,path,val) (immutable-returning), debounce, uid, hexToRgb, rgbToHex, shade(hex, pct), mix(hexA,hexB,t), el(tag, attrs, ...children) DOM helper, escapeHtml |
| 2 | `js/data.js` | foundation | `CB.data` — the full parts catalog + presets + defaultBuild() |
| 3 | `js/state.js` | foundation | `CB.state` — store, undo/redo, persistence, URL share |
| 4 | `js/physics.js` | physics | `CB.physics` |
| 5 | `js/rules.js` | rules/pricing | `CB.rules` |
| 6 | `js/pricing.js` | rules/pricing | `CB.pricing` |
| 7 | `js/ui-kit.js` | foundation | `CB.ui` — form control factories |
| 8 | `js/render.js` | render | `CB.render` — SVG car visualizer |
| 9 | `js/charts.js` | charts | `CB.charts` — canvas charts |
| 10 | `js/panels-powertrain.js` | panels A | registers panels: `body`, `engine`, `transmission`, `drivetrain` |
| 11 | `js/panels-chassis.js` | panels B | registers: `suspension`, `brakes`, `wheels`, `aero`, `weight` |
| 12 | `js/panels-style.js` | panels C | registers: `exterior`, `interior`, `tech` |
| 13 | `js/garage.js` | shell | `CB.garage` — saved builds, compare, spec sheet, share, presets gallery |
| 14 | `js/app.js` | shell | boot, layout, nav, summary sidebar, keyboard shortcuts |
| — | `css/styles.css` | shell/styles | all styling |

## The Build object (single source of truth)

All numeric units are in the key name. `CB.data.defaultBuild()` returns a fresh object exactly of this shape.
Option-type fields store the catalog option `id` string.

```js
{
  version: 1,
  meta: { name: 'Untitled Build', id: 'b_xxx', created: <ms>, modified: <ms>, presetId: null },
  body: {
    style: 'coupe',            // CB.data.bodyStyles[].id
    chassisMaterial: 'steel',  // CB.data.chassisMaterials[].id
    construction: 'standard',  // CB.data.constructions[].id: 'classic'|'lightweight'|'standard'|'reinforced'|'armoured' (glider mass ×0.66..×1.45)
    modelPhysics: false,       // true: glider mass, frontal area and Cd follow the real model (CB.data.modelRefs); stock specs set it
    wheelbase_mm: 2650,        // clamp to bodyStyle.wheelbaseRange
    trackWidth_mm: 1600,       // 1450..1750
    doors: 2,                  // must be in bodyStyle.doorOptions
    seats: 4,                  // must be in bodyStyle.seatOptions
  },
  engine: {
    type: 'ice',               // 'ice' | 'hybrid' | 'ev'
    layout: 'V8',              // CB.data.engineLayouts[].id (ignored when type==='ev')
    displacement_l: 4.0,       // clamp to layout.displacementRange, step 0.1
    aspiration: 'twin-turbo',  // CB.data.aspirations[].id
    boost_bar: 1.2,            // 0 when 'na'; 0..3.0
    compression: 10.0,         // 8.0..14.0
    fuel: 'premium',           // CB.data.fuels[].id
    redline_rpm: 7500,         // 5000..9500 (diesel max 5200)
    position: 'front',         // 'front' | 'mid' | 'rear'
    tune: 'stock',             // CB.data.tunes[].id
    exhaust: 'sport',          // CB.data.exhausts[].id
    cooling: 'standard',       // CB.data.coolings[].id
    speedLimiter_kph: 0,       // CB.data.speedLimiters[].id: 0 = off, else the ECU top-speed cap (150..420)
    // electric / hybrid part (used when type is 'ev' or 'hybrid'):
    motors: 2,                 // 1..4 (hybrid: 1..3 — P2 at the crank + front e-axle motors)
    motorPower_kw: 200,        // per motor, 50..500
    battery_kwh: 85,           // ev 30..200; hybrid 1..30
    chemistry: 'nmc',          // CB.data.batteryChemistries[].id
    voltage: 800,              // 400 | 800
    regen: 2,                  // 0..3
  },
  transmission: {
    type: 'dct',               // CB.data.transmissions[].id ('manual','dct','auto','cvt','sequential','single-speed')
    gears: 7,                  // within transmission.gearRange
    ratios: [3.80,2.60,1.90,1.45,1.15,0.95,0.78],  // length === gears; descending
    finalDrive: 3.42,          // 2.5..5.5
    launchControl: true,
  },
  drivetrain: {
    layout: 'rwd',             // 'fwd' | 'rwd' | 'awd'
    frontDiff: 'open',         // CB.data.differentials[].id
    rearDiff: 'lsd-clutch',
    centerDiff: 'none',        // only for awd
    torqueSplitFront_pct: 0,   // fwd=100, rwd=0, awd 10..90
    torqueVectoring: false,
    tractionControl: 2,        // 0 off .. 3 max
  },
  suspension: {
    type: 'double-wishbone',   // CB.data.suspensionTypes[].id
    springFront_nmm: 60, springRear_nmm: 70,   // 20..250
    damping: 5,                // 1..10
    rideHeight_mm: 120,        // 50..300 (clamped by type: air 60..250 etc)
    camberFront_deg: -1.5, camberRear_deg: -1.0,  // -5..+1
    toeFront_deg: 0.0, toeRear_deg: 0.1,          // -0.5..+0.5
    arbFront: 5, arbRear: 4,   // 1..10
  },
  brakes: {
    material: 'iron',          // CB.data.brakeMaterials[].id
    frontRotor_mm: 360, rearRotor_mm: 330,   // 280..440
    frontPistons: 6, rearPistons: 4,         // 1,2,4,6,8,10
    abs: 'sport',              // 'standard'|'sport'|'race'|'off'
  },
  wheels: {
    design: 'y-spoke',         // CB.data.wheelDesigns[].id
    material: 'cast',          // CB.data.wheelMaterials[].id
    diameter_in: 19,           // 15..23
    widthFront_in: 9.0, widthRear_in: 10.5,  // 6.0..13.0, step 0.5
    finish: '#2b2b2b',         // hex
    staggered: true,
  },
  tires: {
    compound: 'performance',   // CB.data.tireCompounds[].id
    speedRating: 'compound',   // CB.data.tireSpeedRatings[].id: 'compound' (the compound's own) | 'H'|'V'|'W'|'Y'|'Y+' (360)|'hyper' (450)
    widthFront_mm: 255, widthRear_mm: 295,   // 175..355 step 10 (ends in 5)
    profileFront: 35, profileRear: 30,       // 25..70 step 5
  },
  aero: {
    splitter: 'lip',           // CB.data.aero.splitters[].id
    wing: 'none',              // CB.data.aero.wings[].id
    wingAngle_deg: 6,          // 0..20
    diffuser: 'mild',          // CB.data.aero.diffusers[].id
    canards: false, sideSkirts: true, activeAero: false,
  },
  weight: {
    soundDeadening: true, rearSeats: true, spareTire: false,
    glass: 'standard',         // 'standard'|'thin'|'polycarbonate'
    battery: 'lead',           // 'lead'|'lithium'
    rollCage: 'none',          // 'none'|'half'|'full'
    ballast_kg: 0,             // 0..100
    ballastPosition: 'center', // 'front'|'center'|'rear'
  },
  exterior: {
    paint: '#b3121f',          // hex
    finish: 'metallic',        // CB.data.paintFinishes[].id
    roof: 'body',              // 'body'|'black'|'carbon'|'glass'|'contrast'
    roofColor: '#111111',      // used when roof==='contrast'
    stripe: 'none',            // CB.data.stripes[].id
    stripeColor: '#ffffff',
    caliperColor: '#f2c200',
    windowTint_pct: 20,        // 0..85
    lights: 'led',             // 'halogen'|'led'|'matrix'|'laser'
    mirrors: 'body',           // 'body'|'black'|'carbon'
    badge: 'chrome',           // 'chrome'|'black'|'delete'
    livery_number: '',         // optional race number string up to 3 chars
  },
  interior: {
    seatType: 'sport',         // CB.data.seatTypes[].id
    upholstery: 'leather',     // CB.data.upholsteries[].id
    primaryColor: '#1a1a1a', accentColor: '#b3121f', stitchColor: '#b3121f',
    trim: 'aluminum',          // CB.data.trims[].id
    steering: 'round',         // 'round'|'flat-bottom'|'yoke'|'race-quick-release'
    headliner: 'alcantara',    // 'cloth'|'alcantara'|'leather'
    ambientLighting: true, ambientColor: '#ff3344',
    harness: false,
  },
  tech: {
    screen_in: 12,             // 0 (delete) | 8 | 10 | 12 | 15 | 17
    digitalCluster: true, hud: false,
    audio: 'premium',          // CB.data.audioSystems[].id
    adas: 'assist',            // CB.data.adasLevels[].id
    climateZones: 2,           // 1..4
    telemetry: false, liftSystem: false, nightVision: false,
  },
}
```

## CB.data (catalog) — foundation

Every option object has at least `{ id, name, desc, price }` (price in USD, added to base) and may have
`weight_kg` (delta), plus module-specific fields below. Catalog arrays:

- `bodyStyles[]`: `{ id, name, desc, basePrice, baseWeight_kg, cd (drag coeff), frontalArea_m2, wheelbaseRange:[min,max], defaultWheelbase, doorOptions:[..], seatOptions:[..], cgHeight_mm, allowedEnginePositions:['front','mid',...], svg: { length, roofHeight, ... free-form hints for render } }` — ids: `coupe, sedan, hatchback, wagon, suv, roadster, pickup, hypercar, shooting-brake, van`.
- `chassisMaterials[]`: `{ id, name, desc, price, weightFactor (multiplier on baseWeight), stiffness (0..1) }` — `steel, high-strength-steel, aluminum, carbon-tub, carbon-monocoque`.
- `engineLayouts[]`: `{ id, name, cylinders, displacementRange:[min,max], basePrice, baseWeight_kg, smoothness 0..1, length_mm, soundProfile }` — `I3, I4, I5, I6, V6, V8, V10, V12, W16, flat-4, flat-6, rotary-2` (rotary uses displacement as equivalent).
- `aspirations[]`: `{ id, name, price, weight_kg, lag (0..1), powerMult base, maxBoost_bar }` — `na, turbo, twin-turbo, quad-turbo, supercharged, twincharged, electric-turbo`.
- `fuels[]`: `{ id, name, octane, knockLimit (max safe effective compression), energyFactor, co2Factor, pricePerUnit }` — `regular, premium, e85, race, diesel`.
- `tunes[]`: `{ id, name, powerMult, reliabilityHit, price }` — `eco, stock, stage1, stage2, stage3, time-attack`.
- `exhausts[]`: `{ id, name, powerMult, weight_kg, price, loudness_db }` — `stock, sport, titanium, straight-pipe, valvetronic`.
- `coolings[]`: `{ id, name, price, weight_kg, heatCapacity (multiplier) }` — `standard, uprated, race`.
- `batteryChemistries[]`: `{ id, name, whPerKg, pricePerKwh, cRate, cycleLife }` — `lfp, nmc, nca, solid-state`.
- `transmissions[]`: `{ id, name, desc, gearRange:[min,max], shiftTime_s, efficiency, price, weight_kg, defaultRatios(gears)→number[] }` (defaultRatios is a function) — `manual, dct, auto, cvt, sequential, single-speed`. cvt/single-speed have gearRange [1,1].
- `differentials[]`: `{ id, name, price, lockFactor 0..1 }` — `none, open, lsd-viscous, lsd-clutch, lsd-torsen, e-diff, locking`.
- `suspensionTypes[]`: `{ id, name, price, weight_kg, gripMult, comfortMult, rideHeightRange:[min,max], adjustable:bool }` — `macpherson, double-wishbone, multilink, pushrod, air, magnetic, coilover-track`.
- `brakeMaterials[]`: `{ id, name, price, weightPerRotor_kg, fadeResistance 0..1, frictionMult }` — `iron, drilled-slotted, two-piece, carbon-ceramic`.
- `wheelDesigns[]`: `{ id, name, price, spokes:int, style:'y'|'split'|'mesh'|'turbine'|'monoblock'|'dish'|'centerlock'|'aero-disc' }` — at least 10 designs.
- `wheelMaterials[]`: `{ id, name, price, weightFactor }` — `steel, cast, flow-formed, forged, magnesium, carbon`.
- `tireCompounds[]`: `{ id, name, mu (peak friction ~0.7..1.6), wetMu, rollingResistance, treadwear, price (per tire), noise }` — `eco, all-season, winter, touring, performance, super-sport, track, slick`.
- `aero = { splitters[], wings[], diffusers[] }`: each `{ id, name, price, downforce_kg_at_200 (at 200 km/h), dragDelta (Cd delta), weight_kg }`. Wings also `adjustable: bool`. Ids: splitters `none, lip, carbon, race`; wings `none, ducktail, lip-spoiler, swan-neck, gt-wing, active, biplane`; diffusers `none, mild, carbon, race`.
- `paintFinishes[]`: `{ id, name, price, gloss 0..1, metallic 0..1, flake:bool }` — `solid, metallic, pearl, matte, satin, chrome, candy, chameleon`.
- `paintSwatches[]`: `{ name, hex }` — 30+ named heritage colors.
- `stripes[]`: `{ id, name, price }` — `none, racing-dual, center, side-skirt, le-mans, hood, pinstripe, gradient`.
- `seatTypes[]`, `upholsteries[]`, `trims[]`, `audioSystems[]`, `adasLevels[]`: `{ id, name, desc, price, weight_kg }` (seatTypes also `support 0..1`, upholsteries `luxury 0..1`).
- `options` flat price table for small items: `{ launchControl, torqueVectoring, hud, telemetry, liftSystem, nightVision, ambientLighting, harness, digitalCluster, perClimateZone, canards, sideSkirts, activeAero, rollCageHalf, rollCageFull, polycarbonate, thinGlass, lithiumBattery, ledLights, matrixLights, laserLights, contrastRoof, carbonRoof, glassRoof, carbonMirrors, windowTintPerPct, ... }` (numbers).
- `presets[]`: `{ id, name, tagline, build: <partial build deep-merged onto defaultBuild()> }` — at least 8 iconic-archetype presets: e.g. "Alpine GT" (V12 front-mid GT), "Track Weapon" (flat-6 mid, gt-wing, slicks), "Electric Hyper" (4-motor EV hypercar), "Hot Hatch" (I4 turbo FWD), "Overland" (diesel SUV, air susp, AT), "Muscle" (V8 supercharged RWD manual), "Eco Commuter" (hybrid sedan), "Rally Legend" (I4 turbo AWD hatch, sequential).
- `defaultBuild()` → fresh build object (shape above).
- `find(collection, id)` → option object or undefined (collection is a key name, e.g. `'bodyStyles'` or `'aero.wings'`).

## CB.state — foundation

```
CB.state.get()                   // current build (treat as immutable)
CB.state.set(path, value, opts)  // path like 'engine.displacement_l'; creates new object; opts {silent, noHistory, label}
CB.state.patch(partialBuild, opts)  // deep merge
CB.state.replace(build, opts)    // whole replacement (load preset/saved)
CB.state.subscribe(fn)           // fn(build, change) ; change = {path, value, label}; returns unsubscribe
CB.state.undo(); CB.state.redo(); CB.state.canUndo(); CB.state.canRedo(); CB.state.history() // labels
CB.state.normalize(build)        // enforce invariants: clamps, ratios length===gears, torqueSplit per layout,
                                 // doors/seats valid for style, boost 0 for na, ev ignores ICE fields, etc.
                                 // Called automatically on every set/patch/replace. Pure; exported for tests.
CB.state.encode(build) -> string // compact URL-safe (JSON -> base64url); decode(str) -> build|null
CB.state.saveLocal(build); listLocal(); loadLocal(id); deleteLocal(id)  // localStorage key 'forge.garage.v1'
CB.state.autosave on every change (debounced 400ms) to 'forge.current.v1'; boot restores from URL hash '#b=' first, then autosave, else default.
```
Panels NEVER mutate the build directly; always `CB.state.set`.
Changes to `transmission.gears` or `transmission.type` regenerate ratios via the transmission's `defaultRatios(gears)`
in `normalize` only when the length mismatches.

## CB.physics — physics

`CB.physics.compute(build) -> Metrics` (pure, deterministic, < 5 ms). Metrics:
```
{
  power_hp, power_kw, torque_nm, peakPowerRpm, peakTorqueRpm, idleRpm, redlineRpm,
  curve: [{rpm, hp, nm}] (every 250 rpm from idle to redline; EV: 0..maxMotorRpm-equivalent mapped to rpm 0..16000),
  weight_kg, weightFront_pct, cgHeight_mm, powerToWeight_hpPerTon,
  cd, frontalArea_m2, cda, downforce_kg_200, downforce_kg_at(kph) fn NOT included (keep JSON-serializable) — instead downforceCurve: [{kph, kg}] 0..topSpeed step 20,
  gripFront, gripRear (effective mu), lateralG, brakingDist_100_0_m, brakingDist_60_0_ft,
  zeroTo60_s, zeroTo100_s, zeroTo200_s (null if unreachable), quarterMile_s, quarterMileTrap_mph, topSpeed_kph, topSpeed_mph, topSpeedLimitedBy: 'drag'|'redline'|'governor',
  topSpeedGovernor: 'limiter'|'tyres'|'eco'|null (which governor), tyreSpeedRating_kph, speedLimiter_kph (0 = none),
  accelCurve: [{t, kph, gear}] (time-stepped sim, dt 0.05s, until topSpeed*0.98 or 60s),
  gearSpeeds: [{gear, ratio, maxKph}],
  fuelEconomy_l100, fuelEconomy_mpg, range_km (ICE: tank 60L; EV/hybrid: battery-based), co2_gkm,
  efficiency_whkm (EV),
  lapTime_s (estimated, a fictional 5.8 km 'Redline Ring' circuit), lapSectors [s1,s2,s3],
  ratings: { acceleration, handling, braking, comfort, efficiency, reliability, practicality, luxury, sound, track } each 0..100,
  reliabilityScore 0..100, comfortIndex 0..100, noise_db_cabin, exhaust_db,
  zeroTo60_note (string, e.g. 'traction-limited' / 'power-limited'),
  warnings: [] // physics-derived (e.g. 'Wheelspin likely in 1st-3rd gear', 'Brake fade risk')
}
```
Model must be physically plausible: torque curve shapes by aspiration (turbo plateau, NA peaky, supercharged linear,
EV flat torque then constant power), drivetrain losses, traction limit (mu * normal load on driven axle incl. weight
transfer), aero drag 0.5ρCdAv², rolling resistance, downforce increases grip, gear-shift time loss, launch control.
Real-world sanity: a ~1500 kg 500 hp RWD coupe should do 0-60 ≈ 3.3–4.3 s; a 2200 kg 1000 kW AWD EV ≈ 2.0–2.4 s; a
1300 kg 150 hp FWD hatch ≈ 7.5–9 s. Include `tests/physics.test.js` asserting these bands.

Real-model scaling (opt-in with `body.modelPhysics`, which every stock spec sets; from `CB.data.modelRefs`, a copy of
the CB.shapes model refs, so it needs no CB.shapes; `body.model` null is the generic style car and is never scaled): the
glider (BIW + closures) mass scales with the shell area of the named real model relative to the style's nominal car
(×0.85..1.2); independently the glider always scales with `body.construction` (period ×0.66 … armoured ×1.45); the frontal area scales with the model's width × height (×0.85..1.45)
and the body Cd is blended half-way to the model's real Cd. Top speed is governed by the lowest of the tyres' speed
rating, the eco map and `engine.speedLimiter_kph`. Launch (shared with the race model, `CB.physics.traction` and
`metrics.launch`): drive μ comes from the compound (`DRIVE_MU`, cold — a standing start — and warm; the chassis enters
with a weak exponent), the traction-control level is a slip target in units of κpeak (off 2.0 — a driver modulating —,
1: 1.4, 2: 1.0, 3: 0.6; launch control 1.0) and the delivered force is the race tyre's magic-formula curve at that
target × a small ripple; launch control holds its launch rpm with partial turbo pre-spool, a manual is launched at
0.85 × that, automatics against a 2,400 rpm converter stall (×1.9 → 1 multiplication); a clutch ramp
(0.12 s LC / EV, 0.2 s auto / DCT, 0.35 s manual from 55 %) and the shift torque carry (DCT 0.55, auto 0.35 / 0.5 for
8+ gears, manual 0) are the same numbers the race model uses; modern 8–10-speed automatics lose a little to converter
slip in 1st / 2nd; commercial vans and pickups with an ICE automatic run a driveline-protection map (70 % / 90 % torque
in 1st / 2nd, upshift by 78 % of the redline). EV motors are constant-torque to 30 % of the maximum motor speed.
`metrics.launch` = `{ rpm, lc, tc, preSpool, ramp, ramp0, converter, stallRpm, convMult, convCouple, carry, shiftCap,
gearTorque, kappaPeak, slipTarget, lcSlip, tcForce, driveRatioF/R, driveRatioWarmF/R }`.

## CB.rules — rules/pricing

`CB.rules.validate(build, metrics?) -> Issue[]` where `Issue = { id, severity: 'error'|'warning'|'info', section: <panel id>, path?: 'engine.layout', message, fix?: { label, patch: <partial build> } }`.
At least 40 rules (compatibility, physics sanity, legality, comfort), e.g. W16 requires mid position & hypercar/coupe, V12 not in hatchback,
FWD with >400hp torque steer warning, diesel redline cap, e85 with na low compression info, slicks not street legal, ride height < 70 with
macpherson error, carbon-ceramic needs ≥ 19" wheels, rotor diameter must fit wheel (rotor_mm + 60 <= wheel diameter in mm), tire width vs wheel
width compatibility (rim width ±), roll cage + rear seats conflict, EV ignores exhaust, mid-engine incompatible with pickup/van/wagon, etc.
`CB.rules.legality(build) -> { streetLegal: bool, reasons: [] }`.

## CB.pricing — rules/pricing

`CB.pricing.compute(build, metrics?) -> { lines: [{section, label, amount}], subtotal, destination, gasGuzzlerTax, luxuryTax, evCredit, total, msrp, monthly(apr, months, down) fn NOT included → instead provide CB.pricing.finance(total, {apr, months, down, tradeIn, taxRate}) -> {monthly, totalInterest, totalCost, schedule:[{month, principal, interest, balance}]}, CB.pricing.lease(total, {months, residual_pct, moneyFactor, down}) -> {monthly, ...}, buildTime_weeks, insuranceGroup 1..50 }`.

## CB.ui — foundation (form kit)

All return a DOM element. All take `path` into the build and handle reading current value + `CB.state.set` on change, and re-sync
when the state changes (they subscribe and update themselves; unsubscribe when removed from DOM — use a MutationObserver-free approach:
each panel re-renders itself on relevant state change, OR controls expose `.sync(build)`; foundation decides and documents it at top of ui-kit.js).

```
CB.ui.section(title, subtitle?, ...children)      -> <section class="cb-section">
CB.ui.group(label, ...children)                   -> <div class="cb-group">
CB.ui.slider({path, label, min, max, step, unit, format?(v), hint?, ticks?})   -> .cb-slider
CB.ui.select({path, label, options:[{id,name,price?}], hint?})                -> .cb-select
CB.ui.cards({path, label, options:[{id,name,desc,price,badge?,icon? (svg string)}], columns?})  -> .cb-cards (rich option cards, the primary picker)
CB.ui.segmented({path, label, options:[{id,name}]})                          -> .cb-seg
CB.ui.toggle({path, label, hint?, price?})                                   -> .cb-toggle
CB.ui.color({path, label, swatches?:[{name,hex}], allowCustom:true})         -> .cb-color
CB.ui.number({path, label, min, max, step, unit})                            -> .cb-number
CB.ui.stat(label, value, unit?)                                              -> .cb-stat  (read-only)
CB.ui.issues(sectionId)                                                      -> .cb-issues (shows CB.rules issues for that section with fix buttons)
CB.ui.price(amount)                                                          -> formatted price chip `.cb-price` (+$1,200 / Included)
```

Panels registry:
```
CB.panels = CB.panels || {};
CB.registerPanel({ id, title, icon (svg string), group: 'Engineering'|'Chassis'|'Design', order, render(container, build, metrics) , update?(build, metrics, change) })
```
`app.js` renders the active panel by calling `render(container, build, metrics)` once; on every state change it calls `update` if defined,
else re-renders the panel (preserving scroll). Panels may show live derived stats (e.g. engine panel shows hp/torque & mini dyno via
`CB.charts.dyno(canvas, metrics)`).

## CB.render — render

`CB.render.mount(containerEl)`; `CB.render.update(build, metrics)`; `CB.render.setView('side'|'front'|'rear'|'top')`;
`CB.render.toggleXray(bool)` (shows engine position, drivetrain, weight distribution, CG marker); `CB.render.snapshotSVG() -> string`.
A detailed procedurally-drawn SVG car that reflects: body style silhouette (distinct per style), wheelbase, ride height, wheel diameter &
design & finish, tire profile, caliper color & rotor size, paint color w/ finish (gradients/specular for metallic/pearl/matte/chrome/chameleon),
roof option, stripes, mirrors, window tint, lights type, splitter/wing/diffuser/canards/side skirts, exhaust tips by exhaust type,
race number livery, badge. Smooth transitions (CSS transitions on transforms / attribute tweening). Animated spinning wheels toggle.
Also `CB.render.thumbnail(build) -> svg string` (small, static) for the garage cards.

## CB.charts — charts

Canvas 2D, HiDPI-aware (devicePixelRatio), theme-aware via CSS vars read at draw time, hover tooltips/crosshair.
`CB.charts.dyno(canvas, metrics, compareMetrics?)` (hp + torque vs rpm, dual axis, peak markers),
`CB.charts.accel(canvas, metrics, compareMetrics?)` (speed vs time with gear shift markers),
`CB.charts.gears(canvas, metrics)` (sawtooth rpm vs speed per gear),
`CB.charts.radar(canvas, ratings, compareRatings?)`,
`CB.charts.downforce(canvas, metrics)`,
`CB.charts.weight(canvas, metrics)` (front/rear distribution bar + breakdown),
`CB.charts.priceDonut(canvas, pricing)`,
`CB.charts.amortization(canvas, financeResult)`.
Each returns `{ destroy() }` and handles resize via ResizeObserver.

## Layout / CSS contract (styles.css)

Dark, premium automotive aesthetic (think high-end atelier): near-black background, warm metallic accent, refined typography
(system font stacks only, e.g. `"Inter", "SF Pro Display", system-ui` fallback; numeric data in tabular-nums monospace).
Light theme via `[data-theme="light"]` on `<html>`.
CSS variables: `--bg, --bg-2, --panel, --panel-2, --line, --text, --text-dim, --accent, --accent-2, --good, --warn, --bad, --radius, --shadow, --font, --mono`.

DOM skeleton in index.html (ids are contract):
```
<header id="topbar">  brand, build name (editable #build-name), undo/redo (#btn-undo #btn-redo), view toggles,
                      #btn-garage, #btn-compare, #btn-share, #btn-spec, #btn-theme, #btn-presets
<div id="layout">
  <nav id="sidenav">  panel nav grouped by group (generated by app.js)        </nav>
  <main id="stage">
     <div id="viewer"> SVG mount (#car-mount), view buttons (#view-side ... ), #btn-xray, #btn-spin, environment backdrop </div>
     <div id="perf-strip"> quick stats: hp, nm, 0-60, top speed, weight, price (ids #qs-hp #qs-torque #qs-060 #qs-top #qs-weight #qs-price) </div>
     <div id="panel-host"> active panel </div>
  </main>
  <aside id="summary"> live price total, ratings radar (#radar), issues list (#issue-list), legality badge, tabs: Performance | Price | Issues </aside>
</div>
<div id="modal-root"></div>  <div id="toast-root"></div>
```
Class names emitted by CB.ui (styles must cover): `.cb-section .cb-section-head .cb-group .cb-label .cb-hint .cb-slider .cb-slider-value
.cb-select .cb-cards .cb-card .cb-card.is-selected .cb-card-price .cb-card-badge .cb-seg .cb-seg-btn.is-active .cb-toggle .cb-switch
.cb-color .cb-swatch .cb-swatch.is-selected .cb-number .cb-stat .cb-stat-value .cb-stat-label .cb-issues .cb-issue.is-error .cb-issue.is-warning
.cb-issue.is-info .cb-fix-btn .cb-price .cb-price.is-included .cb-grid-2 .cb-grid-3 .cb-chart (canvas wrapper) .cb-modal .cb-modal-card .cb-btn
.cb-btn.primary .cb-btn.ghost .cb-toast .cb-tabs .cb-tab.is-active .cb-badge .cb-kv (key-value table)`.
Responsive: ≥1280 three columns; 900–1280 sidenav collapses to icons; <900 single column with bottom nav.
Print stylesheet for spec sheet (`@media print`).

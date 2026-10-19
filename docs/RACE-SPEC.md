# FORGE Atelier — Race Mode: Technical Contract (addendum to SPEC.md)

After building a car, the user can take it onto a track and race AI opponents. Same rules as SPEC.md: zero deps,
classic scripts on `window.CB`, works from `file://`, no ES modules/CDN/fetch. Pure-logic files must also load in
Node for tests (`var CB = (globalThis.CB = globalThis.CB || {});` + `module.exports`).

## Files (loaded after app.js in index.html)

| File | Namespace | Purpose |
|------|-----------|---------|
| `js/race/tracks.js` | `CB.race.tracks` | track catalog + geometry builder (pure) |
| `js/race/vehicle.js` | `CB.race.vehicle` | real-time vehicle dynamics derived from a build (pure) |
| `js/race/ai.js` | `CB.race.ai` | AI drivers + opponent grid generation (pure) |
| `js/race/engine.js` | `CB.race.engine` | race session: fixed-step sim loop, collisions, laps, positions, rules (pure, no DOM) |
| `js/race/renderer.js` | `CB.race.renderer` | Canvas 2D world rendering, camera, effects, HUD, minimap |
| `js/race/audio.js` | `CB.race.audio` | WebAudio procedural engine/tire/collision sound (optional, mute toggle) |
| `js/race/race-ui.js` | `CB.race.ui` | full-screen race overlay: setup, countdown, pause, results, records; input |
| `tests/race.test.js` | | Node tests |

Entry point: a prominent `#btn-race` ("Race") in the top bar and a CTA in the summary aside →
`CB.race.ui.open(CB.state.get())`. Esc / "Back to Atelier" returns to the configurator with build untouched.

## Tracks (`CB.race.tracks`)

`list` → array of `{ id, name, country, length_m (computed), desc, difficulty 1..5, surface: {grip}, theme: {grass, asphalt, kerbA, kerbB, sand, sky}, width_m, points: [[x,y],...] (closed centripetal Catmull-Rom control points in meters), pitStraight index, scenery: [...] }`.
At least 5 distinct circuits: a fast oval-ish speedway, a technical street circuit (tight 90° corners, walls instead of runoff),
a flowing GP circuit with a chicane and hairpin (the "Redline Ring", ~5.8 km), a mountain/touge-style twisty course, and a short
karting-style tight track. `build(trackDef)` → geometry: dense centerline samples every ~2 m `{x,y,heading,curvature,s,width,leftKerb,rightKerb}`,
total length, start/finish line, sector boundaries (3 sectors), grid slots (2-wide staggered behind the line), and
`racingLine` (precomputed optimal-ish line offset per sample via iterative curvature minimization within track width),
plus `speedProfile(maxLatG, maxBrakeG, accelFn)` helper → target speed per sample (forward/backward pass).
`project(geom, x, y, hintIndex)` → `{index, s, lateral (m from centerline, +left), onTrack, surface:'asphalt'|'kerb'|'grass'|'sand'|'wall'}` — fast local search from hintIndex.

## Vehicle dynamics (`CB.race.vehicle`)

`fromBuild(build, metrics)` → immutable vehicle params: mass, CG height, wheelbase, a/b axle distances from weightFront_pct, yaw inertia,
torque curve (from metrics.curve), gear ratios + final drive + shift time, drivetrain layout & torque split, tire mu (dry/wet) per axle,
cornering stiffness from tire width/profile/compound, brake force/bias, downforce & drag coefficients (from metrics cd·A, downforce_kg_200),
diff lock factor, TC/ABS levels, redline, EV flag.
`createState(params, pose)`; `step(params, state, input, dt, env)` — input `{throttle 0..1, brake 0..1, steer -1..1, handbrake bool, shiftUp, shiftDown}`,
env `{gripMult (surface × weather), wet}`. Planar dynamic bicycle model (or 4-wheel) with: Pacejka-lite/brush tire model with combined slip
(friction circle), load transfer longitudinal + lateral, aero downforce & drag, rolling resistance, engine rpm from wheel speed & gear,
torque from curve, rev limiter, auto or manual gearbox, launch, traction control, ABS, handbrake, speed-sensitive steering.
**Launch & traction (shared with `CB.physics`, see SPEC.md "Launch")**: `input.hold` holds the car on the line
(brakes + clutch / transbrake): it cannot move, the engine revs freely (launch control: its launch rpm with turbo
pre-spool; automatics against the converter stall). On release the clutch / converter takes up over the plan's ramp.
Traction control is a drive-torque limiter on a slip target per TC level (launch control: the peak): feed-forward
from the tyre model at the current load / μ / slip angle (open diffs limited by the lighter wheel) + wheel & coupled
engine inertia, wheel-speed feedback (τ 0.06 s) — never dependent on engine power, so more power never launches slower.
TC off + `env.assists.driverSlip` emulates a driver modulating at that slip (reference launches). Drive μ by compound
(`metrics.launch.driveRatio*`) warms from cold to warm over ~a lap (`state.tyreWarm`). `simulateLaunch(p, kph, opts)`
stages the start (held 1.5 s at full throttle, timed from the release; `opts.stage false` = from idle) and lands within
~2–3 % of the Garage 0–100 (`node tools/launch-report.js`); `launchHoldThrottle(p)` = the throttle that holds a car
without launch control at its launch rpm (AI / reference).
Must be stable at dt = 1/120 s at all speeds incl. zero (low-speed blending). The car's behavior MUST reflect the build: more power accelerates
harder, slicks grip more, downforce helps at speed, FWD understeers, RWD high-power can oversteer, heavy cars brake longer.
State exposes `{x,y,heading,vx,vy,yawRate,speed,rpm,gear,slipAngleF,slipAngleR,wheelspin,skidding,steerAngle}`.

## AI (`CB.race.ai`)

`createGrid(playerBuild, {count 1..11, difficulty 'rookie'|'amateur'|'pro'|'alien', field: 'similar'|'presets'|'mixed'})` → opponent list
`{ name, number, color livery, build (from CB.data.presets or performance-matched variations of the player build, normalized), skill 0..1,
aggression 0..1, consistency 0..1 }` with fictional driver names & teams.
`createDriver(opponent, geom, params)` → controller with `control(vehicleState, raceContext, dt) -> input`: follows racing line using
pure-pursuit/lookahead steering, uses the track speedProfile computed from its own car's grip/brakes (scaled by skill), brakes for corners,
overtakes (move off-line when faster car ahead and gap available), defends, avoids collisions (looks at nearby cars), adapts its planned limits
online (cornering: tyre saturation → `gripLearn`; braking: measured deceleration on a firm straight brake, arriving
hotter than the plan, the rear stepping out under braking → `brakeLearn`), so mass / aero / grip it was not told about
(±20 % mass, Real-car mass & aero) does not send it off (`tests/race-ai-robust.test.js`, `tools/ai-robustness.js`), recovers when off track or
spun (reverse + rejoin), random mistakes scaled by (1-consistency), rubber-banding OFF by default (optional toggle).

## Race engine (`CB.race.engine`)

`createSession({trackId, laps 1..50, opponents, playerBuild, weather 'dry'|'damp'|'wet', timeOfDay 'day'|'dusk'|'night', mode 'race'|'time-trial'|'practice', assists {abs, tc, autoShift, racingLine, steeringAssist}})`.
`update(dt, playerInput)` with fixed 1/120 s substeps. Handles: grid & 3-2-1-GO lights countdown (every car is held on
the line with `input.hold` until lights-out — revving is allowed in every mode, so throttle is never a jump start; only a
car that actually moves out of its box on its own is penalised),
car-to-car collisions (oriented-box SAT + impulse response with restitution & friction), walls (street circuit) and off-track surfaces (grass/sand
lower grip & drag), lap counting with anti-cut (must pass sectors in order; track limits: cut corners → lap invalidated in time-trial / warning
then penalty in race), live positions by (lap, s), gaps to leader/ahead, sector & lap times, best lap, fastest lap of race, finish order,
DNF if stuck. Time-trial: solo + ghost of best lap (recorded pose samples, persisted to localStorage per track+build hash).
Exposes `snapshot()` for renderer/HUD and `results()`.

## Renderer (`CB.race.renderer`)

Canvas 2D, HiDPI, 60 fps with interpolation between sim states. Top-down world with chase camera that follows & rotates with the player
car (toggle: rotating chase / fixed north-up / TV-style broadcast cam), speed-dependent zoom, slight look-ahead. Draw: grass with texture
noise, run-off sand, asphalt with subtle grain & racing-line rubber, red/white kerbs, white edge lines, start/finish checkerboard, grid boxes,
sector boards, walls/barriers/tyre stacks, trees/grandstands/buildings scenery per track theme, night lighting (headlight cones, lamp posts).
Cars drawn from their builds' body style proportions and paint/stripe/wheel colors (top view consistent with CB.render's top view), brake lights,
number on roof. Effects: tire skid marks (persistent, fading), smoke on wheelspin/lockup, sparks on wall hits, rain particles & spray when wet.
HUD: speedometer (km/h or mph toggle), tachometer arc with redline + shift light, gear, position "P3/8", lap "2/5", current/last/best lap,
sector deltas (green/purple/yellow), gap ahead/behind, live standings tower, minimap with all cars, damage/tire-temp indicator optional,
assists indicators, wrong-way warning, "Track limits" warnings, final-lap banner.

## UI (`CB.race.ui`)

Full-screen overlay `#race-root` (created on demand). Screens: **Setup** (track cards with minimap previews & stats, mode, laps, opponents count,
difficulty, field type, weather, time of day, assists, camera, units; shows the player car summary from the configurator: hp, weight, 0-60),
**Countdown/Race**, **Pause** (resume, restart, settings, quit), **Results** (finishing order with gaps, best laps, your lap chart, records,
"Tune car" → back to configurator, "Race again"). Records: per-track best lap per build hash in localStorage `forge.race.records.v1`.
Input: keyboard (WASD/arrows, Space handbrake, Shift/Ctrl or E/Q shift, C camera, P/Esc pause, R reset to track), and Gamepad API
(analog steer/throttle/brake). Touch controls on narrow screens (on-screen pedals and steering).

## Inter-module contracts (binding — modules are built in parallel)

HUD is split out of the renderer into `js/race/hud.js` (`CB.race.hud`). Load order: tracks, vehicle, ai, engine, renderer, hud, audio, race-ui.

**Engine**: `CB.race.engine.createSession(cfg) -> session` with `session.geom` (from tracks.build), `session.update(dt, playerInput)`,
`session.snapshot()`, `session.results()`, `session.restart()`, `session.resetPlayerToTrack()`, `session.config`.
`playerInput = {throttle, brake, steer, handbrake, shiftUp, shiftDown}` (shift flags are edge-triggered: true for one call).

**Snapshot** (plain object, new each call):
```
{ t, phase: 'grid'|'countdown'|'racing'|'finished', countdown: {lightsOn 0..5, lightsOut bool, goTime}, lapsTotal, mode,
  weather, timeOfDay, playerId, fastestLap: {carId, time}|null,
  cars: [{ id, isPlayer, name, team, number, color (hex), accent (hex), build, bodyStyle,
           length_m, width_m, x, y, heading (rad, 0 = +x, CCW), speed (m/s), rpm, redline, gear, maxGear, steerAngle (rad),
           throttle, brake, slipF, slipR, skidding (0..1), wheelspin (0..1), surface, lap (completed laps), s (m along lap),
           position (1-based), currentLap_s, lastLap_s, bestLap_s, sectors: [s1,s2,s3 of current lap or null], lastSectors,
           bestSectors, gapAhead_s, gapLeader_s, finished, finishTime_s, penalties_s, dnf, wrongWay, trackLimits (count),
           lapValid, offTrack }],
  events: [{ type: 'collision'|'wall'|'lap'|'sector'|'penalty'|'finish'|'jumpstart'|'trackLimits'|'fastestLap',
             carId, x, y, intensity 0..1, value?, text? }]   // events since last snapshot() call
  ghost: {x, y, heading}|null }
```

**Renderer**: `CB.race.renderer.create(canvas, geom, trackDef, opts {timeOfDay, weather}) -> { render(snap, alpha?), setCamera('chase'|'north'|'tv'), cycleCamera(), resize(), destroy() }`.
It owns the canvas sizing (HiDPI), draws world + cars + effects. Pre-renders static track to offscreen canvases (tiled) for speed.

**HUD**: `CB.race.hud.create(canvas, geom, trackDef, opts {units:'kph'|'mph'}) -> { draw(ctx, snap), setUnits(u), destroy() }`, drawn on top
of the same canvas after renderer.render (ctx already in CSS-pixel transform; read canvas.clientWidth/Height).

**Audio**: `CB.race.audio.create() -> { start(), update(snap), setMuted(bool), destroy() }` (handles snap.events itself; must not throw
if AudioContext unavailable; starts only after a user gesture).

**UI**: `CB.race.ui.open(build)`, `CB.race.ui.close()`. Owns `#race-root` overlay, the rAF loop (fixed-step accumulator calling session.update
with 1/120 s), input (keyboard/gamepad/touch), screens. Works standalone via `race.html` (a test page loading util/data/state/physics + race
files) if the configurator shell isn't present: in that case it falls back to `CB.data.defaultBuild()` / first preset.

**Vehicle metrics fallback**: if `CB.physics` is unavailable, `vehicle.fromBuild(build, null)` must derive approximate params directly from
the build & catalog so race mode never hard-depends on physics.js.

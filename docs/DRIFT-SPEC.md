# FORGE — Drift Mode + Steering Assist Contract (addendum to RACE-SPEC / RACE3D-SPEC / GAME-SPEC)

Goals (from the user): turn racing into a **drifting game in 3D**; **3D is the default** view; **heavy steering assist so it's
easy to steer with the arrow keys**; the player chooses **Drift mode** or **Race mode**.

All new code lives in `js/race/drift/` (classic scripts, zero deps, `var CB = (globalThis.CB = globalThis.CB || {}); CB.race = CB.race || {}; CB.race.drift = CB.race.drift || {};`,
pure modules Node-testable with module.exports guards). Load order: after js/race/engine.js and js/race/gl/*, before js/race/race-ui.js.
Reuse existing code where it fits: `CB.race.vehicle` (dynamics), `CB.race.engine` (sessions, cfg.hooks), `CB.race.tracks` (geometry, project()),
`CB.race.renderer3d` (3D), `CB.race.hud`, `CB.game.challenges` (already has a drift scorer — extend/borrow, don't duplicate blindly).

## 1. Steering assist — `js/race/drift/assist.js` → `CB.race.assist`
`CB.race.assist.create({ level: 'off'|'light'|'medium'|'heavy' (DEFAULT 'heavy'), mode: 'race'|'drift' }) -> assist`
`assist.filter(raw, car, ctx) -> input` where
- `raw` = keyboard/gamepad intent `{ left:bool, right:bool, up:bool, down:bool, steerAxis?: -1..1 (gamepad), throttleAxis?, brakeAxis?, handbrake:bool, shiftUp, shiftDown }`
- `car` = player vehicle state `{ speed (m/s), vxLocal, vyLocal (car frame, +x fwd, +y left), yawRate (rad/s, +CCW), heading, steerAngle, slipAngleF, slipAngleR, rpm, gear, maxSteer_rad }`
  (engine exposes this via `session.playerState()` — the integrator adds it if missing; assist must also accept a snapshot car and degrade gracefully)
- `ctx` = `{ dt, geom, proj (tracks.project result for the car: index, lateral, onTrack), params (vehicle params) }`
- returns engine input `{ throttle 0..1, brake 0..1, steer -1..1, handbrake, shiftUp, shiftDown }`.
Behaviour (heavy = strongest):
- Digital arrows → smooth analog steer: rate-limited ramp (faster return-to-center than turn-in), speed-sensitive max lock (full lock at walking pace, ~25% at 250 km/h for race; drift keeps more lock).
- **Counter-steer assist**: steer target blends toward the velocity direction (drift angle β = atan2(vyLocal, vxLocal)) so the car self-catches slides; heavy ≈ 85% automatic counter-steer, player input adds/subtracts drift angle.
- **Yaw stabilization**: if yawRate exceeds the stable band for the current speed/angle and the player isn't asking for more angle, damp it with counter-steer + throttle lift → spins are very hard on heavy.
- **Race mode extras** (heavy): gentle lane-keeping pull toward the racing line on corner approach when no steer key is pressed, braking assist (auto-brake to the speedProfile target speed when far over it), auto-throttle traction limiting, off-track recovery steer back toward track.
- **Drift mode extras** (heavy): **drift initiation helper** — pressing a direction above ~40 km/h with throttle kicks the rear out (brief rear-grip drop / handbrake-flick emulation); **angle hold** — throttle is auto-modulated to hold the drift angle the player asks for (left/right = more/less angle; up = more throttle/angle, down = less); exiting a drift straightens smoothly.
- Expose `assist.debug()` (target angle, β, applied counter-steer) and `assist.setLevel(level)`.
- **Defaults per discipline** (race-ui `raceSteerAssist` / `driftSteerAssist`, settings `assistDefaultsV: 2`): Race **light**, Drift **heavy**; `steerAssist` is the active level (the discipline's own one or a launch override). Old shared saves: untouched 'heavy' -> new defaults; an explicit pick is kept for both.
- **Keyboard drift steering** (digital arrows in drift mode, `KB` table): 'off' = self-aligning wheel (front-axle travel direction + a sideslip-rate lead) + speed/slip-sensitive reach and rate + throttle ramp; light / medium = release holds the angle (unwinds when the road straightens or off throttle), held opposite arrow straightens, a < 0.3 s opposite tap is a switchback. Both send `input.slideRack` (vehicle.js: the speed-sensitive rack limit is widened by the front axle's sideslip so slides can be caught at speed; inert without the flag). Gamepad / phone wheel are unchanged (proportional).
Tests: with heavy assist, a scripted "hold right arrow + throttle" in drift mode on a skidpad sustains a drift (|β| 20-45°) for ≥10 s without spinning (|β| < 90° throughout); in race mode, a bot pressing only arrows at corners finishes a lap on the Redline Ring without leaving the track; light assist is measurably less stabilizing than heavy.

## 2. Drift handling tune — `js/race/drift/tune.js` → `CB.race.drift.tune`
`tune.apply(params, { level: 'grip'|'street'|'pro'|'competition' (DEFAULT 'street' in drift mode), build }) -> new params` (pure; never mutates input):
more steering lock (up to 60°), locked/welded rear diff, slightly lower rear grip & higher front grip, quicker steering response, adjusted yaw inertia,
power boost for low-power cars so every car can drift (min ~350 hp effective in drift mode), rev-limiter friendly gearing hint (auto-box holds gear while drifting).
`tune.recommendedBuildPatch(build)` → a partial build (rwd, lsd-clutch/locking rear diff, steering lock via suspension etc.) used by a "Drift setup" button in the configurator later.

## 3. Drift scoring — `js/race/drift/scoring.js` → `CB.race.drift.scoring`
`createScorer(geom, trackDef, opts { zones?: [...], difficulty }) -> scorer { update(car, dt, events), state(), results(), reset() }`:
points/s = f(drift angle 15-70° (sweet spot 30-50°), speed, smoothness) × combo multiplier; combos chain drifts (multiplier +0.1 per 2 s held, up to ×5,
decays after 1.5 s of no drift); bonuses: **clipping zones/points** (inner & outer zones per corner auto-generated from geom curvature, shown in 3D/HUD,
bonus for proximity), wall-proximity "close to wall" bonus, transition (left↔right "manji/swing") bonus, long-drift bonus, entry speed bonus,
tandem proximity bonus (when following an AI drifter); penalties: spin (>110° → drift lost), wall hit (combo lost), off-track (drift banked at half), going backwards.
Grades per drift (C/B/A/S/SS) and run total; `state()` = `{ total, current, combo, multiplier, angle_deg, speed, grade, zones: [{id, s, side, kind, hit}], lastEvent: {text, points} }`.
`results()` = `{ total, best drift, longest drift, max angle, max combo, zones hit %, medal: bronze/silver/gold/platinum by targets per track }`.

## 4. Drift tracks — `js/race/drift/tracks.js`
Register 3+ drift-focused tracks into `CB.race.tracks` (use `register(def)` if it exists, else push into `list` in a compatible way) with the exact
track-def shape used by js/race/tracks.js, plus `driftZones` hints: a Japanese **mountain drift circuit** ("Kurogane Pass": chained switchbacks & S-bends),
a **harbor drift park** ("Dockyard Sliders": wide-open industrial asphalt with containers as walls, long sweepers), and a **skidpad + figure-8** practice area ("Circle Lab").
They must build cleanly with tracks.build, be wide enough for drifting (14-22 m), and have themes/scenery that the 3D scenery module can use.

## 5. Drift AI — `js/race/drift/ai.js` → `CB.race.drift.ai`
`createDriftDriver(opponent, geom, params) -> { control(state, ctx, dt) -> input }`: an AI that drifts through corners (initiation, angle hold via throttle,
counter-steer) following a drift line, used as the **tandem lead car** in Tandem Battle. Uses tune.apply'd params. Must not spin on the drift tracks.

## 6. Drift HUD — `js/race/drift/hud.js` → `CB.race.drift.hud`
`create(canvas, opts) -> { draw(ctx, snapshot, scorerState, assistDebug?), destroy() }` drawn on the 2D overlay canvas after the regular HUD (or replacing
its standings tower in drift mode): big score counter with count-up, current-drift points & combo multiplier bar, drift angle arc meter, grade popups
("+2,450 GREAT DRIFT ×3.2", "CLIPPING ZONE!", "SWING!", "COMBO LOST"), zone indicator arrows, run timer, medal targets, tandem distance gauge.

## 7. Drift session & UI — `js/race/drift/session.js` (+ `drift.html` test page)
`CB.race.drift.createSession({ trackId, mode: 'free'|'trial'|'tandem', build, assist level, tune level, timeOfDay, weather, duration_s }) -> session`
wrapping `CB.race.engine.createSession` (practice mode, no/one AI) + scorer + tune; same `update/snapshot/results/restart` surface as engine sessions, plus `scorerState()`.
`drift.html`: a standalone **playable** page: mode select (DRIFT / RACE) → track select → 3D view by default (`CB.race.renderer3d`, chase camera default for drifting,
C cycles cameras incl. cockpit) → HUD + drift HUD → results; arrow keys + heavy assist default; assist level & tune selectors; Race mode on this page uses the
normal engine race session with AI + assist (race mode). Final integration into race-ui/hub is done separately (race-ui will gain a "Drift / Race" choice and 3D default).

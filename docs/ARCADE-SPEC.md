# ARCADE-SPEC — Redline Arcade mode

Arcade is a **third top-level game mode** (`#/arcade`) next to Race (`#/race`) and Drift (`#/drift`).
It is an addition: Race, Drift, Career, Challenges and Multiplayer keep the simulation physics and their setups
exactly as before. In Arcade every car — player and AI — drives the **arcade vehicle model**: the tyres never
let go (no wheelspin, lock-up, under/oversteer or spins), steering is crisp and speed-sensitive, braking is
strong and stable, walls are soft bounces and grass slows you without spinning you. The player's current
Garage build is used like in every other mode; power, weight, gearing and top speed still separate cars.

Files

| file | owner | what |
|---|---|---|
| `js/race/vehicle.js` | arcade core | `params.handling === 'arcade'` kinematic grip model, `spinOut`, powerslide, `arcadeResponse` |
| `js/race/ai.js` | arcade core | AI recognises arcade params (grip, braking, curvature steering) |
| `js/race/drift/assist.js` | arcade core | CB.race.assist (heavy etc.) maps steering through the arcade curvature limit |
| `js/race/engine.js` | arcade core | `cfg.handling: 'arcade'` → all cars arcade, soft walls, separate ghost key |
| `js/arcade/mode.js` | arcade core | `CB.arcade.mode`: settings, extension registry, track list, session factory |
| `js/race/race-ui.js` | arcade core | `#/arcade` setup / HUD badge / results / records (discipline `'arcade'`) |
| `js/arcade/stunt-track.js` … | stunt agent | `CB.arcade.stunt` (§4) |
| `js/arcade/items.js`, `nitro.js`, `gameplay.js`, `arcade-hud.js`, `arcade-sfx.js`, `arcade-layer.js`, `js/race/gl/arcade-fx.js` | gameplay agent | the `'gameplay'` extension (§3, §7) |

---------------------------------------------------------------------------------------------------------------

## 1. Vehicle model (`CB.race.vehicle`, handling `'arcade'`)

```js
var V = CB.race.vehicle;
var p = V.fromBuild(build, metrics, { handling: 'arcade' });   // or V.withHandling(simParams, 'arcade')
var s = V.createState(p, { x, y, heading, speed });
V.step(p, s, input, dt, env);                                  // same contract as the simulation
```

* `p.handling === 'arcade'`, `p.arcade = { latG, brakeG, tracG, dfGain, punch }`. `p.capabilities`,
  `p.maxLatG`, `p.maxBrakeG`, `p.topSpeed_ms` are the **arcade** envelope (AI / assists plan with them).
  `latG` ≈ 1.22–1.7 g (tyre/suspension stats only nudge it), `brakeG` ≈ 1.25–1.6 g, drive force × 1.12
  capped at `tracG` g (1.12, AWD 1.25) so launches never spin the wheels.
* Steering: `input.steer` (−1..1, +left) is a **curvature command**: full lock = `arcadeCurvatureLimit(p, v, grip)`
  = min(lock geometry, latCap(v)/v²), i.e. full lock is the cornering limit at every speed (controllable at
  300 km/h). Linear, so analog phone/tilt input stays proportional. Slew 7.5 /s in, 11 /s back to centre.
  Yaw rate follows `v·κ` with a 70 ms lag; body slip relaxes in 45 ms. Cornering at the limit scrubs
  ≤ 0.12 g so lines still matter.
* Off-track: `env.gripMult` only scales the limit by `0.7 + 0.3·grip` (grass 0.58 → 0.87); the engine's surface
  drag slows the car. Nothing spins.
* **Powerslide** (Mario-Kart style, cosmetic + slightly tighter): handbrake + steer above 9 m/s swings the nose
  in up to ~29° while the path stays exactly as commanded (×1.3 curvature, 0.06 g scrub). State:
  `s.powerslide` (bool), `s.slideTime` (s held), `s.slideAngle` (rad, +left), `s.slideDir`. Below 9 m/s the
  handbrake is a 0.45 g brake.
* **Boost** per step through `env.arcade` (e.g. from a `vehicleEnv` hook):
  `{ boost: drive-force multiplier (default 1), push: extra forward accel m/s² independent of throttle
  (boost pads), topSpeedMult: governor multiplier (speed classes) }`. `s.boosting` mirrors it.
* **Spin-out** — the only allowed loss of control: `V.spinOut(p, s, { duration: 1.0, dir: ±1, speedLoss: 0.45,
  turns: 1 })` — a cartoon 360 that keeps the travel direction; inputs are ignored meanwhile; `s.spin` is
  non-null while it runs. Works on either handling model.
* Collisions: `V.applyImpulse` / the engine's wall + car contacts work unchanged; in arcade sessions the engine
  uses a soft wall (restitution 0.25, friction 0.12) and clamps the yaw kick to 1.6 rad/s, and the grip
  constraint straightens the car within ~0.2 s.
* Telemetry stays populated (rpm, gear, wheels omega/load, gLat/gLong); slip/skid/wheelspin are ~0 except
  during powerslides (rear `skid`) — renderers / audio keep working.

### 1.1 Drive interface for track-space integrators (stunt loops, ramps)

```js
V.arcadeResponse(p, speed, input, env?) -> {
  accelLong,      // m/s², + forward: drive (best gear for that speed, × env.arcade.boost) − drag − rolling − brakes + push
  curvature,      // 1/m (+ left) the steering asks for (input.steer × maxCurvature)
  yawRate,        // rad/s = speed × curvature
  steerAngle,     // rad, front-wheel angle for rendering
  latAccel,       // m/s² = speed² × curvature
  maxLatAccel,    // the arcade lateral limit at this speed
  maxCurvature,   // full-lock curvature at this speed
  topSpeed,       // m/s (boost / speed class aware)
  brakeDecel      // m/s² from the brake / handbrake pedals
}
V.arcadeCurvatureLimit(p, v, gripMult)   V.arcadeLatCap(p, v, gripMult)   V.isArcade(p)   V.ARCADE (tuning)
```

Stateless and pure: integrate `speed += accelLong·dt` along the track tangent and `heading += yawRate·dt` in
the track's local frame. For a full stateful car (engine rpm, gears, audio) call `V.step` on a planar state and
read `s.ax` (forward accel) / `s.yawRate` / `s.speed`, then re-project onto the stunt surface.

## 2. Engine and AI

* `CB.race.engine.createSession({ ..., handling: 'arcade' })` builds every car with `{ handling: 'arcade' }`.
  `snapshot().handling` / `results().handling` = `'arcade' | 'sim'`. Ghosts are stored under
  `forge.race.ghost.v1:arcade:<track>:<build>` (separate from simulation ghosts).
* `CB.race.ai` reads `params.handling`: neutral axle balance, arcade grip / braking caps, steering through
  `arcadeCurvatureLimit` (curvature command instead of a learned wheel-angle ratio), higher grip use
  (0.86–0.96) and later braking. Measured (pro AI, 2 laps, 4 cars): 0 off-track ticks and 0 wall hits on all 10
  circuits, laps ~15–20 % quicker than the simulation.
* `CB.race.assist` (off/light/medium/heavy/auto) applies on top: steering maps through the arcade limit, the
  slide catchers / traction limiter / spin guard are skipped for arcade cars (they cannot slide), line hold,
  lane keeping, edge guard and brake assist keep working with the arcade speed profile.

## 3. Gameplay extensions (nitro, items, speed classes …)

```js
CB.arcade.mode.registerExtension({
  id: 'gameplay', name: 'Power-ups', order: 10,
  options: [   // shown in the Arcade setup screen ("Arcade rules"), values land in settings.options[id]
    { id: 'items', name: 'Items', type: 'toggle', default: true, desc: '…' },
    { id: 'speedClass', name: 'Speed class', choices: [{ id: '100', name: '100cc', desc: '…' }, …], default: '150' }
  ],
  appliesTo: function (ctx) { return true; },          // optional (ctx.kind 'stunt'|'circuit', ctx.mode 'race'|'time-trial')
  create: function (ctx) { return instance; }          // once per session, BEFORE the session is created
});
```

`ctx = { cfg, kind, settings, options, mode, seed, rng /* seeded mulberry32 */, vehicle: CB.race.vehicle,
playerId: 'player', track }`.

The instance (every member optional):

| member | when | use |
|---|---|---|
| `hooks` | engine hook object or array — `vehicleEnv` may be used on its own (no `vehicleParams` needed); merge, don't replace: `return Object.assign({}, env, { arcade: Object.assign({}, env.arcade, { boost: 1.4 }) })` (`preStep(car, input, dt) → input`, `postStep(car, dt)`, `vehicleEnv(car, env) → env`, `carCreated(car)`, `onImpact(...)`, `snapshot(car) → obj`) | read cars (`car.state`, `car.params`, `car.isPlayer`, `car.ctx` with position/lap/nearby), set `env.arcade.{boost,push,topSpeedMult}`, `V.applyImpulse(car.params, car.state, jx, jy, px, py)`, `V.spinOut(car.params, car.state, {...})`. Runs inside the fixed 1/120 s step with the engine's seeded `Math.random`. |
| `attach(session)` | right after creation | keep a handle |
| `snapshot(snap) → any` | every `session.snapshot()` | exposed as `snap.arcade.ext[<id>]` (HUD, audio, net) |
| `entities(snap) → [{ id, type, x, y, z?, heading?, radius?, color?, glyph? }]` | each frame | world objects (item boxes, oil, rockets); race-ui hands them to `renderer.setEntities(list)` when the renderer has it, otherwise draws simple 2D markers via `view.project` |
| `drawHud(ctx, snap, view)` | each frame after the race HUD | `ctx` is the HUD canvas (CSS px). `view = { width, height, units, renderer, project(x, y, z) → { x, y, visible, scale } }` |
| `setRenderer(r)` | after the renderer exists | 3D renderer handle (`getCameraState()` etc.) |
| `results(res)` | `session.results()` | add arcade stats to the results object |
| `reset()` | `session.restart()` | clear state |
| `serialize() / restore(state)` | networking later (§6) | JSON-able state |
| `destroy()` | teardown | |

The session returned by `CB.arcade.mode.createSession` exposes the same aggregation as `session.arcade`
(`entities`, `drawHud`, `setRenderer`, `serialize`, `restore`, `destroy`, `instances`, `kind`, `settings`).

## 4. Stunt tracks (`CB.arcade.stunt`, feature-detected)

* `CB.arcade.stunt.list() → [{ id, name, kind: 'stunt', difficulty?, length_m?, desc? }]` — listed **first**
  in the Arcade setup (a "Stunt" chip), then the normal circuits.
* `CB.arcade.stunt.createSession(cfg) → session` with the engine surface race-ui drives:
  `update(dt, input)`, `snapshot()` (RACE-SPEC snapshot; cars may add `z`, `pitch`, `roll`, `airborne`),
  `results()`, `restart()`, `geom`, `trackDef`, `config`; optional `setPlayerAutopilot`, `resetPlayerToTrack`.
  `cfg` is the engine-style cfg race-ui builds: `trackId, track, laps, mode, opponents (ai.createGrid entries),
  playerBuild, playerMetrics, playerName, weather, timeOfDay, difficulty, seed, assists, steerAssist (level),
  hooks (extension engine hooks — call them with the same contract), handling: 'arcade', arcade (settings)`.
* Rendering: if the session (or `CB.arcade.stunt`) has `createRenderer(canvas, session, opts)` returning
  `{ render(snap, alpha), resize?, destroy?, setCamera?, cycleCamera?, getCameraState? }`, race-ui uses it
  instead of the circuit renderers.

### 4.1 Stunt pack files and what is implemented (stunt agent)

Load order (index.html, right after `js/arcade/mode.js`): `js/arcade/stunt-track.js → stunt-maps.js → stunt-physics.js →
stunt-ai.js → stunt-session.js → js/race/gl/stunt-mesh.js → js/race/gl/stunt-renderer.js`. All pure-logic files load in
Node; the two GL files only touch WebGL inside `create()` / `build()`.

| API | what |
|---|---|
| `CB.arcade.stunt.list()` | `[{ id, name, kind: 'stunt', stunt: true, theme, length_m, laps, desc, tagline, difficulty, stunts, corners, width_m, points (2D outline for race-ui maps), thumbnail (SVG string), minimap, estLap_s, timeOfDay }]` |
| `get(id)` / `build(def)` | built track: `sample(s) → {pos, tangent, up, right, left, width, halfWidth, bank, kLeft, kNormal, flags}`, `pointAt(s, lat, h)`, `project(worldPos, {hintS, window, maxDist, surfaceOnly}) → {s, lateral, height, dist}`, `features`, `gaps`, `checkpoints`, `pieces`, `geom2D` (HUD/minimap), `groundY` |
| `drawThumb(canvas, def)` | 2D thumbnail (theme colours, loop / gap markers) |
| `createSession(cfg)` | self-contained race (grid → 5-light countdown → laps → finish → results), engine surface + `getState()/setState()` |
| `createRenderer(canvas, session, opts)` | 3D renderer (`render, setCamera, cycleCamera, getCamera, cameraModes, setLookBack, resize, setQuality, getQuality, stats, destroy, getCameraState, worldToScreen, setCameraController, setEntities, reset, is3D: true, drawsArcadeWorld: true`) |

**Track format** (`stunt-maps.js`): turtle pieces `straight, turn {angle, radius, bank, rise}, hill, drop, climb, pitchTo,
kicker, gap {len, drop}, loop {radius, shift}, corkscrew {len, radius, turns}, wall {len, bank, side}` + per-piece
`features` (`pad, ring {z}, box (row), can, coin, checkpoint, arrow`). Frames are explicit (turtle frame = rotation-
minimising for yaw/pitch, authored bank/roll on top, smoothed); the builder appends a C1 Hermite closing piece with a
double-reflection RMF and spreads the residual roll; `def.solve` auto-tunes 1–3 piece parameters so every map closes
exactly. Six maps: `loop-rush` (starter loop + hills + small gap), `canyon-leap` (3 gaps, boost drop), `corkscrew-carnival`
(double loop, corkscrew, bowls), `neon-wallride` (wall-rides, half-pipe bowl, loop, night), `mega-drop` (2-turn spiral
climb, 44 m boost-chain drop, 64 m monster gap), `figure-8` (crossover jump 13 m over the lower road). 2.4–2.9 km, AI laps 45–58 s.

**Gameplay hooks / items**: `cfg.hooks` are called with the engine contract on stunt cars — `carCreated(car)`,
`preStep(car, input, dt) → input`, `vehicleEnv(car, env) → env` (its `env.arcade.{push, topSpeedMult}` become stunt boosts),
`postStep(car, dt)` (a changed `car.state.vx` is read back), `snapshot(car)`. Each step a stunt car exposes
`car.ctx {t, phase, trackLength, dt}`, `car.s / lat / dist / lap / v / mode / airborne / idx / input` and a mirror
`car.state {vx, speed, s, lat, dist, mode, airborne}` + `car.params {handling: 'arcade', capabilities.topSpeed_mps}`.
When a hook named `'arcade-gameplay'` is present (the `gameplay` extension) the session does not create its own
`CB.arcade.gameplay`; standalone it creates one itself (feature-detected) fed with the map's authored layout
(item-box rows, pads, rings incl. floating ones over gaps, cans, coins). Without any gameplay module a small built-in
fallback handles pads / rings / cans / boxes and a nitro meter. Direct API: `session.applyBoost(id, secs, topMult, accel)`,
`spinOut(id, secs)`, `addNitro(id, amount)`, `spawn({type, s, lat, z, life}) / despawn(id) / entities()`.

### 4.2 Track-space vehicle motion (`stunt-physics.js`)

* Ground: integrated in track coordinates `s, lat (+left), psi (heading vs tangent), v` — glued to the surface frame through
  loops / corkscrews / banks / walls. Arcade gravity along the track × 0.55; rails clamp `lat` (scrape: speed loss + nose
  straightened, `rail` event). Magnet adhesion: `press = v²·kNormal + g·up_y + 0.4 g (+2.5 g on loop / corkscrew / wall /
  bowl while |v| ≥ 35 km/h)`; `press < 0` → leave the surface (`drop` in stunts, `takeoff {crest}` on hills).
* Gap lips launch a ballistic flight (1.45 g). Jump assist (heavy keyboard assist + AI; `cfg.jumpAssist`): launch speed
  topped up to 1.05 × the gap's design speed, lateral drift pulled back over the landing, flight direction turned with
  the track below, pitch / roll stabilised to the landing surface. Re-attach on ANY surface crossed from above within
  −90…+420 m of the takeoff s; below the ground plane / > 8 s air → respawn (0.9 s fade, last checkpoint, rolling start,
  1.6 s no-collide). Stuck > 3 s or wrong way > 4 s also respawn; `input.requestReset` (R) respawns manually.
* Human-proofing (regression: "fell through the road after a ramp"; `tools/stunt-sweep.js`, tests/arcade-stunt-sweep.test.js):
  `project()` refines its hit against the INTERPOLATED frame (the per-sample planes stepped 0.1–0.2 m at the outer lanes
  of banks / wall roll-ins, so a landing could step past the deck); landings are swept (previous point measured against
  the same surface plane) with a capture margin of `HALF_W + 0.5` m beyond the road edge, plus a pop-up for a car that
  slides in just under the deck (≤ 0.9 m, ≤ 1.8 m at a gap's landing lip). In the air every level follows the plan-view
  heading of the road below ('off' 80 %), air steering is a bounded lateral nudge (3.5 m/s², ≤ 4.5 m/s), and the guard
  rails extend into the air (no outward steering / outward drift damped past the usable width). Gap lips faster than
  1.06 × the design speed launch on the flat ballistic root that hits the deck 6 m past the lip (same speed); hill
  crests only release the car once its climb rate is < 9 m/s; loops / walls never shed a car above 35 km/h; the ground
  plane sits under the lowest road EDGE and the fall check ignores a car with road right under it; after 2 falls in a
  row the next jumps get one level more air / jump assist until a clean landing (`fallStreak`).
* Drive model adapter — `model.create(build, opts) → state`, `model.step(state, input {throttle, brake, steer (+1 left)},
  ctx {dt, speed, bank, topMult, push, vTarget, throttleMult, latMax, slope}) → {accel, yawRate, steerAngle, rpm, gear, vTop}`,
  optional `model.steerFor(state, yawRate, speed, {bank}) → steer` (AI). Resolution order: `cfg.drive` object →
  `CB.arcade.drive` → `CB.race.vehicle.arcadeResponse` (§1.1; build drive force / gearing / brakes, curvature-command
  steering, stunt grip bonus via `env.gripMult`, top speed capped at 58 m/s + boosts) → built-in fallback
  (`cfg.drive: 'builtin'`). Assist levels: heavy (auto-align + loop / gap speed top-up + full jump assist; holding
  throttle alone completes every map), light, off.

### 4.3 Rendering (`stunt-mesh.js`, `stunt-renderer.js`)

Vertex-coloured plastic channel (lane stripes, dashed centre, edge stripes, rails, underside), emissive neon edges,
hazard-striped gap lips + run-up chevrons, pulsing boost pads, item boxes / cans / coins / rings (gameplay entities
when present), pylons to the ground plane (skipped where another level is below), loop towers, corkscrew hoops,
checkered start arch with 5 countdown lamps, flags, arrow boards, themed scenery (stadium / canyon / toybox / neon /
volcano). Budgets: < 60 k tris high, < 30 k low. Uses CB.gl core (drawList, shadow map, post FX bloom + speed blur,
particles: landing sparks / dust, boost flames, rail sparks), CB.gl.car models + pose (landing compression, spin yaw,
hop), CB.gl.effects sky + lighting. Cameras `chase` (follows the track up-vector with damped vector springs: no flips
in loops), `chase-far`, `hood`, `cockpit`, `tv`. `drawsArcadeWorld: true` tells arcade-fx to skip its 2D entity / flame
overlay (it still draws HUD-ish effects).

### 4.4 Multiplayer notes (stunt sessions) — implemented in §6

Deterministic (fixed 1/120 s, no `Math.random` in the sim, seeded PRNGs) and snapshot-serialisable:
`session.getState()` is plain JSON (per car: track-space `s, lat, psi, v, dist, mode` + air pose/velocity, timers,
drive-model scalar state; gameplay state via `gp.serialize()`), `setState(state)` restores it and the same inputs then
reproduce the run bit-exactly (tests/arcade-stunt.test.js). A host-authoritative netrace would send inputs up and
`getState()` deltas (or snapshots) down; clients render `snapshot()` (cars carry world `pos / fwd / up`).
Implemented (§6) with: entrant `id`s (`opponents[i].id` becomes the car id), `preStep` hooks **chained** like the engine
(each hook gets the previous hook's input), `car.humanAssist` (a remote player's assist level, no AI pace / grip) and
`car.external` puppets (no AI / physics; the `externalStep(car, dt, api)` hook poses them).

## 5. Mode shell (race-ui discipline `'arcade'`)

* Route `#/arcade` (router NAV item "Arcade", hub main-menu tile). Deep links `#/arcade?track=<id>&quick=1`.
* Setup: track list (stunt first, then circuits), Mode (Race / Time trial), Laps, Opponents, AI difficulty,
  Steering assist, **Arcade rules** (extension options), Weather / Time of day, graphics. Arcade settings are
  stored in `forge.race.settings.v1 → arcade` and never change Race / Drift defaults.
* HUD: `ARCADE` badge; results screen shows an `ARCADE` chip; best laps go to the separate store
  `forge.arcade.records.v1` (same record format as race records, per track and build).
* Replays record `meta.handling = 'arcade'` and replay with the badge (pose playback, unaffected by physics).
* The finish report (`onFinish` / `cb:race-finished`) carries `handling: 'arcade'`, `arcade: true` (discipline stays
  `'race'` for compatibility) so profile / reward listeners can tell arcade runs apart.
* Track cards: stunt entries draw `def.points` (2D outline) when present, else `CB.arcade.stunt.drawThumb(canvas, def, opts)`,
  else a generic loop glyph. Optional card fields: `tagline` / `desc`, `difficulty` (1–5), `length_m`, `stunts` (count).
* Test hook: `window.drift.start({ mode: 'arcade', trackId, laps, opponents, difficulty, seed, arcadeMode: 'time-trial' })`.

## 6. Multiplayer (`js/net/netarcade.js`, `CB.net.arcade`)

Lobby mode **Arcade** (`#/multiplayer`, lobby protocol `forge-net/2`): the host picks a stunt track or a circuit, laps, AI fill +
difficulty and the arcade rules (`items`, `itemFrequency`, `nitro`, `speedClass`, `coins`). Online rooms, invite codes and
same-device tabs all work; online rooms fall back to the server relay (`relay: true`, `peer.mode === 'relay'`).

* **Host-authoritative.** The host runs one `CB.arcade.mode` session with every car: itself as the player, remote players and
  AI fill as grid cars (entrant ids = net car ids, `gridOrder: 'given'`, the same grid index on every peer). Its gameplay
  layer runs with `gp.setNet({ role: 'host', humans: [ids], externalLaunch: true, onEvent })`: item boxes, rolls, item use,
  hits, shields, canisters, coins, positions, laps, finish and results are decided there only.
* **Input replay.** A client records the exact (quantised: steer ±127, pedals /255, flags handbrake | nitro | aim-back,
  item-press counter, start grade) input of every 1/120 s tick and sends the changes since the host's ack (~40 Hz, `fast`;
  loss-proof because every packet repeats all un-acked changes). The host applies tick `n − D` at its tick `n` (D adaptive:
  measured lateness + 2.5·jitter + one send interval, 3–42 ticks, 96 on relay links) and holds the car until GO + D, so its
  copy of the car is the player's own trajectory shifted by D. Remote players' rocket starts come from the client's grade
  (`gp.launchKart`). Remote cars on a stunt track drive with the player assist (`car.humanAssist`, AI pace / grip off).
* **Client = predicted mirror.** Same seed / track / grid; only the own car is simulated. Other cars are puppets (stunt:
  `car.external = true`, the session skips AI + physics and calls the `externalStep` hook; circuit: frozen engine cars posed
  in `postStep`), interpolated ~2 snapshots behind (adaptive, 60–400 ms; relay 300–1000 ms). The gameplay layer is a
  **follower** (`setNet({ role: 'follower' })`): no rolls, no hits; it predicts only the own car's nitro burn, powerslide
  turbo, landing / trick boosts and pads / rings, and merges the host's `gp.netPack()` (`gp.netApply`) + events
  (`gp.pushEvents`, `gp.applyHit` for hits on the own car).
* **Reconciliation.** Each snapshot carries the host's tick N and per player `[ackTick, D]`; the client compares the host's
  state of its car with its own history at N − D, shifts the later history by the difference and blends it into the car
  (τ 0.12 s). Mode mismatch (ground / air) for 4 snapshots or > 14 m → hard snap. Without interaction the error is millimetres
  (`tests/net-arcade.test.js`).
* **Messages.** `start{v:'redline-net-arcade/1', arcade:true, seed, t0, cfg{trackId, kind, laps, arcade, snapHz,
  lightsOutDelay_s, maxSteerAssist}, grid, you}` · `na.s` (fast, `snapHz` 20 Hz / 15 Hz for > 5 cars: quantised pose arrays per
  grid index — stunt `[i, mode, s, dist, lat, psi, v, rpm, gear, steer, thr, flags, fade, (air pose)]`, circuit `[i, x, y, h,
  vx, vy, w, rpm, gear, steer, thr, brk, flags]` — the gameplay pack every 2nd, acks) · `na.in` (fast) · `na.st` standings 5 Hz
  · `na.ev` gameplay events ~15 Hz · `results{arcade:true, classification[{…, arcade{hitsLanded, hitsTaken, itemsUsed, coins,
  boxes, blocked, nitroUsed_s}}]}` · `na.leave{id}` · `na.end` · `na.quit`. Relay links get self-contained 5 Hz snapshots
  (pack every time). ~0.6 KB per 8-car snapshot → ~12 KB/s down per client.
* **Race control.** Ends when every connected human is over the line, or `finishWait_s` (30 s) after the first human
  finished; classification by finish time, then distance. A player who leaves is turned into an AI car (`(AI)`, kind `ai`);
  the host leaving ends the session for everyone.
* **race-ui.** `openNet` runs the session as discipline `'arcade'` (ARCADE HUD, stunt renderer through `session.track`,
  `session.arcade` for the HUD / FX / phone wheel), never writes `forge.arcade.records.v1`, and shows the multiplayer results
  with an ARCADE chip and hits · items · coins. No purse: multiplayer results are not reported to the hub (as other MP races).

## 7. Gameplay layer (nitro, boosts, items, coins) — `CB.arcade.gameplay`

Load order (index.html, after the mode core and the stunt pack, before race-ui): `items.js → nitro.js → gameplay.js →
arcade-hud.js → js/race/gl/arcade-fx.js → arcade-sfx.js → arcade-layer.js`. `arcade-layer.js` registers the
`'gameplay'` extension (§3); without `CB.arcade.mode` every module still works stand-alone.

**Setup options** (`settings.options`): `items` (toggle), `itemFrequency` `low|normal|high|frantic`, `nitro` (toggle),
`speedClass` `street|pro|mayhem` (top speed ×1.0/1.12/1.28 + extra push, AI aggression ×0.9/1.0/1.15), `coins` (toggle).
Mode `time-trial` = no item boxes, a triple Turbo at the start (the engine's ghost runs as usual), no rubber band.

**Controls**: N / Shift = nitro (held; Shift is consumed so it never shifts up) · F / X = use item (hold S / ↓ to
aim back) · Space = powerslide (the vehicle's own handbrake slide) · gamepad B/RB nitro, X/LB item, D-pad down / LT aim
back · touch NITRO + ITEM buttons (swipe down on ITEM = back) · phone wheel page NITRO (hold) + ITEM (swipe down = back).

**Mechanics** (all in track space: `s` m along the lap, `lat` m + left, race distance):
* Nitro meter 0..1 — fills from air time (0.11/s), clean landings ≥ 0.45 s (+0.08, ≥ 0.9 s also a trick boost),
  near-misses (+0.05), completed slipstreams (+0.10), powerslides (+0.055/s, +0.04×tier on release), overtakes (+0.06
  per place), nitro canisters (+0.34), boost rings (+0.10). Burns 0.27/s for ×1.17 top speed and +9.5 m/s².
* Rocket start: a rev gauge during the countdown (throttle raises it, releasing drops it); gold band at GO = 1.6 s
  boost, green = 0.95 s, pinned past 0.97 = over-rev bog. Cars are held on the brakes during grid/countdown.
* Powerslide mini-turbo: charges while the slide lasts — blue ≥ 0.95 s, orange ≥ 2.0 s, purple ≥ 3.3 s → 0.7/1.25/1.9 s boost.
* Slipstream: 3.5–30 m behind a car within 2.4 m laterally above 18 m/s charges for 1.5 s → 1.15 s boost.
* Boost pads (1.0 s, ×1.22) and rings (1.2 s, ×1.2). Coins: +1 % top speed each, cap 10, lose up to 3 when hit.
* Items (`CB.arcade.items`, position-weighted roulette — leader gets Oil/Shield/EMP, the back Turbo/Mega/Rocket/
  Magnet and the rare Lightning, ≥ 4 cars): Turbo ×3, Oil Slick (dropped behind; hit = harmless 360 via `V.spinOut` +
  slow), Shockwave/EMP (22 m), Bumper Rocket (homes on the car ahead / behind when aimed back; hop + spin + slow),
  Shield (blocks one hit, 9 s), Magnet (3.6 s pull to the car ahead), Ghost (4.2 s: `car.noCollide`, immune),
  Mega Nitro (refill + 2.4 s super boost), Lightning (slows everyone ahead).
* AI: difficulty `easy|normal|hard|expert` (race-ui `rookie|amateur|pro|alien`) sets item reaction time, how smartly
  items are used (rockets at the car ahead < 160 m, oil when followed, shield vs incoming rockets …), nitro thresholds
  (burns on straights), passive nitro trickle and rocket-start odds. Rubber band: AI behind the player get up to
  +2–3 m/s² push / +7 % top, AI far ahead ease off the throttle (expert barely).

**Hook interface** (one instance per session, `gp = CB.arcade.gameplay.create(opts)`):
* Engine-style sessions: `cfg.hooks = [gp.hooks]` (name `'arcade-gameplay'`), then `gp.attachEngine(session)` (finds
  the CB.race.engine inside wrappers via `.engine` / `_debug().inner`; builds the track adapter + auto layout: box rows,
  pads + ring on the longest straights, coin lines, canisters on the inside of the tightest corners). The hook runs
  `gp.step` once per 1/120 s substep (on the first car's `preStep`) and then per car: `preStep` returns the modified
  input (throttle cut while hit, grid hold, stylised slide steer for non-arcade handling) and sets `car.noCollide`
  (engine collisions skip such cars) and `car.arcadeFx`; `vehicleEnv` feeds boosts to arcade handling through
  `env.arcade { push, topSpeedMult }`; `postStep` starts `car.V.spinOut(...)` for hits and applies slowdowns
  (`brakeTo`) / sim-handling pushes to the body-frame `state.vx` (wheel speeds kept consistent).
* Hook car fields read: `id, isPlayer, idx, position, finished|dnf, ctx {t, phase, trackLength}`, `lapS|s`,
  `lateral|lat`, `raceDist|dist`, `state {speed|vx|v, powerslide?, slideDir?, airborne?|mode}`, `airborne`,
  `params.capabilities.topSpeed_mps`, `input {throttle, steer, handbrake}`, `halfW`.
* Track-space integrators that do not use the hooks: `gp.step(dt, { t, phase, trackLength, cars: [{ id, isPlayer, s, lap,
  dist, lat, speed, position, vTop, halfW, throttle, steer, airborne, finished, powerslide?, slideDir?, nativeSpin? }] })`,
  then per car `gp.effects(id)` = `{ push m/s², vTarget m/s, brakeTo m/s|null, brakeDecel, throttleMult, steer|null,
  stripHandbrake, yaw / slide (visual rad), hop (visual m), noCollide, shielded, ghost, boostKind, nitroOn, spinReq
  {duration, dir, speedLoss, turns}|null (one step) }`. Stunt sessions: when the hooks are present use
  `car.arcadeFx` (= `gp.effects(car.id)`) for brakeTo / throttleMult / spinReq / noCollide, not only `vehicleEnv`.
* `gp.setInput({ nitro, item, aimBack, drift, rev })`, `gp.applyBoost(id, kind, secs, top, accel)`,
  `gp.addNitro(id, amount, source)`, `gp.hitCar(id, kind, byId)`, `gp.giveItem(id, item, uses)`, `gp.useItem(id, back)`,
  `gp.addEntity({type, s, lat, ...})`, `gp.setTrack(track {length, pose(s, lat), halfWidth?}, layoutSpecs?)`,
  `gp.state()` (HUD/net view: `karts`, `player`, `entities`, `options`), `gp.takeEvents()`, `gp.stats(id)`.
* Stunt tracks: the extension maps the built track (`CB.arcade.stunt.get(id)`: `pointAt`, `sample`, `features`) to the
  gameplay track — its `box / pad / ring / coin / can` features become the gameplay entities, so the stunt session
  should not apply its own pickups when a hook named `'arcade-gameplay'` is present (it already does not).
* Extension instance: `snapshot(snap)` → `snap.arcade.ext.gameplay` (state + drained `events`) and decorates cars
  (`car.arcade`, visual `heading += yaw + slide`, `car.arcadeHop`); `drawHud` draws `arcade-fx` (projected crates,
  pads, rings, coins, canisters, oil, rockets, nitro/boost flames, drift sparks, shield/ghost bubbles, EMP rings,
  lightning, speed lines, boost vignette; entities behind nearer cars are masked) then `arcade-hud` (item slot +
  roulette under the ARCADE badge, power-up chips, announcer callouts, nitro gauge + coins, rev gauge, draft meter);
  `setRenderer` adds a chained camera controller (FOV kick + shake) and the car hop through `roadY`. The instance has
  **no** `entities` member on purpose (race-ui's fallback markers would double-draw); `worldEntities()` is ready for a
  renderer that gains `setEntities`. `results(r)` → `r.arcade.gameplay`. Phone: `CB.input.hub.onEvent` +
  wheel message `{t:'arcade', on, nitro, nitroOn, item, uses}` ~4 Hz; buttons send `nitroOn|nitroOff|item|itemBack`.

**Determinism / multiplayer later**: own serialisable mulberry32 (`serialize().rng`), everything advances in the fixed
step, no `Math.random` in the core (FX particles are cosmetic only), every event has an increasing `id` + `t`, entities
have stable ids, `gp.serialize()` / `gp.load(state)` round-trip the whole world (karts, items, entities, timers). For a
host-authoritative lobby: run the layer on the host only, send clients `snap.arcade.ext.gameplay` (+ events), forward
client buttons (`nitro`, `item`, `aimBack`) with their inputs into `gp.setInput(carId, …)`; clients only render.


# FORGE Atelier — Game Systems Contract (addendum to SPEC.md + RACE-SPEC.md)

Meta-game layered on top of the configurator and race mode. Built in parallel with them; wired in by a final
integration pass. Same rules: zero deps, classic scripts, `CB.game.<name>`, works on `file://`, pure modules Node-testable.
Files live in `js/game/`; tests in `tests/game-*.test.js`. UI modules inject their own `<style id="game-<name>-styles">`.

## Shared profile (`js/game/profile.js` → `CB.game.profile`)
Single persisted player profile in localStorage `forge.profile.v1`:
```
{ version:1, driverName, avatarColor, credits (start 150000), xp, level, createdAt,
  ownedCars: [{ id, name, build, purchasedFor, odometer_km, races, wins, condition 0..1 }], activeCarId,
  unlocks: { parts: [catalogPath:id ...], tracks: [ids], bodyStyles: [ids] },
  career: <career state>, achievements: { [id]: {unlockedAt, progress} },
  stats: { races, wins, podiums, poles, fastestLaps, distance_km, topSpeed_kph, crashes, creditsEarned, driftScoreBest },
  settings: { units, difficulty, assists, audio: {master, engine, sfx, music}, controls: {bindings}, camera } }
```
API: `load()`, `save()`, `get()`, `update(fn)` (fn mutates a clone; saved + emits), `subscribe(fn)`, `reset()`, `addCredits(n, reason)`,
`spend(n, reason) -> bool`, `addXp(n) -> {levelUp, newLevel}` (level curve: xpForLevel(l) = round(1000 * l^1.6)), `ledger` (last 200 transactions).
Must work without localStorage (memory fallback).

## Economy & progression (`js/game/economy.js` → `CB.game.economy`)
- `partUnlockLevel(collectionPath, id)` → level required (expensive/exotic parts gated: W16 L20, carbon-monocoque L15, slicks L8, quad-turbo L12 …; cheap parts L1).
- `isUnlocked(profile, collectionPath, id)`, `lockedOptions(profile)` → map collectionPath → Set(ids) (configurator greys these with a lock badge, in career mode only; Free Build mode ignores locks).
- `carCost(build)` = CB.pricing total (fallback own estimate) × careerPriceFactor 0.35; `upgradeCost(oldBuild, newBuild)` = difference in part costs (selling parts refunds 50%).
- `raceRewards({position, fieldSize, difficulty, laps, trackId, cleanRace, fastestLap, pole})` → `{credits, xp, breakdown:[{label, credits, xp}]}`.
- `repairCost(car)`, `sellValue(car)` (depreciation by odometer & condition).

## Career (`js/game/career.js` → `CB.game.career`)
Tiers: Rookie Cup → National GT → Continental Series → World Endurance → Hypercar Masters (5 tiers, 3-5 championships each, 3-6 rounds each).
Championships have entry requirements (`maxPower_hp`, `minWeight_kg`, `bodyStyles`, `drivetrain`, `engineTypes` e.g. EV-only cup, `tireCompounds`, `maxPrice`) checked by
`checkEligibility(build, championship) -> {ok, reasons[]}`. Points systems (F1-style 25-18-15…, +1 fastest lap). Standings for AI drivers simulated persistently
(AI drivers have consistent identities from CB.race.ai names). Also special events: Time Attack, Drag Race (quarter-mile, uses physics), Drift Trial, Eliminator,
Endurance (tire wear + fuel + pit stops), Manufacturer Challenge (must build with given constraints), Rivals (1v1 vs named rival).
API: `catalog` (all tiers/championships/events data), `state(profile)`, `nextRound(profile, champId)`, `raceConfigFor(profile, champId, roundIdx)` → a
`CB.race.engine.createSession` cfg (+ `extras: {wear, fuel, pitStops, eventType}`), `recordResult(profile, champId, roundIdx, results)` → updates standings,
awards via economy, returns `{pointsTable, standings, rewards, championshipComplete, trophy}`. Simulate AI-only rounds deterministically from seed.

## Wear, fuel, damage, pits (`js/game/endurance.js` → `CB.game.endurance`)
Pure, per-car state extension used by the race engine through hooks:
`createCarState(vehicleParams, build, opts)` → `{ tireWear: [fl,fr,rl,rr] 0..1, tireTemp_c: [...], fuel_l, damage: {front, rear, left, right, engine, aero} 0..1, brakeTemp_c }`.
`step(carState, vehicleState, input, dt, env)` updates wear (slip energy), temps (optimal window by compound; cold/overheated reduce grip),
fuel use (from throttle × power), damage from collision events (`applyImpact(carState, impulse, localDir)`).
`modifiers(carState)` → `{ gripMult: [per axle], powerMult, dragMult, downforceMult, steerPull }` — engine multiplies these in.
`pitStop(carState, request {tires:bool, compound?, fuel_l, repair:bool})` → `{ duration_s, newState }`. Pit lane spec: tracks define `pitEntry_s`, `pitExit_s`
(if absent, integration derives from the start/finish straight); pit speed limit 60 km/h.

## Replay & photo mode (`js/game/replay.js` → `CB.game.replay`)
`createRecorder(session)` → `{ capture(snapshot) (every frame, decimated to 30 Hz, compact typed arrays), finish() -> Replay }`.
`Replay` serializable (compressed delta/quantized) and storable (last 5 in localStorage `forge.replays.v1`, size-capped).
`createPlayer(replay, renderer, hud)` → `{ play(), pause(), seek(t), speed(x: 0.25..4), setCamera(mode incl. 'orbit-car', 'helicopter', 'trackside'), followCar(id), duration }`.
Replay UI (inject into #race-root): timeline scrubber with lap & event markers (overtakes, collisions), car selector, camera buttons, speed.
Photo mode: pause, free camera pan/zoom/rotate, filters (contrast, vignette, motion blur trail, B&W, film grain), frame overlays, `export PNG` via canvas.toBlob download.

## Achievements (`js/game/achievements.js` → `CB.game.achievements`)
60+ achievements across configurator (e.g. "Bespoke": spend >$500k on a build, "Featherweight": <900 kg, "Thousand Horses", "Every Finish", "Silent Running": EV build),
racing ("First Win", "Grand Slam": pole+win+fastest lap+led every lap, "Clean Sweep", "Comeback": win from last, "Ton-Up": 400 km/h), career, drift, endurance.
`check(profile, event)` with events `{type:'build-changed', build, metrics} | {type:'race-finished', results, config} | {type:'career', ...} | {type:'stat', ...}` → newly unlocked list.
Each `{id, name, desc, icon (svg string), tier: bronze|silver|gold|platinum, xp, credits, hidden?, progress?(profile)->{cur,max}}`.
UI: `CB.game.achievements.toast(a)` (animated unlock toast), `openGallery()` modal with progress bars & filters.

## Challenges / Driving school (`js/game/challenges.js` → `CB.game.challenges`)
Skill tests that reuse race engine on special generated layouts (provide them as extra track defs registered into `CB.race.tracks.list` if present via `CB.race.tracks.register(def)` — if `register` doesn't exist, push into `list` then call `build`):
Launch Control (0-200 timing), Braking Zone (stop in box), Slalom (cones as small obstacles), Drift Trial (score from slip angle × speed × duration, combo multiplier),
Top Speed Run (long straight), Hot Lap (beat target times — bronze/silver/gold medals per challenge), Elk Test. Each `{id, name, desc, trackDef, rules, scoreFn, medals}`;
`createChallengeSession(id, build)` returns an engine-compatible cfg plus `evaluate(snapshot) -> {score, medal, done}` hooks. Drift scoring HUD widget drawn via
`drawOverlay(ctx, snapshot, state)`.

## Hub UI (`js/game/hub.js` → `CB.game.hub`)
Full-screen main menu / career hub `#game-hub` (inject styles): animated title screen "FORGE" with the active car rendered (CB.render.thumbnail or snapshot),
menu: **Career**, **Quick Race**, **Time Trial**, **Challenges**, **Free Build (Atelier)**, **Garage (owned cars)**, **Achievements**, **Replays**, **Profile & Stats**, **Settings**.
Career screens: tier map, championship cards with eligibility check against active car (reasons shown, "Modify car" jumps to configurator), round calendar,
standings tables, pre-race briefing, post-race rewards screen (animated credits/xp count-up, level-up fanfare), trophy cabinet.
Garage: owned cars grid with condition/odometer, buy new (opens configurator in career mode with price shown in credits and locked parts),
upgrade (configurator diffs priced as upgrade cost; "Confirm purchase"), repair, sell. Settings: units, difficulty, assists, audio sliders, control rebinding
(keyboard capture), camera, graphics quality (particles, shadows, skidmarks), reset profile. Profile: stats dashboard with charts.
Integration hooks the hub expects (stub-guarded): `CB.race.ui.open(build, cfgOverrides, {onFinish(results)})`, `CB.app.openAtelier({mode:'free'|'career-buy'|'career-upgrade', carId, onConfirm(build)})`.

## Engine hook contract (implemented by the final integrator into js/race/engine.js)
`createSession(cfg)` accepts `cfg.extras = { endurance: bool, fuel: bool, damage: bool, pitStops: bool, challenge: <challenge cfg>, onEvent(e) }` and
`cfg.hooks = { carCreated(car), preStep(car, input, dt), postStep(car, dt), modifiers(car) -> mods }`. snapshot cars gain `endurance` fields when enabled.

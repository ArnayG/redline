# Redline — Formula 1 mode (contract)

User request: "implement a formula 1 mode where you play on actual formula 1 maps and you race f1 cars that are all the
same spec and you can pick your f1 team". Route `#/f1`, nav item / menu tile **Formula 1**. Same rules as the rest of the
game: zero dependencies, classic scripts on `window.CB`, works from `file://` and a subfolder, pure-logic files load in
Node (`var CB = (globalThis.CB = globalThis.CB || {}); ... module.exports`). Team names are text badges only (no logos);
every driver is fictional; circuit names are descriptive place names.

F1 lives in its own modules. Shared files only get small, additive, feature-detected hooks.

## Files and owners

| File | Namespace | What |
|---|---|---|
| `js/f1/f1-teams.js` | `CB.f1.teams` | 11 teams, liveries, fictional drivers, `buildFor(teamId, opts)` (done) |
| `js/f1/f1-circuits.js` | `CB.f1.circuits` | real F1 circuit layouts in the turtle track format + F1 metadata |
| `js/race/gl/f1-scenery.js` | `CB.gl.f1scenery` | pit lane, garages, pit wall, start gantry, DRS boards, themed landmarks |
| `js/f1/f1-car.js` | `CB.f1.car` | single-spec car params, tyres (compounds, temperature, wear), DRS, ERS, pit-stop timing |
| `js/f1/f1-hooks.js` | `CB.f1.hooks` | the race-engine hook object that turns an engine session into an F1 session |
| `js/f1/f1-ai.js` | `CB.f1.ai` | F1 racecraft wrapper around `CB.race.ai` drivers |
| `js/f1/f1-strategy.js` | `CB.f1.strategy` | tyre / pit strategy (1–2 stops), live advice |
| `js/race/gl/f1-car-mesh.js` | `CB.gl.f1car` | hand-authored low-poly F1 car, team liveries, LOD, cockpit (halo, wheel display) |
| `js/f1/f1-mode.js` | `CB.f1.mode` | session config builder (grid, entrants, engine cfg) |
| `js/f1/f1-weekend.js` | `CB.f1.weekend` | weekend / championship state, points, standings, persistence |
| `js/f1/f1-hud.js` | `CB.f1.hud` | steering-wheel dash, timing tower, sectors, tyres, ERS / DRS, race control, phone HUD, touch buttons |
| `js/f1/f1-ui.js` | `CB.f1.ui` | `#/f1` screens (team, circuit, format, settings, weekend hub, standings), launches race-ui |

Shared-file hooks already added to `js/race/engine.js`: `cfg.maxOpponents` (default 11; F1 passes 21), hook
`wrapDriver(driver, car, entrant, isAutopilot) -> driver`, hook `pitBox(car, laneInfo) -> s` (per-team box), and the
pit lane (surface `'pit'` or `car.pitPhase`) never counts as a track-limits excursion.

## 1. Teams (`CB.f1.teams`)

See the file header. Builds have `body.model = 'f1-2026'` and `build.f1 = { teamId, seat, number, driver, driverShort,
teamName, livery {primary, secondary, accent, number, halo, wheel}, isPlayer }`. `isF1Build(build)` is what renderers test.

## 2. Circuits (`CB.f1.circuits`)

`list` (defs), `ids`, `get(id)`, `meta(idOrDef) -> resolved metadata in metres on the built geometry`.
Defs come from `CB.race.tracks.makeTrack` (exact catalog shape) and are registered into `CB.race.tracks.get()` only
(wrap `get` like tracks-extra does), NOT pushed into `CB.race.tracks.list`, so Race / Drift / Arcade lists and the
existing all-circuit tests are unchanged. Each def carries `f1` metadata (lap fractions `u` in [0,1) of the layout,
resolved to metres by `meta()`):

```
def.f1 = {
  real: { name, country, length_m, laps (race laps), turns, pole_s, raceLap_s, opened },
  sectors: [u1, u2],                         // also def.sectors (the engine's sector split)
  drs: [{ detect: u, start: u, end: u }],    // 1–3 zones
  pit: { side: +1 (left) | -1 (right), entry: u, exit: u, box0: u, boxSpacing_m, offset_m, width_m, speedLimit_kph },
  night: bool, landmark: 'ferris-wheel' | 'harbour' | ... , elevation: [[u, m], ...] (optional)
}
def.pitEntry_s / def.pitExit_s (metres) for the engine's pit-lane logic.
meta(id) -> { length_m, drs: [{ detect_s, start_s, end_s }], sectors_s: [s1, s2], pit: { side, entry_s, exit_s, box_s(teamIndex),
              offset_m, width_m, speedLimit_ms }, real: {...} }
```
Circuits (≥8): `monza`, `silverstone`, `spa`, `monaco`, `suzuka` (figure-8 bridge via the existing `crossing: 'bridge'`),
`interlagos`, `red-bull-ring`, `montreal`; stretch `bahrain`, `zandvoort`, `cota`, `marina-bay` (night), `las-vegas`
(night). Ids are prefixed `f1-` in the catalog (`f1-monza` ...). Lengths within ±5 % of real, real-ish widths (12–15 m,
Monaco ~8–10 m), red/white kerbs, gravel / asphalt run-off, walls where real (Monaco, Montréal Wall of Champions, Baku-
style street parts), DRS zones, sector lines, pit lane on the correct side.

Pit lane: a parallel strip outside the track edge on `pit.side` between entry and exit; `CB.race.tracks.project`
reports surface `'pit'` (onTrack) inside it (additive support in tracks.js keyed on `def.f1.pit` / `def.pitLane`),
and the pit-side barrier sits beyond it. The 3D pit lane / garages / pit wall are drawn by `CB.gl.f1scenery`.

## 3. Car (`CB.f1.car`)

One spec for every car (difficulty changes AI skill only):

- ~1000 hp hybrid (ICE + ERS deploy), 800 kg with driver, 8-speed seamless (shift ≈ 0.03 s, no torque cut), 3.6 m
  wheelbase, ~1.6 m track, 5.6 m × 2.0 m collision box, rev limit ~12 500 rpm.
- Downforce ∝ v² (≈ 3× car weight at 250 km/h), CdA ~1.1–1.3 (DRS open: −20–25 % drag, −~15 % rear downforce),
  heavy braking (≈ 5 g at 300 km/h, ~2 g at low speed; 200→0 in ~55 m), mechanical grip μ ~1.7 slick.
- Targets (Node tests): 0–100 ≈ 2.6 s, top speed ≈ 340–350 km/h with DRS, 200→0 ≈ 55 m, ≈ 4–5 g in fast corners.
- Tyres: `COMPOUNDS` soft / medium / hard / inter / wet { grip, window [lo, hi] °C, wearRate, warmRate, wetGrip }.
  Per-car tyre state: temperature (surface) per corner, wear per corner 0..1, age in laps; grip = f(compound, temp,
  wear, wetness). Slicks in the wet are bad, wets in the dry overheat / wear.
- DRS (race rules): a car may open DRS inside a zone when it was within 1.0 s of the car ahead at that zone's detection
  point, from lap 3 (2 laps after the start) and not in the first lap after a restart; closes on braking / zone end.
  Practice / qualifying: free use in zones. Wet race: disabled.
- ERS: store 0..1 (4 MJ), deploy mode `'auto'` (default) | `'boost'` (overtake, hold) | `'harvest'`; harvest under
  braking / lift; boost adds ~120 kW until empty.
- Pit stop: ~2.5 s stationary (± crew variance), tyre change to the requested compound; pit limiter 80 km/h
  (Monaco 60).

```
CB.f1.car.params(opts?) -> frozen CB.race.vehicle params (opts { drsOpen })
CB.f1.car.COMPOUNDS, createTyres(compound, opts), stepTyres(ts, carState, dt, env), tyreGrip(ts, wetness) -> [4]
CB.f1.car.drs: { eligibleAt(detectGap_s, lap, phase, mode, weather) }, ers: { create(), step(es, dt, ctx) }
CB.f1.car.pitStopTime(rng, opts) -> s
```

## 4. Engine hooks (`CB.f1.hooks`)

`CB.f1.hooks.create({ circuit (def), meta, mode 'race'|'qualifying'|'practice', weather, playerTeam, entrants, seed,
assists { abs, tc, autoShift, brakingLine, ersAuto }, tyreStart: { [carId]: compound } }) -> hook object` with:
`carCreated` (replace `car.params` with the F1 params, `car.build` with the F1 build, collision dims, fresh state at the
same pose; attach `car.f1` state), `preStep` (DRS open/close, ERS, pit limiter, automatic pit-lane driving for the
player and AI: steer to the pit lane, stop at the team box, rejoin), `vehicleParams` (DRS / ERS variants, cached),
`vehicleEnv` (per-wheel tyre grip), `postStep` (tyre / ERS / DRS detection update), `snapshot(car) -> { f1: {...} }`
(snapshot cars gain `endurance.f1`), `pitStop` (duration + new tyres), `pitBox`, `advice` (→ `CB.f1.strategy`),
`wrapDriver` (→ `CB.f1.ai.wrapDriver`). Player F1 inputs come in via `hooks.setPlayerControls({ drs, ersBoost,
ersMode, pitCompound })` (HUD / UI calls it every frame) and `hooks.state()` exposes race-control messages
(`drainMessages() -> [{ t, kind: 'drs'|'flag'|'penalty'|'radio'|'pit'|'info', text, carId }]`).

Snapshot `car.endurance.f1`:
```
{ team, compound, tyreWear: [4], tyreTemp: [4], tyreAge, compoundsUsed: [...], drs: { zone, eligible, open, available },
  ers: { soc, mode, deploying, harvesting }, pitLimiter, inPitLane, pitStops, blueFlag, yellow, penalties_s, warnings }
```

## 5. AI (`CB.f1.ai`, `CB.f1.strategy`)

`CB.f1.ai.wrapDriver(baseDriver, car, entrant, ctx) -> driver` (same `control(state, raceCtx, dt)` contract):
proper racing line per circuit, downforce-aware braking (the base AI's speed plan from the F1 params), defending (one
move), overtaking with DRS / slipstream, clean in packs, pit-lane driving, ERS / DRS usage (through `car.f1`), tyre
management, no wall-riding at Monaco. Difficulty scales pace (Pro ≈ a good player with assists).
`CB.f1.strategy.plan(meta, laps, compoundsAllowed, rng) -> { stints: [{ compound, laps }] }`, `advice(car, ctx)`.

## 6. Mode / weekend / UI / HUD (as built)

`CB.f1.mode.sessionConfig({ settings (sanitize()d F1 setup), circuitId, session 'practice'|'qualifying'|'race', laps?,
gridOrder? (car ids P1 first, 'player' for you), seed, playerName, maxTime_s? }) -> { build, launch, settings, circuit }`.
`launch` = race-ui options: settings (engine mode 'race' | 'practice', laps, difficulty, weather, timeOfDay, assists,
camera3d), opponents (21 entrants: fictional drivers, `carName` = team chassis e.g. "MCL40", `f1` block), maxOpponents 21,
hooks [CB.f1.hooks instance], extras `{ pitStops: true, mandatoryPitStops: 0, autoPit: false }` (the two-compound rule is
the hooks' `requireTwoCompounds`, dry races ≥ 10 laps), context `{ kind: 'f1' }`, gridOrder 'given' + startPosition when
qualifying set the grid, maxTime_s for timed practice / qualifying (`sessionLength_s`: ≈ 3.6 laps quali, 6 laps practice).
Time of day: `'auto'` (UI "Circuit default", the default) uses the circuit's own (`def.timeOfDay` / `def.f1.night`:
Bahrain, Marina Bay, Las Vegas run at night); Day / Dusk / Night only when the player picks one.

`CB.f1.weekend`: `POINTS` 25-18-15-12-10-8-6-4-2-1, `+1` fastest lap in the top 10 (option), DNF / DSQ score nothing;
`score(results, opts)`, `gridFrom(qualifying)`, weekends (`createWeekend`, `currentSession`, `recordSession`, `skipSession`;
the race cannot be skipped; skipping qualifying simulates a grid), seasons (`createSeason`, `applyRound`, `standings`
with count-back, `isSeasonOver`), storage `forge.f1.save.v1` (weekend / season in progress), `forge.f1.settings.v1`,
`forge.f1.stats.v1` (races, wins, podiums, poles, points, fastest laps, titles, circuits won, teams raced).

`CB.f1.ui` (#/f1): setup (team cards with livery stripes + text badges + seat choice, circuit cards with map preview, real
length / laps / pole time, NIGHT tag; format Quick race / Race weekend / Championship (pick the calendar; each round race
only or full weekend); race length laps or % of the real distance; difficulty; weather; time of day; camera; starting
tyre; assists: braking line, ABS, TC, auto gears, auto DRS, steering assist; fastest-lap point), hub (session cards,
last session's classification, grid, drivers / constructors standings, calendar), "Continue / Abandon" for a saved run.
Deep link `#/f1?quick=1&circuit=<id>&team=<id>&laps=<n>`. Test hooks `window.f1 = { state, start, go, newRun }`.

race-ui plugin (additive, every member optional, failures logged and ignored): `CB.race.ui.open(build, { ...launch,
plugin, oneShot, continueLabel, backLabel, onFinish, onClose })`, `plugin = { id, findTrack(id), records (createRecords
on forge.f1.records.v1), hudOptions { tower, timing, cluster, minimap: false }, configure(cfg, R) -> cfg (a fresh hook
set on every restart), attach(session, R), setRenderer(r, R), drawHud(ctx, snap, view { width, height, cockpit, paused,
units, project }), results(raw, res, snap), resultsPanel(res, raw, myRow) -> Element, detach(R) }`. `launch.maxOpponents`
lifts race-ui's 11-opponent cap. race-ui resolves an F1 build's car name from `build.f1.chassis`.

`CB.f1.hud` (drawn by plugin.drawHud over the trimmed race HUD, which keeps lights / banners / wrong way): steering-wheel
dash (15 shift lights, gear / pit limiter, speed, delta, DRS box (available / open), ERS bar + mode, tyre temperature
colours + wear % per corner, compound), timing tower (interval / tyre / PIT / DRS; best laps in timed sessions; compact on
phones: top 3 + the cars around you), session box (position or time left, current / best / last lap, sectors purple /
green / yellow), track map with DRS zones, race-control strip (track limits, penalties, fastest lap, hooks messages),
team radio, box / pit-window / limiter prompt. Phone (< 760 × 480): compact layout and touch DRS / ERS / BOX buttons.
Controls: F DRS (toggle; resets when the flap closes), N hold ERS boost, V ERS mode (auto / harvest / overtake),
I box this lap (I again cancels), O cycle the pit tyre; gamepad RB DRS, LB ERS boost, Back box; phone wheel ITEM = DRS,
NITRO = ERS boost. Inputs go to `hooks.setPlayerControls` every frame.

## 7. Integration (as built)

Router `#/f1` (layer `screen-f1`, nav item "Formula 1", leaving the route closes a running race-ui session), main-menu
tile *Formula 1*, achievements category `f1` (ids `f1-*`, event `{ type: 'f1', ... }`: lights-out, points, podium, win,
pole, fastest-lap, charge (+10 places), pit-master, rain-master, legend, champion, every garage (5 teams), globetrotter
(8 circuits)), profile stats through `CB.game.profile.recordRaceStats` (eventType 'f1'), best laps per circuit in
`forge.f1.records.v1`. Multiplayer: later (the lobby race would need the F1 hooks and 22-car entrant lists synced over
`js/net/netrace.js`; not cheap enough for this pass).

## Not implemented yet (later)

- **Collision penalties**: contact between cars is resolved by the race engine's physics, but nobody is blamed and no
  time penalty is given (only track-limits warnings, then time penalties, are enforced). A later pass can judge
  fault from the closing speed and the overlap geometry in an `onImpact` hook in `js/f1/f1-hooks.js`.
- **Elevation**: the circuits are flat (Eau Rouge / Raidillon at Spa, the Interlagos bowl). The only height in the track
  mesh is the figure-8 bridge (Suzuka). Real elevation needs the road, walls, terrain and scenery to follow a height
  profile (`def.f1.elevation`), plus pitch in the physics.
- **Landmarks**: the Monaco pit building and the Zandvoort tower are not modelled yet.

## Measured (integration pass)

Car (`node tools/f1-physics-report.js`): 992 hp (ICE 600 kW + ERS 140 kW), 800 kg, 0–100 km/h 2.62 s, 0–200 4.73 s,
346.7 km/h with ERS + DRS (333.6 ERS, 312 ICE only), 200→0 in 50 m, 300→0 in 93 m (peak 4.8 g), cornering 2.5 g at
120 km/h, 3.7 g at 200, 4.75 g at 250, 5.5 g at 300. Spec tuned in this pass: slick μ 1.95 (was 1.78), clA 5.1 (5.4),
rear drive μ factor 0.80 (0.88, keeps the launch at 2.6 s), tread heating 4.2 (6.0: an Alien hot lap was cooking the
rears to ~144 °C, now ~105–118 °C inside the window).

Circuit polylines are arc-length resampled and Gaussian smoothed (σ 9 m, `smoothLoop` in f1-circuits.js): the surveyed
vertices are 5–50 m apart, so the spline had curvature spikes that read a 170 m corner as 30–50 m.

AI (F1 circuits only, `js/race/ai.js` keyed on `A.f1Circuit` / `L.f1`): the circuit's own racing line without the
road-car edge knee / hard clamp (they kinked the line at every apex: Ascari read as R 54 m instead of 170 m); the line
is scaled in smoothly to keep 0.95 m of edge room (1.4 m on walled street circuits); F1 trail braking keeps 88 % of the
lateral grip at speed (road cars 58 %); the saturation limiter starts at 0.985 (0.72) and releases at 14 m/s² (2.5);
the AI's own wheelspin cap only above 0.3 slip (the car's TC does the rest); running wide onto paved run-off is not a
slow "rejoin"; the plan uses the car's real power (×0.94), traction (0.72) and brakes. Difficulty is pace on the plan:
rookie ~0.85, amateur ~0.9, pro ~0.95, alien ~1.0 (`DIFF_SKILL` in f1-mode.js, `paceOf` in f1-ai.js).

Lap times (`node tools/f1-laptimes.js --laps`; hot lap, medium tyres; "limit" = quasi-static lap of the car on the
circuit's racing line with ERS all lap, so it is optimistic on power circuits; Zandvoort's banking is not modelled):

| Circuit | Real pole | Limit | AI Pro | AI Alien | Alien vs pole | before this pass (Alien) |
|---|---|---|---|---|---|---|
| Monza | 1:18.8 | 1:14.4 | 1:22.4 | 1:20.9 | +2.6 % | +19.0 % |
| Silverstone | 1:24.9 | 1:26.2 | 1:36.1 | 1:34.0 | +10.7 % | +37.5 % |
| Spa | 1:40.6 | 1:38.8 | 1:51.3 | 1:48.0 | +7.4 % | +24.8 % |
| Monaco | 1:10.0 | 1:06.9 | 1:16.4 | 1:14.8 | +6.8 % | +35.2 % |
| Suzuka | 1:27.0 | 1:25.6 | 1:36.6 | 1:35.2 | +9.5 % | +28.5 % |
| Interlagos | 1:10.0 | 1:09.1 | 1:16.1 | 1:14.3 | +6.1 % | +23.2 % |
| Red Bull Ring | 1:04.0 | 1:04.3 | 1:09.7 | 1:08.5 | +6.9 % | +23.8 % |
| Montréal | 1:10.9 | 1:07.0 | 1:15.3 | 1:13.4 | +3.5 % | +22.4 % |
| Bahrain | 1:29.8 | 1:28.2 | 1:37.1 | 1:35.6 | +6.5 % | +24.4 % |
| Zandvoort | 1:08.7 | 1:12.8 | 1:20.5 | 1:19.8 | +16.2 % | +38.6 % |
| COTA | 1:32.5 | 1:33.7 | 1:45.7 | 1:43.5 | +11.9 % | +36.6 % |
| Marina Bay | 1:29.2 | 1:27.0 | 1:38.5 | 1:35.8 | +7.4 % | +26.3 % |
| Las Vegas | 1:32.3 | 1:27.5 | 1:35.4 | 1:33.4 | +1.2 % | +18.1 % |

The Alien AI still runs ~6–9 % over the limit lap (tracking and braking margins of the adaptive base AI). That is the
next lever for "Alien within 2–3 % of pole". The physics-limit lap is within ±3 % of pole on 8 of 13 circuits (power
circuits −5 % because the limit assumes ERS all lap; Zandvoort +6 % without banking).

22-car, 3-lap Pro race sweep (`--race --cars=22 --race-laps=3`): no DNFs on any circuit; contacts 4–31 per race
(mostly light lap-1 touches, Monza / Suzuka T1 the worst); Monaco 4 wall touches; DRS used everywhere except Monaco /
Montréal in these short races.

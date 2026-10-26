# Redline — Drag Racing mode (contract)

User request: "Implement drag racing". Route `#/drag`, nav item **Drag**, main-menu tile *Drag Racing*. Christmas-tree
starts, burnout box, staging beams, launch-rpm mini-game, manual shift timing, ¼-mile timeslips, AI ladder, bracket racing,
elimination tournaments. Same rules as the rest of the game: zero dependencies, classic scripts on `window.CB`, works
from `file://` and a subfolder, pure-logic files load in Node (`var CB = (globalThis.CB = globalThis.CB || {}); ...
module.exports`).

The drag sim drives the **real race vehicle model** (`CB.race.vehicle`: `fromBuild`, `step`, `input.hold`, launch control,
clutch / converter take-up, manual / DCT / auto gearboxes, TC levels, tyre compounds, mass, aero), so Garage tuning
(power, weight, tyres, gearing, final drive, layout, launch control) decides the ET. Drag lives in its own modules;
shared files only get small additive hooks (router, nav, hub tile, index.html script tags + screen section, styles,
achievements, profile).

## 0. Files and owners

| File | Namespace | What |
|---|---|---|
| `js/drag/drag-strip.js` | `CB.drag.strip` | distances, splits, surfaces, strip geometry constants, venues |
| `js/drag/drag-tree.js` | `CB.drag.tree` | Christmas tree state machine (Pro / Sportsman / flag start), red lights, race decision (heads-up + bracket) |
| `js/drag/drag-timing.js` | `CB.drag.timing` | beam crossings, splits, ET, trap speeds, timeslip text, records (PBs), ghost share codes |
| `js/drag/drag-launch.js` | `CB.drag.launch` | burnout heat model, launch-rpm sweet spot, shift-window grading, shift lights, N2O params, quick tune |
| `js/drag/drag-ai.js` | `CB.drag.ai` | AI driver (reaction / launch / shift quality by difficulty), rival ladder, elimination ladder |
| `js/drag/drag-session.js` | `CB.drag.session` | the run: two lanes, phases, fixed 1/120 s loop, events, results, headless `simulate` |
| `js/race/gl/drag-strip-mesh.js` | `CB.gl.dragStrip` | strip / street meshes: lanes, centre line, burnout box, beams, tree, timing boards, grandstands, return road, lights |
| `js/race/gl/drag-renderer.js` | `CB.drag.renderer` | 3D renderer: cars (CB.gl.car), cameras, smoke, flames, wheelie, chute, tree lights, boards |
| `js/drag/drag-hud.js` | `CB.drag.hud` | canvas HUD: tach + shift lights, launch gauge, tree, splits, lane progress, prompts, touch buttons |
| `js/drag/drag-sfx.js` | `CB.drag.sfx` | engine / shift bang / tree beeps (WebAudio, optional; may reuse `CB.race.audio`) |
| `js/drag/drag-ui.js` | `CB.drag.ui` | `#/drag` route: setup, play loop, input, pause, results / timeslip, ladder / tournament screens |

Load order (index.html, before `js/race/race-ui.js` is fine — drag never needs race-ui): `drag-strip → drag-tree →
drag-timing → drag-launch → drag-ai → drag-session → gl/drag-strip-mesh → gl/drag-renderer → drag-hud → drag-sfx →
drag-ui`.

## 1. Coordinates & strip

Sim metres: `x` down the strip (launch direction), `y` left, `z` up; heading 0 = +x. GL world = `[x, z, −y]` (as derby).
`CB.drag.strip.LANE_Y = 3.1` → lane 0 (left) at `y = +3.1`, lane 1 (right) at `y = −3.1`; painted centre line at `y = 0`,
guard walls at `y = ±7.6`. **Stage beam at `x = 0`** (the starting line), pre-stage beam at `x = −0.178` (7 in). A lane's
`xFront` = front tyre leading edge (car centre + `a` + tyre radius). Pre-staged when `xFront ≥ −0.178`; staged when
`xFront ≥ 0`; **deep** when `xFront ≥ 0.10` (pre-stage bulb goes out); the clock starts (and the RT is taken) when the tyre
clears the stage beam: `xFront ≥ ROLLOUT (0.29 m)`. Burnout box `x ∈ [−30, −14]`; cars start at `x = −22` (in the box).
Tree at `x = 6, y = 0`. Finish at `x = D` (distance); timing boards just past the finish on both outer sides; shutdown
to `D + 700`; return road at `y = −24`. Street venue: same coordinates, no beams (auto line-up at `x = 0`), flag start.

`DISTANCES` (`list`, `get(id)`):

| id | name | finish | splits (labels) |
|---|---|---|---|
| `eighth` | 1/8 mile | 201.168 m | 60 ft, 330 ft, 1/8 |
| `quarter` (default) | 1/4 mile | 402.336 m | 60 ft, 330 ft, 1/8, 1000 ft, 1/4 |
| `half` | 1/2 mile | 804.672 m | 60 ft, 330 ft, 1/8, 1/4, 1/2 |
| `km` | 1 km | 1000 m | 60 ft, 330 ft, 1/8, 1/4, 1000 m |
| `dig` | Dig 0–200 km/h | speed 55.56 m/s | 60 ft, 100 km/h, 160 km/h, 200 km/h |
| `roll` | Roll 60–200 km/h | rolling start 60 km/h, ends at 200 km/h | 100, 160, 200 km/h |

Split `{ id, label, m }` (distance) or `{ id, label, v }` (speed). Trap speed = average over the last 66 ft (20.117 m) before
the 1/8 and the finish (real ET-timer practice); speed races report the time at each speed.

`SURFACES`: `prepped` (VHT-prepped strip, grip ×1.10, burnout gain 1.0), `street` (×1.00, 0.8), `wet` (×0.62, wetness 0.7,
0.5). `VENUES`: `strip` (two-lane drag strip, tree, boards, grandstands), `street` (city road, flagger). Night option
(`night: true`): lights.

## 2. Tree (`CB.drag.tree`)

`create({ type 'pro'|'sportsman'|'flag', seed, handicap: [s0, s1] (bracket: the slower dial starts first) })`. Activated
when both lanes are staged (`arm(t)`), auto-start delay 0.6–1.4 s (seeded). Pro: all three ambers together, green **0.4 s**
later. Sportsman: ambers top→bottom 0.5 s apart, green 0.5 s after the third. Flag: the flagger raises arms ("ready"),
drops 1.0–2.4 s later (seeded) = green. Per lane `lights(t, lane) → { preStage, stage, amber: [b, b, b], green, red }`,
`greenT[lane]`. A car that clears the stage beam before its green → **red light** (RT < 0), the green on that side never
shows. `decide(laneA, laneB, { bracket, dial })` (pure, per lane `{ rt, et, red, dq, finished }`):
heads-up — a red light loses (both red: the first red loses), DQ loses, else the lower `rt + et` (the first to the finish)
wins; **holeshot** = winner had the slower ET but the better RT. Bracket — breakout (`et < dial`) loses unless both break out
(then the smaller breakout wins); else the lower `rt + (et − dial)` wins. Returns `{ winner, reason, margin_s, holeshot }`.

## 3. Timing (`CB.drag.timing`)

`createLane(distanceDef)` + `update(lt, t, xFront, v)` (interpolated beam crossings, trap windows, speed splits),
`lt.rt, lt.et, lt.trap (m/s), lt.splits [{ id, label, t, v }]`. `slipText(res, lane, opts)` → monospace timeslip text.
Records (`forge.drag.records.v1`): `records.load()`, `records.submit(carKey, distanceId, laneResult) → { pb, prev }`,
`records.best(carKey, distanceId)`. Ghost codes: `encodeGhost(run) → 'RLD1…'`, `decodeGhost(code) → run | null` with
`run = { v: 1, name, carName, modelId?, color, distanceId, rt, et, trap, trace: [x at 10 Hz from the green] }`.

## 4. Launch / shifting (`CB.drag.launch`)

* **Burnout**: `burnout.create()` → `{ temp °C (ambient 28), heat 0..1, overheated }`; `burnout.step(b, dt, { spinning,
  throttle, rpmFrac, powerFactor, gain })`; `burnout.bonus(b, surface) → grip multiplier delta` (ideal window 70–95 °C:
  up to +8 % prepped / +5 % street / +3 % wet; > 110 °C falls off, −6 % at 140 °C). Cools ~0.5 °C/s. Sets the vehicle's
  `tyreWarm` (slicks need heat).
* **Launch rpm**: held on the brake (`brake ≥ 0.5 && throttle > 0.05` while stopped → `input.hold`), the revs follow the
  throttle (digital keys: the rpm climbs while held and falls when released — feather in the band). On release the run
  uses a params copy with `launchRpm` = the held rpm (manual / DCT without launch control). `sweetSpot(params, env) →
  { lo, hi, best }` from short 60-ft sims across the rev range (cached per params / grip). Converter cars rev against the
  stall; EVs have no band (`ev: true`). Launch control (if the build has it and the assist is on) pins the 2-step.
* **Shift window**: `grade(rpm, gear, params, limiterT) → 'perfect'|'good'|'early'|'late'` against
  `params.upshiftRpm[gear−1]` (perfect within ±2.5 % of redline, good ±6 %, late also when bouncing the limiter > 0.15 s).
  `shiftLight(rpm, gear, params) → { level 0..1, flash }` (lights from optimal − 1800 rpm, flash in the window).
* **N2O**: `nitrousParams(params, shot_hp)` → params copy with the shot added from 2500 rpm (constant power, capped);
  armed only in the `pro-mod` class; 6 s bottle per run.
* **Quick tune**: `tuneBuild(build, { finalDrive, gearSpread })` → a new build (same Garage fields:
  `transmission.finalDrive`, `transmission.ratios`).

## 5. Session (`CB.drag.session`)

```js
var s = CB.drag.session.create({
  seed, distanceId 'quarter', venue 'strip'|'street', surface 'prepped'|'street'|'wet', night false, treeType 'pro',
  bracket false, class 'street'|'pro-mod',
  lanes: [entry, entry],            // index 0 = left lane
  playerLane 0, skipBurnout false
});
entry = { kind 'player'|'ai'|'ghost'|'remote'|'none', name, build, carName, color, modelId?, difficulty 'rookie'|'amateur'|'pro'|'alien',
          assists { autoShift, launchControl (bool, only if the build has it), tc 'car'|0|1|2|3, autoStage }, nitrous_hp 0,
          dial (s)|null, ghost (decoded run)|null };
s.update(dtReal, input)   // fixed 1/120 s steps (max 8 per call) ; input = { throttle, brake, shiftUp, shiftDown (edges), nitrous, analog? }
s.setLaneInput(lane, input); s.step(); s.snapshot(); s.results(); s.restart(); s.destroy();
CB.drag.session.simulate(cfg) -> results     // headless, every lane AI / ghost (tournaments, tests)
```

Phases: `burnout` (in the box; hold brake + throttle = burnout; drive forward to leave) → `staging` (creep: pre-stage /
stage; deep optional; autoStage assist) → `tree` (both staged, tree running) → `run` → `shutdown` (after the finish: lift,
brake, chute) → `done`. AI lanes do a 2–3.5 s burnout, auto-stage, react to the tree.

`snap = { t, phase, venue, night, surface, distance (def), treeType, bracket, tree { armed, lanes: [lights, lights], greenT: [t|null, t|null], flag 'ready'|'drop'|null },
lanes: [lane, lane], playerLane, winner (lane|null), decision, events: [...] }`

Snapshot lane: `{ lane, kind, name, carName, color, build, modelId, isPlayer, x, y, z, heading, pitch (nose up +), roll,
vx, speed, xFront, rpm, idle, redline, gear, maxGear, autoShift, throttle, brake, wheelspin 0..1, wheelOmega (rad/s, drive
wheels), smoke 0..1, burnout bool, tyreTemp, gripBonus, preStaged, staged, deep, red, rt, et, trap, splits [{ id, label, t,
v }], finished, finishT, dq, launch { held, rpm, lo, hi, best, ev, lc }, shiftLight { level, flash }, shiftRpm, lastShift
{ grade, gear, t }|null, limiter, boost, nitrous { armed, active, left_s, shot_hp }, chute 0..1, wheelie 0..1, dial,
gLong, layout 'rwd'|'fwd'|'awd' }`.

Events `{ type, lane, t, ... }`: `prestage`, `stage`, `deep`, `tree`, `amber`, `green`, `red`, `launch` {rpm, spin}, `bog`,
`wheelspin`, `shift` {gear, rpm, grade}, `bang` (backfire on shift / lift), `burnout-start`, `burnout-end` {temp},
`overheat`, `split` {id, t, v}, `finish` {et, trap}, `chute`, `win` {winner, reason, margin_s}.

Results: `{ distance, winner, reason, margin_s, holeshot, bracket, lanes: [{ name, carName, kind, rt, et, trap, splits,
red, dq, breakout, dial, won, shifts { perfect, good, early, late }, burnout { temp, bonus }, launch { rpm, lo, hi } }] }`.

## 6. AI (`CB.drag.ai`)

`createDriver({ difficulty, seed })` → `{ control(laneView, treeView, dt) → input }`. Reaction (from green, before the
rollout time) rookie 0.32 ± 0.08 s … alien 0.07 ± 0.03 s with a red-light chance (rookie 1 %, alien 3 %: alien leaves on
the amber), launch rpm error (rookie ±18 % of the band, alien ±3 %), shift rpm error (rookie ±9 % redline, alien ±2 %),
burnout length. `RIVALS` ladder (10 fictional street racers with stock cars, slow → fast), `ladder.load/save/beat`.
`tournament.create({ entrants, seed })` → 4/8-car single elimination bracket; AI-vs-AI heats via `session.simulate`.

Session extras (as built): `s.view(lane)` (AI / HUD view: `launchBand`, `optShift`, `greenT`, `rolloutT`, `clutchLocked`,
...), `s.ghostRun(lane)`, `s.phase()`, `s.time()`, and the network surface `setRemote(lane, st)`, `netState(lane)`,
`setTree({ startIn, greenIn })` (with `cfg.treeAuthority: 'remote'`), `treeRel()`, `setDecision(d)`. Lane kind `remote`
is a puppet posed from another machine's own simulation. Player input `{ throttle, brake, shiftUp, shiftDown, nitrous,
analog }`: held booleans for the shift buttons (edge-detected in the session); `analog: true` maps the throttle straight
to the held revs (pads, touch sliders, AI), keys without it make the revs climb while held and fall when released.
Holding the brake while stopped holds the car on the line (no auto-reverse select). A player approaching the beams is
speed-governed (creep ≤ ~1 m/s at the line); before the tree is armed a slow roll past deep stage is braked, after it
any roll-through is a red light. AI release timing uses `rolloutTime` (60-ft style launch sims at its staging depth).

## 7. Multiplayer (`js/net/netdrag.js`, `CB.net.drag`)

Lobby mode **Drag** (two racers: the host and the first guest; others watch; no AI; settings distance / venue /
surface / time of day / assists). Each side simulates only its own car in a `CB.drag.session` (lane 0 host, lane 1
guest); the other lane is a `remote` puppet from 20 Hz `nd.s` state packets (extrapolated by half the RTT). The host
arms the tree when both lanes report staged and sends the amber / green times relative to now (`nd.tree`, the guest
subtracts half the RTT); RT and red lights are measured on each driver's own machine against their own green. The
host decides from both lanes' RT / ET and broadcasts `nd.res`. Solo (no guest): lane 1 is an AI rival. The lobby opens
the run with `CB.drag.ui.openNet(session, cfg)`. Tests: `tests/net-drag.test.js` (loopback with latency / jitter / loss).

## 8. Measured (physics sanity, `node tools/drag-report.js`)

Stock-spec cars (CB.stock) on the street surface, no burnout, alien AI driver (RT ≈ 0.04, manual shifts at the optimal
point), 1/4 mile, the unmodified race vehicle model:

| Car | Real ET @ mph | Game ET @ mph | ET Δ | trap Δ |
|---|---|---|---|---|
| Tesla Model S Long Range (2021) | 11.2 @ 119 | 10.98 @ 120.5 | −2.0 % | +1.2 % |
| Bugatti Chiron | 9.4 @ 156 | 9.05 @ 162.9 | −3.8 % | +4.4 % |
| Porsche 911 Carrera S (992) | 11.3 @ 124 | 11.17 @ 125.8 | −1.2 % | +1.5 % |
| BMW M4 Competition (G82) | 11.7 @ 122 | 11.58 @ 121.6 | −1.0 % | −0.4 % |
| Honda Civic Type R (FL5) | 13.4 @ 108 | 12.93 @ 109.4 | −3.5 % | +1.3 % |
| Dodge Challenger SRT Hellcat | 11.8 @ 125 | 11.35 @ 127.0 | −3.8 % | +1.6 % |
| Chevrolet Camaro ZL1 (10AT) | 11.4 @ 127 | 11.22 @ 129.7 | −1.5 % | +2.1 % |
| Ford F-150 Raptor (gen 3) | 14.3 @ 97 | 13.85 @ 97.6 | −3.1 % | +0.6 % |
| Mercedes Sprinter 2.0 diesel | 18.3 @ 77 | 18.34 @ 77.6 | +0.2 % | +0.8 % |
| Nissan GT-R (R35) | 11.1 @ 124 | 10.78 @ 128.2 | −2.9 % | +3.4 % |
| Chevrolet Corvette C8 Z51 | 11.2 @ 123 | 10.84 @ 127.8 | −3.2 % | +3.9 % |
| Ford Mustang GT (S650, manual) | 12.4 @ 116 | 11.82 @ 118.1 | −4.7 % | +1.8 % |
| VW Golf GTI (Mk8) | 14.0 @ 101 | 13.69 @ 103.0 | −2.2 % | +1.9 % |

Mean |ET Δ| 2.5 % (3.5 % on the prepped strip with a burnout); every trap within 5 %. The sim is a little quick overall
(an ideal driver and an ideal 1-ft rollout vs magazine runs). The power delivery is the shared vehicle model's (the same
in every mode, `CB.physics` curve → `CB.race.vehicle` torque table): the Model S's motors fade above ~35 % of max motor
speed (field weakening at a sagging pack voltage, stock spec `mc`), and the Chiron's W16 is held to its 1,600 Nm ECU
torque ceiling so its power peaks near 6,500 rpm instead of a fat mid-range (boosted stock engines get
`engine.torqueLimit_nm` = the quoted peak torque). Before that fix the Model S trapped 135 mph (+13.6 %) and the Chiron
167.6 mph (+7.5 %).

## 9. UI, HUD, first person and the tutorial (`js/drag/drag-ui.js`, `drag-hud.js`, `drag-sfx.js`)

* **Route** `#/drag` (nav **Drag**, menu tile *Drag Racing*, accent `--mode-drag`). Deep link `#/drag?quick=1&car=<stockId>&dist=<id>&opp=<ladder|ai|solo|tournament|ghost>`.
  Settings `forge.drag.settings.v1`; tutorial flag `forge.drag.tutorial.v1`; ladder `forge.drag.ladder.v1`; PBs `forge.drag.records.v1`.
* **Setup**: car (Stock cars = Auto-config `CB.stock`, Presets, My Cars incl. the current Garage build), side card with
  hp / weight / drive / gearbox / tyres / 0–100 plus a headless **predicted ET + trap and 60-ft estimate** (`session.simulate`,
  alien AI, auto-shift) and your PB; opponent (rival ladder with avatar cards, quick AI race, 4/8-car tournament, friend's
  ghost code, solo pass, **practice**: no opponent + slow-motion tree + coach tips); distance cards with a strip graphic; venue,
  tree, surface, night; bracket + dial-in; class + N2O; assists (manual / auto shift, launch control when the build has it,
  TC as built / off / 1–3, auto-stage, deep stage, skip burnout); quick tune (final drive, gear spread — a drag-only copy via
  `CB.drag.launch.tuneBuild`, the Garage build is untouched); camera / units / graphics / sound / touch / fps.
* **Camera `auto` by default** (`camera: 'auto'`, older saves migrate once via `camV`): a third-person chase cam while
  lining up (burnout, pre-stage / stage beams, the tree), then a ~0.4 s blend (`setCamera(m, { blend })`) into the first-person
  cockpit on the player's green (or when the car leaves: a red light), held through the finish (`CB.drag.ui._.stageCamera`,
  `createCamState`). C during a run overrides it for that run only; every run / heat stages in the chase cam again. A fixed
  camera setting is used as is. First person: `CB.gl.cockpit` interior
  (wheel + hands, A-pillars, mirrors, cluster with tach and gear), the tree in the windscreen, head pitch-back on launch /
  forward on braking (longG × 2.4 into the cockpit head model), shake on launch / shifts / bangs (renderer), FOV
  stretch with speed + launch kick. The HUD goes minimal: a dash-mounted shift-light bar, gear + rpm while staging, the
  live ET / speed counter; the launch-rpm and tyre gauges move off the cluster (lower left over the door; upper left on
  touch, `CB.drag.hud.fpGauges`); the big tach and the HUD tree return in the other cameras (C cycles chase, low, side, bumper).
* **Drag dash** (`CB.drag.renderer._.dragDash(lane, snap, oppLane)` → `cockpit.update(v)` as `v.drag`): when `v.drag` is
  set, `CB.gl.cockpit` draws drag readouts instead of the race ones (race sessions never pass it, so the race cluster is
  unchanged). Cluster (`drawDragCluster`): big 270° tach with the redline zone, the green launch-rpm band on the outer
  ring while staging, a 14-LED shift-light bar across the side panels (blue flash in the shift window), huge gear in the
  hub; left panel = PRE / STAGE lamps, the tree (3 ambers, green, red) and a status (ROLL IN / PRE-STAGED / STAGED /
  WATCH TREE / GO! / RED LIGHT) while staging, then the live ELAPSED timer (t − green − RT) + R/T, then the final ET;
  right panel = launch band / 2-STEP / EV + rpm while staging, speed on the run, TRAP + WIN / LOSS / DONE after it.
  Every readout sits in the band the binnacle hood and wheel hub leave visible (~0.3–0.95 of the panel height). The
  centre screen becomes a live timeslip (`drawDragScreen`: R/T, splits, ET for both lanes, trap, result); the windscreen
  HUD and race-wheel display show the ET in place of the race position.
* **Mirrors**: the interior mirror (and the door mirrors, which sample its left / right halves) shows a live rear view:
  `mirrorPlan(quality, { cockpit, fbo, aspect })` → high / ultra 256 / 320 px wide every frame, medium 192 px every 2nd
  frame, height from the glass aspect (256×72 on most cars); low tier, or when render targets fail, a static dark-tint
  texture. The pass draws the strip, the timing boards and the other car (no particles, cockpit or own car) from a
  camera on the glass along the reflected eye ray (`mirrorView`) with a horizontally flipped projection, into one of two
  render targets (the cockpit samples the previous result, as in renderer3d). `renderer.setMirror(bool)`,
  `mirrorState()`, `stats().mirror` ('live' | 'fallback' | 'off') / `mirrorMs`. Measured (headless Chrome, Apple GPU,
  60 synced frames): ~0.4–0.6 ms / frame on high, ~0.4 ms on medium (every other frame), 0 on low; fps unchanged
  (vsync 60 desktop, ~48–49 in the 4× CPU-throttled phone profile before and after). Race / F1 cockpits already had
  live mirrors (renderer3d's own mirror pass) and are untouched.
* **HUD**: tach + 12-LED shift lights (flash in the perfect window), launch-rpm gauge with the green band, tyre-heat meter,
  the tree (bulbs pop + glow as they light; flagger on the street), live splits for both lanes, lane race bar with the gap,
  live ET + speed counter, reaction readout on launch ("0.012 — PERFECT!" / GREAT / GOOD / OK / SLOW), PERFECT SHIFT /
  GOOD / EARLY / LATE pop-ups, split ticker sliding in at 60 ft / 330 ft / 1/8 / 1000 ft / finish, prompts per phase,
  WIN / LOSS banner with the margin; the UI slows time to 0.3× for ~1.3 s at the finish line.
* **Tutorial** (offered on the first Race press, replayable from setup "How to drag race", Skip any time): a practice pass
  with a coach card (`X.COACH`, pure `X.coachNext`): intro (press brake) → burnout (tyre meter highlighted) → roll to
  pre-stage → stage → revs in the band → watch the ambers / release on green → shift at the top (skipped with auto-shift) →
  finish → done. The HUD element of each step pulses; key hints follow the last device (keys, pad, touch, hub). A red
  light shows "You left 0.123 s before the green" with Try again. Practice and tutorial runs use a Sportsman tree at
  0.45× speed. Results carry **coach's notes** (`X.tipsFor`: red light by how much, slow light, bog → rev higher,
  wheelspin → fewer revs / longer burnout, cold or overheated tyres, early / late shifts).
* **Results**: the timeslip prints out of a slot (CSS) with a tear-off edge; reaction / 60 ft / launch rpm vs band / tyre
  temp / shift grades; payout (pass, win by difficulty, holeshot, perfect light, money shifts, PB, rival beaten, tournament);
  copy slip text, slip PNG, share ghost code; next rival / rematch / bracket.
* **Input**: W/↑ throttle, S/↓ brake (hold both to rev on the line or burn out), E / Space / → shift up, Q / ← down,
  N nitrous, C camera, R restart, Esc pause, M mute, Enter continue. Pad RT / LT, A / RB up, X / LB down, B nitrous,
  Y camera, Start pause. Touch: BRAKE / THROTTLE pads (analog by height), SHIFT ▲ / ▼, N2O, camera, pause (≥ 44 px, safe
  areas). Phone wheel ITEM = shift up, NITRO = nitrous. Hub sources (phone wheel, webcam fist, mouse, tilt) get a
  line-lock assist: staged, the brake is held and the revs sit in the band; a fresh full fist / full throttle releases.
* Test hooks `window.drag = { start(o), state(), setInput(o), step(n), settings(), setup(), bracket(), session(), ghostCode() }`.
  `CB.drag.ui.openNet(session, cfg)` runs the play loop on a lobby session (`js/net/netdrag.js`).

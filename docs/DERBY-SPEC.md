# DERBY-SPEC — Redline Demolition Derby mode

Demolition Derby is a **top-level game mode** (`#/derby`, nav item "Derby", main-menu tile) next to Race, Drift and
Arcade. Pick one of the 22 preset cars (or a My Cars build), bolt on accessories, and smash 3–11 aggressive AI cars in
one of six themed arenas. Damage is per zone and changes how the car drives. Last car standing wins.

It is fully separate from the circuit engine: its own deterministic rigid-body sim (`js/derby/*`), its own WebGL
renderer (`js/race/gl/derby-*.js`) and its own UI (`js/derby/derby-ui.js`). Shared files only get tiny additive hooks
(router route + nav item, index.html script tags + screen section, hub menu tile, achievements).

## 0. Files and owners

| file | what |
|---|---|
| `js/derby/derby-arenas.js` | `CB.derby.arenas` — 6 arena definitions (pure data) + `compile(def)` geometry helpers |
| `js/derby/derby-physics.js` | `CB.derby.physics` — 2.5D rigid-body car model, car–car / car–wall / car–obstacle contacts, floors, ramps |
| `js/derby/derby-damage.js` | `CB.derby.damage` — zone damage model, impact attribution, handling effects, fire / stall / elimination |
| `js/derby/derby-accessories.js` | `CB.derby.accessories` — accessory defs, loadout validation, runtime behaviour |
| `js/derby/derby-ai.js` | `CB.derby.ai` — aggressive derby AI |
| `js/derby/derby-session.js` | `CB.derby.session` — the match: grid, countdown, fixed-step loop, rules, events, results, save/restore |
| `js/race/gl/derby-parts.js` | `CB.gl.derbyParts` — accessory meshes (shared by renderer + setup preview) |
| `js/race/gl/derby-arena-mesh.js` | `CB.gl.derbyArena` — arena meshes (ground, walls, obstacles, scenery, crowd, lights) |
| `js/race/gl/derby-renderer.js` | `CB.derby.renderer` — 3D renderer: cars + per-car mesh deformation, FX, cameras, preview |
| `js/derby/derby-hud.js` | `CB.derby.hud` — canvas HUD (damage diagram, health, accessory charges, kill feed, minimap, banners) |
| `js/derby/derby-sfx.js` | `CB.derby.sfx` — WebAudio crash / scrape / flame / engine sounds (synthesised, no assets) |
| `js/derby/derby-ui.js` | `CB.derby.ui` — `#/derby` route: setup, loadout garage, play loop, input, touch, pause, results |

Load order (index.html, after the arcade pack and before `js/race/race-ui.js` is fine — derby never needs race-ui):
`derby-arenas → derby-physics → derby-damage → derby-accessories → derby-ai → derby-session → gl/derby-parts →
gl/derby-arena-mesh → gl/derby-renderer → derby-hud → derby-sfx → derby-ui`. All `js/derby/*` except `derby-ui.js`
are pure logic and load in Node (tests).

## 1. Coordinates

* Sim: metres, `x` east, `y` north, `z` up. `heading` rad CCW from +x. Car forward `f = (cos h, sin h)`, left
  `l = (−sin h, cos h)`. Car-local sim frame: `lx` forward, `ly` left, `lz` up.
* GL world = `[x, z, −y]` (same as the stunt renderer). GL car-local: `+X` forward, `+Y` up, `+Z` right
  (so GL `Z = −ly`).
* Steering input `steer` −1..1, **+1 = left**. Throttle / brake 0..1.

## 2. Arena definition (`CB.derby.arenas`)

```js
CB.derby.arenas.list()  -> [def...]          get(id) -> def|null      ids() -> [...]
def = {
  id, name, tagline, desc, theme, difficulty 1..5, timeOfDay 'day'|'dusk'|'night', weather 'dry'|'wet'|'snow',
  surface: { grip, rolling, color '#rrggbb', kind 'dirt'|'mud'|'concrete'|'ice'|'asphalt'|'sand' },
  bounds: { minX, minY, maxX, maxY },                     // for minimap / camera
  boundary: { type: 'ellipse', rx, ry } | { type: 'roundrect', hw, hh, r } | { type: 'poly', pts: [[x,y],...] }
            // closed CCW outline of the drivable area. Poly edges can be flagged open: boundary.open = [edgeIndex...]
            // (no wall: a car that crosses it falls off -> eliminated, rooftop arena)
  wall: { height, style 'concrete'|'tyres'|'scrap'|'barrier'|'glass'|'stone', restitution, friction },
  obstacles: [ { id, type: 'circle', x, y, r, h, kind 'tyres'|'pillar'|'barrel'|'post'|'statue' }
             | { id, type: 'box', x, y, hw, hh, rot, h, kind 'container'|'scrap'|'block'|'car-pile'|'crusher'|'barrier' } ],
  ramps:   [ { id, x, y, hw, hh, rot, h, kind 'kicker'|'deck' } ],  // height rises 0 -> h along local +x (rot = its heading)
  floors:  [ { id, poly: [[x,y]...], z } ],               // optional raised flat decks (rooftop upper level); drivable
  hazards: [ { id, type: 'crusher', x, y, hw, hh, rot, period, dmg }        // closes periodically: big damage inside
           | { id, type: 'mud'|'ice'|'oil', x, y, r, grip, drag }            // grip / drag patch
           | { id, type: 'fire', x, y, r, dps }                              // burning barrel pit: damage + ignites
           | { id, type: 'pit', x, y, r } ],                                 // hole: fall -> eliminated
  spawns:  [ { x, y, heading } x 12 ],                    // index 0 = player
  decor:   { ... }                                        // cosmetic only (renderer): stands, lights, flags, crowd, props
  camera?: { height, dist }                                // optional chase tweak
}
```

Six arenas: `mud-bowl`, `figure-8`, `junkyard`, `ice-rink`, `rooftop`, `colosseum`.

## 3. Car state (session internal; JSON-serialisable except `build`)

```js
car = {
  id, idx, name, isPlayer, team|null, presetId, color, accent, number, build (object, not serialised),
  spec: { mass, Iz, length, width, height, wheelbase, a, b, cgH, track, powerKw, drive 'rwd'|'fwd'|'awd',
          enginePos 'front'|'mid'|'rear', topSpeed (m/s, derby cap), driveForce (N), brakeForce (N), grip (mu),
          steerLock (rad), baseMass (before accessories) },
  x, y, z, heading, vx, vy, vz, w /*yaw rate*/, pitch, roll, pitchV, rollV, airborne, flipped, steer, throttle, brake, gear (+1|−1),
  dmg: see §5,
  alive, out /*eliminated*/, elimReason 'wrecked'|'engine'|'immobile'|'fell'|'fire'|'time', elimT, immobileT, flippedT,
  acc: [ { id, slot, charge 0..1, ammo, cooldown, active, t, ... } ], shieldT, boostT,
  stats: { dealt, taken, hits, bigHits, kills, tbones, rams, wallHits, flameDmg, maxImpact, airTime, survived_s },
  lastHitBy, lastHitT, lives,
  input: last applied input
}
```

## 4. Physics (`CB.derby.physics`)

Fixed step `DT = 1/120`. Axle tyres as impulse-style lateral friction (kills axle slip up to `μ·N`, per-corner grip
multipliers from damage), drive from the derby accel envelope `accel = 6.2 … 10.8 m/s²` (fun pass; power-to-weight, AWD ×1.05,
accessory mass × `(m0/m)^0.6`) fading to the top speed (`30 … 44 m/s`), traction-capped at `1.9 × μ·N_drive ×
arena.surface.traction` (optional, default 1; the ice rink's studded tyres 1.9). **Arcade friction circle**: full
throttle costs at most 40 % of an axle's lateral grip (no power-donuts at full lock; the handbrake swings the tail:
rear grip ×0.42). Braking, reverse (brake held at < 0.8 m/s = reverse gear, ×0.85 drive, ≤ 36 % of top speed),
rolling + aero + mud drag. Measured (muscle car, dirt): 0→80 km/h in < 3.6 s (tests). `mods.push` (m/s², ram boost /
rockets) is a forward shove not limited by traction. **Moving ground**: when `surfaceAt` reports `carry {vx, vy}`
(turntables / conveyors from `arenas.hazardAt`), all tyre forces work on the velocity *relative to the surface* and the
yaw damping on the yaw rate relative to it (the platform's yaw rate is derived from the carry at the two axles), so a
parked car rides and turns with a turntable and cars get flung into each other. Vertical: floors / ramps height field, gravity, airborne ballistic flight, pitch / roll with spring recovery
(roll / pitch kept within ±2π), landing with |roll| > 100° → `flipped` (auto-righting after 1.5 s for 6 % health, or R
after 0.5 s; any car). Angles are wrapped in O(1) (huge / non-finite angles cannot stall the step).

Contacts each step:
* **car–car**: OBB vs OBB (SAT), contact point = deepest vertex, normal from the separating axis. Impulse
  `j = −(1+e)·vrel·n / (1/m1 + 1/m2 + (r1×n)²/I1 + (r2×n)²/I2)` with `e = 0.18…0.3` and Coulomb friction 0.35; positional
  correction 80 %. Momentum is conserved exactly (tests). Swept: each step moves ≤ 0.5 m at 60 m/s, cars ≥ 1.6 m wide.
* **car–wall** (boundary) and **car–obstacle**: the 4 corners + 4 edge midpoints are tested against the boundary /
  obstacle signed distance; impulse against infinite mass (`e` = wall restitution); a CCD clamp on the centre (previous
  → current segment vs boundary) prevents tunnelling at any speed.
* Each contact produces `contact = { a, b|null, px, py, nx, ny /*from a to b*/, vn /*closing speed m/s*/, vt, j /*N·s*/,
  energy /*J, ½·μ·vn²*/, kind 'car'|'wall'|'obstacle' }` handed to the damage model and accessories.

API: `physics.createBody(car, pose)`, `physics.drive(world, car, input, mods, dt)`, `physics.collideCars(a, b, opts)`,
`physics.collideArena(world, car)`, `physics.surfaceAt(arena, x, y, t)` → `{ z, floor: bool, grip, drag, kind, open, pit,
crush, dps, ignite }`, `physics.raycast(world, x, y, dx, dy, maxDist, ignoreId, z?)` → `{ dist, kind
'wall'|'edge'|'obstacle'|'pit'|'crusher'|'car', id, step? }` (with `z` it also reports raised deck / ramp sides the car
cannot climb as `wall` + `step: true`), `physics.edgeInfo(arena, x, y)` → `{ dist, nx, ny, open }`, `physics.corners(car)`.
Verified (tests/derby-physics.test.js): linear momentum exact and angular momentum about the contact point conserved,
`vn' = e·vn` without friction, kinetic energy never grows; 60 m/s (+nitro) into every wall / obstacle of every arena
from 24 directions and into parked cars at any angle: no tunnelling, no NaNs.

## 5. Damage model (`CB.derby.damage`)

```js
car.dmg = {
  health 1..0,                         // overall pool; 0 = wrecked (eliminated)
  zones: { front, rear, left, right }, // 0 = pristine .. 1 = destroyed
  wheels: [fl, fr, rl, rr],            // 0..1; ≥ 0.45 bent (pull + vibration), ≥ 0.75 punctured (grip, drag), 1 = lost
  wheelLost: [b, b, b, b], punct: [b, b, b, b],
  engine: { hp 1..0, temp 0..1, fire 0..1, stalled bool, smoke 0..1, black 0..1 },
  fuelLeak 0..1, onFire 0..1 (body fire from flamethrower / fuel), burnT,
  parts: { bumperF, bumperR, hood, trunk, doorL, doorR, lightFL, lightFR, lightRL, lightRR } (true = detached / broken),
  dents: [ { x, y, z, nx, ny, nz, depth, r } ],  dentSeq   // car-local sim frame, inward push; ≤ 48 (merged)
}
```

* **Zone attribution**: the contact point in car-local frame → zone by the normalised position on the car's outline
  (`|lx|/(L/2)` vs `|ly|/(W/2)`, corners shared between the adjacent zones and the nearest wheel).
* **Impact energy → damage**: below 2.2 m/s closing speed nothing; car–car `pts = ½·(vn² − 2.2²)·share² / K`
  (`share` = the other car's mass fraction, `K` = 124), walls `½·(vn² − 2.2²)·0.2 / K` × 0.68 (soft tyres / islands ×0.45).
  Zone increment `pts·weight / toughness` (front 1.0, rear 1.05, sides 0.75 — sides are weakest). **Fun pass health**:
  `HEALTH_PER_PT` 0.155·pts (+0.3 × overflow past a destroyed zone), × a convex speed curve `clamp((vn/13)^1.35, 0.3, 1.9)`
  (bumps barely count, a 70 km/h T-bone is decisive), soft-capped per impact (above 0.09 compressed ×0.35, max 0.18),
  × `IMPACT_SCALE` 0.75 — cars crumple visibly long before they die (≈ 12–32 solid hits; zones reach 1.0 mid-match).
  Direct zone damage (`addZone`: flame, hammer, saws, crusher, ring, idle burn) uses `ZONE_HPP` 0.26 health per point,
  wheels 0.075; body / engine fire ticks 0.008 + 0.01·fire and 0.004 + 0.006·fire per s.
  × accessory modifiers (bull-bar, ram, armour, spikes, shield), the armor pickup (×0.5), ram boost (dealt ×1.4), difficulty and
  the attacker bonus: the **attacker** (the car whose own velocity along the normal was larger) takes ×0.62, the victim
  ×1.1, and the attacker is credited with the victim's damage.
* **Sudden death — ring of fire** (session, §12): from 75 s of fighting (`rules.suddenDeathAt`), or earlier after a lull.
  Disable with `rules.suddenDeath: false`.
* **Limp floor** (fun pass): until a car is eliminated, damage never takes it below 38 % power, 60 % steering lock, 58 %
  top speed and 0.3 corner grip (`damage.LIMP`); a lost wheel limps (grip 0.3, drag 0.32) instead of stopping the car. A
  stalled engine has no drive and is eliminated within 2.5 s (`engine`).
* **Effects on driving** (`damage.effects(car) → mods`): `powerMult`, `topMult`, `gripMult[4]` per corner, `steerPull`
  (rad bias toward the damaged side), `steerLockMult`, `wobble` (rad amplitude of oscillation), `dragAdd`, `vibration`
  0..1 (HUD / camera / phone haptics), `brakeMult`.
  * front (or the engine zone: rear for rear-/mid-engined cars) → radiator / engine: power loss, overheating
    (`temp` rises above 50 % damage, fire at 100 %), stall at engine hp 0;
  * rear → fuel tank (leak → fire risk) + drive axle for RWD (drive force ×(1 − 0.6·rear)), FWD barely;
  * left / right → suspension / steering: steering pull toward that side, reduced lock, wobble;
  * each wheel → bent (pull + vibration + drag), punctured (corner grip ×0.55, drag), lost (corner grip ×0.2, big drag,
    the car sits on that corner: visual tilt).
* **Elimination**: health ≤ 0 (`wrecked`), engine stalled for 2.5 s (`engine`), immobile (< 1 m/s while trying) for
  10 s (`immobile`, now practically unreachable: wedged cars get an unstick push first), fell off the arena / into a pit
  (`fell`). Eliminated cars stay as wrecks (they roll freely — pushable shells) and smoke. Last car (or team) standing wins; time limit → most health wins.

## 6. Accessories (`CB.derby.accessories`)

Budget **12 points**, slots `front` 1, `rear` 1, `roof` 1, `side` 1, `util` 2; at most **2 active** accessories (mapped
to ACTION 1 / ACTION 2 in loadout order). Each adds mass (handling changes) and has visuals.

| id | slot | pts | kind | effect |
|---|---|---|---|---|
| `flamethrower` | roof | 4 | active (hold) | 10 m · 26° cone ahead: 18 health %/s split over zones in the cone, sets targets on fire; 6 s fuel, refills 0.12/s |
| `ramp` | front | 3 | passive | wedge: head-on hits launch the other car (vz + a random, speed-scaled roll kick: ~12 % of launches in matches end on the roof, more for fast head-ons), front damage taken ×0.8 |
| `hammer` | side | 3 | active (press) | hydraulic hammer swings to the side of the nearest car within 5.5 m: big lateral impulse + damage, 2.2 s cooldown |
| `bullbar` | front | 2 | passive | spiked bull-bar: front damage dealt ×1.45, front taken ×0.7, punctures tyres it hits |
| `ram` | front | 3 | passive | battering ram: +1.2 m reach, front impulse ×1.3, dealt ×1.6, taken ×0.6, +140 kg |
| `armour` | util | 3 | passive | armour plating: all damage taken ×0.65, +220 kg |
| `nitro` | util | 2 | active (hold) | +65 % drive, +20 % top speed and a rocket thrust (3.2 m/s², beyond tyre traction), rams while boosting deal ×1.3; 4 s tank, refills 0.15/s |
| `caltrops` | rear | 2 | active (press) | drops a 3.2 m caltrop patch (25 s): a car rolling over it gets 1–4 tyres punctured (wheel +0.8); 4 drops |
| `oil` | rear | 1 | active (press) | drops an oil slick (grip ×0.18, 9 s): spins chasers; 3 drops |
| `magnet` | roof | 3 | active (press) | electro-magnet: pulls the nearest car within 22 m toward you for 2.2 s, 9 s cooldown |
| `wrecking-ball` | rear | 4 | passive | 260 kg ball on a 4.5 m chain (rolling pendulum, inelastic rope): whip it into cars by turning hard; damage by ball speed (> 4 m/s) |
| `saws` | side | 2 | passive | wheel saw blades: side-by-side contacts grind (damage over time to the other's side + tyres) |
| `shield` | util | 3 | active (press) | 2.5 s force field: no damage taken, impacts repel; 14 s cooldown |
| `repair` | util | 2 | active (press) | one-time field repair: +35 % health, zones −40 %, puts out fires, re-inflates tyres |
| `spikes` | rear | 2 | passive | rear spike plough: rear damage dealt ×1.5, rear taken ×0.75 (reverse-ramming build) |

`validate(ids) → { ok, points, budget, errors[], actives[] }`, `create(car, ids)`, `step(world, car, input, dt)`,
`modifiers(car, zone, role 'dealt'|'taken')`, `onContact(world, car, other, contact)`, `entities(world)`,
`describe(id)`, `PRESETS` (suggested loadouts: Brawler, Pyro, Tank, Trickster, Juggernaut).

## 7. Session (`CB.derby.session`)

```js
var s = CB.derby.session.create({
  arenaId, seed, difficulty 'rookie'|'amateur'|'pro'|'alien', opponents 3..11,
  rules: { timeLimit_s 0|120|180|300, lives 1..3, teams false, suddenDeath true, suddenDeathAt 75, idlePenalty true },
  pickups?: true,      // false: no arena pickups (CB.derby.pickups is feature-detected)
  player: { build, presetId, name, color, accessories: [ids] },
  ai?: [{ presetId, build, name, color, accessories }]   // optional explicit grid; default picks presets + loadouts by seed
  playerAutopilot?: false, countdown_s?: 3,
  aiDisabled?: false   // tests: AI cars use car.scriptInput (or idle) instead of their brains
});
s.update(dtReal, input)    // accumulates fixed 1/120 s steps (max 8 per call); input = {throttle, brake, steer (+1 left), handbrake, action1, action2, boost (held: ram boost), reset}
s.step(input)              // exactly one fixed step
s.snapshot() -> snap       // render / HUD view, events drained
s.results() -> res
s.getState() / s.setState(st)   // JSON round trip; same inputs afterwards reproduce the run bit-exactly
s.restart(); s.destroy(); s.setPlayerAutopilot(on); s.spectateTargets() -> [ids alive]
```

`snap = { t, phase 'countdown'|'fight'|'over', countdown_s, timeLeft_s|null, arenaId, arena (def), playerId, aliveCount,
total, winnerId, endReason 'last-standing'|'time'|null, slowmo 0..1 (hint), suddenDeath {on, t, level 0..1, safeScale 1→0.5,
ringFire, mult, startsIn, start} (§12), damageMult (the sudden-death damage multiplier), cars: [...],
events: [...], entities: [...], feed: [...] }`

Snapshot car: `{ id, idx, name, isPlayer, number, color, accent, build, presetId, x, y, z, heading, pitch, roll, vx, vy,
speed, vSigned, steer, throttle, brake, airborne, flipped, alive, out, elimReason, health, zones, wheels, wheelLost, punct,
engine {temp, fire, stalled, smoke, black}, onFire, parts, dents, dentSeq, acc: [{id, slot, active, charge, ammo,
cooldown, ready, swing?, side?, ball?: {x, y, z}}], shield (s left), boosting (nitro or ram boost), ram {charge 0..1, active},
idle (camping flag), combo (current hit streak, 0 after 3 s), score, armorT (armor pickup s left), bomb (sticky bomb armed),
ringOut (outside the sudden-death ring), stats, lives, team, target (AI target id) }`.

Events: `{ id, t, type, carId, otherId?, x, y, z, nx?, ny?, energy?, zone?, big?, text? }` with types
`impact` (car–car), `wall`, `scrape`, `eliminated`, `fire`, `explode`, `part-off` (`part`), `wheel-off` (`wheel` 0..3),
`puncture`, `flame`, `hammer`, `launch`, `oil`, `caltrops`, `magnet`, `shield`, `repair`, `nitro`, `stall`, `flip`,
`countdown`, `go`, `win`, `sudden-death`, `land`, `unflip`, `respawn`, `hammer-swing`, and (fun pass) `score` {carId, otherId,
label, points, combo}, `ram-boost`, `unstick` {forced}, `idle`, `kick` {hazard}, `ring`, `pickup` (from CB.derby.pickups),
`explode` {bomb: true}. Impact events also carry `kind` 'tbone'|'headon'|'rear'|'reverse'|'sideswipe'|'hit' and `boost`.
Feed lines: `{ t, text, kind 'kill'|'hit'|'info'|'taunt', carId, otherId }` (e.g. "You T-boned DVO!", `DOZER: “Felt that one?”`).

Entities: `{ id, type 'oil'|'caltrops'|'ball'|'debris', x, y, z, r, heading, life, owner }` (balls also `ax, ay, az`: the chain
anchor), plus pickups `{ id, type: 'pickup', kind 'repair'|'boost'|'ammo'|'armor'|'bomb', x, y, z, active, respawn }`.

Results rows add `score`, `coins` (= score / 20) and `stats.launches, sandwiches, revenge, boostHits, bestCombo, pickups`;
`mvpId` is the top scorer.

## 8. AI (`CB.derby.ai`)

`ai.create(car, { difficulty, rng }) → brain`; `brain.think(world, car, dt) → input`; `brain.serialize() / restore(o)`
(includes the seeded rng state, so `session.getState/setState` stays bit-exact). A mode machine re-evaluated at the
driver's reaction time (rookie 0.42 s … alien 0.12 s), steering every step:

* **Target selection**: −distance, + weakness (1 − health)·24, + revenge 20 (hit by it < 5 s ago), + player bias
  (difficulty, 0.2 … 0.4 × 42; +34 more when nobody is within 25 m of the player), + hysteresis 14, + we are at its flank 9,
  + flipped / stalled 8, + leader 6, **+ camping (idle) 34, + slow / wedged 6**, − 10 per extra hunter beyond 2 (two or
  three on one car is fine, seven is a conga line), − 25 for a car on the other deck level, deterministic spread;
  re-picked every 1.4–2.8 s and 0.8–1.6 s after each hit (fresh targets).
* **hunt** → drive at an intercept point (lead ∝ distance / closing speed), curving in toward the target's flank when we
  are ahead of its nose (offset shrinks to 0 up close → T-bones); **charge** when lined up (|err| < 0.5 rad, 5–50 m): full
  throttle + nitro + **ram boost** (lined up within 0.22 rad, 6–34 m), committed until contact, or 0.9 s of grinding
  against the target at < 4.5 m/s → back off; **backoff** after a hit: reverse with the nose kept on the target until a
  9–13 m run-up (the Wreckfest rhythm) → charge again; **reposition** when the target is close behind / beside, or behind
  within 28 m: reverse while swinging round (until lined up or > 32 m); **handbrake U-turns** in hunt for big direction
  changes at 4–15 m/s; **ambush**: two AIs hunting each other for 6 s without contact (round a deck / island) — the
  junior one stops nose-on and charges when the other is within 18 m; pickups: repair when < 50 % health (≤ 45 m), boost
  when the ram meter is < 50 %, ammo / armor / bomb when no target is close, give up after 4 s (banned 8 s), no detours
  with ≤ 3 cars left; inside the sudden-death ring it drives back in (boosting); **reverse** (front-engined car with a wrecked nose and
  a healthy tail, clear line): back into the target, drive out for a run-up after each hit; **recover** when stuck
  (moved < 0.8 m in ~1.2 s while slow and pushing): go the other way with lock that swings the nose to the target.
* Corner-speed control: brakes when the radius needed to reach the aim point is tighter than the tyres allow at the
  current speed (√(0.85·g·μ·R)); slick surfaces brake earlier.
* Navigation: detours round big obstacles (islands, containers, the statue) and — from the lower level — the rooftop
  deck and its ramp sides (shortest inflated corner); goes to a deck ramp entry to reach a target on the upper deck.
* Overlays: raycast wall / obstacle avoidance (not when pinning the target against the wall), lethal-edge / pit /
  crusher (when about to close) / brazier avoidance with an escape hysteresis on open edges, flank protection (turns the
  nose toward a fast car heading for its crumpled side), accessories (flame when anyone is in the cone, hammer when a
  car is alongside, nitro on aligned runs, magnet at 7–20 m, shield vs an incoming car < 8 m, repair < 32 % health,
  oil / caltrops when chased).
* Measured: see §12 (`tools/derby-play.js` with player-like bots; `tools/derby-sim.js` with the autopilot player).
  12 cars: 22–27 ms CPU per simulated second on the junkyard (the heaviest arena), incl. 60 Hz snapshots.

## 9. Renderer (`CB.derby.renderer`)

`create(canvas, session, { quality, camera }) → { render(snap, alpha), setCamera(m), cycleCamera(), getCamera(),
cameraModes(), setFollow(id), setLookBack(b), shake(amount), resize(), setQuality(q), getQuality(), stats(), destroy(),
worldToScreen(x, y, z), is3D: true }`. Cars use `CB.gl.car.build` models with per-car vertex deformation from
`car.dents` (CPU positions, re-uploaded per new dent), scorch tint, detached parts (debris), lost wheels, broken lights,
smoke (white → black), fire, sparks, flame cones, hammer arm swing, wrecking-ball chain, magnet beam, shield bubble,
nitro flames. `createPreview(canvas, { build, color, accessories }) → { update(opts), destroy() }` for the setup garage.

## 10. UI (`CB.derby.ui`), controls

Setup: car (preset gallery + My Cars), arena cards, opponents 3–11, difficulty, rules (time limit, lives), loadout
garage (slots + points + 3D preview), graphics quality. HUD: health bar, car damage diagram, accessory charges /
cooldowns, opponents remaining, kill feed, minimap, elimination / win banners, spectate. Results: placing, damage
dealt / taken, hits, eliminations, MVP.

Keys: W/↑ throttle · S/↓ brake / reverse · A D / ← → steer · Space handbrake · **F / J = ACTION 1** · **G / K = ACTION 2**
· R flip / unstick · C camera · B look back · Esc pause · M mute. Gamepad: RT / LT, stick, A handbrake, X action 1,
B action 2, Y camera, Start pause. Touch: steering pad + pedals + ACTION buttons (≥ 44 px, safe areas). Phone wheel:
ITEM = action 1, NITRO (hold) = action 2 (via the arcade wheel protocol).

## 11. Determinism & multiplayer notes

Fixed 1/120 s steps, seeded mulberry32 (`state.rng`), no `Math.random` in `js/derby/*` except cosmetic FX in the
renderer, stable entity / event ids. `getState()` is plain JSON; `setState` + the same input stream reproduces the run
bit-exactly (tests). A host-authoritative lobby can run the session on the host, forward client inputs
(`{throttle, brake, steer, handbrake, action1, action2}` per tick, like netarcade) and send `snapshot()` deltas. Not
implemented yet.

## 12. Fun pass — anti-stalemate, ram boost, sudden death, scoring (session `CB.derby.session`)

* **Ram boost** (every car, `input.boost` held): `car.ram {charge 0..1, active}`. While active (needs > 12 % to start):
  accel ×1.8, top ×1.25, a 3.2 m/s² forward shove (`mods.push`, not traction limited; works at ≥ 70 % power even with a
  wrecked engine), drains 0.55/s; refills 0.2/s when released and +0.12 × (points / 200) per scored hit. A boosted
  attacker deals ×1.4 and adds 35 % knock-back. AI uses it on lined-up charges and to escape the ring.
* **Knock-back**: on top of the impulse, every car–car hit with vn > 6 m/s shoves the victim along the normal by
  `clamp((vn − 6)·0.2, 0, 4.5) · √(1500 / mass)` m/s with a yaw kick (bigger on side hits); hits > 13 m/s pop the victim
  up and roll it (side hits) — light cars fly.
* **Unstick**: a car pushing (throttle / brake / boost) at < 2 m/s that moved < 1.1 m, or touching another slow car
  (< 3.5 m/s both), for 1.2 s gets a push-off impulse (4.2 m/s, growing per repeat) away from everything it touches
  (cars, walls, obstacles, deck sides) and toward the centre, plus a little hop + spin. `input.reset` held for 1 s on a
  stuck (not flipped) car forces it (6.5 m/s pop, −2 % health, 3 s cooldown). Event `unstick {forced}`.
* **Idle penalty** (`rules.idlePenalty`, default on): no damage dealt or taken (any hit > 0.004 health, or a contact
  > 6 m/s, counts) for 15 s → `car.idle` (snapshot `idle`), event `idle`, feed line ("camping"), AI target bonus +34, and
  it burns (0.028 health/s growing to ×3, body fire visuals) until it hits or is hit.
* **Sudden death** (`safeScaleAt(t, rules, startOverride?)`, pure): starts at `rules.suddenDeathAt` (75 s) or — **lull
  failsafe** — after 35 s of fighting when nothing crunched (vn > 7 or > 0.03 health) for 9 s (feed "The crowd is
  bored…"). Over 60 s the safe area (the arena outline scaled about the origin by `safeScale` 1 → 0.5) shrinks and the
  damage multiplier ramps ×1 → ×2. Outside it a car burns (0.07 + 0.07·level per s, × mult), catches fire and is pushed
  inward (7 m/s²); event `ring`. The renderer draws the fire along the scaled boundary; the HUD warns when outside.
  Rooftop: only x / y are scaled, so the central deck is inside the ring.
* **Lonely player failsafe**: nobody within 25 m of the player for 5 s → the nearest AI is sent at the player.
* **Action director**: no crunch (> 7 m/s) at / within 15 m of the player for 3 s → the nearest free AI is retargeted at
  the player for 5 s (a second one after 5 s quiet) with ≥ 80 % ram meter; directed AIs lead the intercept up to 2.4 s
  and boost on the way in (> 12 m).
* **AI run-ups**: a back-off lasts until the 9–13 m run-up (×1.35 on ice; 3.2 s safety), and an AI that sits within
  reach + 3 m below 5 m/s for 0.8 s (nudging, not hitting) backs off for a run-up instead.
* **Hazard kicks**: `hazardAt().kick` (pusher pads) shoves a car once per (hazard id, cycle) by `strength·√(1500/mass)`
  with a hop and spin (event `kick`).
* **Pickups** (`CB.derby.pickups`, feature-detected; `cfg.pickups: false` disables): created in init with a session rng
  (state saved in getState as `pkRng`), stepped every fighting step with the facade (`cars, emit, feed, damage, rng, t,
  arena, byId, suddenDeath, phase`), entities appended to `snap.entities`, state in `getState().pickups`. Armor pickup:
  `car.pickupArmorT` (damage ×0.5, counts down); sticky bomb: `car.bombT` — the next car hit (> 3 m/s) takes a blast
  (0.55 zone points × 0.42/ZONE_HPP, 9 m/s shove + 5.5 m/s pop + roll, `explode {bomb}`, +250 STICKY BOMB!).
* **Scoring** (deterministic): every car–car hit that costs the victim > 0.012 health at > 4 m/s scores for the attacker:
  AIRBORNE HIT 300 (attacker in the air > 0.25 s), SANDWICH 300 (victim touching a wall / another car within 0.35 s),
  T-BONE 250, REAR-ENDER 150, REVERSE RAM 150, HEAD-ON 120, SIDESWIPE 80, SMASH 60 (half for non-big hits), plus bonus
  REVENGE! 200 (you hit whoever hit you within 6 s), RAM BOOST HIT 100, LAUNCHED 200 (ramp launch), TAKEDOWN 500 (credited
  elimination), LAST CAR STANDING 1000. Combo: hits within 3 s of the previous one ×(1 + 0.25·(n − 1)), max ×3. Event
  `score {label, points, combo}`; `stats.score`, results `score` / `coins` / MVP.
* **Taunts**: an AI that lands a big hit on the player (40 % chance) or eliminates the player posts a line in the feed
  (`kind 'taunt'`), at most one every 6 s, seeded.

Measured with `node tools/derby-play.js all 3` (8 cars, pro, the player driven by a scripted bot; 3 seeds per row;
crunch = car–car impact > 7 m/s or > 0.03 health; the *before* gaps were measured with the older definition, > 0.05
health in 0.1 s, on 2 seeds), before → after the fun pass:

| metric (all arenas, bots chaser / holder / idle) | before | after |
|---|---|---|
| match length (s) | 76–217 (rooftop idle 217) | 87–130 |
| car–car impacts / min | 25–69 | 44–81 |
| big hits (vn > 11) / min | 4.6–14 | 11–24 |
| time to first hit (s) | 1.4–3.5 | 1.5–2.1 |
| longest gap without a crunch anywhere (s, avg) | 11–112 | 6.5–26 |
| longest gap without a crunch near the player (s, avg / worst) | 3–119 / 226 | 4.5–15 / 23 |
| longest time nobody within 15 m of the player (s) | 0–61 | 0.2–7.7 |
| stuck % (never > 1.5 m/s for 2 s) | 2.3–15.7 | 0–3.7 |
| self-falls (all matches) | 0 | 0–1 |

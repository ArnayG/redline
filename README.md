# Redline

**Build a real car, then race it, drift it and fly it through stunt loops, all in the browser, with zero dependencies.**

**Play it: https://squarejumper.com/RacingGame/**

Redline is one game with one UI. You build a car in the Garage, then race it, drift it, take it into Arcade stunt tracks with nitro and items, run a career, or play online with friends. Everything runs from `index.html`: plain classic scripts, a hand-written WebGL renderer, no npm packages and no build step.

| | |
|---|---|
| ![Title screen](docs/screenshots/01-title.jpg) | ![Garage with the live 3D low-poly car](docs/screenshots/02-garage.jpg) |
| ![3D race, chase camera, full grid](docs/screenshots/03-race.jpg) | ![Drifting on Kurogane Pass](docs/screenshots/04-drift.jpg) |
| ![Arcade: Loop Rush stunt track](docs/screenshots/05-arcade-loop.jpg) | ![Arcade: nitro and slipstream on Mega Drop](docs/screenshots/06-arcade-items.jpg) |
| ![Multiplayer room set up for Arcade](docs/screenshots/07-multiplayer.jpg) | |

## Highlights

- **Garage**: 53 real manufacturer models (Porsche 911, GR Yaris, AE86, Ferrari SF90, F-150 Raptor, VW ID. Buzz …) drawn as low-poly renderings, with 12 tuning sections, live physics, pricing, a rules check and share links.
- **Race**: 3D circuit racing on 10 tracks against an AI field (Grand Prix, Time Trial, Practice), with weather and time of day.
- **Drift**: score attack, free run and tandem on dedicated drift venues, with steering assists from Off to Auto.
- **Arcade**: arcade grip, nitro, Mario-Kart style item boxes (turbo, oil, shockwave, rockets, shield, magnet, ghost, lightning …) and coins, on 6 stunt tracks with loops, jumps, wall rides and corkscrews, plus every circuit.
- **Arcade** (`#/arcade`): every car on a forgiving arcade grip model, with nitro (filled by drifting, drafting, jumps and near misses), item boxes and coins. Six stunt tracks (Loop Rush, Canyon Leap, Corkscrew Carnival, Neon Wall-Ride, Mega Drop, Crossover 8) plus all the circuits. Modes: Race and Time trial; AI from Rookie to Alien; speed classes Street, Pro and Mayhem.
- **Career**: championships by tier, event formats from drag to endurance, credits, owned cars, upgrades, licences, challenges, achievements and replays.
- **Multiplayer**: up to 8 players in Race, Drift battle, Free roam or Arcade, peer to peer over WebRTC, with a server relay fallback for networks that block it.
- **Phone as a steering wheel**: scan a QR code and tilt your phone to steer the game on your computer.
- **Mobile**: touch controls, tilt steering and an automatic graphics tier on phones and tablets.

Car names and model designations are trademarks of their owners. Redline is a fan project and is not affiliated with or endorsed by any manufacturer. The cars contain no logo artwork: brands appear only as text badges.

## Quick start

```
git clone https://github.com/ArnayG/redline.git && cd redline
open index.html                  # works straight from file:// (single player, invite-code multiplayer)
node tools/dev-server.js         # static site + the /api/signal multiplayer backend (in memory) on http://127.0.0.1:8080
python3 -m http.server 8080      # or any static server: http://127.0.0.1:8080/index.html
node tests/run.js                # full test suite (Node only, no packages)
node tests/run.js models         # only the test files whose name contains "models"
node tools/build-zip.js          # dist/redline-cpanel.zip for GoDaddy / cPanel hosting
```

The tests and tools need only Node (CI runs Node 20). Nothing needs `npm install`.

**Controls in short**: arrows / `WASD` drive, `Space` handbrake, `C` camera, `R` reset, `Esc` pause. In Arcade, `N` / `Shift` is nitro and `F` / `X` fires your item (hold `S` / `Down` to aim it backwards). Gamepads, touch controls and the phone wheel all work too. Details in *Controls* below.

**Deploy**: upload the `node tools/build-zip.js` package to any Apache + PHP host (GoDaddy / cPanel; the live site runs this way), or import the repo into Vercel with an Upstash store for the signalling function. See *Deploy to GoDaddy / cPanel* and *Deploy to Vercel*.

## Project structure

```
index.html            the whole game (one page; every screen is a route)
hub.html race.html    redirect stubs so old links keep working (→ #/menu, #/race,
race3d.html drift.html  #/race?quick=1, #/drift)
css/styles.css        design tokens and every screen's styles
js/                   classic scripts on window.CB (see Architecture)
  shapes/             the 53 real car models + hand-authored low-poly definitions
  race/  race/gl/     race engine, vehicle physics, AI, HUD and the WebGL renderer
  race/drift/         drift scoring, assist, tunes, AI, camera
  arcade/             Arcade mode, stunt tracks, items, nitro
  game/               career, economy, challenges, achievements, replays, menu
  net/  input/        multiplayer (signalling, WebRTC, relay, lobby) and phone wheel / tilt input
api/signal.js|.php    signalling relay (Vercel function / PHP for cPanel)
tools/                dev server and the cPanel zip builder
tests/                Node test suite (tests/run.js)
docs/                 design specs per subsystem and the README screenshots
```

## Features in detail

- **53 real manufacturer models** across 10 body styles (coupe, sedan, hatchback, wagon, SUV, roadster, pickup, hypercar, shooting brake, van), from the Porsche 911 (992), GR Yaris and AE86 to the Ferrari SF90, Koenigsegg Jesko, F-150 Raptor and VW ID. Buzz. The model is stored in `build.body.model`. Every car is drawn as a clean, flat-shaded **low-poly rendering of the real car** (crisp planar facets and flat material colours; likeness comes from the silhouette, proportions, glasshouse and signature lamp and grille shapes). Player and AI cars use the same model, with a lighter LOD for distant cars. Cars without a hand-authored low-poly definition get an automatic low-poly version generated from their `js/shapes/` profile. Settings → Graphics can switch between low-poly and the detailed mesh.
- **Garage (car builder)**: 12 sections (body/model, engine, transmission, drivetrain, suspension, brakes, wheels, aero, weight, exterior, interior, tech) with live physics (power, 0–100, top speed, lap time), pricing, finance, a legality and rules check with one-click fixes, a live 3D low-poly turntable of your car (the SVG view stays as the fallback and for thumbnails), undo/redo, saved builds, comparisons, spec sheets, share links (`#b=`) and a gallery of 22 presets. The default build is a 911 Carrera S (rear-engined 3.0 twin-turbo flat-six, about 440 hp, RWD, 8-speed dual-clutch). Each preset uses a real model whose layout matches its mechanicals.
- **Racing** in 3D (WebGL; the 2D top-down view is a fallback and the "map" camera) on 10 circuits: Redline Motor Speedway, Porto Vecchio Street Circuit, Redline Ring GP, Akagane Pass, Little Anvil Kartodromo, Neon Harbour Night Circuit, Ouroboros Figure-8, Grünwald Ring, Shuto Night Loop and Mesa Verde Raceway. Modes: Grand Prix (AI field), Time Trial and Practice. Difficulty: Rookie, Amateur, Pro. Weather and time of day are adjustable.
- **Drifting** on Kurogane Pass, Dockyard Sliders and Circle Lab (and the race circuits). Modes: Score attack (timed, bronze to platinum), Free run and Tandem (chase an AI lead car). Drift tunes: Grip, Street, Pro, Comp.
- **Career**: championships by tier with calendars and standings, several event formats (circuit race, time attack, drag, drift trial, eliminator, endurance, one-make, rivals duel), credits, XP, owned cars, a showroom, upgrades, licences and challenges (launch, braking, top speed, drift school), plus achievements, replays and a driver profile.

## Routes

`index.html` starts `CB.router` (`js/router.js`). Each screen is a full-viewport layer inside `#app-root`, and only one is visible at a time. A race or drift session is torn down (audio stopped) when you leave it.

| Route | Screen |
|---|---|
| `#/menu` | Title and main menu (the default) |
| `#/garage` (`#/garage/<panel>`, `#b=` share links) | The Garage: the car builder (old `#/atelier` links redirect here) |
| `#/race` | Race setup (track, mode, laps, field, weather, time of day, steering assist), then a 3D race |
| `#/drift` | Drift setup (track, score attack / free run / tandem, duration, tune, assist), then a 3D drift run |
| `#/arcade` | Arcade setup (stunt track or circuit, race / time trial, items, nitro, speed class, AI difficulty), then an Arcade race |
| `#/multiplayer` (`#/multiplayer/<CODE>` joins room CODE) | Multiplayer lobby: create / join a room, ready up, race or drift with friends |
| `#/career` | Championships, tiers, calendar, standings |
| `#/challenges` | Launch, braking, top-speed and drift-school challenges |
| `#/cars` (`#/cars/showroom`) | My Cars: current build, saved builds, owned career cars, showroom, upgrades |
| `#/achievements`, `#/replays`, `#/profile`, `#/settings` | Meta screens (Settings → Developer links the dev pages) |
| `#/wheel/<CODE>` | Phone steering-wheel controller (opened from the pairing QR code; see *Phone steering wheel*) |

**Rebrand note (FORGE → Redline).** The car builder was called the *Atelier* (`#/atelier`) and the saved-cars screen was the *Garage* (`#/garage`). The builder is now the **Garage** at `#/garage`, and the saved-cars screen is **My Cars** at `#/cars`. `#/atelier` and `#/atelier/<panel>` redirect to `#/garage...`, and old share links (`#b=…`, `#p=<panel>&b=…`) still open the builder. Old `#/garage` bookmarks now open the builder rather than the saved-cars screen. Old hub links (`hub.html#garage`, `#hub=garage`) still open My Cars. Internally the route ids stay `atelier` (builder) and `garage` (My Cars), and `CB.router.format()`/`parse()` map them to the URLs. localStorage keys keep their `forge.*` names, so existing saves, career, settings, achievements and replays load unchanged. Replay exports now start with `REDLINE-REPLAY:` (`.redlinereplay`), and `FORGE-REPLAY:` / `.forgereplay` files still import.

`#/race`, `#/drift` and `#/arcade` take deep-link parameters: `?track=<id>`, `?mode=<id>`, `?assist=<level>`, `?tune=<id>` and `?quick=1` (start straight away). Developer pages: `lowpoly-preview.html` shows every low-poly car in a grid or as a single-car turntable (`?model=<id>&view=side|front|rear|top|34`, with a paint picker and a wireframe toggle), and `shapes-preview.html` shows the 2D silhouettes.

The old pages are redirect stubs, so old links still work: `hub.html` → `#/menu`, `race.html` → `#/race`, `race3d.html` → `#/race?quick=1`, `drift.html` → `#/drift`.

## Which car you drive

- **Free play** (Race, Drift, the Garage's *Drive it* button, or opening `#/race` / `#/drift` directly) uses the Garage's current build (`CB.state`). These sessions count towards your profile stats and achievements however you started them: from a button, a bookmark, a deep link or a page refresh. They pay no purse.
- **Career** rounds and events use your **active career car** (the owned car selected in My Cars), not the Garage build. The career records its own results, credits and standings.
- Buying or upgrading a car opens the Garage in career mode, with a live quote and part locks for your level. Confirming keeps the new car in the Garage (if your previous Garage build was unsaved, it is kept in Saved builds); Cancel restores your previous build. Your Garage build can also be registered as the free entry car.

## Multiplayer

Race, drift or play **Arcade** with up to **8 players** (your friends, plus optional AI cars to fill the grid). Open **Multiplayer** in the top nav (`#/multiplayer`). Everyone drives their own Garage build, and every car is shown in 3D as its real model with a name tag above it. The browsers connect to each other directly (peer to peer, WebRTC). The room creator is the **host** and runs the race (grid, start lights, laps, positions, penalties, results).

**Play with friends.** Pick a connection method:

| Method | How |
|---|---|
| **Online** | *Create room* gives a 5-letter code (and a link like `…/index.html#/multiplayer/ABCDE`). Friends type the code or open the link. You need the deployed site with the signalling backend (see *Deploy to Vercel*) or `node tools/dev-server.js`. |
| **Invite code** | No server needed (works from `file://` too). The host makes an invite code and sends it by chat or email. The friend pastes it and gets an answer code back. The host pastes the answer. Repeat for each friend. |
| **Same device** | Two tabs in the same browser, for testing. Create in one tab and join with the code in the other. |

In the room, each player sets a name and toggles **Ready**. The host picks the mode (**Race**, **Drift battle** with tandem lead/chase runs that swap roles, **Free roam**, or **Arcade**), the track, laps, AI fill, weather, time of day, the allowed assists and the maximum steering assist, then presses **Start**. Results come from the host. After them, *Back to lobby* returns everyone to the room for a rematch. There is also text chat, and the host can kick players.

**Arcade multiplayer.** Pick **Arcade** in the room. The host then chooses a stunt track (listed first) or a circuit, the laps, the AI fill and difficulty, and the Arcade rules: items on/off, how many item boxes, nitro on/off, speed class (Street, Pro, Mayhem) and coins. Everyone races with arcade grip, nitro and the Mario-Kart style items, and everyone sees the same race. The host owns the item boxes and rolls, every item effect (hits, spin-outs, shields, rockets, oil, lightning), nitro canisters, coins, positions, laps, the finish and the results. Your own car reacts to your inputs at once (it is predicted on your computer and corrected from the host), and the other cars are smoothed. Nitro, items and aim-back work from the keyboard, gamepad, touch buttons and each player's own phone wheel (NITRO / ITEM buttons). If a player leaves mid-race, the host's AI takes over their car and drives it to the flag, marked *(AI)*. Arcade multiplayer races are not saved to your arcade records and pay no purse, the same as other multiplayer races. The results screen shows each driver's hits landed, items used and coins.

**Controls** are the same as single player (below). Steering assist is your own level for the mode, **Light** for races and **Heavy** for drift battles by default, capped by the host's limit. `Esc` opens the pause menu, but the race keeps running underneath: an online session never pauses. The top of the screen shows your ping, the number of drivers and the sync quality. *Reset car* is disabled in races and allowed in drift battles and free roam. The host can end the session for everyone from the pause menu.

**Limits**
- 8 players per room. AI fill cars are simulated by the host.
- If the **host leaves, the session ends** for everyone (everyone sees a message and goes back to the lobby). A dropped guest has about 15 s to reconnect before they are marked as gone.
- The connection is direct between browsers, using public STUN servers (Google, Cloudflare). The phone wheel automatically falls back to relaying through the signalling server when that fails (see *Phone steering wheel*). **Online rooms use the same fallback** (the lobby passes `relay: true` to `CB.net.transport.host` / `connect`), so rooms also work on networks that block peer-to-peer links. The status pill then reads *via server*. Over the relay, Arcade sends self-contained 5 Hz snapshots and uses a longer smoothing window and a larger input-delay budget, so expect roughly 0.3–0.6 s of extra lag for the other cars and for item hits. Your own car still responds at once. All of a host's relay links share one hub, and one request carries the posts for every guest. Each side posts at most about 7 times a second, pipelined, so a slow round trip never holds the next update back, and each post also collects that side's mail. An 8-player room therefore costs about 7 requests/s per player. Coalescing per message type keeps only the newest `'fast'` packet, for example the binary car states. `js/net/relay.js` documents the wire format and the scheduler. Networks that block peer-to-peer links connect directly through a **TURN** server when the site has one configured (see *TURN (low-latency connections on blocking networks)*), and the status then reads *via TURN*. You can also set `window.REDLINE_TURN = { urls: 'turn:…', username: '…', credential: '…' }` (or an array of these; the older name `window.FORGE_TURN` still works) before the game scripts load.
- Everyone needs the same game version. A mismatch is refused with a message.

## Controls

**Driving (race and drift)**

| Key | Action |
|---|---|
| Arrow keys / `W A S D` | Throttle, brake, steer |
| `Space` | Handbrake |
| `E` / `Shift` | Shift up (when auto-shift is off) |
| `Q` / `Ctrl` | Shift down |
| `C` | Change camera (chase, cockpit, bumper, map …) |
| `B` | Look back |
| `R` | Reset the car to the track |
| `M` | Mute |
| `Esc` / `P` | Pause (Resume, Restart, Back to Garage, Back to menu) |
| `Enter` / `Space` | Start from the loading screen |

**Arcade** adds `N` / `Shift` for nitro, `F` / `X` to use your item, and `S` / `Down` held while firing to aim it backwards (gamepad: B / RB nitro, X / LB item; touch and phone wheel: NITRO and ITEM buttons). With nitro on, `Shift` is nitro rather than shift up.

You can also use a gamepad (standard mapping, analog), a phone as a tilt steering wheel (see *Phone steering wheel*), and on touch devices on-screen controls appear. Keys can be rebound in Settings → Controls.

**Steering source.** Settings → Driving and the setup screen's *Controls & input* have one *Steering source* picker: **Keyboard / Gamepad** (default), **Phone wheel**, **Webcam air wheel**, **Mouse / trackpad wheel** and **Controller tilt**. Keyboard and gamepad always work on top of the picked source and take over while you use them. Picking a source switches the other opt-in sources off. The pause menu shows the picked source's re-centre / off entries. Mouse and controller tilt are local inputs, so there is no network in the path: a new reading is used by the next physics step, the same as a key press.

**Mouse / trackpad wheel.** Pick it, start driving and **click the track** to capture the mouse (Pointer Lock, raw unaccelerated counts where the browser supports it). Move the mouse left / right to turn a virtual wheel; a bar above the HUD shows the wheel position. **Esc** releases the mouse and pauses the game, and so does switching tabs. Pause menus and results release it automatically; click the track again to recapture it. Settings: sensitivity (600 counts from centre to full lock at 1.00×), self-centring spring (0 % = the wheel stays where you leave it), dead zone, invert, and mode: *Capture* (Pointer Lock) or *Cursor position* (the cursor's horizontal position across the screen is the wheel). When Pointer Lock is unavailable the game falls back to cursor position on its own. Optional *Mouse buttons* (off by default): left = throttle, right = brake, wheel click = nitro in Arcade (handbrake in Drift), back side button = item. The keyboard throttle / brake keep working either way. Steering stays proportional in Race, Drift (through the drift assist at every level) and Arcade.

**Controller tilt.** This mode turns a PlayStation or Switch controller into a small wheel: hold it in both hands and turn it. Pick *Controller tilt*, press *Connect controller* and choose the controller in the browser's prompt. Supported: **DualSense** (PS5) and DualSense Edge, **DualShock 4** (PS4), **Switch Pro Controller** and a single **Joy-Con** held sideways, over USB or Bluetooth. It needs **WebHID**: Chrome or Edge on a desktop, on HTTPS or `localhost`. Safari, Firefox and iPhone / iPad browsers show a message saying so instead. The site remembers the permission: next time the controller re-opens without a prompt. The gyro and accelerometer are fused (a complementary filter with gyro-bias learning): the gyro gives instant response and gravity removes drift. The angle keeps counting past ±90° and ±180°, and any hold works (flat, tilted toward you, upright). **R3** (on a Joy-Con, the stick click) or a click on the status chip re-centres. Full lock 90° / 180° (default) / 270° lock to lock, dead zone, invert. Sticks, triggers and buttons keep working as a normal gamepad (B / RB nitro, X / LB item, triggers throttle / brake). The status chip shows the controller, transport, live angle and report rate.

**Gamepad stick: proportional / digital** (Settings → Driving, under the picker). **Proportional** (default, recommended): the assist reads the stick's magnitude at every level, so half stick turns about half as much. **Digital (classic)**: the old reading, where Heavy / Auto in Race treat the stick like the arrow keys (it picks the line, so any deflection ends at the road edge). Measured on Redline Ring at 58 km/h with Heavy and a half stick: front-wheel angle 1.00× full stick with Digital, 0.61× with Proportional. Off / Light / Medium are identical in both modes, and the Drift Heavy / Auto drift lock works the same with an analog stick.

**Steering assist** (set on each setup screen and in Settings → Driving). Race and Drift each remember their own level: **Light** is the default for racing and **Heavy** for drifting. Saves from before the split that still had the old default (Heavy) get the new defaults; a level you picked yourself is kept for both.

| Level | What it does |
|---|---|
| Off | Raw steering: you do everything (in Drift mode the keyboard steering still self-aligns, see below) |
| Light | Smoothed steering and slide catching |
| Medium | Counter-steer help, stability control and braking assist |
| Heavy | Arrow keys are enough: automatic counter-steer, stability, braking and line help |
| Auto | Heavy, plus the car picks its own lines and drifts. Just hold the throttle |

**Drifting with the arrow keys.** In Drift mode the arrows steer *relative to the slide*, like the keyboard handling of most drift games:

- **Off**: with no arrow held, the front wheels self-align with the direction the car is travelling, so the counter-steer happens on its own. An arrow turns the wheels from there. The amount depends on speed (full lock when slow, about the grip limit at speed, more room while sliding), and the wheel moves at a speed- and slip-sensitive rate. A tap is a small correction, not a full-lock flick, and the counter-steer has enough lock to catch a slide at speed. Up ramps the throttle in about 0.2 s. There is no angle hold and no spin guard: you control the angle with the throttle.
- **Light / Medium**: hold the arrow toward the corner to start and hold a drift. The assist supplies the counter-steer, and the throttle sets the angle (Up = more, Down = less). **Release** the arrow to hold the current angle steadily; it unwinds as the road straightens or when you lift off. **Hold the opposite arrow** to straighten up (or swing into a drift the other way). A **quick tap of the opposite arrow** (under 0.3 s) is a switchback (manji) into the other direction. Light also slows a slide that is running wide on a track, and Medium adds the edge guard and braking help.
- **Heavy / Auto**: the drift lock (unchanged): pick a direction, and the car holds the slide and follows the road.

A gamepad stick (with *Gamepad stick: proportional*, the default), the phone wheel, the webcam air wheel, the mouse wheel and controller tilt keep proportional steering at every level. The assist still adds its help on top.

**Garage**: `[` / `]` previous / next section, `Ctrl/Cmd+Z` undo (`Shift` to redo), `Ctrl/Cmd+Y` redo, `Ctrl/Cmd+S` save, `Ctrl/Cmd+P` spec sheet, `P` presets, `G` saved builds, `C` compare, `V` view, `X` X-ray, `S` wheel spin, `T` light/dark theme, `R` race, `D` drift, `H` career, `M` menu, `?` all shortcuts.

## Phone steering wheel

Steer continuously by tilting a phone, like holding a real wheel. Steering is the phone's rotation about its **screen normal** (measured against gravity), so leaning the phone back or forward does not steer. Both landscape orientations work, and turning the phone round mid-race is followed. A 2° dead zone, a 1€ low-pass filter and a configurable full-lock angle (default **±35°** of tilt = full steering) keep it smooth. Keyboard, gamepad and on-screen controls keep working and take over while you use them.

**Use your phone as a wheel for the game on your computer**

1. On the computer, open **Use phone as wheel**. It is in Settings → Driving, in the race / drift setup (*Controls & input*) and in the pause menu.
2. The computer shows a QR code, a 5-letter code and a link (`…/index.html#/wheel/<CODE>`). Scan the code with the phone camera.
3. On the phone, tap **Start** and allow motion access (iOS asks). Hold the phone in landscape. **Gas** is the right half of the screen and **brake** the left. The screen also has handbrake (HB), gear − / +, pause, **Centre** (sets the current angle as straight ahead) and ⚙ settings (full-lock angle, smoothing, dead zone, invert, vibration).
4. Both screens show the connection state and the latency. A chip at the bottom of the computer screen shows it while paired; click the chip to reopen the pairing screen. The phone vibrates on kerbs, contact and wall hits.

Connection methods: **Online** uses the `/api/signal` backend (Vercel + Upstash, or `tools/dev-server.js`). The input then goes peer to peer over a WebRTC data channel at about 60 Hz. **Same device (test)** pairs two tabs of one browser through BroadcastChannel (`#/wheel/<CODE>?via=local`). **Invite code** needs no server: the phone opens `#/wheel/~<invite>` and shows an answer code, which you paste on the computer.

**Server relay fallback.** Campus and hotel Wi-Fi (client isolation, UDP blocked), some cellular NATs and corporate networks stop the direct WebRTC link from opening. If the data channel isn't open about 4.5 s after the phone joins (9 s while ICE is still trying a configured TURN server), or ICE fails earlier, both ends switch to relaying through the signalling server (`api/signal.php` on cPanel, `api/signal` on Vercel and in `tools/dev-server.js`). Each screen says which path is in use: **Connected (direct)**, **Connected (via TURN)** or **Connected (via server)**. It also shows the input delay, for example *· ~190 ms delay*: the one-way time from the phone sampling your input to the computer applying it. The computer measures it from a timestamp in every input packet and sends the figure to the phone.

How the relay keeps the delay down:
- The phone posts its newest input about 8 times a second, with up to two posts in flight, so it never waits for the previous round trip. Each post also collects the phone's own mail (telemetry, haptics).
- The computer keeps two long-polls open. The server checks the mailbox every 10 ms and answers as soon as mail arrives. When nothing between the browser and the server buffers responses, a single streamed response replaces the polls; this is probed automatically.
- Input therefore crosses about two network legs (phone → server → computer). Behind GoDaddy's Sucuri proxy (about 170 ms per round trip) that is roughly **190 ms one-way**. The old one-request-at-a-time loop took 200–360 ms one-way, averaging about 400 ms of input age, and showed a round-trip figure of about 600–700 ms. Physics sets the floor here. For about 20–60 ms, use TURN, or the quick workaround below.
- The rate stays near the old 13 requests/s per pairing (phone about 8/s, computer about 4–8/s), because the host's firewall bans IPs that send much more. A phone and a laptop on campus Wi-Fi share one IP. Any HTTP 429 or firewall page (403/406) slows the relay right down.

Because input arrives in batches, the disconnect failsafe below is relaxed from 0.3 s to **1 s** in relay mode.

**Quick workaround on campus Wi-Fi:** connect the laptop to the phone's hotspot. Both devices are then on the same network, the link is direct, and the delay is about 20–50 ms. The phone shows each stage (**Reaching server…**, **Waiting for computer…**, **Connecting…**, **Connecting via server…**, **Connected (…)**) and names the problem when something fails: server unreachable, blocked by the host's security (HTTP 403/406), code expired or computer not found, or the computer did not answer.

If the phone disconnects, or stops sending for more than 0.3 s (screen locked, app in the background, Wi-Fi drop), the car **centres its steering and lifts the throttle**. The race keeps running, and the keyboard or gamepad can take over at once. The phone reconnects by itself, and the pairing room stays open for it. The wheel feeds the same analog input as everything else, so it works in races, drift runs and multiplayer sessions. With **Heavy** and the lighter assists, a wheel steers in proportion to its angle. The assist still adds stability, counter-steer, edge guard and braking help, but it does not pick a line the way it does for the arrow keys. **Auto** still drives the line for you.

**TURN (low-latency connections on blocking networks).** A TURN server relays the WebRTC traffic itself (UDP, or TCP/TLS on port 443 where only that gets through). That keeps the phone wheel and online rooms at about 20–60 ms on networks that block peer-to-peer links, instead of the ~190 ms server relay. ICE always prefers a direct path, then TURN, and the server relay stays the last resort. The site hands out TURN servers through the signalling backend (`{action:'ice'}`), and `CB.net.transport` uses them automatically. Long-term API keys stay on the server, which mints short-lived credentials, so browsers only ever see `{urls, username, credential}`. No free public TURN server works without signing up any more: the old `openrelay.metered.ca` credentials are dead (2026), so none is built in.
- **cPanel / GoDaddy**: in File Manager, open `public_html/RacingGame/api/`, right-click `turn-config.example.php` and rename it to `turn-config.php`. A later zip brings the example back next to it and never touches your file. Edit it and fill in **one** provider:
  - **Cloudflare Realtime TURN**. The first 1,000 GB a month is free; the wheel uses far less. In the Cloudflare dashboard, open **Realtime → TURN Server → Create**, then copy the *Turn Token ID* into `keyId` and the *API Token* into `apiToken`. Set `'provider' => 'cloudflare'`.
  - **Metered.ca** (free plan). Sign up at dashboard.metered.ca and create an app. Put the app name (`<app>.metered.live`) into `app` and the API key into `apiKey`. Set `'provider' => 'metered'`.
  - Your own coturn server or other fixed credentials: `'provider' => 'static'` with `urls` / `username` / `credential`. Include `turns:<host>:443?transport=tcp` for campus firewalls; for Cloudflare and Metered it is added automatically.

  `turn-config.php` is not in git or in the zip, so uploading and extracting a new zip over the folder keeps it. `.htaccess` denies it over HTTP. Check the setup by pairing on a blocking network: the status should read *Connected (via TURN)*.
- **Vercel / `tools/dev-server.js`**: set `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN`, or `METERED_TURN_APP` + `METERED_TURN_API_KEY`, or `TURN_URLS` (comma-separated) + `TURN_USERNAME` + `TURN_CREDENTIAL`. Optionally set `TURN_PROVIDER` to choose between them.

**Tilt steering when you play on the phone itself.** Open Race or Drift on the phone. Tap **Enable tilt steering** (on the driving screen, in setup or in the pause menu). The on-screen layout then switches to gas (right), brake (left), handbrake, Centre and gears. While you drive, the game asks for fullscreen and landscape and blocks page scroll and zoom.

**HTTPS is required.** iOS Safari and Android Chrome only provide motion sensors on secure pages (`https://`; `localhost` also counts on the same device). The Vercel deployment is fine. On a plain `http://` page the phone shows a message, still pairs, and lets you steer by dragging the wheel. To test from a phone against a local server:

- `node tools/dev-server.js --port 8080`, then an HTTPS tunnel to it: `npx localtunnel --port 8080` or `cloudflared tunnel --url http://localhost:8080`. Open the tunnel's `https://…` address on the **computer** too, so the QR code points at it. Online pairing works through the tunnel because the dev server also serves `/api/signal`.
- Or, for Android only, on the phone: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → add `http://<your-LAN-IP>:8080`, and run the server with `--host 0.0.0.0`.

Files: `js/input/analog.js` (`CB.input.hub`, analog source hub + haptics), `js/input/tilt.js` (orientation → steer, filter, recalibration, sensor), `js/input/qr.js` (zero-dependency QR encoder, byte mode, ECC M, versions 1–10), `js/input/phone-wheel.js` (`forge-wheel/1` protocol over `CB.net.signal` + `CB.net.transport`, failsafe, pairing session), `js/input/input-ui.js` (pairing screen, status chip, touch pedals, menu / setup / settings entries), `js/input/wheel-page.js` (the phone controller page), `js/net/relay.js` (`CB.net.relay`, the server-relay fallback used when WebRTC cannot connect).

## Architecture

Every file is a classic script that attaches to `window.CB`. There are no ES modules and nothing fetches local files, which is why `file://` works. Pure-logic modules also export for Node, which lets the tests run without a browser.

| Area | Files |
|---|---|
| Foundation | `js/util.js`, `js/data.js` (catalog, presets, default build), `js/state.js` (single store, normalize, share codes, autosave), `js/ui-kit.js` |
| Car model and rules | `js/shapes/core.js`, `js/shapes/models/*` (the 53 real models: dimensions and profiles), `js/shapes/lowpoly/*` (hand-authored low-poly definitions), `js/physics.js`, `js/rules.js`, `js/pricing.js` |
| Garage (builder) | `js/app.js` (shell, summary, shortcuts, *Drive it*, free-race recording), `js/studio3d.js` (`CB.studio3d`, the live WebGL low-poly turntable), `js/render.js` (SVG fallback and thumbnails), `js/charts.js`, `js/panels-*.js`, `js/garage.js` |
| Driving | `js/race/{tracks,tracks-extra,vehicle,ai,engine,hud,audio,race-ui,renderer}.js`, `js/race/gl/*` (WebGL renderer, `lowpoly.js` = `CB.lowpoly` low-poly car registry and generator, car meshes, cockpit, scenery, post-processing), `js/race/drift/*` (drift scoring, assist, tune, AI, camera, HUD) |
| Game | `js/game/{profile,economy,career,endurance,replay,achievements,challenges,hub}.js` |
| Shell | `js/router.js` (hash router, screen layers, global nav) |
| Phone steering | `js/input/{analog,tilt,qr,phone-wheel,input-ui,wheel-page}.js` (see *Phone steering wheel*) |
| Multiplayer | `js/net/signal.js` (signalling: online / invite code / same device), `js/net/transport.js` (WebRTC data channels), `js/net/netrace.js` (`CB.net.race` host-authoritative race / drift / free-roam sessions), `js/net/netarcade.js` (`CB.net.arcade` host-authoritative Arcade races: input replay, prediction + reconciliation, items; docs/ARCADE-SPEC.md §6), `js/net/lobby.js` (`#/multiplayer`), `api/signal.js` (Vercel function), `tools/dev-server.js` (see `docs/NET-SPEC.md`) |

The data flow is simple. `CB.state` holds the build. The Garage recomputes one bundle per change (metrics, price, issues, legality). `CB.race.ui` mounts into `#/race` or `#/drift`, runs the session and reports results through its launcher's `onFinish` callback and a `cb:race-finished` event. The career, hub and challenges record the sessions they launch. `CB.app` records free sessions.

`css/styles.css` defines the shared design tokens (`--bg --panel --line --text --accent …`), type, buttons, cards, tabs, modals, toasts and form controls, so every screen looks like the same product. A slim global nav (menu, Garage, Race, Drift, Multiplayer, Career, My Cars, profile/credits, settings) is shown on every screen except while driving.

Specs (the design contracts the code was written against; some details have since moved on, the code and tests are authoritative): [`docs/SPEC.md`](docs/SPEC.md) (configurator), [`docs/RACE-SPEC.md`](docs/RACE-SPEC.md), [`docs/RACE3D-SPEC.md`](docs/RACE3D-SPEC.md), [`docs/DRIFT-SPEC.md`](docs/DRIFT-SPEC.md), [`docs/ARCADE-SPEC.md`](docs/ARCADE-SPEC.md) (Arcade, stunt tracks, items, arcade multiplayer), [`docs/GAME-SPEC.md`](docs/GAME-SPEC.md), [`docs/UNIFY-SPEC.md`](docs/UNIFY-SPEC.md) (one-game shell), [`docs/NET-SPEC.md`](docs/NET-SPEC.md) (multiplayer), [`docs/LOWPOLY-SPEC.md`](docs/LOWPOLY-SPEC.md) (low-poly real cars), [`js/shapes/README.md`](js/shapes/README.md) (the car shape library).

## Tests

`node tests/run.js` runs every `tests/*.test.js` file in Node with no packages. Pass a filter to run a subset, for example `node tests/run.js router` or `node tests/run.js drift`. Physics, rules, AI and drift-tuning tests are calibrated on a fixed reference car (`CB.data.referenceBuild()`, a front-engined 4.0 V8 coupe) rather than on the default build. The suites cover data and state (normalize, share codes, every preset), physics, rules and pricing, the real models and their dimensions, the router, the Garage shell, the race engine, AI, tracks, HUD and UI, the 3D renderer modules, drift (scoring, assist, tune, AI, sessions), and the game layer (profile, economy, career, challenges, achievements, replays, hub). `REDLINE_E2E=1 node tests/run.js wheel-relay-e2e` adds a browser test of the phone wheel on the cPanel package (`php -S` plus two headless Chromes). It checks that blocking WebRTC UDP still pairs "via server" and delivers steering, and that normal browsers stay direct. It also reports the true one-way input delay next to the computer's estimate. `REDLINE_E2E_PORT` and `REDLINE_E2E_TMP` move its ports and profiles. `node tests/run.js net-relay-latency` covers the relay scheduler, the stream fallback, PHP wake latency under `php -S` with 8 workers, and TURN credential handling with mocked providers.

## Deploy to Vercel

The site is static, plus one small serverless function (`api/signal.js`) that helps players find each other. It only relays the connection set-up messages; the race data goes directly between browsers. Everything fits the free **Hobby** plan.

1. Push the repo to GitHub, then in Vercel go to **Add New… → Project** and import it.
2. Set **Framework Preset** to **Other**, leave the build command empty, and leave the output directory as the repo root. Deploy. `vercel.json` already sets the function and cache headers.
3. Add the signalling store. In the project, go to **Storage → Marketplace → Upstash (Redis)**, choose the **Free** plan, create the database and **Connect** it to the project. This sets `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (the `KV_REST_API_*` names work too).
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the new environment variables.
5. Check it: `GET https://<your-app>.vercel.app/api/signal` should return `{"ok":true,"backend":"upstash",…}`. Without the store it returns `{"ok":false,"code":"no-backend"}`, and the lobby offers Invite code and Same device only.

**Local testing.** `node tools/dev-server.js` serves the site and runs `/api/signal` with an in-memory store, so Online mode works without Vercel at http://127.0.0.1:8080/index.html#/multiplayer. To play with friends on the same Wi-Fi, run `node tools/dev-server.js --host 0.0.0.0` and have them open `http://<your-LAN-IP>:8080/index.html#/multiplayer`. Other options: `--port <n>`, `--upstash` (use the real Upstash store from the environment variables) and `--no-api` (simulate a deployment without the backend).

## Deploy to GoDaddy / cPanel

Any Apache + PHP host works (GoDaddy cPanel shared hosting, Namecheap, Bluehost …). No Node, database or shell access is needed, and the game can live in any sub-folder because every path is relative. Online multiplayer and the phone wheel use `api/signal.php`, a PHP copy of the signalling relay that stores small files in `api/_data/`. The client tries `api/signal.php` first, then `api/signal`, so the same code also works on Vercel and with `tools/dev-server.js`.

1. **Build the zip**: run `node tools/build-zip.js` (no npm needed). This writes `dist/redline-cpanel.zip`, with everything inside a single `redline/` folder: `index.html`, the redirect stubs, the dev preview pages, `css/`, `js/`, `api/signal.php`, `api/turn-config.example.php` (never your `api/turn-config.php`), `.htaccess` and `DEPLOY-CPANEL.txt`. Tests, tools, `docs/` and Node-only files are left out. Each `<script>` / `<link>` URL gets `?v=<content hash>`, so a new upload is picked up straight away. Use `--folder <name>` to change the folder name.
2. **Upload**: in cPanel, open **File Manager → public_html → Upload** and pick `redline-cpanel.zip`.
3. **Extract**: select the zip, click **Extract** and extract into `/public_html`. You get `public_html/redline/`. Then delete the zip. You can rename the folder (for example to `public_html/game/` for `https://yourdomain/game/`). To serve the game from the domain root, move the *contents* of `redline/` into `public_html/`.
4. **Visit** `https://yourdomain/redline/`. To check online play, open `https://yourdomain/redline/api/signal.php`. It should show `{"ok":true,"backend":"php",…}`.
5. **SSL**: in cPanel, open **SSL/TLS Status** and run **AutoSSL** (free). Phone tilt steering only works on `https://`. The bundled `.htaccess` redirects http to https. It accepts both HTTPS and the `X-Forwarded-Proto` header, so it doesn't loop behind GoDaddy's proxy or a CDN.
6. **PHP version**: in cPanel, use **Select PHP Version** (or **MultiPHP Manager**) to pick **7.4 or newer**. The default extensions are enough.

`.htaccess` sets `DirectoryIndex`, MIME types (js, css, json, svg, wasm), gzip, caching, `Permissions-Policy` (accelerometer, gyroscope), `nosniff` and no directory listings. HTML is always revalidated and JS/CSS is cached for 7 days. Every block is wrapped in `<IfModule>`, so a missing module is skipped and doesn't cause an error. To see dotfiles in File Manager, open **Settings → Show Hidden Files**.

**Troubleshooting**

- **First check**: open `https://yourdomain/redline/api/signal.php` in a browser. It must show `{"ok":true,"backend":"php",…,"relay":true}`. Without `"relay":true`, an old `signal.php` is still on the server, so re-upload and extract the new zip over the folder.
- **Phone stuck on "Waiting for computer…" / "Connecting…" or says "via server"**: the network blocks direct connections (campus Wi-Fi, cellular NAT). The relay handles this automatically, at roughly 190 ms of delay behind Sucuri, and it needs the current `api/signal.php`. To get about 20–60 ms, add a TURN key (see *TURN*). Or put the laptop on the phone's hotspot, which gives a direct link at about 20–50 ms.
- **403 / "Not Acceptable" from `api/signal.php`** (the lobby says online play is unavailable; the phone says *Blocked by the web host's security (HTTP 403/406)*): mod_security blocked the request. Turn it off for the domain or folder in **cPanel → ModSecurity**, or ask the host to whitelist `/redline/api/signal.php`. Invite code and Same device modes work without the server.
- **GoDaddy Website Security / Sucuri firewall** (response headers mention `Sucuri/Cloudproxy`): if it ever blocks or caches the pairing requests, allowlist the game's `api/` path (for example `/RacingGame/api/`) in the GoDaddy Website Security (Sucuri) dashboard. All requests are `POST` with `Cache-Control: no-store`. A wheel pairing sends about 12–16 requests/s in total (phone ~8/s, computer ~4–8/s), and the relay backs off on HTTP 429 or a firewall page. Sucuri's flood protection bans an IP that sends much more for a while; the connection then times out completely. If the stream probe ever shows Sucuri buffering responses, the relay simply stays on long-polls.
- **`{"ok":false,"code":"no-backend"}`** (storage not writable): PHP can't write its data folder. In File Manager, run `chmod` to set `redline/api` and `redline/api/_data` to **755**, and the files to 644. If the folder still isn't writable, the script falls back to the system temp folder.
- **500 error on every page**: the host rejects a line in `.htaccess`. Rename the file to `htaccess.txt` to confirm, then remove `Options -Indexes` or whichever block fails.
- **Old files after an update**: upload and extract the new zip over the old folder, then hard-refresh (Ctrl+F5 / Cmd+Shift+R). If a CDN sits in front of the site, purge its cache.
- **Phone says motion sensors need HTTPS**: open the computer page over `https://`, so the QR code points to https too.

`api/signal.php` uses the same JSON protocol and limits as `api/signal.js`: room TTL 2 h, mailbox TTL 2 min, 64 KB payloads, 8 players, per-IP rate limits (600 signalling requests/min, a separate 7200/min bucket for the `relay` action and 30/min for `ice`) and same-origin only. Each poll or relay request waits at most 5 s, and a streamed relay response stays open for at most 12 s, which keeps it safe on shared hosts. A waiting request checks its mailbox with a cheap `stat()` every 10 ms. A wheel pairing holds about 3 PHP workers: the computer's two long-polls, or one stream, plus the short posts. Data files start with `<?php exit; ?>` and the folder has its own deny rule. Expired rooms are cleaned up automatically.

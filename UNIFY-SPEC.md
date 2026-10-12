# FORGE — One Game, One UI (addendum; user: "unify the ui so there's not different versions of the game")

## Single entry point
`index.html` is THE game. It loads every script (util, data, shapes, state, physics, rules, pricing, ui-kit, render, charts,
panels, garage, app, race core + gl + drift + hud/audio/race-ui, game modules, router) and boots `CB.router`.
All other pages become thin redirect stubs (keep the files so old links work):
`hub.html → index.html#/menu`, `race.html → index.html#/race`, `race3d.html → index.html#/race?quick=1`,
`drift.html → index.html#/drift` (ONLY after the drift team finishes — until then leave drift.html untouched),
`shapes-preview.html` stays as a developer tool (linked from Settings → Developer).

## Router — `js/router.js` → `CB.router`
Hash routes: `#/menu` (title + main menu, default on first load), `#/atelier` (configurator; `#/atelier/<panel>`; keeps `#b=` share
param compatibility), `#/race` (race setup → 3D race), `#/drift` (drift setup → 3D drift), `#/career`, `#/challenges`, `#/garage`,
`#/achievements`, `#/replays`, `#/profile`, `#/settings`. `CB.router.go(route, params)`, `current()`, `on(route, enter, leave)`.
Back/forward work. Each screen is a full-viewport layer inside one `#app-root`; only one is visible; screens are mounted lazily and
torn down (race/drift sessions destroyed, audio stopped) on leave. The configurator layout (`#topbar/#layout/...`) is the `#/atelier` layer.

## Unified shell & design system
One persistent slim **global nav bar** on every non-driving screen: FORGE logo (→ menu), Atelier, Race, Drift, Career, Garage, plus
profile/credits chip and settings. Hidden while driving (Esc/P pause menu offers "Back to menu / Atelier").
One design system in `css/styles.css`: shared tokens (`--bg --panel --line --text --accent ...`), typography, buttons (`.cb-btn`),
cards (`.cb-card`), tabs, modals, toasts, form controls. The hub (`js/game/hub.js`), race UI (`js/race/race-ui.js`), drift setup and
achievements/replay overlays must use these tokens/classes — remove or alias their divergent injected styles so every screen looks
like the same product. Same car card component everywhere (CB.render.thumbnail + make/model + key stats).

## Flow
Menu → **Atelier** (build/tune; "Drive it" button offers Race / Drift) · **Race** (track → session options → 3D race, heavy assist
default, assist level selectable) · **Drift** (drift track → mode free/trial/tandem → 3D drift, heavy assist default) · **Career**
(career-buy/upgrade opens the Atelier in career mode; rounds launch race or drift sessions) · results always return to where you came from.
The active car is ALWAYS the configurator's current build (CB.state), so what you build is what you drive, in every mode.
3D (`CB.race.renderer3d`) is the default everywhere; 2D top-down only as fallback / "map" camera.

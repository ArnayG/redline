# CB.shapes — real-manufacturer car shape library

`js/shapes/` holds measured, production-car geometry for every FORGE body style (three real models each, 30 in
total) plus a small core that registers the models, **fits** them to a Build (wheelbase, track, ride height,
wheel/tyre size), emits SVG path strings for the 2D views and lofts a watertight 3D mesh. Renderers should draw
these shapes instead of generic proportion-driven silhouettes so a coupé looks like a 911, an M4 or a Supra, not a
generic coupé.

* Classic scripts, zero dependencies, no DOM, run unchanged in the browser (`file://`) and in Node.
* Namespace: `CB.shapes` (`var CB = (globalThis.CB = globalThis.CB || {}); CB.shapes = CB.shapes || {};`).
* Brand names are only text (`make`, `name`, `badgeText`). The geometry contains no logo artwork; `badgeArea`
  marks where a text badge may go.

```
js/shapes/core.js                 CB.shapes core (registry, fit, SVG, sections, loft)
js/shapes/models/coupe.js         porsche-911-992 (default), bmw-m4-g82, toyota-gr-supra-a90
js/shapes/models/sedan.js         bmw-m3-g80, mercedes-amg-c63-w206, tesla-model-s-2021
js/shapes/models/hatchback.js     vw-golf-gti-mk8, honda-civic-type-r-fl5, toyota-gr-yaris
js/shapes/models/wagon.js         audi-rs6-avant-c8, mercedes-amg-e63s-estate-s213, volvo-v60-polestar-engineered
js/shapes/models/suv.js           porsche-cayenne-e3 (default), range-rover-sport-l461, lamborghini-urus
js/shapes/models/roadster.js      mazda-mx5-nd, bmw-z4-g29, porsche-718-boxster-982
js/shapes/models/pickup.js        ford-f150-raptor-gen3 (default), toyota-tacoma-trdpro-2024, tesla-cybertruck
js/shapes/models/hypercar.js      ferrari-sf90-stradale, mclaren-p1, bugatti-chiron
js/shapes/models/shooting-brake.js porsche-taycan-cross-turismo, ferrari-gtc4lusso, mercedes-cls-shooting-brake-x218
js/shapes/models/van.js           mercedes-sprinter-vs30, vw-id-buzz, ford-transit-hr
js/shapes/models/pack-*.js        extra real cars (JDM, USA, exotic, sport packs) in the same styles
```

(If no model in a style sets `default: true`, the style default is the first model registered for it.)

## Loading

Browser: load `core.js` first, then any model files, after `data.js` and before every renderer that uses them:

```html
<script src="js/shapes/core.js"></script>
<script src="js/shapes/models/coupe.js"></script>
<script src="js/shapes/models/sedan.js"></script>
<!-- … hatchback, wagon, suv, roadster, pickup, hypercar, shooting-brake, van … -->
<script src="js/render.js"></script>
```

Load order does not matter for correctness: a model file loaded before `core.js` pushes onto
`CB.shapes._pending`, and `core.js` registers the queue when it loads (later pushes register immediately).

Node (tests):

```js
const S = require('../js/shapes/core.js');               // === globalThis.CB.shapes
require('../js/shapes/models/coupe.js');                 // registers its 3 models
```

Every consumer must still work when `CB.shapes` is absent or has no model for a style. Guard with
`if (CB.shapes && CB.shapes.getModel) { … } else { /* existing procedural fallback */ }`.

## Coordinates and paths

* Units are **metres**, at the real car's published dimensions.
* Car-local axes: **x forward** (front bumper at +x), **y up** (ground y = 0), **z right**.
  Origin: midpoint between the axles, on the ground, on the centreline. So the front axle is at x = +wheelbase/2.
* Views: **side** = (x, y) seen from the car's right; **top** (plan) = (x, z); **front** and **rear** = (z, y).
  All four views use their native coordinates, so the front view is *not* mirrored in the data. When you draw the
  front view as seen by a viewer standing ahead of the car, the car's right (+z) appears on the viewer's left, so
  pass `flipX: true` to `toSvgPath`. The rear view needs no flip.
* A **Path** is an array of segments `[{t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b], …]}]`: `M`/`L` take one point,
  `Q` takes a control point and an end point, `C` takes two control points and an end point, `Z` takes `[]`.
  Body surfaces are smooth cubic Béziers. On registration, SVG `d` strings and plain point lists `[[a,b],…]` are also
  accepted and converted to Paths.
* A **geometry slot** (e.g. `front.headlights`) can be a Path, an array of Paths, `{path, paint, …}`, or an array of
  those. Read every slot through `S.items(slot)`, which always returns `[{path, paint?, …}]`.

## Model object

```js
{
  id: 'porsche-911-992', make: 'Porsche', name: '911 Carrera', gen: '992', years: '2019–', style: 'coupe',
  default: true,                        // optional: style default
  enginePosition: 'rear', drivetrain: 'rwd', powertrain: 'ice',   // 'ice' | 'ev' | 'hybrid'
  ref: { length, width, height, wheelbase, trackF, trackR, frontOverhang, rearOverhang,       // metres
         wheelDiameter_in, tireF: '235/40ZR19', tireR: '295/35ZR20', groundClearance, rideHeight, cd, curbWeight_kg },
  side:  { body, greenhouse, windows:[…], pillars:[…], doorCuts:[…], panelLines:[…], characterLines:[…],
           sill, lowerTrim, archF:{x, y, r, flare, path?}, archR:{…} },   // some styles add windshield, rollHoops, softTop
  top:   { body, greenhouse, hood, roof, deck, mirrors, characterLines?, panelLines?, cockpit?, roofGlass?, softTop? },
  front: { body, greenhouse, bumper, grille:[…], intakes:[…], headlights:[…], drl:[…], fogLights?, splitter?,
           characterLines?, panelLines?, plateArea, badgeArea, badgeText? },
  rear:  { body, greenhouse, bumper, taillights:[…], lightBar?, diffuser,
           exhaust:[{shape:'round'|'oval'|'trapezoid'|'hidden', cx, cy, w, h}], plateArea, badgeArea, spoiler?,
           characterLines?, panelLines?, badgeText? },
  details: [{ view:'side'|'top'|'front'|'rear', role:'mirror'|'handle'|'vent'|'intake'|'scoop'|'chargePort'|
              'fuelCap'|'wiper'|'antenna'|'trim'|'glass'|'light'|'marker'|'spoiler'|'wing'|…, path, paint }],
  sections: [{ x, ring:[[y,z],…], ringHalf?, belt?, glass?:[0|1 per vertex], paint?:['body'|'black'|…] }],  // optional
  look: { head, tail, grille },          // renderer lamp / grille signature (fixed vocabulary, see below)
  signature: { headlights, taillights, grille, notes },
  // optional extras some models carry: color (hex), colorName, doors, openTop, badgeText, twoTone, sources
}
```

`ref.*` length fields given in millimetres (> 20) are converted to metres on registration; missing `ref` fields are
derived from the side/top views. `archF/archR` default to the axle positions and the tyre radius.

### `look`: lamp and grille signature

Every model carries `look: { head, tail, grille }`, a coarse description of the real car's lighting and grille
signature that the 3D renderer turns into procedural lamp and grille geometry (the 2D views keep drawing the
authored `front.headlights` / `rear.taillights` / `front.grille` paths). Values come from a fixed vocabulary:

| field | values |
|---|---|
| `head` | `oval-4pt` (Porsche oval + four-point DRL) · `c-clamp` (Ford C-shaped DRL) · `y-blade` (Lamborghini Y) · `round-halo` (round lamp + halo ring) · `slim-led` (slim LED strip/eyebrow) · `projector-twin` (twin projector lenses) · `quad-round` (four round lamps) · `blade` (thin blade / pop-up lids / light bar) |
| `tail` | `light-bar` (full-width bar joining the lamps) · `c-ring` · `round-ring` (round ring lamps) · `slim` (slim horizontal lamps) · `full-width` (full-width lamp panel) · `y-shape` · `vertical` (upright lamps, incl. Mustang tri-bar) · `quad-round` (four round lamps) |
| `grille` | `kidney` · `slats` · `honeycomb` · `mesh` · `blanked` (no grille: EV / closed nose) · `seven-slot` (Jeep) · `hex` · `horseshoe` (Bugatti) · `split-v` · `bar` (one bold bar / block lettering, e.g. the FORD Raptor grille) |

Examples: 911 `oval-4pt / light-bar / slats`, M4 `slim-led / slim / kidney`, F-150 Raptor `c-clamp / vertical / bar`,
Chiron `slim-led / full-width / horseshoe`, Wrangler `round-halo / vertical / seven-slot`, ID. Buzz
`slim-led / light-bar / blanked`, Challenger `quad-round / full-width / mesh`. `fit()` copies `look` unchanged
(it does not depend on the build). `tests/shapes-look.test.js` checks every registered model against the vocabulary.

### Badges, mirrors

* `front.badgeText` / `rear.badgeText`: the plain text a renderer writes inside `front.badgeArea` / `rear.badgeArea`
  (e.g. `'PORSCHE'`, `'FORD'`, `'SILVIA'`). Text only, never logo artwork. Every model sets both; a car with no
  lettering on that face sets `badgeText: ''` and `badgeArea: null` (the Cybertruck nose). A few models also carry
  a model-level `badgeText` (string or `{front, rear}`); the per-view field wins.
* Mirrors: every model has exactly one side-view `role:'mirror'` detail per mirror head (the housing outline the 3D
  renderer lofts between its y range) and `top.mirrors` as **one closed path per side** (two items). Arms, stalks
  and sail feet are separate side/front/rear details with `role:'mirrorArm'` (usually `paint:'black'`), so they do
  not widen the housing's y range and do not take the build's mirror-cap paint.

### Paint vocabulary

Every slot item and detail carries (or defaults to) a `paint`:

| paint | meaning | suggested fill |
|---|---|---|
| `body` | body colour (build `exterior.paint`) | paint gradient + specular |
| `black` | matte black plastic / cladding / tyre-side trim | `#121315` |
| `gloss-black` | piano black (pillars, mirror caps, roof) | `#0b0c0e` + soft highlight |
| `chrome` | bright metal | grey gradient `#e8ebee → #7d838a` |
| `glass` | glass (windows, lamp covers) | `#141c25` + reflection band |
| `light` | white/clear lamp, DRL | `#f4f7fb` (emissive at night) |
| `light-red` | tail / brake lamp | `#b3121c` (brighter when braking) |
| `light-amber` | indicators / side markers | `#e08a12` |
| `carbon` | carbon fibre | `#1b1d20` + weave pattern |
| `grille` | grille mesh / intake openings | `#08090a` + mesh pattern |
| `line` | a stroke, not a fill (some characterLines) | stroke only |

Slot defaults when an item has no `paint`: `body`→body, `greenhouse`→black trim (the DLO surround), `windows`→glass,
`pillars`→body (detail pillars often say gloss-black), `lowerTrim`/`sill`→black, `hood`/`roof`/`deck`/`bumper`→body
panel (stroke the outline as a shut line), `mirrors`→body, `grille`/`intakes`→grille, `headlights`/`fogLights`→light,
`drl`→light, `splitter`→carbon, `plateArea`→white plate, `badgeArea`→none (text only), `taillights`/`lightBar`→light-red,
`diffuser`→black, `spoiler`→body. `doorCuts`, `panelLines` and `characterLines` are open strokes: dark shut lines for
the first two, a light highlight with a dark offset shadow for character lines.

## API reference

```js
const S = CB.shapes;
```

### Registry

| call | returns |
|---|---|
| `S.registerModel(model)` | normalised model (paths converted, `ref` completed, arches defaulted); re-registering an id replaces it |
| `S.models` | map `id → model` |
| `S.list()` | all models in registration order |
| `S.modelsByStyle(style)` | `[model]` for a `CB.data.bodyStyles[].id` |
| `S.defaultModel(style)` | the `default: true` model of the style, else the first one, else `null` |
| `S.getModel(build, opts?)` | `models[build.body.model]` if registered, else `defaultModel(build.body.style)`. With `{strict:true}` the explicit model is only used when its style equals `build.body.style`. Returns `null` when the style has no models. |
| `S.refBuild(model)` | a partial Build that reproduces the model's reference dimensions (useful for previews and tests) |
| `S.STYLES` | the ten body-style ids |

```js
S.modelsByStyle('coupe').map(m => m.make + ' ' + m.name);
// ['Porsche 911 Carrera', 'BMW M4 Competition', 'Toyota GR Supra']
const model = S.getModel({ body: { style: 'coupe', model: 'bmw-m4-g82' } });   // the M4
const fallback = S.getModel({ body: { style: 'coupe' } });                      // the 911 (style default)
```

### `S.fit(model | id, build?) → fitted`

Returns a deep copy of the model with every view remapped onto the Build. Without a build (or with
`refBuild(model)`) the result is identical to the model. Build fields read:

| build field | effect |
|---|---|
| `body.wheelbase_mm` | x between the axles is scaled piecewise; the overhangs and the zones within ~1.35 arch radii of each axle keep their shape (front overhang moves by +Δwb/2, rear by −Δwb/2). Clamped to 0.7–1.4 × ref. |
| `body.trackWidth_mm` | z (top, front, rear views, sections) scaled by build track / mean ref track; clamped 0.75–1.3. |
| `suspension.rideHeight_mm` | body y shifted by (build − ref ride height), clamped −0.15…+0.25 m. Wheels stay on the ground. |
| `wheels.diameter_in`, `tires.widthFront_mm/widthRear_mm`, `tires.profileFront/profileRear` | tyre overall diameter → wheel radius; the side-view wheel arches (and the explicit-section wheel-well openings) are resized so the tyre always clears the arch. Diameter clamped 0.72–1.4 × ref. |

Sub-millimetre differences are treated as zero. The fitted object adds:

```js
fitted.dims = {
  length, width, height, wheelbase, track, trackF, trackR,
  wheelRadius /* front */, wheelRadiusR, rimRadiusF, rimRadiusR, tireWidthF, tireWidthR, rideHeight,
  axleF /* = +wheelbase/2 */, axleR /* = -wheelbase/2 */,
  xFront, xRear,            // bumper extremes of the fitted side body
  centerX,                  // (xFront + xRear)/2: centre of the overall length in shape coordinates
  frontOverhang, rearOverhang, dy /* ride-height shift */, scaleZ
};
fitted.wheels = {
  front: { x, y, r, rimR, width, track },   // wheel centre (x, y), tyre radius, rim radius, tyre width, track
  rear:  { x, y, r, rimR, width, track }
};
fitted.side.archF / archR = { x, y, r, flare, path? };   // fitted arches (draw the tyre inside these)
fitted.fitted = true;
fitted._map = { x(x), side([x,y]), top([x,z]), front([z,y]), rear([z,y]) };   // non-enumerable point mappers
```

Use `fitted._map.side([x, y])` etc. to place your own attachments (wings, roof racks, number roundels) authored in
reference coordinates so they follow the same remap.

### SVG helpers

```js
S.toSvgPath(path, { scale = 1, ox = 0, oy = 0, flipY = false, flipX = false })   // → 'M 10 200 C … Z'
//   X = ox + (flipX ? -a : a) * scale,  Y = oy + (flipY ? -b : b) * scale   (numbers rounded to 0.01)
S.bounds(pathOrArrayOfPaths)   // → { minX, minY, maxX, maxY, w, h, empty? } on the flattened curve (a, b axes)
S.items(slot)                  // → [{ path, paint?, … }]
S.flatten(path, steps)         // → [{ pts:[[a,b]…], closed }]  polylines (hit tests, canvas fills)
S.parsePath('M 0 0 C …')       // SVG d-string → Path;  S.toPath(any) → Path | null;  S.isPath(v)
S.mapPath(path, fn)            // apply fn([a,b]) → [a',b'] to every point
S.parseTire('245/35ZR20')      // → { width_mm: 245, profile: 35, rim_in: 20 };  S.tireDiameter(t) → metres
```

SVG y points down, shape y points up, so side/front/rear views use `flipY: true` with `oy` at the ground line.

### 3D: `S.sectionsFromViews(model | fitted, opts?) → sections`

```js
opts = { stations: 48, ringVerts: 32, maxStations?, wheelWells: true }
// → [{ x, ring:[[y, z] × ringVerts], belt, glass:[0|1]|null, paint?:[…], top?, bottom?, halfWidth? }]   sorted by x
```

* Rings are closed: vertex 0 is the bottom centre, the ring runs up the **right** side (+z) to the roof centre and
  back down the left; the left half mirrors the right exactly.
* When the model has explicit `sections` (most models do: wing crowns, carved wheel wells, sharp creases as
  doubled vertices, cockpit tubs, beds), they are used as authored. Half rings (`ringHalf: true`) are mirrored. If
  `ringVerts` is omitted the authored vertex count is kept (recommended: resampling rounds off doubled-vertex
  creases); if given, rings are resampled by arc length and `glass`/`paint` flags are carried to the nearest vertex.
  `stations` does not apply to explicit sections; use `maxStations` to decimate them for a low LOD (end caps kept).
* Without explicit sections the rings are derived from the views: plan-view half width, side-view roof and rocker,
  super-ellipse lower body whose squareness, waist height, rocker tuck and shoulder come from the front view, a
  greenhouse inset from the plan/front greenhouse with tumblehome, wheel wells carved inboard of the tyres, and
  `glass` flags above the belt (the plan-view `top.roof` stays painted).
* Always pass the **fitted** model so sections follow the build.

### `S.loftToMesh(sections, opts?) → mesh`

```js
{
  positions: Float32Array /* xyz */, normals: Float32Array, uvs: Float32Array /* u = around ring, v = along x */,
  indices: Uint32Array,                     // whole body, triangles, CCW = outward
  groups: [{ paint: 'body'|'black'|'grille'|…, indices: Uint32Array }],   // body split by per-vertex section paint
                                            // (one 'body' group when sections carry no paint)
  glass: { positions, normals, indices },   // greenhouse glass shell, 4 mm proud of the body along the normals
  vertexCount, triangleCount, ringVerts, stations
}
```

The body is watertight (every edge shared by exactly two triangles in opposite directions, centroid-fan caps at the
nose and tail) with positive signed volume, so back-face culling is safe. Glass comes from the per-vertex `glass`
flags (a quad is glass when ≥ 3 of its corners are flagged) or, when no flags exist, from vertices above the belt
whose normals are not roof-like (`opts.roofNormalY`, default 0.93). The body underneath the glass stays closed: draw
the glass after the body with depth test on (depth write optional) and a dark, reflective material.

A full-detail model takes about 2 ms (fit + sections + loft) and produces 3k–18k triangles;
`{ ringVerts: 12, maxStations: 16, stations: 16 }` stays under 400 triangles.

## Adoption guide

All four consumers share one rule: **`const f = S.fit(S.getModel(build), build)`**, then draw from `f`. Cache `f` (and
any mesh) keyed on `model.id` plus the fitted fields (`body.wheelbase_mm`, `body.trackWidth_mm`,
`suspension.rideHeight_mm`, `wheels.diameter_in`, `tires.*`), not on the whole build. Paint colour, finish,
stripes and lights do not change geometry.

### 1. `js/render.js` — configurator SVG visualizer

Replace the procedural silhouette with the fitted views. Keep the existing scene features (studio backdrop,
shadow, spin, x-ray, aero parts, cross-fade between views).

```js
function shapeView(build, view, box /* {x, y, w, h} px */) {
  const S = CB.shapes, model = S && S.getModel(build);
  if (!model) return null;                                     // fall back to the procedural drawing
  const f = S.fit(model, build), v = f[view];
  // scale to fit the box; ground line at the bottom for side/front/rear, centreline for top
  const b = S.bounds(S.items(v.body).map(i => i.path));
  const sc = Math.min(box.w / b.w, box.h / (view === 'top' ? b.h : f.dims.height)) * 0.92;
  const flipX = view === 'front';
  const ox = box.x + box.w / 2 - (flipX ? -1 : 1) * (b.minX + b.maxX) / 2 * sc;
  const oy = view === 'top' ? box.y + box.h / 2 : box.y + box.h * 0.94;          // ground line (or centreline)
  const T = { scale: sc, ox, oy, flipY: view !== 'top', flipX };
  const d = p => S.toSvgPath(p, T);
  const out = [];
  const fill = (key, def) => S.items(v[key]).forEach(it =>
    out.push(`<path d="${d(it.path)}" ${paintAttr(it.paint || def)}/>`));        // paintAttr: see table above
  const stroke = (key, cls) => S.items(v[key]).forEach(it =>
    out.push(`<path d="${d(it.path)}" class="${cls}" fill="none"/>`));
  const details = () => f.details.filter(x => x.view === view).forEach(x =>
    out.push(`<path d="${d(x.path)}" ${paintAttr(x.paint || 'black')}/>`));
  // …layer list below…
  return out.join('');
}
```

Layer order (back to front). Same for the thumbnail and the snapshot.

* **side**: ground shadow → far-side wheels if you show them → `body` (paint) → `lowerTrim`, `sill` (black) →
  `greenhouse` (black DLO surround) → `windows` (glass) → `pillars` → `doorCuts`, `panelLines` (shut-line strokes) →
  `characterLines` (highlight strokes) → `details` (mirror, handles, vents, fuel/charge flap, side markers, lamps) →
  **wheels** → build aero overlays (splitter/wing/skirts) → x-ray layer.
  Wheels: centre `f.wheels.front.x / .y` and `f.wheels.rear.x / .y`, tyre radius `.r`, rim radius `.rimR`, drawn
  with the same transform (`ox + x*sc`, `oy - y*sc`). Draw a dark wheel-well disc of radius `archF.r` at
  (`archF.x`, `archF.y`), clipped by the body or drawn before the tyre, so the tyre sits inside the arch. The arches
  are already sized for the build's tyres.
* **front** (`flipX: true`): `body` → `bumper` → `grille`, `intakes` (grille) → `greenhouse` → glass (`details` with
  paint `glass`, or fill the greenhouse with glass inside a body-colour frame) → `headlights` → `drl` →
  `fogLights` → `splitter` → `plateArea` → `badgeArea` text (`model.make`, or `front.badgeText`, in a plain font,
  never logo artwork) → remaining `details` → tyres at `±f.wheels.front.track/2` (width `f.dims.tireWidthF`, bottom at
  the ground, top at `2*f.wheels.front.r`) behind the bumper.
* **rear** (no flip): `body` → `bumper` → `diffuser` → `exhaust` (draw from `{shape, cx, cy, w, h}`: round/oval →
  ellipse, trapezoid → rounded trapezoid, hidden → nothing) → `greenhouse`/glass → `taillights` → `lightBar` (one
  path spanning the tail; brighter when braking) → `spoiler` → `plateArea`, `badgeArea` text → `details`.
* **top**: shadow → four tyres (rectangles at x = axle ± r·0.9, z = ±track/2, width = tyre width) → `body` → `hood`,
  `deck` (panel outlines) → `greenhouse` (glass) → `roof` (body or black per build roof option) → `mirrors` →
  `details` (wipers, antennas, roof glass, spoilers). For the top view `flipY` is false and SVG y is the car's z,
  so the car's right side appears at the bottom of the screen with the nose to the right.

Compute the colours once per paint and per build (`exterior.paint`, finish, roof colour). Draw headlights with
an emissive glow only for `light`/`drl`. Keep `CB.render.resolve(build)` working: add `d.model = f.id` and
`n.length/n.height` from `f.dims` so tests and hub thumbnails stay consistent. When `CB.shapes` is missing
(old pages, Node tests that don't load it) the current procedural path must still render.

### 2. `js/race/gl/car-mesh.js` — 3D race car

```js
const S = CB.shapes, model = S && S.getModel(build);
if (model) {
  const f = S.fit(model, build);
  const secs = S.sectionsFromViews(f, lod === 'low'
    ? { stations: 16, maxStations: 16, ringVerts: 12 }
    : {});                                    // high: authored stations and ring size (keeps the creases)
  const m = S.loftToMesh(secs);
  // car-mesh origin is the centre of the overall length; shape origin is the axle midpoint
  const dx = -f.dims.centerX;
  for (let i = 0; i < m.positions.length; i += 3) m.positions[i] += dx;
  for (let i = 0; i < m.glass.positions.length; i += 3) m.glass.positions[i] += dx;
  m.groups.forEach(g => parts.push({ mesh: gl.mesh(m.positions, m.normals, m.uvs, g.indices),
    material: g.paint === 'body' ? paintMat : g.paint === 'grille' ? grilleMat : blackTrimMat, kind: 'body' }));
  parts.push({ mesh: gl.mesh(m.glass.positions, m.glass.normals, null, m.glass.indices),
    material: glassMat, kind: 'glass', transparent: true });
  // wheels: f.wheels.front/rear {x + dx, y, r, rimR, width, track}  →  existing tyre/rim/brake builders
  // dims for cameras/collision: f.dims.length/width/height/wheelbase/track/wheelRadius/rideHeight
}
```

* Axes already match (x forward, y up, z right). Only the x origin differs: subtract `f.dims.centerX`.
* **Lights, grilles, intakes, badges, vents** come from the 2D views as decals. Front-view items (z, y) project
  onto the nose: for each point, cast a ray along −x from x = `f.dims.xFront + 0.1` onto the loft (or the ring at the
  matching station) and place the decal there. Rear-view items do the same along +x from `xRear`. Side-view
  `details` (mirrors, handles, vents, markers) project along −z onto the right flank and mirror to the left.
  Triangulate each closed path (`S.flatten(path, 8)` gives polygons; ear-clip) and offset it ~3 mm along the surface
  normal, or render it into the body texture using the uvs. Emissive materials: `light`, `light-red` (×2 when
  braking), `light-amber`.
* Mirrors: extrude each `top.mirrors` item (one plan shape per side) between the y range of the side-view
  `role:'mirror'` detail; paint per the detail. Add `role:'mirrorArm'` details as thin struts down to the door.
* Lamps and grille: build the procedural lamp / grille style named by `f.look` (`head`, `tail`, `grille`), placed at
  the bounds of `front.headlights`, `rear.taillights` / `rear.lightBar` and `front.grille` projected onto the nose and
  tail. Badge text from `front.badgeText` / `rear.badgeText` inside the projected `badgeArea`.
* Exhausts: `rear.exhaust[]` → short cylinders (round/oval) or boxes (trapezoid) at (x = `xRear`, z = `cx`, y = `cy`).
* Keep the existing procedural loft as the fallback and for body styles without models. Aero options (wings,
  splitters, canards) attach using `f.dims` and `f._map.side`.
* Cache by `CB.gl.car.cache.key(build)`; the key already includes the geometry fields. Add `build.body.model`.

### 3. `js/race/renderer.js` — 2D top-down sprites

Race-world units are metres with +x east, +y north and heading CCW from +x. Build the cached body sprite from the
plan view:

```js
const f = S.fit(S.getModel(build), build), v = f.top;
// sprite space: nose along +x, car-local left = +y (CCW world), so a shape point (x, z) → (x - centerX, -z)
function trace(g, path) {
  S.flatten(path, 10).forEach(pl => {
    pl.pts.forEach(([x, z], i) => (i ? g.lineTo : g.moveTo).call(g, (x - f.dims.centerX) * ppm, -z * ppm));
    if (pl.closed) g.closePath();
  });
}
// draw order: shadow (body offset) → tyres (dynamic) → body (paint) → hood/deck outlines → greenhouse (glass)
//           → roof → mirrors → top-view details (wipers, spoilers, roof glass) → number roundel on the roof
```

With the renderer's y-flip to screen, `-z` puts the car's right on the right-hand side of travel. Draw wheels
from `f.wheels` at (x − centerX, ±track/2) using the existing steer and tread animation. Head/tail lamp light pools
go at the nose and tail: `xFront`/`xRear`, z from `front.headlights` / `rear.taillights` bounds (`S.bounds(...).minX/maxX`
are the z extents in those views). Collision boxes stay on `f.dims.length × f.dims.width`.

### 4. Configurator model picker, `build.body.model`, presets

* **Build field**: `build.body.model` (optional string id; absent or `null` = style default). `defaultBuild()` may
  leave it unset. Normalisation (`state.js`/`rules.js`) should keep it only when
  `CB.shapes.models[id] && CB.shapes.models[id].style === build.body.style`, and otherwise delete it. When the user
  changes `body.style`, clear `body.model`. Use `S.getModel(build, { strict: true })` in renderers if you
  cannot guarantee that.
* **Picker** (body panel, under the body-style cards):

```js
const list = (CB.shapes && CB.shapes.modelsByStyle(build.body.style)) || [];
const current = CB.shapes.getModel(build, { strict: true });
list.forEach(m => card({
  id: m.id, title: m.make + ' ' + m.name, sub: (m.gen ? m.gen + ' · ' : '') + m.years,
  thumb: CB.render.thumbnail(Object.assign({}, build, { body: Object.assign({}, build.body, { model: m.id }) })),
  selected: current && current.id === m.id,
  onPick: () => CB.state.set('body.model', m.id)
}));
```

  Optional "match real dimensions" action: set `body.wheelbase_mm = round(m.ref.wheelbase*1000)`,
  `body.trackWidth_mm = round((m.ref.trackF + m.ref.trackR)/2*1000)` (clamped to the style ranges),
  `suspension.rideHeight_mm = round(m.ref.rideHeight*1000)` and the tyre sizes from `S.parseTire(m.ref.tireF / tireR)`.
  `S.refBuild(m)` returns exactly these fields. Picking a model only changes looks; physics and pricing still
  come from the build's numbers.
* **Presets** (`data.js` `presets[].build.body.model`). Suggested mapping by style, engine layout and wheelbase:

| preset | style | model id |
|---|---|---|
| alpine-gt | coupe | `bmw-m4-g82` |
| track-weapon | coupe | `porsche-911-992` |
| muscle | coupe | `toyota-gr-supra-a90` (or `bmw-m4-g82`, closer wheelbase) |
| electric-hyper | hypercar | `ferrari-sf90-stradale` |
| le-mans-hybrid | hypercar | `mclaren-p1` |
| hot-hatch | hatchback | `vw-golf-gti-mk8` |
| rally-legend | hatchback | `toyota-gr-yaris` |
| overland | suv | `range-rover-sport-l461` |
| eco-commuter | sedan | `mercedes-amg-c63-w206` (or `tesla-model-s-2021`) |
| super-wagon | wagon | `audi-rs6-avant-c8` |
| lightweight-roadster | roadster | `mazda-mx5-nd` |
| desert-runner | pickup | `ford-f150-raptor-gen3` |
| atelier-shuttle | van | `vw-id-buzz` |

  Unregistered ids are harmless because `getModel` falls back to the style default. The share URL and saved builds
  carry the field, so it must survive `state` serialisation.

## Authoring or changing a model

```js
(function () {
  var CB = (globalThis.CB = globalThis.CB || {}); CB.shapes = CB.shapes || {};
  var model = { id: 'make-model-gen', style: 'coupe', ref: { … }, side: { … }, top: { … }, front: { … }, rear: { … },
                details: [ … ], signature: { … } };
  if (CB.shapes.registerModel) CB.shapes.registerModel(model);
  else (CB.shapes._pending = CB.shapes._pending || []).push(model);
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
})();
```

* Use real published dimensions in `ref`. The side body must span `xRear … xFront` = `−wheelbase/2 − rearOverhang
  … wheelbase/2 + frontOverhang` and reach `height`. The plan body spans ±width/2. Wheel arches are cut into
  `side.body` around `archF/archR`.
* Explicit sections: every ring the same vertex count after mirroring. Use doubled vertices for sharp creases.
  `glass`/`paint` arrays must have the expanded ring length.
* Inspect every model in `shapes-preview.html` (side/front/rear/top + a software-rendered 3D loft, with paint picker).

## Tests

```
node tests/run.js shapes-          # all tests/shapes-*.test.js (core + one file per style)
node tests/run.js                  # the full suite
```

`tests/shapes-core.test.js` covers: the `_pending` queue, registry and fallback, `toSvgPath`/`bounds`/`parsePath`,
tyre parsing, `fit` identity at `refBuild`, wheelbase/ride-height/track/arch remapping, section consistency and
symmetry, wheel wells inboard of the tyres, glass flags, explicit half sections, a watertight outward-normal loft,
and "every model file loads, fits and lofts".

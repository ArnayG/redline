# FORGE — Low-poly real cars (user: "turn all the cars into low-poly renderings of the real version … confirm similarity by comparing to real images")

Goal: every car is a clean, deliberately faceted **low-poly model of the real car** (think premium low-poly art: crisp planar
facets, flat shading, flat material colours, no decals, no texture tearing). Likeness comes from silhouette, proportions,
glasshouse shape, and the signature light/grille shapes modelled as small flat-coloured polygons — not from fine detail.
Target 600–2,500 triangles per car (wheels included), identical model for player and AI (a ~300-tri LOD for far cars).

## Files
- `js/race/gl/lowpoly.js` → `CB.lowpoly` — registry, generator, auto-fallback, car-mesh integration (core agent).
- `js/shapes/lowpoly/<group>.js` — hand-authored per-car definitions (authoring agents). Load after js/shapes/models/* and before js/race/gl/car-mesh.js.
- `lowpoly-preview.html` — dev page: grid + single-car turntable `?model=<id>&yaw=&pitch=&view=side|front|rear|top|34`, paint picker, wireframe toggle.
- Studio: the configurator `#/atelier` viewer shows the same low-poly car as a live WebGL turntable (`js/studio3d.js` → `CB.studio3d`), SVG `CB.render` stays as fallback/thumbnails.

## Authoring format (binding)
Car-local metres: x forward (front bumper +x), y up (ground 0), z right; origin mid-wheelbase on the ground (same as js/shapes).
```js
CB.lowpoly.register('porsche-911-992', {
  // optional: dims override; default comes from CB.shapes.models[id].ref
  body: {                          // main shell, mirrored about z=0
    stations: [                    // 8–16 stations front→rear, SAME point count each (7–12), each a half-ring
      { x: 2.20, pts: [[0.25,0],[0.33,0.62],[0.60,0.78],[0.66,0.55],[0.68,0]] }, // [y,z] from bottom-centre → round → top-centre
      ...
    ],
    mats: [ ['paint','paint','black',...], ... ]   // (stations-1) rows × (pts-1) cols material per quad strip
  },
  cabin: { stations: [...], mats: [...] },         // optional separate glasshouse shell (same rules); 'glass' faces etc.
  parts: [                         // flat-coloured detail pieces (mirrored if mirror:true)
    { t:'poly',  mat:'light', mirror:true, pts:[[x,y,z],...], offset:0.004 },   // planar polygon slightly proud of the surface
    { t:'box',   mat:'black', c:[x,y,z], s:[lx,ly,lz], rotY:0 },
    { t:'prism', mat:'trim',  pts2d:[[x,y],...], z0, z1 },                     // extrude a side-profile polygon across z
    { t:'poly', view:'front', mat:'light', pts:[[z,y],...], offset, mirror, maxTilt:40 }, // projected decal; maxTilt
                                   // (deg, opt-in): one flat polygon facing the view within maxTilt, just proud of the
                                   // skin (lamps / grilles straddling a bonnet or deck edge stay unsquashed)
  ],
  // flare() arch bands (4-point radial prisms round an arch) must start AT the arch cut radius (the fitted arch r the
  // well is cut at, >= wheel r + 25 mm, ~ wheel r x 1.1): the generator pushes any inner edge inside it out to it.
  exhaust: [{ cx, cy, w, h, shape:'round'|'oval'|'trapezoid', mirror }],   // optional: replaces the base model's
                                   // rear.exhaust tips (rear-view z / y; mirror adds the twin at -cx; [] = none visible)
  wheels: { spokes: 5, style:'star'|'mesh'|'disc'|'split'|'turbine', inset:0.02 }, // low-poly 12–16 sided tyre + rim polygon
  notes: 'reference photos used: …'
});
```
Materials: `paint` (build exterior colour + finish), `paint2` (second tone/roof), `glass`, `black` (trim/plastic),
`gloss` (gloss black), `chrome`, `rubber`, `light` (headlight, emissive at night/DRL), `drl`, `tail` (emissive red,
brighter when braking), `indicator`, `grille`, `carbon`, `plate` (white/yellow number plate), `badge`.
Shading: FLAT (per-face normals, unwelded verts), subtle per-face value jitter allowed, no textures on bodies.

## Generator / integration (core)
- `CB.lowpoly.has(id)`, `CB.lowpoly.build(build, {lod}) -> { parts:[{mesh-data positions/normals/colors/indices, kind, mat}], dims, cockpitEye, hoodCam, bumperCam }`
  matching the existing `CB.gl.car.build` part kinds (body, glass, wheel-fl/fr/rl/rr, light-head, light-brake, light-rev, …) so
  renderer3d/pose/cockpit keep working (wheel spin/steer, brake lights, headlights).
- Fitting to the build: stretch stations between axles by build wheelbase/ref wheelbase, scale z by track, wheels sized from the
  build's tyres, ride height offset; build-driven extras (wings, splitter, diffuser, number roundel) as low-poly parts.
- Models without a hand-authored definition get an **auto low-poly** from `CB.shapes` (sections resampled to ~12×9, flat shaded,
  materials from glass/black flags), so every car works immediately; hand-authored ones replace them as authors finish.
- `CB.gl.car.build` delegates to `CB.lowpoly` by default (setting `graphics.carStyle: 'lowpoly' | 'detailed'`, default lowpoly).

## Likeness verification (mandatory for every hand-authored car)
Open real photos of the car (Wikipedia / Wikimedia Commons article images) in Chrome and screenshot them, then screenshot
`lowpoly-preview.html` at matching angles (side, front 3/4, rear 3/4, front). Compare silhouette, glasshouse, lamp/grille
graphics and stance; iterate until an enthusiast would name the car instantly. Record the photo URLs in `notes`.

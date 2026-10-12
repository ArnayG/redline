# FORGE — 3D Race Renderer Contract (addendum to RACE-SPEC.md)

Racing is rendered in real 3D (first-person cockpit / third-person chase) so the player sees the other cars in 3D.
Pure WebGL (WebGL2 with WebGL1 fallback), ZERO dependencies (no three.js, no CDN), classic scripts, works from file://.
The existing 2D top-down renderer (`js/race/renderer.js`) remains as a fallback when WebGL is unavailable and as the "map" camera.
Simulation stays 2D planar (x, y, heading from the race engine snapshot). World axes: sim (x, y) → GL (x, z = -y), up = +Y.
Track elevation: flat road at y = 0 (optional gentle procedural terrain undulation only OFF the track beyond walls/run-off).

## Files (all under `js/race/gl/`, load in this order, after js/race/renderer.js and before js/race/hud.js)

| File | Namespace | Owner |
|------|-----------|-------|
| `gl-core.js` | `CB.gl` | core engine |
| `textures.js` | `CB.gl.textures` | procedural textures |
| `track-mesh.js` | `CB.gl.track` | track + terrain geometry |
| `scenery.js` | `CB.gl.scenery` | trackside objects |
| `car-mesh.js` | `CB.gl.car` | 3D car models from builds |
| `cockpit.js` | `CB.gl.cockpit` | first-person interior |
| `effects.js` | `CB.gl.effects` | particles, skids, weather, sky |
| `renderer3d.js` | `CB.race.renderer3d` | assembly, cameras, frame |

## CB.gl (gl-core.js)
- `CB.gl.createContext(canvas, {antialias:true}) -> ctx` wraps `gl`, `isWebGL2`, extensions (OES_element_index_uint, ANGLE_instanced_arrays/WebGL2 native instancing, OES_standard_derivatives, EXT_texture_filter_anisotropic, WEBGL_depth_texture), `resize(cssW, cssH, dpr)`, `lost` handling.
- Math: `CB.gl.mat4` (create, identity, multiply, perspective, lookAt, invert, transpose, translate, rotateX/Y/Z, scale, fromRotationTranslation), `CB.gl.vec3` (add, sub, scale, cross, dot, normalize, length, lerp). Column-major Float32Array like gl-matrix.
- `CB.gl.Mesh`: `CB.gl.createMesh(ctx, {positions:Float32Array, normals, uvs?, colors?, indices:Uint16|Uint32Array}) -> mesh {draw(program), destroy(), bounds}`; `createInstanced(ctx, mesh, instanceData: Float32Array (mat4 per instance + vec4 color))`.
- `CB.gl.geometry` builders returning plain `{positions, normals, uvs, indices}`: box, cylinder (with segments, caps), torus, sphere, plane, extrudeProfile(profile2D, path3D), lathe(profile, segments), loft(sections: array of closed 3D rings with equal vertex count, closeEnds), merge(list with transforms & per-part colors), computeNormals.
- Materials/shaders: `CB.gl.createProgram(ctx, vsSrc, fsSrc)`, and built-in programs from `CB.gl.shaders(ctx)` → `{ standard, unlit, sky, particles, shadow, post }`.
  `standard` uniforms: uModel, uView, uProj, uNormalMat, uBaseColor (vec4), uMap (sampler, optional via uUseMap), uMetallic, uRoughness, uClearcoat, uFlake (paint flake), uEmissive (vec3), uSunDir, uSunColor, uAmbientSky, uAmbientGround, uFogColor, uFogDensity, uCamPos, uEnvTop/uEnvHorizon/uEnvBottom (procedural env for reflections/fresnel), shadow map uniforms (uShadowMap, uShadowMatrix, uUseShadow), point/spot lights array (max 8: headlights, lamp posts: uLightPos[8], uLightDir[8], uLightColor[8], uLightParams[8] = range, cosInner, cosOuter, type), uWetness (puddle reflection/darkening), vertex colors (aColor) multiplied in.
- `CB.gl.createShadowMap(ctx, size)` directional sun shadow (fit to camera frustum region ~200 m around player).
- `CB.gl.createRenderTarget(ctx, w, h, {depth})` (for rear-view mirror and post FX). Post: optional bloom on emissive/bright, vignette, speed-blur (radial at high speed), tonemap (ACES) + gamma.
- `CB.gl.drawList(ctx, items, camera, env)` — items `{mesh, program?, material:{...uniform values}, model: mat4, castShadow, instanced?}`; sorts opaque front-to-back, transparent back-to-front.

## CB.gl.textures (textures.js)
Canvas-generated, mipmapped, anisotropic, cached per ctx: `asphalt(ctx, {wet})`, `asphaltNormal`, `grass`, `sand`, `gravel`, `kerb(colorA, colorB)`, `concrete`, `barrierArmco`, `tyreWall`, `crowd`, `trees (billboard atlas)`, `buildingFacade(seed, night)`, `billboard(text, brandColor)` with FORGE / sponsor logos, `startLine` (checker), `gridBox(number)`, `skidmark`, `smoke`, `spark`, `rainDrop`, `carNumber(number, color)`, `tireSidewall`, `carbonWeave`, `dashboard gauges canvas (dynamic: updated per frame by cockpit)`. Each returns a `WebGLTexture`. `CB.gl.textures.canvas(ctx, w, h, drawFn)` helper.

## CB.gl.track (track-mesh.js)
`CB.gl.track.build(ctx, geom, trackDef) -> { meshes: [{mesh, material, castShadow}], bounds, groundY(x, z) }` using `geom` from `CB.race.tracks.build` (samples `{x,y,heading,curvature,s,width,leftKerb,rightKerb}`):
road ribbon (UV along s for asphalt tiling, darker racing-line rubber band via vertex color), painted edge lines, kerbs as raised 3D strips with sawtooth color, start/finish line, grid boxes, run-off asphalt/sand/gravel areas, grass terrain extending ~300 m with gentle undulation outside walls, walls/armco/concrete barriers (street track: tall concrete walls with catch fences) along track edges at the distance used by the engine for wall collisions, pit straight markings. Walls and road must line up EXACTLY with the sim geometry so 3D visuals match physics.

## CB.gl.scenery (scenery.js)
`CB.gl.scenery.build(ctx, geom, trackDef, {quality}) -> { items: [...], update(time, cameraPos), lights: [{pos, dir, color, range, cosInner, cosOuter}] (lamp posts for night) }`.
Places (deterministic, seeded, never on the track) instanced trees (low-poly conifers/deciduous + billboards far), grandstands with crowd texture & roofs near the start/finish, pit building with garages, start/finish gantry with the 5 countdown lights (emissive controlled by snapshot.countdown), marshal posts, tyre stacks at corner run-offs, billboards, bridges/footbridge over the track at one location, city buildings for street/night-city tracks, rock walls & guardrails for touge, mountains/hills skyline ring in the distance, lamp posts. Uses trackDef.scenery if present plus procedural fill. Camera-distance LOD/culling.

## CB.gl.car (car-mesh.js)
`CB.gl.car.build(ctx, build, {number, color, accent, lod:'high'|'low'}) -> carModel { parts: [{mesh, material, local: mat4, kind:'body'|'glass'|'wheel-fl'|'wheel-fr'|'wheel-rl'|'wheel-rr'|'caliper-*'|'light-head'|'light-brake'|'light-rev'|'wing'|...}], dims: {length, width, height, wheelbase, track, wheelRadius, rideHeight}, cockpitEye: vec3 (driver eye position in car-local space), hoodCam: vec3, bumperCam: vec3, destroy() }`.
Car-local axes: +X forward, +Y up, +Z right (renderer converts). Body generated by LOFTING cross-section rings along the length from the body style (all 10 styles visibly distinct: coupe, sedan, hatchback, wagon, suv, roadster (open top), pickup (bed), hypercar (low, cab-forward), shooting-brake, van) using build.body.wheelbase_mm/trackWidth_mm, suspension.rideHeight_mm, wheels.diameter_in, tires profile, plus SPEC svg hints in data.js. Paint from build.exterior (color, finish → metallic/roughness/clearcoat/flake; matte high roughness; chrome metallic 1 rough 0.05; chameleon hue shift via shader view-angle uniform `uHueShift`), roof option, stripes (texture or vertex color bands), windows (tinted transparent glass), headlights/taillights (emissive; brake light intensity driven at render), mirrors, splitter, side skirts, diffuser, canards, wing per type & angle, exhaust tips, race number decals (textures.carNumber) on doors/hood/roof, wheels: tire torus-ish with sidewall, rim per wheels.design (spoke count, style) & finish, brake disc + caliper in caliperColor. `CB.gl.car.cache` keyed by a build hash. LOD low for distant AI cars (< 400 tris).
`CB.gl.car.pose(carModel, carSnap, dt, prevState) -> list of draw items` computing world transforms: body roll/pitch from lateral/longitudinal accel (spring-damper visual), wheel spin from speed/radius, front wheel steer from steerAngle, brake light emissive from brake, headlights on at dusk/night.

## CB.gl.cockpit (cockpit.js)
`CB.gl.cockpit.build(ctx, build) -> cockpit { draw items in car-local space, update(carSnap, dt, time) }`: dashboard shaped per build.interior (trim material color, carbon/aluminum/wood), steering wheel per interior.steering (round/flat-bottom/yoke/race-quick-release) that ROTATES with steerAngle (×~12 steering ratio), driver hands/gloves on the wheel, live gauge texture (rpm needle, speed digits, gear, shift lights) and center screen (tech.screen_in, shows minimap/speed), A-pillars, roof liner, windshield frame, rear-view mirror (shows a render-target texture of the rear view supplied by renderer3d), side mirrors, roll cage bars if weight.rollCage, harness if interior.harness, ambient lighting glow color, HUD projection if tech.hud. Head bob / g-force head movement (lean on lateral g, push back on accel).

## CB.gl.effects (effects.js)
`CB.gl.effects.create(ctx) -> { emitSmoke(pos, vel, intensity), emitSparks(pos, vel, n), emitDust(pos, vel, surface), addSkid(carId, wheelIdx, pos, intensity), update(dt, snap, camera), drawItems(camera) , sky: drawSky(camera, timeOfDay, weather), rain:{...} }`:
GPU point-sprite / billboard particles (smoke, sparks, dust, tire spray), skid-mark ribbons on the road (persistent with fade, capped buffer), rain streaks + wet road sheen + spray when weather wet, sky dome with sun/clouds gradient per timeOfDay (day/dusk/night with stars), sun direction per timeOfDay, light shafts optional, lens dirt at dusk optional. Keep total particles capped (quality setting).

## CB.race.renderer3d (renderer3d.js) — SAME interface as CB.race.renderer
`CB.race.renderer3d.isSupported() -> bool`.
`CB.race.renderer3d.create(canvas, geom, trackDef, opts {timeOfDay, weather, quality:'low'|'medium'|'high'|'ultra', camera}) -> { render(snap, alpha?), setCamera(mode), cycleCamera(), getCamera(), resize(), destroy(), setQuality(q) }`.
`canvas` is the 2D canvas race-ui already uses for the HUD. renderer3d creates its OWN WebGL canvas inserted directly BEFORE `canvas` in the same parent, absolutely positioned to exactly cover it (pointer-events none), and each frame CLEARS the 2D canvas to transparent (clearRect) so the HUD (drawn after render) overlays the 3D view. It must also set the 2D canvas background to transparent. destroy() removes the GL canvas.
Camera modes (cycleCamera order): `'cockpit'` (1st person from cockpitEye with interior, default), `'hood'`, `'bumper'`, `'chase'` (3rd person close, default if cockpit unsupported), `'chase-far'`, `'tv'` (trackside broadcast cams switching by s), `'heli'` (high orbit), `'map'` (delegates to the 2D CB.race.renderer drawn into the 2D canvas — i.e. render nothing in GL and call the 2D renderer). Camera smoothing via spring-damper; chase cam lags on yaw, look-behind support `setLookBack(bool)`; speed-dependent FOV (60°→75°), camera shake on kerbs/collisions/high speed, collision-safe chase cam (doesn't clip into walls).
Per frame: interpolate car poses (keep previous snapshot), build/update car models for every car (high LOD near, low far), cull by frustum, sun shadow pass, main pass (sky, terrain, track, scenery, cars, effects), rear-view mirror render target in cockpit view (at ~1/4 res, every other frame), post FX, emissive countdown gantry from snap.countdown, events (collisions → sparks, wall → sparks+shake), skids from car.skidding/wheelspin, headlights as spot lights at dusk/night for the nearest 4 cars + lamp posts.
Performance target: 60 fps on a MacBook Air at 'high' with 12 cars; auto-downgrade quality if frame time > 22 ms for 2 s.

## Test page
`race3d.html`: standalone page loading util/data/state/physics(if present)/race core (tracks, vehicle, ai, engine), renderer.js, all gl files, hud.js, audio.js; a minimal self-contained driver loop (fixed-step 1/120 accumulator, keyboard WASD/arrows, C cycles camera) running a session with 7 AI on a selectable track, drawing renderer3d then hud. (Final integration into race-ui is done separately: race-ui will prefer renderer3d when supported, with a "Graphics" setting 3D/2D and camera selection.)

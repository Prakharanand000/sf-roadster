# Night lighting: current state and recommended architecture

Source: research agent, 2026-10-26. A design proposal; nothing is profiled yet. Performance numbers are estimates.

## Current state (file:line)

**What works:**
- `uNight`/`uTime` are shared into every patched material via `onBeforeCompile` (city.js:69).
- `setNight` writes one uniform, lamp-head emissive = n×2.2, and calls `landmarks.setNight` (city.js:117-125). Keep this pattern.

**Street lights:**
- Positions are invented. Lamps go only on trunk/primary/secondary/tertiary roads, every 34 m on alternating sides, skipping 6 m around junctions (roads.js:8,254-270). **Residential streets are dark.**
- The bridge branch is dead code: `LIT.has(t) && !r.bridge`, then `r.bridge ? 50 : 34` (roads.js:254-255). Only the Golden Gate deck gets lamps (309-319).
- Poles use 3 `new BoxGeometry` per lamp, merged per 500 m chunk (415-434).
- The glow is one global `THREE.Points` with `frustumCulled=false`, a single warm colour and size `900*7/-z` px (369-398).
- The additive blend plus `fog_fragment` adds fog colour across the whole point square, so halos show square corners (389-392).

**No lamp light reaches the ground.** The road and terrain shaders have no lamp term, and terrain wires up `uNight` but never reads it (terrain.js:119). At night the ground gets only the hemisphere light (0.25), the moon (0.35) and the player's headlight.

**Windows:**
- A window is lit when hash(floor, bay, seed) < a per-style fraction. The seed is `(k*37)&255`, so there are only 256 patterns (buildings.js:133).
- The pattern is static, ignores land use, and has emissive 0.75×night.
- Windows shimmer at distance because there is no `fwidth` fade.

**Landmarks:**
- About 20 materials ramp emissive (landmarks.js:87-104,621-623).
- Bay Lights are static emissive boxes every 16 m (255-265).
- The Salesforce crown is a scrolling canvas (297-307).
- Golden Gate has a 0.12 orange emissive plus red aviation lights.

**env.js:**
- ACES tone mapping (main.js:267); night exposure 0.6 (env.js:229).
- UnrealBloomPass at half resolution: strength 0.35–0.5, radius 0.5, threshold 0.92. Off on low quality.
- HalfFloat render target with MSAA×4.
- FogExp2 plus Karl density near the Golden Gate.
- Lights: hemisphere, sun/moon directional (2048 shadow map) and the player's SpotLight.
- The PMREM probe is sky-only, so car paint never reflects city lights.

**Won't scale:** the global Points, per-lamp geometry, invented lamps, the 8-bit window seed, no ground lighting, and no per-tile night data.

## Recommended architecture

r160 is forward-rendered. Light counts are part of the shader program key (WebGLPrograms.js), so adding or removing lights recompiles everything, and every fragment loops over every light. Hence:

| Piece | Owner | How |
|---|---|---|
| a. Light field | MAP | Camera-following 2048² RGBA8 at 2 m/texel (4 km) plus 1024² at 8 m/texel (8 km). Lamps are drawn additively as instanced quads from a top-down ortho camera with a lopsided falloff; only the strip that scrolled in is redrawn. Road, sidewalk, terrain and facade shaders add `albedo*L.rgb*uNight`. Zero main-pass draw calls. |
| b. Glow billboards | MAP | One instanced quad batch per tile, 16 B per instance, for lamps, signals, aviation lights, bridge strings and LEDs (GTA V style). Not `gl.POINTS`, because they clip by centre and have a size cap. Minimum 1.5 px. In fog the halo grows (1+k·fog) and the core fades exp(−σd). |
| c. Real lights | MAP | A fixed pool of 6 PointLights (25 m, decay 2, no shadows) moved to the nearest lamps every 4 frames and faded by rank. Never add or remove lights. Remove the point-light loop from the road and terrain shaders so the ground isn't lit twice. |
| d. Windows | MAP | The bake adds a use class (residential/office/retail/hotel/civic/industrial) and a 16-bit id. A 6×24-byte schedule texture plus `uHour` sets per-window on/off times. Offices switch whole floors at 4000K; homes switch per unit at 2700K, with ~3% TV flicker. Retail stays lit to ~21:00. Fade out by `fwidth`. Optional interior mapping on high quality. |
| e. Neon / LED | MAP | Sign quads using a procedural 1024² atlas of generic words (no logos or names), with steady/flicker/chase/scroll modes in the shader. Bay Lights get a pattern shader stepped to the LED spacing: Bay Lights 360, ~50k LEDs, both sides of the bridge (2026). |
| f. Bridge cable lights | MAP | Instanced glows sampled along the cable curves from bake parameters. |
| g. Traffic signals | MAP + **[physics]** | One InstancedMesh of heads per tile. A pure `world.signalPhase(intId, t)` drives both the lamps and the traffic AI. |
| h. Wet roads | MAP shader, env supplies `wetness` | Roughness 0.92→0.25, albedo ×0.6. Streaky reflections come from intersecting the reflected ray with the lamp-head plane and sampling the light field's alpha channel. No SSR or Reflector. |
| i. Bloom / tone mapping | Integrator (env.js) | Keep threshold bloom. Glow cores 3–8, windows ≤0.6, threshold about 0.9. Bloom strength rises with fog. Consider AgX (available in r160). Night exposure about 0.9. Fog/horizon tinted by `world.skyGlow`. Add a city-light horizon band to the PMREM probe. |

**Budget (rough):** about 130 extra draw calls with ~25 tiles resident, and about 30 MB of textures.

**Contract changes:**
- `env` becomes `{night, time, hour, fogDensity, wetness}`.
- New `world.lightField`, `world.signalPhase(intId, t)` and `world.skyGlow`.

## Bake output per tile

| Record | Fields | Bytes |
|---|---|---|
| Lamp | x,z u16 tile-local; height above ground u8 (0.1 m); heading u8; colour-temperature class u8 (1800/2100/3000/4000K); fixture/flags u8 | 8 |
| Building | use class u8, schedule override u8 | 2 |
| Shopfront edge | building u16, edge u8 | 3 |
| Sign | position 6, facing 1, size 2, glyph 2, colour 1, animation 1 | 12 |
| Signal head | position 6, heading 1, intersection id 2, phase group 1, type 1 | 11 |
| Light string | endpoints, sag, spacing, colour | ~40 |

About 8.5 KB/km² raw (~5 KB gzip) at SF density, roughly +5–7% on the current world file. Light pools are generated on the GPU at load, so they cost nothing on disk.

## Sources
- three.js r160 WebGLPrograms.js (light counts in the program key): https://github.com/mrdoob/three.js/blob/r160/src/renderers/webgl/WebGLPrograms.js
- discourse.threejs.org threads on many lights in a city game: /11802/7, /36153
- GTA V graphics study pt. 2 (batched distant lights): https://www.adriancourreges.com/blog/2015/11/02/gta-v-graphics-study-part-2/
- r160 SpotLight docs (`.map` needs castShadow)
- Interior mapping: https://www.alanzucconi.com/?p=10105
- The Bay Lights: https://en.wikipedia.org/wiki/The_Bay_Lights
- r160 selective bloom example

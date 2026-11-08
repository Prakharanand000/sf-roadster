# Tiled world format: judged proposal (MAP side)

Date: 2026-10-26. Author: MAP team (judging pass over three independent designs: *min-disruption*,
*streaming-perf*, *accuracy-first*). Builds on `tools/MAP_RESOURCES.md` (blockers 1-8) and is meant to
be read with `CONTRACTS.md`.

**What I checked in the code for this judgement** (all claims below about call sites were re-read, not taken
from the designs):

- `src/physics/vehicle.js`:
  - :91-92 surface tables use `?? 1` / `?? 0` fallbacks.
  - :226 `reset` defaults to `surfaceHeight(x,z,1e4)`.
  - :269 the water test hard-codes `y < 0.3` and `y < -0.5`.
  - :802 "never below terrain" uses `heightAt`.
  - :886 the ledge re-probe.
- `src/physics/ai.js`:
  - :82 and :123 call `world.groundHeight(x,z)` with no y reference.
  - :83 is the fallback path, which already chains `yRef = y + 2`.
- `src/physics/traffic.js`:
  - :190 `placeCar` sets `car.y = NaN`, so the first pose uses yRef 1e4.
  - :137-160 endpoint links are made by xz distance (12 m) only.
  - :200-230 `_spawn` samples uniformly over all road length.
- `src/main.js`:
  - :159 the camera ground clamp uses `heightAt`.
  - :604 gates are placed with `surfaceHeight(..,1e4)`.
  - :546/575/581/654/657 call `reset` without y.
- `src/world/worlddata.js`:
  - `surfaceHeight` always takes terrain as a candidate, which is why tunnels fail.
  - `collideCircle` skips solids with top ≤ y+0.75 or base > y+3.
  - `deckAt` is the Golden Gate special case.
- The `dev/physics-ai-*.mjs` tests import `createWorldData` from `city.js`.
- `dev/physics-ai-probe2.mjs` calls `Q.roadAt`. The real world has no `deck` member; `dev/physics-test.html` uses the mock's `world.deck`.
- Sibling research:
  - `validation.md` §0.2 pins the vertical datum: MSL is 0.969 m above NAVD88 at NOAA 9414290, epoch 1983-2001. It also requires `y0_navd88` in the data.
  - `water-shoreline.md` recommends the opposite convention (see Open questions).
  - `night-lighting-rendering.md` wants per-tile lamp/sign sections.

---

## 1. Scores

Scale 1-5, **5 is always best**: 5 = least disruption, best performance, most accurate, least effort, lowest risk.

| Criterion | min-disruption | streaming-perf | accuracy-first |
|---|---|---|---|
| Disruption to physics owner | **5**. Five small, feature-detected edits; no signature changes; nothing removed | **3**. Same edits plus removal of `deckAt`/`roadAt`/`landcoverAt`/`data` (a physics dev probe uses `roadAt`) and a new `loadWorld` option | **2**. Changes the `collideCircle` and `isWater` signatures, makes `heightAt` invalid in tunnels, requires `surfaceInfo`/`floorAt`/`ceilingAt`/`addFocus` plus mock updates; long step-7 migration for Prakhar |
| Runtime performance at 1,500 km² | **3**. Sound streaming (worker, 1 tile/frame, LRU, single-tile queries), but no terrain LOD technique and no draw/memory budgets; 1 m ground material in the render file is heavy; pins every track corridor at boot (~15 MB first load) | **5**. CDLOD over the same R16UI heights physics reads, HLOD buildings, explicit draw/triangle/GPU/heap budgets, precompiled materials, upload budget, time-to-reach priority, hashed immutable file names, no L0 over open water | **3**. Small physics tiles (~105 KB) and BatchedMesh, but TIN point location costs more per query than a grid, multi-tile `collideCircle` via `reach` masks, and `addFocus` keeps tiles resident around every car |
| Physics accuracy | **4**. 2 m lidar grid plus fitted road/sidewalk ribbons (crown, superelevation, curb heights), exact global decks and tunnels, tunnel-envelope rule; overlap of ribbons at junctions not addressed | **3**. 1 m grid captures grade and crown, but curbs are only visual polylines and a 1 m material class; no curb geometry in the physics data | **5**. Drive TIN with exact cross-sections, curb steps, junction patches, exact triangle normals, barrier capsules, roughness from PCI, seam-exact borders, strong validation gates |
| Implementation effort for map team | **3**. Ribbon fitting and global structure net are real work, render side under-specified (will grow) | **2**. Simple physics data, but a large render build (CDLOD, HLOD-1/2, imposter atlas, KTX2 albedo, worker pool) | **1**. Cross-section fitting every ≤10 m to 1 cm, lidar curb-step detection, constrained-Delaunay junction stitching, derived tunnel/lower-deck interiors, plus the full render LOD stack |
| Risk | **4**. Incremental, everything feature-detected, parity test before switching; corridor pinning grows with track count | **3**. ~310 MB in ~2,000 files near likely host limits; API removals; curb physics left for later | **2**. Junction-patch bumps, exact 15 cm steps against single-ray wheels (the design flags it itself), many new physics-facing calls, longest path to a playable build |
| **Total (/25)** | **19** | **16** | **13** |

**Verdict:**
- Use **min-disruption as the spine.** It keeps physics on the same synchronous calls and costs Prakhar about 10 lines.
- Graft in **streaming-perf's render/LOD and budget machinery**, its "no L0 over water" rule, and its fallback chain.
- Graft in **accuracy-first's seam rule, its simpler tunnel rule, its validation gates, and a reserved TIN section** so junctions can be upgraded later without changing the format.

---

## 2. Recommended design ("SFT1")

### 2.1 Coordinates and datum

**Projection**
- Use `+proj=tmerc +lat_0=37.7880 +lon_0=-122.4075 +k_0=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m` on NAD83(2011), computed in float64 with pyproj, in `tools/geo.py` only.
- x = easting, z = −northing. The origin stays at Union Square.
- Scale error is about 5 ppm at the Phase 2 east edge (21 km) and about 60 ppm at San Jose (70 km).
- The runtime never projects. `world.project(lat,lon,out)` and `world.unproject(x,z,out)` exist only as helpers for tools.

**Datum alignment**
- OSM, Overture and DataSF are reprojected with pyproj.
- The bake then measures each district's remaining offset against lidar curb breaklines and applies a fitted shift when it exceeds 0.3 m.
- Lidar is the geometric truth. OSM supplies topology and attributes only.

**Vertical**
- `y = H_NAVD88(GEOID18) − y0`, with `y0 = 0.969 m` (MSL above NAVD88 at 9414290, epoch 1983-2001, from `validation.md` §0.2).
- The bake writes `datum: { vertical: "NAVD88/GEOID18", y0_navd88: 0.969 }` to the manifest.
- Sea water stays at **y = 0**, so `vehicle.js:269` and the contract's "water level is y = 0" stay true.

**Tile grid**
- L0 tiles are 512 m: `i = floor(x/512)`, `j = floor(z/512)`, and the tile centre is `((i+0.5)·512, (j+0.5)·512)`.

**Packing**
- Tile-local x/z are **int16 at 1/32 m from the tile centre** (±1,024 m), so halo copies and large footprints fit without clipping.
- **Seam rule** (from accuracy-first): every vector vertex is quantised once on the global 1/32 m lattice, then the integer tile centre is subtracted. A vertex shared by two tiles therefore decodes bit-identically in both.
- Heights are **uint16 cm above a per-tile f32 `hBase`** (655 m range). The global `net` file uses int32 cm.

**Render precision**
- Vertices are float32 and tile-local, and each tile's Object3D sits at its tile origin. three.js composes modelView in float64, so there is no jitter in the Bay Area.
- Shaders never use float32 world position for noise; they take a `uTileOrigin` uniform.

### 2.2 Levels and files

| Level | Tile | Height grid | Contents | Resident (high / low quality) |
|---|---|---|---|---|
| L0 `q` (query) | 512 m | 2 m, 256 cells, 259² samples (shared border + 1 apron) | everything physics reads (2.4) | 1 km radius + 3 s velocity look-ahead + pinned corridors / same |
| L0 `r` (render) | 512 m | none (uses q heights) | building visuals, roof planes, trees, props, ground tint, lighting sections (2.5) | 768 m / 512 m |
| L1 | 2,048 m | 8 m, 256 cells + apron | terrain, HLOD-1 footprints (≤12 vertices, flat roofs; **also collision fallback**), tree imposter points, 8 m landcover + water mask, night emissive mask | 6 km / 3 km |
| L2 | 8,192 m | 32 m, 256 cells + apron | terrain, block prisms in 3 height tiers, towers > 40 m | always |
| `net` | global | 16 m coarse heights + water mask | road network (with y), road graph, road spatial index, **every bridge/viaduct/ramp/tunnel structure**, structure barriers, tracks, landmarks, spawn | always |

**Notes on the levels**
- Every grid level has 256 cells plus a 1-sample apron (from streaming-perf), so one patch mesh and one texture format serve all levels and edge normals are exact.
- **No L0 over open water** (from streaming-perf). The manifest carries a tile bitmap. Water-only slots answer from L1 (bathymetry resampled from CoNED/USGS) and `net`. Piers and shoreline tiles get an L0.
- **Structures live in `net`** (from min-disruption), so decks and tunnels never stream out and the Golden Gate special case disappears.
  - Estimate: under 1.5 MB for Phase 1+2.
  - If Phase 3 pushes `net` past about 5 MB, split it by region into `net/{region}`.

**Paths**
- `data/manifest.json`
- `data/net.{hash8}.wasm`
- `data/q/{i}_{j}.{hash8}.wasm`
- `data/r/{i}_{j}.{hash8}.wasm`
- `data/l1/{i}_{j}.{hash8}.wasm` and `data/l2/...`

The hashed names make tiles immutable for the HTTP cache. The `.wasm` extension is kept, as today, so static hosts serve the bytes untouched.

### 2.3 File format (all levels)

**Header** (little-endian), then a section table, then the payload:
- magic `SFT1`
- u16 version, u8 level, i32 i, i32 j
- f64 originX, f64 originZ
- f32 hBase
- u16 sectionCount

**Section table entries**
- u16 id, u8 codec (0 raw, 1 gzip), u32 offset, u32 rawLen, u32 compLen.
- Each section is compressed on its own. That lets the worker decode physics sections first, and lets the bake skip rewriting unchanged sections.

**Unknown section ids are skipped.** The lighting team can add `LAMP`, `SIGN` and `SIGH` sections to `r` without a version bump. Id ranges are reserved per team in the manifest.

**Codec detection**
- If a section that should be gzip already starts with something other than `1f 8b`, treat it as raw.
- This covers hosts that add `Content-Encoding`, in which case fetch has already inflated it.
- Decoding uses `DecompressionStream('gzip')` in browsers and in Node 18+, and `zlib` in Node tests.

### 2.4 `q` (query) sections

| Id | Section | Encoding | Raw per km² (est.) |
|---|---|---|---|
| `HGT` | bare-earth/drive grid, 259² | uint16 cm above hBase; planar-predictor residuals, zigzag | 510 KB |
| `RIB` | layer-0 road and sidewalk ribbons | per ribbon: header {wayId u32, kind u8 road/sidewalk/median, surf u8, nStations u16}; per station **16 B**: x i16, z i16, y u16 cm, halfL u16 cm, halfR u16 cm, crossL i8 (0.1%), crossR i8, curbL u8 cm, curbR u8 cm, bevel u8 (cm), flags u8 | 50 KB |
| `SOL` | solids: buildings, pillars, landmark parts, retaining walls | per solid: nV u8, ring i16 xz, base u16, top u16, roof u8, kind u8, global id u32 (`tile << 16 \| index`, no 62k cap) | 75 KB |
| `LC` | surface class at 2 m (road, sidewalk, brick, grass, sand, dirt, pier, rail…) | u8 RLE | 40 KB |
| `TUN` | tunnel polygons crossing this tile (pointer into `net` structures) | polygon i16 xz, structId u16 | <1 KB |
| `HALO` | collision-only copies of neighbour solids within 32 m of the tile edge | same as `SOL` | 6 KB |
| `JTIN` | **reserved, empty in v1**: accuracy-first's junction TIN (vertices 3×i16, triangles 3×u16 + mat u8 + flags u8) | — | 0 |

**Bake rules for ribbons**
- Stations are adaptive, at most 4 m apart.
- Crown and superelevation come from robust plane fits to lidar ground returns for each half of the carriageway; Caltrans defaults apply where the lidar is sparse.
- Curb lines come from DataSF `emxt-b6yg`. Curb heights come from lidar step detection (default 15 cm).
- The curb is a **bevel** (default 25 cm wide) rather than a vertical step. That is the wheel-envelope compromise accuracy-first recommends for single-ray wheels.
- Ribbons end at junction mouths and never overlap; the bake asserts this.
- Junctions are grid. The bake first burns the ribbon surfaces into `HGT`, then fills junctions so that each mouth matches its ribbon end within 1 cm.
- If the gate in 2.7 fails at a junction, that junction gets `JTIN` triangles. The format does not change.

**Gzip estimate:** about 250-300 KB per km² for `q`, roughly 70 KB per tile. This is an estimate; the pilot bake measures it.

### 2.5 `r` (render) sections

| Section | Encoding | Raw per km² (est.) |
|---|---|---|
| Building visuals | 16 B per building: roof type and parameters, facade kit and style, wall and roof RGB565, eave and top bands, schedule/use class (night lighting) | 25 KB |
| Lidar-fitted roof planes for complex roofs | variable | 40 KB |
| Trees | x/z i16, kitId u8, height u8 (0.25 m), crown u8, seed u8 (from `vegetation.md`) | 21 KB |
| Props | x/z i16, y u16, type u8, yaw u8, param u8 | 12 KB |
| Ground material id | u8 at 2 m (reuses `LC` from q) plus NAIP tint RGB565 at 4 m. Optional KTX2 ETC1S albedo at 2 m/px (decoded with r160's KTX2Loader, decoder vendored) | 130 KB |
| Lighting sections (owned by the lighting team) | per `night-lighting-rendering.md` | ~8.5 KB |

I dropped min-disruption's 1 m ground material grid, which was 1.1 MB raw per km². Roads and curbs are drawn from ribbons, so 2 m classes plus 4 m tint are enough for ground colour.

**Gzip estimate:** about 120-180 KB per km².

### 2.6 `net` (global)

**Roads**
- Simplified centrelines, with **y per point**, `level` (−1 tunnel, 0 ground, ≥1 structure), `struct` id, width, type, name, oneway, CNN and wayId.
- The road graph.
- A CSR hash over road segments with 128 m cells, for `roadsNear`.

**Structures**
- Records: `{id, name, kind: bridge|viaduct|ramp|tunnel, level, clearance dm, parapet cm, source: lidar|derived|haer}`.
- Each structure has deck ribbons in the same 16 B station format, including bank.
- Barriers are capsules: parapets, Jersey barriers and tunnel walls, each with base, height and thickness.
- Tunnel polygons and their ceiling heights.
- Pillars are ordinary `SOL` records in the tiles they stand in.
- Bay Bridge lower-deck and YBI tunnel interiors that lidar cannot see are `source: derived`, from HAER `ca1352` drawings or interpolated between portals, and get manual QA.

**Everything else**
- Tracks (path, checkpoints and grid all with y), landmarks, spawn (with y), attribution.
- A 16 m height grid and water mask over the whole bbox, as the last-resort fallback.

### 2.7 Query semantics (what physics sees)

**One tile per query**
- A point belongs to exactly one tile (`floor`).
- Every feature overlapping the tile plus a 32 m margin is copied into that tile.
- So any query with radius ≤ 32 m reads exactly one q tile plus `net`, and returns the same answer whichever neighbours are loaded.
- Lookup goes through a dense slot array over bounds plus a last-tile cache, with no Map lookups. Queries are allocation-free.

**Ground at (x, z)**
- If a layer-0 ribbon covers the point, ground is that ribbon's analytic surface (centre-line y lerped between stations, plus cross-slope, plus curb bevel).
- Otherwise ground is the `HGT` grid, using today's triangle split.

**Surface selection** (`surfaceHeight` / `normalAt` / `surfaceAt`, yRef, `lim = yRef + 0.75`). This takes accuracy-first's rule, which is simpler than an envelope test:
1. Ground is always a candidate, **except inside a tunnel polygon**. There it is a candidate only if ≤ lim, like any other layer. A car on the hill above the Broadway tunnel gets the hill; a car inside gets the tunnel floor.
2. Structure deck ribbons (layer ≥ 1, tunnel floors) and flat roofs are candidates when ≤ lim.
3. The highest candidate wins. If there is none (only possible below a tunnel floor), the result is the tunnel floor.
4. **Outside tunnel polygons and structure footprints this is bit-for-bit today's rule.**

**Normals** come from the chosen surface: the grid triangle plane, the analytic ribbon gradient, straight up for roofs, or the deck ribbon with bank.

**`collideCircle`**
- Covers tile solids (buildings, pillars, landmark parts) plus `net` barrier capsules.
- Uses the same skip rule as today (top ≤ y+0.75 or base > y+3). That rule already passes under decks and ignores pillars from the deck above.
- Also writes `out.top`.

**Fallback when a q tile is not resident** (from streaming-perf):
- Queries never throw and never return NaN.
- Heights come from L1 at 8 m, otherwise from `net` at 16 m.
- `collideCircle` uses the L1 HLOD-1 footprints.
- Structures and tunnels are always exact, because they live in `net`.
- `world.isLoaded(x,z)` reports full detail, and `world.stats.misses` counts fallbacks.
- When a tile arrives it goes live by an atomic swap at a frame boundary.

**Validation gates** (Node, `tools/test_world.mjs`, extending `validation.md`):
- Height difference across tile borders is exactly 0 at 10⁵ border points.
- Steps across ribbon/grid boundaries are ≤ 2 cm. If this fails, the junction gets `JTIN`.
- Filbert and 22nd St grades are within ±0.5 pp of 31.5%.
- Curb heights are within ±2 cm of lidar.
- A scripted drive over both Bay Bridge decks and through the Broadway and YBI tunnels shows no layer flips.
- The old and tiled worlds agree (step 4 of the migration).

### 2.8 Loader and streaming

**`loadWorld` resolves after loading:**
- the manifest, `net` and all L2 tiles;
- L1 within 4 km;
- q tiles within 1 km of spawn;
- r tiles within 300 m;
- **q tiles along every shipped track corridor (path ±60 m), pinned.**

The corridors are about 80 tiles (~5 MB gzipped) for the six tracks. They are pinned because `AIDriver` samples heights along the whole path when it is constructed (ai.js:74-83). With them pinned, main.js needs no change on day one. The boot download is roughly 12-15 MB (estimate).

**`update(dt, camera, env)`** (signature unchanged):
- Builds the wanted set from camera position and velocity (3 s look-ahead) plus pins.
- Priority is time-to-reach, in tiers:
  1. player q
  2. pinned q
  3. L0 r
  4. L1
  5. L2
- Up to 6 fetches run at once.
- Decoding happens in 2 module workers. The workers contain no three.js, because import maps do not reach workers. They return transferable typed arrays: physics arrays (CSR hashes for solids at 16 m and ribbons at 32 m) and render buffers (extrusions, ribbon strips, instance matrices).
- On the main thread, attaching takes at most 2 ms or 4 MB of GPU upload per frame.
- All materials are shared and precompiled at boot.
- Render arrays drop their CPU copies through `onUpload`; physics arrays stay.

**Eviction** is LRU beyond 1.5× the radius:
- caps are 128 q tiles (about 45 MB decoded), 40 r tiles and 30 L1 tiles;
- pinned tiles are never evicted;
- a 128 MB LRU of compressed bytes is kept for fast re-entry.

**Later:** `world.ensure(area)` gives on-demand pins (section 3, item 14). When the integrator adopts it at race start, boot pinning is turned off with `loadWorld(scene, { pinTracks: false })`.

### 2.9 Render LOD and budgets (from streaming-perf, adjusted)

**Terrain**
- CDLOD on a factor-2 quadtree with one shared 64×64 patch mesh.
- Heights are R16UI textures read with `texelFetch` on a `usampler2D`. They are the same uint16 arrays physics reads, so near the car the rendered ground *is* the physics ground.
- Geomorphing covers the last 30% of each LOD band.

**Roads**
- Ribbon strips are drawn inside the L0 ring.
- Beyond it, roads are painted into the ground tint.
- The near plane is 0.5 m. Logarithmic depth is not needed at a 26 km far plane if the near plane is raised.

**Buildings**
- L0: full detail.
- L1: HLOD-1, dropping buildings under 6 m beyond 1.5 km.
- L2: block prisms plus towers.
- Every level keeps style and floor UVs so the night window shader works across the skyline.

**Trees**
- InstancedMesh per kit out to 300 m.
- Atlas imposters out to 2 km.
- Canopy colour in the ground tint beyond that.

**Budgets (high quality):**
- At most 150 main-pass draw calls and 2.5 M triangles for the world.
- Shadow pass: L0 content within 110 m only.
- About 300 MB GPU and 250 MB JS heap for the world.

### 2.10 Size (estimates, to be replaced by the pilot bake)

| Item | Phase 1+2 (~330 km² land) |
|---|---|
| L0 q + r | ~330 km² × ~0.45 MB = ~150 MB |
| L1 + L2 + net + manifest | ~15 MB |
| **Total on host** | **~165 MB in ~2,800 files** (q and r for ~1,300 land tiles, plus L1 and L2) |
| At 1,500 km² (Phase 3) | about 3× the land, so ~450-500 MB and ~8,000 files: the host limit question in section 5 |

### 2.11 Where each idea came from

| Idea | Source |
|---|---|
| Same synchronous API; feature-detected physics edits; separate q/r files; global `net` structures; corridor pinning; per-tile hBase; 1/32 m int16 coordinates; parity test | min-disruption |
| CDLOD on shared R16UI heights; uniform 256-cell + apron grids; no L0 over water; L1 footprints as collision fallback; budgets; hashed file names; time-to-reach priority; per-section compression | streaming-perf |
| Seam lattice rule; tunnel rule ("ground must also be ≤ lim inside a tunnel polygon"); curb bevel; reserved junction TIN; validation gates; `floorHeight` instead of re-using `surfaceHeight` for the clamp | accuracy-first |
| Codec sniffing; unknown-section skipping for the lighting team; explicit `y0_navd88 = 0.969` | this judgement |

---

## 3. Proposed CONTRACTS.md changes (for Prakhar)

Prakhar: every physics edit below is **feature-detected**. Your code keeps working against today's world, the
new world and `mockWorld.js`, so either side can merge first. Each item gives what the contract says now, what we
propose, why, and the exact edit on your side, if any. Items 1-4 and 10-13 need **no code from you**.

1. **Projection text** (no physics edit)
   - *Before:* `x = (lon - LON0) * 111320 * cos(LAT0)`, `z = -(lat - LAT0) * 110540`.
   - *After:* the local transverse Mercator in 2.1, defined in `tools/geo.py` and exposed as `world.project/unproject`.
   - *Why:* today's constants squash the map by 0.41% N-S and 0.13% E-W (~40-50 m across SF). Nothing under `src/physics` uses lat/lon.

2. **Vertical datum text** (no physics edit)
   - *Before:* "Water level is y = 0".
   - *After:* "y = NAVD88 (GEOID18) height − 0.969 m (MSL at NOAA 9414290, epoch 1983-2001); sea water is y = 0; the manifest records `datum.y0_navd88`".
   - *Why:* the validation suite needs an explicit datum. Keeping sea at 0 keeps your `inWater` thresholds at vehicle.js:269 valid.

3. **`surfaceHeight` / `normalAt` / `surfaceAt` semantics** (same signatures, no physics edit)
   - *Before:* "terrain, bridge decks, flat building roofs", with the Golden Gate as the only deck.
   - *After:* any number of stacked decks, viaducts, ramps and tunnel floors, plus the tunnel rule in 2.7. A tunnel floor reports `'road'`, a deck `'bridge'`.
   - *Why:* the Bay Bridge (two decks), I-80/US-101/I-280 viaducts and the Broadway/Stockton/YBI tunnels.
   - Results are identical to today outside tunnel polygons and structure footprints.

4. **`heightAt` text** (no physics edit after item 5)
   - *Before:* "terrain (ground) height".
   - *After:* adds "bare earth; NOT a valid floor inside tunnels (use `floorHeight`)".
   - *Why:* inside a tunnel, terrain is the hill above the car.

5. **New `floorHeight(x, z)`**: the lowest drivable surface. It equals `heightAt` everywhere except inside tunnel polygons, where it returns the tunnel floor.
   - **Your edit (1 line), vehicle.js:802:** `const tH = (world.floorHeight || world.heightAt)(com.x, com.z);`
   - *Why:* the "never below terrain" clamp would teleport every car out of a tunnel onto the hill above.
   - This is more robust than re-using `surfaceHeight(.., com.y)`: a car that falls below a tunnel floor is put back on the floor, not on the hilltop.

6. **`groundHeight(x, z)` → `groundHeight(x, z, yRef = 1e4)`**
   - It is not in the contract today, but city.js exposes it and ai.js:82 and :123 call it.
   - *After:* documented as "highest terrain, deck or tunnel floor ≤ yRef + 0.75, ignoring roofs, with the same tunnel rule".
   - **Your edit (~4 lines), ai.js:**
     - At :82 pass `k === 0 ? seedY : y + 2`, with `seedY = track.path[0][2] ?? heightAt + 1`.
     - In the `gh`/`hl` helpers from :123, pass `this.h[i] + 2` (or `heightAtS(ss) + 2`).
   - *Why:* with no y reference, the AI on the Embarcadero Sprint reads the Bay Bridge approach deck it drives under, and on the SoMa and Central Freeway viaducts it sees fake "steps" of about 10-20 m and hops.
   - Your existing fallback at :83 already chains yRef, so the logic is not new.

7. **`roads[i].points`: `[[x,z]]` → `[[x,z,y]]`**, plus `roads[i].level` (−1 tunnel, 0 ground, ≥1 structure) and an optional `struct` id.
   - **Your edits (traffic.js):**
     - `placeCar` (:190): seed `car.y` from the interpolated road y instead of `NaN`.
     - `_prepRoads` (:137-160): skip an endpoint link when the two ends differ in y by more than 2 m.
   - *Why:*
     - With `car.y = NaN` the first pose uses yRef 1e4, so a surface-street car under a viaduct spawns on the deck and then rides along the deck.
     - xz-only linking connects ramps to the streets under them.
   - Extra array elements are ignored by today's code (`points[i][0]`, `[1]`).

8. **`tracks[i].path`, `checkpoints[]`, `grid[]` and `spawn` gain `y`** (`[x,z,y]`, `{x,z,y,heading}`).
   - Your edit: none required. You can use `path[0][2]` as the AI seed in item 6.
   - *Why:* it gives every consumer the right deck level without probing at 1e4.

9. **New `roadsNear(x, z, r, out) → count`.** It writes road indices into `out` (allocation-free; global 128 m hash in `net`).
   - **Your edit (traffic.js `_spawn`, :200):** when `world.roadsNear` exists, sample from the returned roads weighted by length instead of from the global cumulative table.
   - *Why:* uniform sampling with 24 tries succeeds about 9× less often at 400 km² (MAP_RESOURCES item 8), and an estimated 20-30× less at 1,500 km². Traffic would starve.

10. **New, optional `ceilingHeight(x, z, y)`**: the underside of the lowest deck soffit or tunnel roof above y, or `Infinity` in open air.
    - Your edit: optional, whenever you like (cap hop/hover height).
    - *Why:* a thruster hop on the Bay Bridge lower deck or in the YBI tunnel otherwise passes through the deck above, and `surfaceHeight` then snaps the car onto it.

11. **`collideCircle`**: same signature, same skip rule.
    - *After:* it now also hits viaduct pillars, deck parapets, Jersey barriers and tunnel walls, and additionally writes `out.top` (the top of the hit solid).
    - Your edit: none. Optionally use `out.top` instead of the ledge re-probe at vehicle.js:886.
    - *Why:* structures need walls, and `top` saves a query.

12. **`surfaceAt` enum: additive `'brick'` and `'dirt'`** (Lombard's crooked block, Presidio and Headlands trails).
    - Your edit: none. `SURFACE_GRIP[s] ?? 1` and `SURFACE_DRAG[s] ?? 0` already cover unknown strings, and fx.js defaults too. Add table entries if you want them to feel different.

13. **Streaming guarantee** (new paragraph, no physics edit): "All World queries stay synchronous and allocation-free, and never throw or return NaN inside `bounds`.
    - Within 1 km of the camera and along pinned track corridors they are full detail.
    - Elsewhere heights are coarse (8-16 m) and `collideCircle` uses simplified footprints, but decks and tunnels are always exact.
    - `isLoaded(x,z)` says which.
    - Every shipped track corridor is pinned when `loadWorld` resolves."
    - *Why:* it tells you exactly when AI and traffic can trust the data. Rivals in a race stay on the pinned corridor, and traffic stays within 600 m, which is inside the 1 km radius.

14. **FYI, integrator-only (not your files):**
    - `world.ensure({x,z,r} | {path, halfWidth}) → Promise<{release()}>`, `world.isLoaded(x,z)` and `world.stats`, for race start, teleports and resets.
    - main.js:159 camera clamp → `surfaceHeight(x, z, camY)`.
    - main.js:604 gates → use `checkpoint.y`.
    - main.js:546/575/581/654/657 → pass the slot or road y to `reset`. The default `surfaceHeight(x,z,1e4)` picks the top deck or a roof.

15. **Kept, not removed:**
    - `deckAt`, `roadAt`, `roadHit`, `landcoverAt` stay as non-contract extras. `deckAt` is deprecated and backed by the generic structures.
    - `createWorldData(index, buffer)` keeps working for your `dev/physics-ai-*.mjs` tests, and `createWorldDataFromDir(dir)` is added.
    - *Why:* `dev/physics-ai-probe2.mjs` uses `Q.roadAt`, and removing these buys nothing.

**Considered and not proposed**, each with the reason:
- `surfaceInfo(x,z,yRef,out)` combined query: revisit only if profiling shows world queries above about 1 ms per frame.
- `addFocus(body)`: corridor pinning plus the 1 km radius already cover every moving body.
- `collideCircle(.., step)` parameter: no consumer yet.
- `isWater(x,z,y)` / `waterLevelAt`: see open questions.
- Removing members: it breaks dev tools.

`mockWorld.js` needs nothing. If you want parity, add `floorHeight = heightAt`, `ceilingHeight = () => Infinity` and a brute-force `roadsNear`.

---

## 4. Migration plan (ordered)

1. **Confirm host limits** before anything is sized:
   - total bytes, file count and per-file size of the publishing sandbox;
   - whether it adds `Content-Encoding` on `.wasm`;
   - GitHub Pages' 1 GB site limit, if that is used.
2. **Contract PR with Prakhar** (items 1-15). The MAP side ships the additive members on today's single bin:
   - `floorHeight = heightAt`;
   - `groundHeight` with yRef;
   - roads, tracks and spawn with y (from today's heightfield);
   - `roadsNear`;
   - `ceilingHeight → Infinity`;
   - `ensure` resolving immediately, and `isLoaded → true`.

   Prakhar's edits can land before or after.
3. **Projection and datum swap** in `geo.py` (TM plus `y0_navd88`), then re-bake today's area as a single bin.
   - Positions shift by up to about 45 m and heights by −0.969 m.
   - Rerun `dev/physics-ai-*.mjs`, `tools/test_world.mjs` and the `validation.md` checks.
   - Grep the dev tests for hard-coded coordinates first.
4. **Tiled writer plus `src/world/tiles.js` in eager mode** (loads every tile) behind the existing `Q` interface. Keep `createWorldData`.
   - **Parity test:** old vs tiled on `heightAt`, `surfaceHeight`, `surfaceAt`, `collideCircle`, `groundHeight`.
   - Sample 10⁶ random points, every track path, and 10⁵ tile-border points.
   - Tolerance: within quantisation (1 cm), identical collision hits, border difference exactly 0.
5. **Pilot bake of Nob Hill plus FiDi (~4 km²)** with the new content (2 m lidar `HGT`, ribbons, curbs).
   - Measure gzip per km², decode ms per tile and fps.
   - Run the gates in 2.7.
   - Update the size table in 2.10 with real numbers.
6. **Streaming on:** workers, LRU, fallback chain, corridor pinning at boot, CDLOD terrain on shared R16UI heights, and the L1/L2 render levels.
7. **Phase 1 content, all of SF:**
   - Uncapped buildings and the lidar refresh of post-2010 heights.
   - Structures in `net`: Central Freeway, I-80, US-101, I-280, the Bay Bridge west approach. The Golden Gate becomes a generic structure.
   - **Tunnels behind the manifest flag `features.tunnels`,** switched on only after Prakhar's item-5 edit is merged.
8. **Integrator adoption:** `ensure()` at race start, teleport and reset; the camera clamp; gate y. Then flip `pinTracks: false`.
9. **Delete the single-bin path.** `deckAt` stays as a deprecated alias for one release.
10. **Phase 2:** more tiles plus `net` additions (Bay Bridge both decks, YBI tunnel, East Bay). There is no format change; the lighting team adds its `r` sections independently.

---

## 5. Open questions

1. **Host limits and git.**
   - Phase 1+2 is roughly 165 MB in about 2,800 files; Phase 3 is roughly 500 MB in about 8,000 files (estimates).
   - Does the sandbox accept that? GitHub Pages does not serve LFS.
   - Do we publish data from a squashed or orphan branch so that rebakes don't bloat `main`'s history? The bake must be deterministic (gzip mtime 0, stable ordering) either way.
   - If the file count is capped, bundle 4×4 tiles into packs with an index. This does not need Range requests.
2. **Datum conflict between research notes.**
   - `water-shoreline.md` recommends y = 0 at NAVD88 with water at +0.97 m.
   - This proposal (and `validation.md`) puts y = 0 at MSL so physics' water thresholds hold.
   - Tide animation would then oscillate about 0 (about −0.95 to +0.83 m at SF) in render only, with physics' water fixed at 0.
   - Needs sign-off from the water agent and Prakhar.
3. **Lakes above sea level** (Lake Merced, Stow Lake, Spreckels; Lake Merritt is tidal). Today `inWater` (`y < 0.3`) never triggers there. Is that acceptable, or does physics want `waterLevelAt(x,z)`? This is Prakhar's call, and separate from the tile format.
4. **Curb feel.**
   - A 25 cm bevel is the default. Prakhar should drive the Nob Hill pilot and say whether curbs should be steeper (narrower bevel) or softer.
   - The bevel width is a per-bake manifest parameter.
5. **Junction quality.** Is the grid good enough at SF's flattened steep-street intersections, or do we need `JTIN` everywhere? Decide from the pilot's ribbon/grid step histogram.
6. **Derived interiors.** Bay Bridge lower deck and YBI tunnel geometry from HAER drawings: who does the manual QA, and to what tolerance?
7. **Free-roam rivals.** If rivals ever exist outside a pinned corridor, they would drive on fallback data (no building walls). Is a kinematic fallback needed (Prakhar), or should the integrator pin around them with `ensure`?
8. **Combined query.** Should `surfaceInfo` be added later? Only if the 120 Hz × 4 wheels × N cars query cost shows up in profiles at Bay Area scale.
9. **Track count growth.** Boot pinning costs about 1 MB per track. Past about 10 tracks the integrator must switch to `ensure()` at race start (step 8).
10. **Phase 3 `net` size.** The Richmond–San Rafael, San Mateo and Dumbarton bridges plus the Peninsula freeways may push `net` past 5 MB. If so, split it by region.

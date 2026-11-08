# v2 world: build plan ("grow beyond today's map")

Started 2026-10-26. Goal: the map grows from northern SF to all of SF, the Bay Bridge,
Yerba Buena / Treasure Island, Oakland, Emeryville and Berkeley, at 1:1 with lidar ground and
measured roads.

**Ground rules**
- v2 is built alongside v1 and selected with `?world=v2`. v1 stays the default and is not touched
  until v2 passes every gate below.
- No edits outside the MAP area (tools/, data/, src/world/). `CONTRACTS.md` changes stay in
  `tools/contracts-sft1.patch` until applied deliberately.
- Nothing that needs Prakhar's physics edits is switched on. Instead, structures are modelled so
  they work under today's physics. For example, a tunnel is a cut floor plus a deck for the hill
  above, so the `heightAt` clamp at vehicle.js:802 keeps cars inside it.
- No commits until the whole thing is done.

## Decisions

These are taken without waiting for Prakhar's review, as Tanmay asked. They are the recommended
options from `contract-changes-draft.md`.

- **Projection:** local transverse Mercator `+proj=tmerc +lat_0=37.7880 +lon_0=-122.4075 +k_0=1
  +ellps=GRS80` (origin Union Square, x east, z = −north). This is `tools/geo2.py`, the only place
  that projects.
- **Datum:** `y = NAVD88 − 0.969` (sea at y = 0), applied to DEM and lidar alike.
- **Area:** lat 37.700..37.905, lon −122.520..−122.200, about 28 × 23 km. That is SF to the Daly
  City line, the Bay Bridge, YBI/TI, Oakland through downtown and Lake Merritt to Fruitvale,
  Emeryville and Berkeley.
- **Tiles:** 512 m (i = floor(x/512), j = floor(z/512)), with one file per tile holding:
  - the 2 m ground grid;
  - road ribbons;
  - buildings (footprints, height, style);
  - trees;
  - the 4 m landcover patch.
- **Global `net`:** always loaded. It holds:
  - roads with y, the graph and junctions;
  - tracks and landmarks;
  - lakes and the coarse 16 m terrain with its sea mask;
  - structures (Golden Gate, Bay Bridge);
  - skyline prisms (tall buildings) for the far view;
  - minimap landcover.
- **Inputs:**
  - **OSM:** the Geofabrik `norcal-latest.osm.pbf`, converted by the osmium command-line tool into
    the same Overpass JSON the v1 bake reads, so the v1 bake logic is reused unchanged.
  - **Ground and building heights:** USGS 3DEP lidar (SF B23; Alameda `_2`/`_3`, picked per tile
    by real coverage).
  - **Bathymetry and fallback terrain:** Terrarium.
- **Building heights:** OSM `height` where present (SF), else lidar first returns minus ground per
  footprint (East Bay).
- **Streaming:**
  - Tiles within 1.2 km of the camera are loaded and dropped beyond 1.7 km.
  - Every shipped track corridor is pinned at load.
  - Outside loaded tiles, queries fall back to the coarse `net` terrain and never throw or return NaN.

## Milestones and acceptance

| # | Milestone | Done when |
|---|---|---|
| M1 | `geo2.py` + PBF → Overpass-JSON caches for the v2 area | Element counts match the PBF recount; spot-check vs v1 caches in the old area |
| M2 | v2 bake: `net` + tiles (no lidar yet) | Bake runs end to end; sizes logged; all six v1 tracks re-derived; landmarks placed |
| M3 | v2 runtime (`src/world/v2/`), `?world=v2` | Loads in the browser with no errors; free roam works; tiles stream in and out; Node queries pass a v2 world test |
| M4 | Parity in the old area | test_world-style checks pass on v2; all six tracks on-road; AI races finish with no DNF or water and resets no worse than v1 |
| M5 | Lidar per tile (ground, ribbons, building heights) | Pilot gates hold on every tile sampled; curbs within 2 cm ≥ 90%; East Bay buildings get lidar heights |
| M6 | Bay Bridge (west + east span) and the YBI tunnel, modelled to work under today's physics | A car drives SF → Oakland; AI test along the bridge; no teleports |
| M7 | Performance and polish | fps measured in a visible window; load time; minimap for the big area; docs; security check; then ask Tanmay about committing |

Progress is logged at the end of this file.

## Log

- 2026-10-26: plan written; M1 started.
- **M1 done.** `tools/geo2.py` (projection, datum, grid) and `tools/osm_from_pbf.py` (Geofabrik
  PBF → the Overpass JSON the v1 bake reads; identical to the v1 caches in the old area).
- **M2 done.** `tools/bake_v2.py`: 1,918 tiles (65 MB) + net (11 MB, 6 MB gzip; 4 MB of it is
  the coarse 16 m terrain). 325k buildings, 45.6k roads, 161k trees. All six v1 tracks re-derived
  within 1.5 m of v1's (`tools/test_parity_v2.mjs`); 16 landmarks within 0.12 m.
  Two bake bugs found by checking against v1 and fixed:
  - `geo2` reused `geo.element_polygons`, which projected with v1's constants: every building
    and landuse polygon was off by up to 50 m (Berkeley). `bake_v2` now refuses to run if any
    projecting function still comes from `geo.py`.
  - Two East Bay sea seeds were on land and flooded Oakland and Berkeley as sea. Seeds must sit
    on DEM < −1 m, and named places must come out land / sea (`LAND_CHECKS`, `SEA_CHECKS`).
  - Unhinted track waypoints took v1's first intersection node in set order, which changed with
    the bigger graph (downtown-gp grew a U-turn). Ties now go to the node v1's track used.
- **M3 done.** `src/world/v2/` (`worlddata2.js` queries, `tiles2.js` streaming, `city2.js`
  loader, `structures2.js` bridge structures, `proj2.js`), behind `?world=v2`; v1 unchanged.
  Streaming: near ring (ground, roads, trees) 1.2 km, buildings 3 km, data 3.3 km, each dropping
  450 m further out; skyline beyond. Coarse net terrain discarded (shader mask) under built tiles.
  Pinned: landmark surroundings, track corridors, the pilot's tiles. Load ~7.5 s; a teleport
  settles in ~9 s. The game reaches its menu on v2 with no errors. `tools/test_world_v2.mjs`.
- **M4 done.** Parity (13 checks): heights after the datum shift median 0.002 m, p95 0.27 m
  (roads 0.20 m); road/sidewalk 99.8 %, walls 99.7 %, every OSM-tagged tower the same height.
  AI races (`node --import ./tools/v2_shim/register.mjs dev/physics-ai-sf.mjs all`): all seven
  tracks finish, no DNF, no water; resets on v1's six tracks 3 (all four cars, autopilot included)
  vs v1-with-pilot's 3.
- **M6 done.** `tools/baybridge_v2.py` + `tools/probes/bridge_profile.py`:
  - Deck heights from lidar (3,440 of 3,875 deck points measured), median filtered, grade
    smoothed (6 %), pinned to the ground (or the lidar pilot's road surface) at every junction
    with an ordinary road. Overlapping ramps share heights; decks near the ground follow its
    cross-slope.
  - Stacked decks (west span, YBI tunnel and viaduct) laid side by side at the upper deck's
    height, each moved by what it needs to clear the other direction by 1 m. The world API is
    2D (roadAt, groundHeight); a true double deck needs the contract change in
    `contract-changes-draft.md`.
  - YBI tunnel: terrain cut to the floor, the hill kept as a roof surface (cars above drive on
    it, cars in the bore do not see it), walls along the bores; Forest, Signal and Sims Roads
    over it are decks on the uncut hill.
  - Railings where a deck stands > 2.5 m up (1.8 m collision height), except where a ramp of
    the same direction joins at the same level. Overpasses inside the lidar pilot box are decks
    too (Harrison Street over Beale Street sagged 10 m into the cut before).
  - A seventh track, `bay-bridge-run` (Embarcadero → West Grand Ave, 10.5 km): on road
    throughout, no step over 0.55 m between 2 m samples, AI finishes with no resets.
  - `groundHeight` in v2 follows the level of the previous call within 12 m (the AI samples
    its track every 2 m, so a street under the bridge stays on the street). With no recent call
    it is the top surface, as in v1. `surfaceHeight(x, z, 1e4)` (spawns) takes the lowest road
    surface where roads cross at different levels. Bridge roads are drawn on their own deck
    (`roadDeckAt`). All three are additive; v1 is untouched.
- **M5 done for buildings; lidar ground only in the pilot box.**
  - The lidar pilot (Nob Hill + FiDi) is baked for v2 by `tools/bake_pilot_v2.py` from the v1
    run's cached lidar: same box less 8 m, curbs within 2 cm 93.5 %, 2.15 MB gzip. The v2 loader
    always keeps its tiles' ground (sunk under the patch). Re-run it after every `bake_v2.py`
    (it is fingerprinted to the net's roads).
  - Building heights from lidar for every building without an OSM height:
    `tools/lidar_heights_v2.py` (reduced-resolution EPT per tile, roof p90 minus ground) →
    `bake_v2.apply_lidar_heights` (bld_src 2). 155,718 measured (SF B23 for SF, YBI and TI;
    Alameda for the East Bay); Marin and San Mateo keep the bake's guess. Skipped: within 120 m
    of a bridge tower, footprints under 150 m² that read over 30 m (trees), and buildings under a
    deck (one under the Golden Gate approach read the deck as its roof, 62.9 m, and blocked the
    road). 1,057 buildings of 30 m or more draw in the skyline beyond the loaded tiles.
  - Not done: lidar ground and road ribbons beyond the pilot box (SF B23 is 650 MB of LAZ per
    km²; the whole map is ~80 GB and hours of processing; do it region by region, starting with
    the track corridors). M8 put lidar ground under the whole map at 8 m; the 2 m ground and
    ribbons are `research/lidar-tiles-plan.md`.
- **Review fixes (2026-10-26).** A code review of M3–M6 found, and these were fixed:
  - `surfaceHeight(x, z, 1e4)` took the hill over the YBI tunnel as the surface: the
    lowest-road rule now applies under tunnel roofs too.
  - `lidar_heights_v2.py` measured only still-guessed buildings, so a second run dropped the
    first run's heights: it now measures both (bld_src 0 and 2).
  - Just past a deck's square end, the deck was dropped even where a bend's next segment covers
    the point: the exclusion now applies only when the nearest segment is the end cap.
  - Bridge road normals in v2 come from the deck surface (`hc` + 0.5), not the ground below.
  - A landmark whose tiles fail to load once is retried before the loader gives up.
  - The buildings cache key includes `load_buildings`' source; `oneway=-1` bridge ways are
    reversed.
- **M7 (performance and polish), 2026-10-27.**
  - Draw calls. The coarse 16 m terrain was 1 km chunks over the 30 km map (320 meshes in view
    from over the city) and every lake was its own mesh (117 in view). Now 2 km chunks, with the
    LOD switch distances padded by 512 m so a chunk's near edge keeps its detail, and one mesh
    for all lakes: 96 and 2 in the same view. Settled streaming, 1600×900:

    | View | v2 calls | v1 calls | v2 ms | v1 ms |
    |---|---|---|---|---|
    | Spawn (Embarcadero) | 289 | 308 | 13.5 | 10.1 |
    | Downtown, 25 m up | 278 | 166 | 12.9 | 9.2 |
    | Nob Hill street | 351 | 260 | 12.6 | 10.5 |
    | Over the city, 400 m up | 432 | 370 | 15.8 | 10.2 |

    ms is update + render + GPU sync per frame, measured in the hidden browser pane (no
    vsync, but its timers are throttled), so treat it as indicative. Load 7.5 s (v1 6.0 s),
    JS heap 735 MB (v1 614 MB). Still to measure: fps in a visible window while driving.
  - YBI tunnel: the bores had walls but no ceiling, so the cut hillside showed up to the hill
    roof 40 m above. Each tunnel segment's wall pair now carries a lit concrete ceiling at wall
    height (6.5 m) with a lamp strip (`structures2.js`).
  - Towers and bridge supports mapped as buildings drew as glass offices (the Bay Bridge's
    160 m SAS tower, the Campanile). The bake gives them style 8, plain walls without windows
    (`plain_structures`; `buildings.js` draws a style past its eight facade styles plain; v1
    data never has one), and a pylon in the bay is measured from the water, not the bay floor.
  - Minimap: 4096 px at high quality (~7 m per pixel over the 28 km map; it was 14 m, too coarse
    for the HUD's 520 m view). It draws in ~0.26 s, the same as 2048.
  - After the re-bake (35 towers and bridge supports drawn plain): `test_world_v2` 61/61 (58/58
    with `PILOT=0`), `test_parity_v2` 13/13, v1's `test_world` 29/29 and `test_pilot` 16/16,
    `dev/physics-tests.mjs` 51/51. AI on v2: all seven tracks finish, no DNF, no water, 3 resets
    over all 28 car runs (autopilot 2 on Lombard and Nob Hill Jumps, gt3rs 1 on Lombard; none on
    the Bay Bridge Run), the same as before the re-bake. With `PILOT=0`, two checks are reported
    as notes, not failures: the Bay Bridge Run's AI profile has 8 rises over 0.55 m (max 0.66 m)
    where decks fitted to the lidar ground meet the DEM ground.
  - Security check before committing: no usernames, local paths, emails or keys in the code,
    docs or data (the 1,922 binaries included). Compiled Python under `tools/__pycache__/`
    embeds the absolute path of the machine that ran the bake: `tools/.gitignore` now excludes
    it. The v2 attribution now credits USGS 3DEP lidar for building and bridge heights.
- **M8: lidar ground everywhere (8 m grid), 2026-10-27.**
  - The 8 m heightfield (tiles and the net's 16 m terrain) now comes from USGS's 1 m bare-earth
    DEM, which USGS made from the same lidar (`CA_SanFrancisco_B23` for SF, YBI and TI;
    `CA_AlamedaCounty_2021_B21` for the East Bay; 2018 projects fill the Marin and San Mateo
    edges). `tools/dem1m_v2.py` downloads the 27 tiles (3.8 GB, cached) and warps them into one
    4 m mosaic on the landcover grid; `bake_v2.lidar_ground_sampler` reads it. 98.8% of land is
    lidar; land with no lidar blends into Terrarium over 48 m; the sea keeps Terrarium's bay floor
    and the coastline is unchanged (the sea mask still comes from Terrarium).
  - Checked against the pilot's raw lidar ground (`tools/probes/dem1m_check.py`,
    `research/dem1m-check.json`): the 1 m DEM differs by a median of -1 mm (half within 3 mm,
    98.6% within 15 cm), and the best horizontal alignment is at zero shift (searched ±3 m in
    0.25 m steps), so datum and projection agree.
  - On land, lidar minus Terrarium is 0.04 m mean, 0.67 m rms, p95 1.16 m. Flat streets barely
    move (Terrarium's SF source was already lidar-based, at lower resolution); hills, cuts and
    slopes do. Inside the pilot box the 8 m grid now sits closer to the 2 m lidar (rms 1.05 m,
    p95 1.41 m; it was 1.28 / 2.12).
  - Tests: `test_world_v2` 61/61 (58/58 with `PILOT=0`, the same two notes), `test_parity_v2`
    13/13 (heights vs v1: median 0.05 m, p95 0.83 m on land, 0.38 m on roads), v1 29/29, pilot
    16/16, physics 51/51. Parity changes, decided before the bake: with lidar ground the height
    checks allow |median| < 0.5 m and p95 < 2.5 m (roads 2.0 m); the towers check compares the
    building's own height `top - (gmin + gmax) / 2`, because `top - gmin` includes half the
    ground relief under the footprint, which the lidar changes (8 towers on slopes, same OSM
    height to 5 cm).
  - AI, 5 random-rival seeds x 7 tracks x 4 cars, against the Terrarium bake (backup, same
    seeds, `V2_DIR` in `tools/v2_shim`): 140/140 finish both ways, no water; resets 13 vs 20,
    recoveries per lap 0.00-0.06 vs 0.03-0.10. The default run: 2 resets (autopilot off-path on
    Painted Ladies at -3253,1698; a rival flipped on YBI at 3781,-2486); both spots reset on the
    Terrarium bake too with other seeds, and the profiles there are smooth (max 1 m step 0.11 m).
  - Re-bake order is now `tools/dem1m_v2.py` (once), `tools/bake_v2.py`, `tools/bake_pilot_v2.py`.
  - Not changed: the tile format and runtime. The 2 m ground and measured ribbons still exist
    only in the pilot box; `research/lidar-tiles-plan.md` is the plan for streaming them city-wide.
  - Noticed, not ours to fix: `dev/world-test.html` colours track overlays from a 6-entry list,
    so v2's 7th track (Bay Bridge Run) logs 56 three.js "color undefined" warnings there.
- **Lidar tiles spike, 2026-10-28** (`research/lidar-tiles-spike.md`). Patches per 512 m tile cut from one
  pilot-style bake (2 x 2 tiles in the old box, the Painted Ladies tile outside it with a real
  fetch-then-delete pass 1) answer exactly as the bake: shared edges identical, no ribbon misses,
  independent of what is loaded, per-tile fingerprints; 14/14 gates
  (`tools/test_lidar_spike.mjs`). Found and fixed on the way:
  - the 2 m grid fill was not local (degenerate Delaunay on the lattice); `bake_pilot.FILL_JITTER`
    makes it so, off for v1;
  - `buildPilot` crashed on a run starting outside its box (chunk key -1).
  Measured: ~1 MB memory and 91-150 ms mesh build per patch, so the runtime needs its own patch ring
  and incremental mesh building. Nothing in the game uses patches yet; existing tests unchanged.
- **Lidar tiles in the game, 2026-10-28** (`research/lidar-tiles-runtime.md`).
  - v2 loads the pilot's 2 m ground and measured ribbons as one patch per tile
    (`data/v2/lidar/`, 21 tiles: the old pilot box rounded out, plus the Painted Ladies), streamed in
    their own ring, in place of the global pilot. `?pilot=0` turns them off.
  - Meshes are built a piece at a time; each chunk's 2 m level is built near the camera and dropped
    away from it; each ribbon segment is drawn by one tile.
  - Buildings take baked lidar ground ranges.
  - Decks are now pinned to the patch ground (8 overpasses, max grade 12.2%).
  - Gates 15/15 (`tools/test_lidar_v2.mjs`); every existing suite passes.
  - AI, 168 runs: 15 resets with patches (23 on the old pilot, 15 before the patches).
  - Frame cost with patches is no worse than without (the existing road builder is the largest
    piece, about 40 ms per tile).
- **All of SF in lidar tiles, 2026-10-29: baked and staged, not switched** (`research/lidar-tiles-runtime.md`,
  All of SF). 524 tiles from a block-wise pass 2 (`tools/lidar_pass2.py`), gates pass, pits under sea
  level raised. SF's 296 OSM bridges become decks (overpass boxes over all coverage; deck heights per
  span between pins). Not switched: the elevated freeways need measured deck heights, Lombard Zigzag
  regresses (16 AI resets), and stacked interchanges need stacked decks or leaving out of coverage.
  In the browser it costs about 65 MB more (meshes and patches); frame times stay within today's
  run-to-run spread.
- Known, not fixed: the pilot's split-level Jones Street step on Nob Hill Jumps (from v1); the
  SF end of the bridge ramps down to the draped I-80 at 2nd & Harrison (SoMa's elevated freeways
  are draped, as in v1); without the pilot (`?pilot=0`) decks fitted to the lidar ground meet the
  DEM ground with steps up to 0.66 m.

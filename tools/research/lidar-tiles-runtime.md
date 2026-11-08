# Lidar tiles in the game (runtime stage, 2026-10-28)

The second step of `lidar-tiles-plan.md`, after the spike (`lidar-tiles-spike.md`). The lidar pilot's
2 m ground and measured road ribbons now load in v2 as one patch per 512 m tile, streamed around the
camera. Where `data/v2/lidar/` exists, they replace the single global pilot. `?pilot=0` turns them
off, as it did the pilot. All of SF is not baked yet: this stage covers what the pilot did and a
little more, to be reviewed before the full bake.

## What is covered

| Island | Tiles | Area |
|---|---|---|
| downtown | 20: i -2..2, j -3..0 | the old pilot box rounded out to whole tiles: Nob Hill, Chinatown, FiDi, Union Square, the Embarcadero by the Ferry Building, the SF end of the Bay Bridge |
| painted-ladies | 1: (-5, 2) | Alamo Square, on the Painted Ladies track |

- **Files:** 21 patches, 5.4 MB on disk (3.0 MB gzip), plus `index.json` and `bground.bin` (92 KB).
- **Bake:** `python tools/bake_lidar_tiles.py`, about 4 min with the lidar rasters fetched, about 2
  min from cache.
  - Pass 1 fetched 14 tiles from EPT (130-200 MB of LAZ each, about 20 s per tile) and deleted the
    LAZ afterwards.
  - Curbs within 2 cm: 93.6% (downtown), 91.1% (Painted Ladies).

## How it works

- **Bake** (`tools/bake_lidar_tiles.py`, helpers in `tools/lidar_tiles.py`):
  - Each island is baked by `bake_pilot.py` as one box, with `FILL_JITTER` on.
  - It is then cut into packed per-tile files: header + arrays, like a v2 tile, with stored station
    normals and each sub-run's distance along its road (`run_s0`).
  - `tools/lidar_bground.mjs` then measures every building with a footprint corner in coverage on
    the lidar ground (6,034 buildings; one lowest-ground change of 5.76 m), using the game's own
    height code.
- **Queries** (`src/world/v2/lidar2.js` `createLidar`): the pilot's API (heightAt, ribbonAt,
  surfaceKind, contains, toSidewalk, coversRoad), so `roads.js` and the queries work unchanged.
  - Fingerprints are checked against the net at startup; a stale patch is refused alone.
  - Node loads patches on first touch. The browser loads them through the streamer.
  - Tile lookups use numeric keys and a per-tile mask of uncovered neighbours: the road builder asks
    on every point.
- **Buildings:** `worlddata2.addTile` applies the baked ground ranges when the tile loads, before
  its meshes are built. It checks the building count and a footprint hash first.
- **Decks:** `bake_v2.py` now pins deck ends to the patch ground (`baybridge_v2.lidar_ground`), not
  the old pilot box. That gave 8 overpasses (4 before) and a max deck grade of 12.2% (14.8%).
  `net.json` records it (`stats.deck_ground`). `test_world_v2` holds decks to that ground and
  reports the others as notes.
- **Streaming** (`src/world/v2/tiles2.js`):
  - Patches have their own ring: the near ring plus one tile diagonal (1.9 km on high), dropped 450 m
    further out. Track corridors inside coverage stay pinned (17 tiles), so rivals far from the
    camera drive on them.
  - A covered tile's near meshes wait for its own and its covered neighbours' patches.
  - A patch that fails 3 times, or is refused, leaves its tile on the 8 m ground.
- **Meshes** (`src/world/v2/patchmesh2.js`): built as a job of small pieces within the 6 ms frame
  budget, and added to the scene only when complete:
  - ground texture;
  - setup;
  - 4 coarse ground chunks (4 and 8 m);
  - 4 ribbon chunks;
  - today's roads (where no ribbon is, and the street lamps);
  - trees.

  A chunk's 2 m level is built when the camera comes within 1 km and dropped beyond 1.3 km. Edge
  normals read the neighbour's nodes. Each ribbon segment is drawn only by the tile holding its
  midpoint, with its lane markings in phase.

## Gates (`node --expose-gc tools/test_lidar_v2.mjs`: 15 passed)

| Gate | Result |
|---|---|
| Fingerprints, files | 21/21 match the net and index.json, 0 refused |
| Shared tile edges | 7,967 nodes on 31 edges identical in both patches |
| The world's heightAt vs each island's one-box bake, 200k points per island | equal within 9e-13 m, surface kind identical |
| Across 7 interior tile edges, 63,488 pairs 1 cm apart | steps equal the bake's within 7e-13 m; 0 ribbon misses within 2 m of an edge |
| Outer edge of coverage | within 0.007 mm of the 8 m ground |
| Ribbon ownership | 51,985 + 2,251 segments, each drawn by exactly one tile |
| Lane marking phase across cuts | along-road distance equal within 0.014 mm |
| Buildings | 6,034 with a corner in coverage stand on the lidar ground |
| The old pilot box | entirely inside coverage |

Existing suites: `test_world_v2` 61/61 with patches; with the old pilot (`LIDAR=0`) 59/59 and without
lidar (`PILOT=0`) 58/58, both with deck checks as notes; parity 13/13, v1 29/29, v1 pilot 16/16,
physics 51/51, spike 14/14.

**AI races** (all 7 tracks, 4 cars, default rivals + 5 seeds = 168 runs each):

| | Patches | Old pilot (same bake) | The lidar ground stage, before patches |
|---|---|---|---|
| Finished | 168/168 | 168/168 | 168/168 |
| Water | 0 | 0 | 0 |
| Resets | 15 | 23 | 15 |

The flips on the Bay Bridge approach around (1300-1400, 280) happen in every mode and on the
Terrarium-ground bake too: a known AI spot, not the patches.

## Frame cost and memory (browser pane, hidden; indicative)

The test flight: from western SF into downtown at 4 m per frame (240 m/s, a stress case), timing
every `world.update`.

| | Without lidar (`?pilot=0`) | With patches |
|---|---|---|
| update p50 / p95 / p99 | 0.5 / 8.1 / 70 ms | 0.4 / 9.0 / 36 ms |
| max | 136 ms | 55 ms |
| updates over 33 ms | 66 | 22 |

The two columns come from separate runs and vary run to run (the same flight with patches, before
the fixes below, gave max 102-207 ms). What they show: patches do not make streaming worse than
today's 8 m tiles.

Per piece (mean / max):

| Piece | Mean | Max |
|---|---|---|
| ground chunk | 1.0 | 3.3 ms |
| 2 m chunk | 2.3 | 3.8 ms |
| ribbon chunk | 3.1 | 6.7 ms |
| setup | 1.6 | 4.2 ms |
| ground texture | 4.0 | 15 ms |
| today's road builder on a lidar tile | 40 | 62-73 ms |
| today's whole 8 m near tile, for comparison | 26 | 66 ms |

The road builder is the one piece over budget. It is the existing `roads.js`, which asks the patch
set for every point of every road. Making it incremental (or skipping roads a ribbon fully covers)
would help 8 m tiles too.

Memory:
- Per patch, decoded: 0.9 MB, decode 1.3 ms median.
- Lidar meshes: 55 MB at spawn and 95 MB in the middle of downtown (3.4 M triangles across all
  LODs, about 20 tiles in the near ring). Most of that is three.js's CPU copies of buffers already
  on the GPU.
- JS heap after the flight: 612-676 MB, against 436 MB without lidar.

## Fixed on the way

- **Lane-marking phase check:** keyed by station, it failed on a loop road (its first and last
  stations coincide) and where two runs of a road meet. It is keyed by segment now; no data was wrong.
- **Deck ends:** fitted to the 8 m ground just outside the old pilot box, they met 2 m lidar ground,
  which made a -2% to +8% kink on the Bay Bridge approach. Decks are now pinned to the patches.
- **Streamer review findings:**
  - a permanently failing patch would have been retried forever, blanking 9 tiles;
  - a 2 m chunk could be built after the camera had left.
- **The road builder:** it took 82 ms per lidar tile until tile lookups stopped building strings.

## Known limits

- **Near-ring edge:** where a tile at the edge of the near ring is drawn and the neighbour that owns
  a ribbon segment is not, the few metres of that segment inside the drawn tile show the painted
  ground texture, not the ribbon (1.2 km or more from the camera).
- **The old pilot (`data/v2/pilot.*`):** still baked and used only when `data/v2/lidar/` is missing.
  Decks are no longer fitted to it.
- **Re-bake order:** `tools/bake_v2.py` (it reads the existing patches for the decks), then
  `tools/bake_lidar_tiles.py` (patches + `lidar_bground.mjs`), then optionally
  `tools/bake_pilot_v2.py`.
- **Spike data:** `data/v2/lidar_spike/` is spike data for `test_lidar_spike.mjs`, not loaded by the
  game.

## Before baking all of SF

1. **Coverage:** today islands must be rectangles, and each is baked whole. For SF, pass 2 needs to
   run in blocks (`FILL_JITTER` makes the fill local), with per-road curb statistics over whole roads
   (spike finding 3).
2. **Size:** about 460 tiles. Pass 1 is about 3 h (20-30 s per tile to fetch and raster) and
   about 1 GB of raster cache. Patches come to about 70-80 MB gzip.
3. **Corridor pins:** at 0.9 MB a patch, pinning every corridor tile in coverage (84 for SF) is
   about 75 MB. Pinning only the race being driven needs a hook into the race that the World API
   doesn't have (Prakhar).
4. **Memory:** freeing the CPU copies of lidar meshes after upload would halve their 95 MB, at the
   cost of context-loss recovery.
5. **The road builder** (above): about 40 ms once per tile as the camera approaches.

## All of SF: baked and staged, not switched (2026-10-29)

Items 1 and 2 above are done; 3 to 5 (memory, corridor pins, frame cost in the browser) are measured
below. The game still loads the 21 tiles. The full bake and a game copy using it live outside the
repo (`~/Downloads/sf-roadster-bakecache/staged_game/`) until the blockers below are settled.

**What is built**

- **Pass 2 in blocks** (`tools/lidar_pass2.py`): stations along whole roads, whole-road curb
  statistics, the grid fill local everywhere (`FILL_ANCHOR`, lakes as water). Blocks of 3 and 2
  tiles give byte-identical patches on three test areas.
- **The bake:** 524 tiles, 122 MB on disk (70 MB gzip), about 1 h 45 min for pass 2 with the pass
  1 rasters cached. The 9 lidar gates pass on it (`LIDAR_DIR=... tools/test_lidar_v2.mjs`).
- **Pits:** ground below sea level that the sea does not reach within 256 m is raised to 0.5 m
  (a garage ramp or a construction pit would otherwise be a pool of sea): 4,367 nodes. This runs
  again after roads are burnt in (a road over a channel cuts off the ground beyond it), on the
  heights as stored (whole cm, so -0.004 m counts as dry).
- **Bridges as decks across SF:**
  - `index.json` `overpassBoxes` now covers all coverage (`bake_lidar_tiles.overpass_boxes`), so
    `bake_v2.py` makes decks of 296 OSM bridges. Draped on the 2 m ground they dipped into the cut
    or street under them.
  - `baybridge_v2.deck_heights`: unmeasured decks merge into one height only when they run within
    30 degrees of each other, so a street over a freeway is not welded to it.
  - A span between pins may climb as steeply as its own pins need (street bridges on Potrero Hill:
    up to 20%), instead of a step at the pin (up to 175% before).
  - The Bay Bridge's measured decks are unchanged (0.000 m).
  - Road positions are unchanged, so patch fingerprints and the old pilot still match.

**Measured on the staged game** (the final bake, 2026-10-30)

The last two pit fixes changed 10 of the 524 patches. One is the Bayview pool, now dry (tile 8,12).
The rest lie within 20 m of decks that are new in this net, where the ground fill under a deck
follows the carved 8 m ground. Suites, races, the every-road drive and the deck check give exactly
the results of the patches from before those fixes. Re-read from the stored patches, no ground
below sea level is cut off from the sea.

| Check | Staged | Today |
|---|---|---|
| Suites | 7 of 8 pass; `test_world_v2` fails the Lombard Zigzag hop gate (5 hops, max 1.03 m per 2 m; v1 has 4, 0.59 m) | all pass |
| AI races, 6 runs x 7 tracks | 34 resets, 16 of them on Lombard Zigzag | 15, none on Lombard |
| Every road in coverage driven both ways (18,359) | 646 hop (rise > 0.55 m per 2 m) or fall (> 1 m) | 297 |
| The converted bridges (287 in coverage): hop / fall | 24 / 11 as decks; 158 / 114 draped on the patches | 14 / 0 |

Of the 454 roads that hop or fall only with the patches:
- 34 are deck roads;
- 108 are within 15 m of a freeway deck;
- 35 are within 15 m of a street deck;
- 277 are hill streets, alleys and stair lanes, 1.5% of roads (today's 21 tiles: 2.2%).

**Frame cost and memory on the full bake** (browser pane, hidden; the flight above, three runs of
each, back to back)

| | Today (21 tiles) | Full bake |
|---|---|---|
| update p50 | 0.4 ms | 0.4-0.6 ms |
| update p95 | 8.9-38.5 ms | 9.1-17.9 ms |
| update p99 | 41-83 ms | 38-89 ms |
| max | 55-138 ms | 52-150 ms |
| updates over 33 ms (of 1,551) | 24-85 | 37-66 |
| road builds on lidar tiles during the flight | 32, 42-92 ms each on average | 111, 30-70 ms |

- **Frame cost:** times vary up to 2x between back-to-back runs on this machine; one core was busy
  with another program throughout. The full bake falls inside today's spread. Most of the flight is
  over lidar tiles now, so the road builder (item 5 above) runs on 111 tiles instead of 32. It is the
  piece to fix if spikes matter.
- **Meshes:** lidar meshes take 66 MB at spawn and 122 MB downtown (4.3 M triangles), against 55 and
  95 MB today.
- **Patches held:** 73 after the flight, about 0.8 MB each decoded, against 21.
- **JS heap:**
  - 10 s after load: 553-627 MB, against 556-557 MB.
  - 10 s after the flight: 654-860 MB, against 525-561 MB.
  - A page can't force a GC, so the heap figures are indicative.
- **Corridor pins:** 53 of the 84 track-corridor tiles are in coverage. The game pins them and loads
  them before the start: 12 MB on disk, 42 MB decoded, about 0.1 s to decode in Node. Today that is
  17 tiles, 4.4 MB and 16 MB. Item 3's estimate was 75 MB.

**Blockers before switching**

1. **Elevated freeways** (I-280, US-101, the Central Freeway) are decks pinned where their ramps
   meet streets, so they sit a few metres up, and the streets under them catch cars (the 108 roads
   above). Fix: measure their deck heights from lidar as `tools/probes/bridge_profile.py` does for
   the Bay Bridge, for every bridge in coverage.
2. **Lombard Zigzag:** at 2 m, the crooked block's terraces and hairpins (tiles -3,-4 and -2,-4)
   make steps the track's centreline crosses: a 7.5 m step 4 m from Leavenworth, a 50% bank near
   Larkin.
3. **Stacked interchanges** (the Alemany Maze, tiles 0,10, 0,11, 1,10 and 0,12): a patch holds one
   road level, and there a deck runs up to 22 m under a ramp that OSM does not tag as a bridge.
   Choose between stacked decks (a contract change) and leaving these tiles out of coverage.
4. **Building colours** (cosmetic): `restyle` draws from one shared random sequence, so 15 more
   buildings keeping their guessed height under the new decks re-roll the styles in about 400 tiles.
   A per-building seed would stop it.

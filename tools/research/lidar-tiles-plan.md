# Plan: the lidar pilot city-wide (2 m ground + measured road ribbons, streamed)

Status 2026-10-29: all of SF is baked (524 tiles, block-wise pass 2, gates pass) and staged outside the
repo with SF's bridges as decks, not switched: four blockers, in `lidar-tiles-runtime.md` (All of SF).
Status 2026-10-28, later: the runtime is in (`lidar-tiles-runtime.md`). v2 streams patches for
the old pilot area and the Painted Ladies tile, 21 tiles, in place of the pilot; 15 gates pass, as
does every existing suite, and the AI resets no more than before. All of SF is not baked yet; that
note lists what to settle first.
Status 2026-10-28: the spike is done and its 14 gates pass (`lidar-tiles-spike.md`). Seams are exact
when patches are cut from one bake. It changed the plan in four places, marked "(spike)" below.
Earlier status, 2026-10-27: proposed, not started. The 8 m ground under the whole v2 map is already lidar (M8 in
`v2-build-plan.md`); this plan takes the pilot's 2 m ground and measured curbs and crowns
(`pilot-bake.md`) from its one 4 km² box to all of SF, then the East Bay.

## Design

**One lidar patch per existing 512 m tile**, `data/v2/lidar/{i}_{j}.bin.wasm`, fetched, kept and dropped
together with its tile. Every lifecycle piece that already works is reused: the data ring, track
corridor pins (AI cars), "near tile waits for its neighbours", and Node's synchronous tile reads.
There is never a state where a tile is loaded and its patch is not. Rejected:
- 2 km blocks: the same seam work, 16x coarser streaming, and they don't match the tile rings and pins.
- Clipping ribbons at tile edges: quads straddle edges and would need new clipped geometry.
- Looking up the neighbour's patch at runtime: heights would depend on what happens to be loaded.

**Seams are solved in the bake, not at runtime.** All patches are cut from one global bake:
- Grids share their edge nodes (257 x 257 per tile), stored as integer cm plus an integer base,
  so a shared node is bit-identical in both files.
- A ribbon segment is copied into every tile its quad touches (with explicit per-station normals),
  so physics finds the same segments the one-box pilot would. Each segment is drawn only by the
  tile holding its midpoint.
- The 24 m blend into the 8 m ground is needed only at the outer edge of coverage. It depends only
  on position and the (static) coverage list, so it is continuous across patches.
- Physics never meets a patch next to an unloaded tile in practice: near tiles wait for their
  neighbours, and AI cars stay inside pinned track corridors.

**Fingerprint per patch**: a hash over the net roads that meet the tile (±32 m). A stale patch is refused
on its own and that tile falls back to the 8 m lidar ground.

## Work

1. **Runtime** (`src/world/pilot.js`, `v2/worlddata2.js`, `v2/tiles2.js`, `v2/city2.js`):
   - Split the pilot queries into a per-patch part (grid, ribbon, surface kind) and the existing
     v1 wrapper (box test + edge blend), so v1 calls do not change.
   - v2 decodes a patch with its tile and asks it first, then the 8 m ground.
   - The near ring draws the patch's ground mesh instead of the tile's 8 m ground.
   - Remove the global pilot pinning and sinking in lidar mode. `?pilot=0` turns lidar patches off.
2. **Bake** (`tools/bake_lidar_tiles.py`, reusing `bake_pilot` the way `bake_pilot_v2` does):
   - Pass 1, per tile, resumable: EPT fetch of the tile + 6 m, a 0.25 m ground raster (int16,
     about 5 MB), then delete the LAZ.
   - Pass 2, over the whole coverage, re-run after every `bake_v2`: building mask, one global 2 m
     grid, every road run measured once, junction and level handling on global keys, then cut per tile.
   - (spike) Fill nodes without ground with `bake_pilot.FILL_JITTER` on: the plain fill depends on the
     whole box (up to 4 m apart between boxes); with it, the fill is local. Per-road curb statistics
     must be over whole roads, not per block.
3. **Gates** (`tools/test_lidar_v2.mjs`): the 16 pilot gates per tile on every corridor tile plus 50
   random tiles, and on top of those:
   - shared edges bit-identical;
   - no step over 2 mm across tile edges (curb faces aside);
   - no ribbon misses near edges;
   - the same answers with one tile loaded or all of them;
   - no NaN under load/unload churn;
   - unchanged outside coverage;
   - a tampered patch is refused alone;
   - v1 bit-identical to before;
   - all 7 tracks on road, AI no worse than today.

## First: a spike

Before anything else, run a spike on a 2 x 2 block inside the old pilot box (its lidar is cached),
plus one tile outside it. That one tile exercises the outer edge and the fetch-then-delete path.
Measure:
- the seam gates, including a corner with a diagonal road;
- heights against today's v2 pilot (p99 < 2 cm);
- memory and decode time per patch;
- mesh build time against a 6 ms frame budget;
- disk per tile.

## Size and effort (estimates)

- ~540 KB/km² gzip, as the pilot: ~65 MB for SF.
- Raster cache ~2.4 GB.
- Machine time 3-5 h for ~460 SF tiles (EPT at ~13 MB/s).
- Work: about 8-10 days for SF (runtime 3, bake 3-4, tests 1-2), plus 2-3 for the East Bay.

## Runtime changes from the spike

- (spike) Patches get their own ring (near ring + margin, 25-40 tiles): ~1 MB each decoded, so the
  data ring's ~250 tiles would be ~250 MB. Pin only the race being driven (~12-15 tiles, not all 84).
- (spike) `buildPilot` takes 91-150 ms and ~6 MB per patch with all three LODs. Build one chunk and LOD
  at a time over frames, and the 2 m LOD only within ~600 m.
- (spike) Draw each copied segment only from the tile that holds its midpoint.

## Risks

- **Memory:** ~250 patches stay in the 3.3-4.2 km data ring. Above ~100 MB, patches need their own,
  smaller ring.
- **AI:** height profiles are sampled once at race start, so preload the race's corridor first.
- **Road re-indexing** in a net re-bake refuses every patch (safe fallback); re-run pass 2.
- **Retaining walls** city-wide raise the "unintended steps" gate on hilly tiles. Whether terrain
  steps become wall solids is Prakhar's call (`pilot-bake.md`, known limit 2).
- **East Bay:** Alameda's lidar is 5-7 ground points/m², too sparse for 0.25 m curb detection, so it
  needs its own resolution and gate.

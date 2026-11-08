# Spike: lidar patches per tile (2026-10-28)

The first step of `lidar-tiles-plan.md`: before building the runtime, check that per-tile patches can
reproduce the one-box lidar pilot exactly, and measure their size, memory and build time.

- Bake and cut: `tools/spike_lidar_tiles.py`
- Gates: `tools/test_lidar_spike.mjs` (`node --expose-gc tools/test_lidar_spike.mjs`: 14 passed)
- Patch queries: `src/world/v2/lidar2.js` (not wired into the game yet)
- Output: `data/v2/lidar_spike/` (spike data, not loaded by the game)

## What was baked

| Island | Tiles | What it exercises |
|---|---|---|
| A | 2 x 2 inside the old pilot box: (-1,-2) (0,-2) (-1,-1) (0,-1), Nob Hill, Chinatown, north of Union Square | four tiles meeting at one corner; raster from the pilot's cached lidar |
| B | 1 tile outside it: (-5,2), the Painted Ladies, on that track | pass 1 for real (EPT fetch, raster, LAZ deleted); an outer edge on all four sides |
| C | 3 x 2 around A (reference only, not cut) | a bigger bake that A's interior must reproduce |

Each island is baked by `bake_pilot.py`, unchanged, as one box (pass 2). It is then cut into patches:

- **Grid:** each tile gets its 257 x 257 nodes. Edge nodes are shared, with the same raw values and
  base height in both files.
- **Ribbons:** each tile gets every road ribbon segment whose quad (+1 m) touches it, together with
  the stations' normals. Without stored normals, a run cut at a tile edge would compute different
  normals at its ends.
- **Coverage:** each patch lists the tiles that have lidar, so the 24 m blend into the 8 m ground
  runs only along the outer edge.
- **Fingerprint:** each patch carries a hash over the net roads within 32 m of its tile.

## Gates

| Gate | Result |
|---|---|
| Shared edge nodes | 1,028 nodes on 4 tile edges identical in both patches |
| Patches vs the island bake, 200k random points per island | heights equal within 2.9e-13 m (rounding), surface kind identical |
| Across tile edges, 8,192 pairs 1 cm apart | the step across an edge differs from the bake's by at most 7e-15 m (heights differ by ~1e-14 m at most because a patch's grid starts at its tile and the bake's at the island, so weights round apart; tolerance 1 nm) |
| Ribbons within 2 m of tile edges, 40k points | 0 misses, 0 extra hits |
| 4-tile corner, 60 x 60 m at 10 cm (360k points, 51 ribbon segments) | equal to the bake (max 1.1e-13 m), kinds identical |
| Each tile loaded alone vs all loaded | 0 of 100k points differ |
| Outer edge, 1 cm inside coverage | within 0.002 mm of the 8 m ground |
| Island A interior (> 64 m from its edge) vs the 3 x 2 bake C | 99.78% identical, p99 0.00 cm, max 2.6 cm |
| Per-tile fingerprints | match the net; a road moved 1 cm refuses only its own tile's patch |
| Today's worlds | test_pilot 16/16, test_world 29/29, test_world_v2 61/61 (58/58 without the pilot), parity 13/13, physics 51/51; both dev pages load with no console errors |

## Findings

1. **The seams are solved by cutting from one bake.** Nothing at runtime needs to look across a
   tile edge. Each point is answered by its own tile's patch, so answers don't depend on what else
   is loaded.

2. **The grid fill was not local; fixed (`bake_pilot.FILL_JITTER`).** The bake fills 2 m nodes
   without ground (about half of them downtown, under buildings) by Delaunay interpolation over the
   nodes with ground. On the bare lattice every square's corners are cocircular, so which diagonal
   Qhull picks depends on the whole point set.
   - The same block filled inside a different box came out different: 4.5% of filled nodes, p99 16 cm,
     max 4.0 m.
   - Moving each node by a fixed 1/1000 cell, keyed to its world position, makes the triangulation
     generic. Then 100% of filled nodes match, and the fill runs twice as fast (14.4 s to 6.5 s on A).
   - The flag is off for v1, so today's pilot re-bakes as it was.
   - Today's v2 pilot was filled the old way. It differs from any tile bake by p99 6.6 cm and up to
     79 cm at single points, so it is to be replaced by the tiles, not compared against them.

3. **What is left between island A and the bigger bake** (0.22% of points, up to 2.6 cm) is per-road
   statistics: whether a road side has a curb, and its height, are medians over the road's stations
   inside the box. Pass 2 must compute these over whole roads (the plan already says so). A
   tile-by-tile bake would not be enough on its own.

4. **Memory: about 1 MB per decoded patch** (0.8 MB typical, 1.0 MB downtown).
   - Patches can't live in the 3.3-4.2 km data ring (~250 tiles). They need their own ring: the near
     ring plus a margin, 25-40 tiles.
   - The track corridors pin 84 tiles. Only the race being driven needs its corridor (~12-15 tiles).
   - Keeping the grid and stations as uint16/int16 and decoding per query would roughly halve the
     per-patch figure.

5. **Mesh build: 91-150 ms per patch on the main thread** with today's `buildPilot`:
   - three ground LODs at once, 139k triangles at 2 m;
   - 27-43k ribbon triangles;
   - ~6 MB of mesh per patch;
   - first render 3-6 ms.

   That is 15-25 frames' budget. So the runtime must build one 256 m chunk and one LOD at a time,
   spread over frames (or in a worker), and build the 2 m LOD only within ~600 m.

6. **Two runtime fixes the patches need.**
   - Fixed: `buildPilot` started each road run with chunk key -1. A patch's run that starts just
     outside its tile has key -1 too, never got a buffer, and crashed.
   - Still to do: `buildPilot` draws every segment a patch holds, so the ~2% copied into two tiles
     are drawn twice. Each segment must be drawn only by the tile holding its midpoint.
   - Still to do (from the code review): on a patch, `buildPilot`'s 256 m chunk keys can alias
     across rows for stations outside the tile (only culling bounds suffer). Its along-road
     distance, which phases the dashed lane markings, restarts at each cut. Clamp the keys to the
     tile's chunks, and store the along-road distance at each sub-run's first station.

7. **Pass 1 per tile.**
   - Tile B: 135 MB of LAZ fetched in 16 s, and the raster built in 25 s in all. The LAZ was deleted;
     the SF cache holds 170 files, as before.
   - The int16 raster is 1.7-2.7 MB per tile, about 1 GB for SF (the plan estimated 2.4 GB).

8. **Pass 2 and sizes.**
   - Bake times: 18 s for 4 tiles, 4 s for 1, 27 s for 6.
   - Curbs measured within 2 cm: 93.3% (A), 91.1% (B), 94.0% (C), above the 90% bar.
   - Patches are 157-196 KB gzip each, about 600-750 KB/km². The four patches of A total 707 KB
     against 663 KB for the island as one file (+7%: copied segments, shared edge nodes, headers).
   - About 80 MB gzip for SF.

## What this changes in the plan

- Pass 2 runs with `FILL_JITTER` on. Per-road curb statistics and junction radii are computed over
  whole roads before tiles are cut.
- The runtime gets a patch ring separate from the data ring. Race corridors are pinned only for the
  race being driven.
- Patch meshes are built incrementally, by chunk and LOD, and segments are drawn by their owning
  tile only.
- The v2 pilot (`data/v2/pilot.*`) is retired once patches cover its box. Expect up to a few cm of
  change there, from the fill.

# Pilot bake: Nob Hill + FiDi (Phase 0, step 5)

Baked and tested 2026-10-26. Real lidar ground and lidar-measured road surfaces now cover a 4 km²
box in the game, and physics drives on exactly what is drawn. Everything sits behind the existing
World API, with no contract change and no edits on the physics side.

- Bake: `tools/bake_pilot.py`
- Runtime: `src/world/pilot.js`
- Gates: `tools/test_pilot.mjs`
- Method behind the road ribbons: `road-surface-method.md`

## What is in the game now

| | |
|---|---|
| Box | x −920..1480, z −1480..200 (game metres; 2.4 × 1.68 km = 4.03 km²). Nob Hill, Chinatown, FiDi, Union Square, and the Embarcadero by the Ferry Building, where free roam spawns. |
| Ground | 2 m grid from USGS 3DEP lidar (`CA_SanFrancisco_1_B23`, ground class, withheld dropped). Ground returns inside building footprints (shrunk 1 m for OSM misalignment) are dropped first, because rooftop parks and podiums are classified as ground. Holes are filled from the surrounding streets; open water and piers use today's terrain. |
| Roads | 1,186 roads (81 km, 42,861 stations) as ribbons with a cross-section every ≤ 2 m. Each section has 7 knots: sidewalk edge, curb top, gutter, crown, gutter, curb top, sidewalk edge. |
| What is measured | Per station: gutter offsets and crown height. Per 10 m: curb height. Per road side: crown depth. |
| Curbs | 1,392 road sides measured from lidar; 496 use the 13 cm default (OSM says sidewalk, lidar found none); 484 have no curb. |
| Junctions | The ribbon follows the lidar grid inside each junction and ramps back to the measured section over 4 m. Curb and sidewalk taper to nothing into the junction, so no street's sidewalk crosses another's roadway; the taper doubles as a corner curb ramp. |
| Edge of the box | Blends into today's terrain over 24 m. Outside the box nothing changes. |
| Stacked roads | Where two roads overlap more than 2.5 m apart (an overpass clears at least 4 m), the upper one is kept and the ground under it is filled, as in today's world (43 stations, 0.1%). Today's `roads.js` still draws the lower road wherever no ribbon remains. Real stacking is Phase 1 structures work. |
| Ground under ribbons | Set to the exact ribbon surface (1 cm below), so physics has no step where a ribbon ends. The terrain mesh is kept behind roads with a depth offset. Near-vertical lidar ground (retaining walls) is drawn as concrete. |
| Fallback | Without `data/pilot.*`, with a pilot baked for a different `world.json`, or with `?pilot=0` in the URL, the game runs exactly as before. |

### Measured road shape (median, p10–p90)

| | Value |
|---|---|
| Curb height | 13.0 cm (9.1–16.9) |
| Crown above gutter | 13.2 cm (4.2–23.4) |
| Gutter to gutter | 10.8 m (5.5–15.2) |

## Gates (`node tools/test_pilot.mjs`: 16 passed)

The gates come from `tile-format-proposal.md` §2.7, adapted to a single overlay.

| Gate | Result |
|---|---|
| World outside the box unchanged | 200k points more than 60 m outside: 0 differences in heightAt, surfaceHeight, surfaceAt, collideCircle |
| Box edge seamless | max 0.00 cm against today's terrain |
| Ribbon-to-grid steps ≤ 2 cm | 99.4% of 67,483 crossings (p50 0.3 cm, p99 1.6 cm). The rest sit against real retaining walls the lidar sees; see below. The gate is the 99% share; the maximum (2.1 m) is not gated. |
| No unintended jumps | 0.07% of 200k random 1 cm pairs jump more than 2 cm (curb faces excluded; the limit is 0.1%) |
| Physics finds the drawn ribbon | 0 misses in about 6,000 points sampled inside the mesh quads, bends included |
| Physics height = drawn height | p99 0.00 cm where one ribbon covers the point (max 3.3 cm, at folds on the inside of sharp bends). Where ribbons overlap (8%, mostly junction mouths), physics follows the highest, which is the one the depth buffer shows (0 cases more than 2 cm below). |
| Curb height within ±2 cm of lidar | 93% of 34,685 measured 10 m windows (median error 0.2 cm, p90 1.6 cm) |
| Crown present | crown above both gutters at 97% of stations outside junctions |
| Curbs physical | heightAt rises > 6 cm from road to sidewalk at 95% of sampled curbs; surfaceAt goes road → sidewalk |
| Tracks | Nob Hill Jumps, Downtown GP and Embarcadero Sprint stay on road 99.6–99.9% inside the box. Nob Hill Jumps' steepest 2 m step is 58% (today 36%): a 1.15 m step where the route crosses between the two levels of split-level Jones St at Vallejo (see limits). |
| Speed | inside the box: heightAt 0.3 µs, surfaceHeight 0.5 µs, surfaceAt 0.7 µs per call (about 10× today's 8 m grid; well inside budget) |

The Filbert and 22nd St grade gate can't run here: both streets are outside the box. They were
checked directly in `road-surface-method.md` (30.4% and 31.5%, published 31.5%).

### Existing tests and AI races

- `tools/test_world.mjs`: 29/29 without the pilot and 29/29 with it.
- `dev/physics-tests.mjs`: 51/51.
- Prakhar's AI race (`dev/physics-ai-sf.mjs`), unmodified, run on the pilot world through
  `tools/pilot_shim` (a Node loader hook that hands `createWorldData` the pilot):

| Track | Finish times, today's world (s) | Finish times, with the pilot (s) | Recoveries / resets / water / DNF with the pilot | Rivals' hard hits, today → pilot |
|---|---|---|---|---|
| Nob Hill Jumps (2 laps) | 139.0–142.9 | about 140–145 | 0 / 0 / 0 / 0 | low single digits both ways |
| Downtown GP (3 laps) | 315.0–318.9 | 311.5–318.9 | 0 / 1 / 0 / 0 (one rival reset at Broadway near Kearny) | similar |
| Embarcadero Sprint | 109.7–115.7 (1 reset today) | 109.7–114.9 | 0 / 1 / 0 / 0 (the autopilot reset at the same spot as today's world) | similar |

**AI is a few seconds slower on Nob Hill with the pilot.** An independent run over 5 seeds on
the previous bake found 14 of 15 rival results slower, by 4.35 s on average. There were no more
resets, recoveries or crashes, and no consistent rise in hard hits. The likely cause is the real
crests, crowns and curbs. It is a feel question for Prakhar (`ai.js` braking for crests), not a
broken road.

## Size and speed

| | Measured |
|---|---|
| `pilot.bin.wasm` | 3.66 MB raw, 2.17 MB gzip, so **537 KB/km² gzip** for the ground grid plus ribbons (no `r`-file content yet) |
| Ground grid alone | 2.02 MB raw, 1.35 MB gzip (336 KB/km²); plain gzip, no predictor yet |
| Ribbons | 1.64 MB raw, 0.81 MB gzip (201 KB/km²) |
| Load in the browser | pilot decode + meshes 0.3 s; whole world 3.4–4.6 s |
| Triangles | terrain patch 2.15 M at LOD0 (2/4/8 m LODs), ribbons 0.50 M |
| Bake | 2.6 GB of LAZ (530 M points) fetched in 195 s with 4 parallel reads; full bake 7.7 min; rebake from the cached raster 1.2 min |

The proposal estimated 250–300 KB/km² for a whole `q` tile. Measured physics data is about 537
KB/km² with plain gzip; the planar predictor saves about 40% on the grid (`lidar-probes.md` §3).
So hilly downtown `q` tiles land at roughly 400 KB/km², above the estimate.

**fps was not measured.** The browser pane was hidden during the test drive, which throttles
rendering. It needs a visible window on the target mid-range laptop.

## Known limits

1. **Split-level streets.** Jones St at Vallejo has two roadways about 2.3 m apart with a wall between them. OSM joins them at one junction node, so the Nob Hill Jumps route crosses the wall: a 1.15 m step a driver will feel (the AI copes). Fix by routing that track around it (tracks are MAP-owned), not in the ground.
2. **Real cliffs.** The lidar ground has vertical steps where the city has walls: sunken plazas and
   ramps (−0.4 m next to 4.6 m near Battery St), the Stockton St cut (34.2 / 39.3 / 41.6 m within
   3 m at Chatham Place), and the Broadway tunnel portal. Physics sees these as cliffs in the ground.
   `vehicle.js` has no wall test for terrain, so **this is a question for Prakhar**: should terrain
   steps above about 0.5 m become wall solids?
3. **Stacked roads are flattened** to the upper level (Bush St over the Stockton cut and similar). Real
   stacking needs Phase 1 structures (`net`) and Prakhar's tunnel edit.
4. **Building ground** in the box moved by −6.5 to +9.6 m against today's terrain. Most of that is
   real slope (today's terrain is an 8 m smoothed model). The extremes are unchecked.
5. **Curb defaults.** 496 road sides got the 13 cm default because OSM marks a sidewalk but the
   lidar didn't find a curb. Some may be flush plazas or shared streets.
6. **Junctions** use the 2 m grid surface; there are no junction meshes or crosswalk ramps beyond the
   4 m blend. Overlapping ribbons at junction mouths can differ by a few cm; physics takes the higher.
7. **Datum.** Heights stay NAVD88, like today's world. D1 (sea level at y = 0) is still open; the
   pilot will be re-baked when the SFT1 projection and datum swap lands.
8. **Elevated roads** the bake skips (OSM bridge flag: the I-80 approach, part of Harrison St) are
   still drawn by `roads.js` on the ground, as before.

## Reproduce

```
python tools/bake_pilot.py                 # analysis venv; PDAL from the conda bake env
node tools/test_pilot.mjs
node --import ./tools/pilot_shim/register.mjs dev/physics-ai-sf.mjs nob-hill-jumps
```

Add `?pilot=0` to the page URL to compare against the world without the pilot.

# Real-data probes (gap 3): lidar classes, decks, one-tile bake, OSM recount

Run 2026-10-26 on real data, closing MAP_RESOURCES §11 gap 3. Every number here was measured, not
estimated. Scripts are in `tools/probes/` (see its README). Raw outputs (JSON, PNG) are in
`tools/research/probes/`. The road-surface results are in `road-surface-method.md`.

## 0. Setup that worked

- **Miniforge** 26.9.4-1. The installer's SHA-256 matched the GitHub release digest and it is signed
  by NumFOCUS.
- **`bake` env** from `tools/environment.yml`: PDAL 2.10.2, osmium-tool 1.19.1.
- On machines with **Windows Smart App Control** enabled, it blocks conda-forge Python's
  `unicodedata.pyd`, `_socket.pyd` and `_wmi.pyd`, and the pyosmium wheel.
  - This breaks pyproj, laspy, matplotlib, pandas and python-pdal inside the env.
  - The PDAL and osmium executables run fine.
  - Workaround (no policy change): call PDAL and osmium as programs, and do the analysis in a
    python.org Python 3.13 venv with numpy, scipy, matplotlib, pyproj and laspy[lazrs].
- **OSM**: Geofabrik `norcal-latest.osm.pbf`, 654.7 MB, MD5 matched. SF + Oakland + Berkeley cut to
  `bay_p12.osm.pbf` (40.5 MB, 4.74 M nodes, 608 k ways) in 9 s.
- **EPT reads through PDAL are fast.** A 106 × 100 m box took 3.5 s; a 512 m tile took 35 s as four
  serial quadrant reads.

## 1. Lidar classes and density

250 m × 250 m boxes. Densities are points/m² over the whole box, counting withheld points.

| Box | Project | All returns | Ground (2) | First returns | Classes present |
|---|---|---|---|---|---|
| Union Square (106 × 100 m plaza) | SF B23 | 154 | 77 | 130 | 1, 2, 7 |
| Financial District | SF B23 | 146 | 31 | 128 | 1, 2, 7, 18 |
| Outer Sunset houses | SF B23 | 121 | 42 | 112 | 1, 2, 7, 18 |
| Golden Gate Park forest | SF B23 | 126 | 33 | 90 | 1, 2, 7 |
| Bay Bridge west span (water) | SF B23 | 49 | 0 | 48 | 1, 7, 9, 17, 18 |
| Nob Hill 512 m tile | SF B23 | 92 | 21 | — | 1, 2, 7, 17, 18 |
| Downtown Oakland | Alameda `_2` | 50 | 5.2 | 40 | 1, 2, 7, 18 |
| MacArthur Maze | Alameda `_2` | 31 | 7.1 | 28 | 1, 2, 7, 17, 18 |
| Berkeley campus | Alameda `_3` | 156 | 6.3 | 120 | 1, 2, 7, 17, 18 |
| Lake Merritt | Alameda `_2` | 0.09 | 0 | 0.05 | 7, 9, 18 (water returns little) |

**Findings**
1. **No building (6) or vegetation (3/4/5) class exists**, in any box of any project. This settles
   the open question in `lidar-coverage.md` (the SF report listed class 4; the data has none).
   - Buildings and trees are all class 1, as the plan assumed.
   - Class 9 (water) and 17 (bridge deck) appear only where expected.
   - Class 20 (ignored ground) appears in the Bay Bridge approach crop (9.4 k points).
2. **SF density is about three times the documented figure.**
   - All returns run 121–154 pts/m² and first returns 90–130, against the documented 44. The 44 is
     probably nominal single-pass pulse density; overlap between flight lines adds the rest.
   - Ground density in SF is 31–42 pts/m² over mixed blocks, 77 on an open plaza, and 21 averaged
     over a dense Nob Hill tile.
3. **East Bay ground density is 5–7 pts/m², five to eight times lower than SF.** This matches the
   NV5 report (6.9 for `_2`).
   - The road-surface method has not been tried at that density yet.
   - A 1 m profile still gets about 25 ground points per station.
   - The 0.2 m curb bins get about 12 per 10 m window, which is marginal.
4. **Withheld is not just noise in Alameda.**
   - In SF, withheld points are exactly classes 7 + 18.
   - In downtown Oakland (`_2`) 236 k points are withheld against 2.7 k noise points, and in
     Berkeley (`_3`) 283 k against 3.4 k.
   - That fits the NV5 note that overlap and edge clips are flagged withheld. Drop withheld points
     everywhere.
5. **Project bounding boxes overstate coverage (affects D7).**
   - `_3` returned 0 points in downtown Oakland, Lake Merritt and the Maze, although its bbox
     contains them.
   - `_2` returned 0 points on the Berkeley campus.
   - So at these spots there is no choice to make: each is covered by one project only. The bake
     must test real coverage per tile (an EPT hierarchy lookup or a sparse read), not bboxes.

## 2. Bridge decks (class 17) and stacked structures

Plots: `probes/deck_*_topdown.png` (highest class per 0.5 m cell) and `probes/deck_*_section.png`
(6 m slabs across the structure, points coloured by class).

| Structure | Class 17 points | Class 17 Z range (m, NAVD88) | What the section shows |
|---|---|---|---|
| Bay Bridge SF approach over Rincon Hill (SF B23) | 4.27 M | 10.1–62.1 | One class-17 deck about 20 m wide at Z 57–58.6. No returns from below it, only truss and piers at the edges. |
| I-280 Southern Freeway viaduct, double-deck stretch (OSM w123867456 layer 2 / w27652088 layer 3, stacked for 495 m) | 458 k | 13.7–23.6 | Upper deck 14.5 m wide at Z ≈ 21.6, all class 17. Lower deck at Z ≈ 14.3 seen **only where it sticks out past the upper deck** (about 3–6 m per side); no returns under the upper deck. |
| MacArthur Maze (Alameda `_2`; `_3` has no points here) | 209 k | 5.0–19.3 | Class 17 on at least three levels (≈ 11.6, ≈ 18, ≈ 19 m). The lower deck is labelled 17 where visible and vanishes where an upper deck covers it. |

**Findings**
1. **Lidar cannot supply a complete lower deck.** Every stacked structure loses its lower roadway
   directly under the upper one. This confirms gap 2: hidden levels need drawings (HAER, Caltrans
   as-builts), interpolation between visible edges, or hand modelling.
2. **The visible edges are still useful.** They pin the lower deck's height (I-280 ≈ 14.3 m) and
   outer width. A lower deck can be built as a surface interpolated between its two visible edges.
3. **Class 17 labelling is inconsistent.**
   - On I-280 the same lower deck is class 1 in one slab and partly 17 in the next.
   - In the Maze, class 17 covers several levels.
   - Don't use class 17 alone to separate decks. Split by Z against the OSM `layer` tags of the
     ways above.

## 3. One-tile bake benchmark (Nob Hill)

Tile: SFT1 L0 (i, j) = (−2, −2), easting −1024..−512 m, northing 512..1024 m, centre
37.79492, −122.41622. Script `tools/probes/tile_benchmark.py`; numbers in
`probes/tile_benchmark.json`. Height-grid work only: no ribbons, solids or landcover yet.

| Stage | Measured |
|---|---|
| Fetch (4 serial EPT quadrant reads) | 35.1 s, 119.4 MB LAZ, 24.15 M points in the tile |
| Load + reproject | 8.8 s |
| Classes | 1: 18.63 M, 2: 5.47 M, 7: 30 k, 17: 19 k, 18: 5 |
| 2 m DTM (259 × 259, spec sample positions) | 1.1 s median + 2.3 s fill; **37.9% of samples had no ground point** (under buildings) |
| 0.5 m DTM | 55.4% empty |
| 0.5 m DSM | 0.35% empty; Z 53.6–208.8 m |
| HGT encode (uint16 cm above hBase = 53.48 m) | raw 134,162 B; gzip 103,380 B; row delta + gzip 69,270 B; **planar predictor + gzip 63,660 B**; 0.1 s |
| Total per tile, single thread | 53.6 s, of which 35 s is network |

**Against `tile-format-proposal.md`**
- **HGT raw size matches.** 510 KB/km² estimated is 133.7 KB per tile; measured 134.2 KB.
- **The `q` compressed budget is too small for hilly urban tiles.**
  - The proposal estimates 250–300 KB/km² for all `q` sections, about 65–79 KB per tile.
  - HGT alone measures 63.7 KB per tile (243 KB/km²) with the planar predictor, leaving almost
    nothing for ribbons, solids, landcover, tunnels and halo.
  - Expect `q` to be larger on hilly urban tiles. Re-estimate after the pilot bake adds the other
    sections.
- **Projection to Phases 1+2** (the proposal's ~1,300 land tiles, Nob Hill density everywhere, so
  an upper bound):
  - about 19 h single-threaded, dominated by fetch;
  - about 155 GB of LAZ downloaded if every tile were this dense;
  - HGT ≈ 83 MB total.
  - Tiles are independent, so fetch and bake parallelise across tiles. Only the manifest and the
    shared-border seam check are serial.

**Against today's terrain (Terrarium z14)**
- Over the whole tile, lidar DTM minus Terrarium: mean +0.31 m, RMS 1.35 m, p95 2.9 m, max 11.0 m.
  No datum shift was applied.
- On streets the difference is near zero, which agrees with the 0.15–0.67 m found on road
  centrelines.
- The large differences are:
  - **A 2–5 m deep trench in the north-west corner.** It is consistent with the cut at the Broadway
    Tunnel's west portal (UNCONFIRMED); Terrarium smooths it away.
  - **Blobs 5–11 m high inside some large blocks.** These are either flat roofs or podiums
    classified as ground, or Terrarium error (UNCONFIRMED). Physics never drives there, but check
    them against footprints before taking building base heights from the DTM.
- The 2 m DTM's slope p99 of 104% and max of 414% are interpolation artefacts inside block
  interiors, where 38% of samples are filled under buildings. Mask by footprints before using slope.

**Review fixes:** a code-checking agent passed `tile_benchmark.py`. A uint16 overflow guard was
added to the residual encoders, and the per-tile HGT estimate was corrected from 510 KB to 133.7 KB.

## 4. OSM recount from the Geofabrik extract

Script: `tools/probes/osm_recount.py` (osmium CLI plus the venv; about 2.6 minutes).
- Data: `norcal-latest.osm.pbf`, replication timestamp 2026-10-25T21:21Z.
- City polygons are OSM relations 111968 (SF, includes ocean and the Farallones), 2833530
  (Oakland, Piedmont excluded) and 2833528 (Berkeley).
- Raw numbers: `probes/osm_recount.json`. Line-by-line comparison against every OSM count in the
  notes: `probes/osm_recount_vs_notes.json`.

**The Overpass-era counts mostly hold.**
- 256 of 327 comparison entries match exactly when recounted over the same bboxes.
- The real differences:
  - **Street lamps**: SF 1,801 (old 1,445–1,451, ~4% of real lights, not ~3%); Oakland 886 (956);
    Berkeley 91 (105). The old numbers came from a partial query.
  - **`building_passage` highway ways**: 177 in the SF bbox (old ~165).
  - **SF `bridge:structure`**: 13 (old 26).
  - **East Bay building tags**: height 0.04–0.10% (old 0.1–0.3%), `building:levels` Oakland 1.0%,
    Berkeley 4.9%; `roof:shape` up to 0.6%.
  - **Light rail and tram way counts** in `road-markings.md` came from a partial cache: 456 and
    127 ways in the SF bbox, not 117 and ~36.
- Previously UNCONFIRMED counts in `street-furniture.md` and `structures.md` are now counted.

**Per city** (city polygons; drivable = motorway…residential, links, unclassified, living_street, service)

| | SF | Oakland | Berkeley |
|---|---|---|---|
| Drivable km (without service) | 2,340 (1,897) | 2,644 (1,779) | 542 (401) |
| `width` / `incline` on drivable ways (% of km) | 0.8 / 0.1 | 0.0 / 0.0 | 0.4 / 0.5 |
| `lanes` / `maxspeed` / `surface` (% of km) | 38 / 27 / 53 | 27 / 14 / 32 | 45 / 71 / 78 |
| `layer` on bridge+tunnel ways | 86% (bridges 327/331, tunnels 35/91) | 89% (474/479, 25/81) | 72% (27/29, 9/21) |
| Traffic signal / stop / crossing nodes | 2,227 / 4,716 / 19,570 | 1,176 / 4,108 / 9,439 | 242 / 1,613 / 3,645 |
| `kerb=*` nodes (SF: 9,322 lowered, 1,615 flush, 257 raised) | 11,528 | 4,697 | 2,618 |
| Street lamps / trees | 1,786 / 10,839 | 568 / 1,414 | 74 / 643 |
| Retaining wall / guard rail ways | 568 (32 km) / 20 (2.9 km) | 256 (22 km) / 19 (1.3 km) | 165 (6 km) / 20 (1.0 km) |
| `tunnel=building_passage` ways | 204 | 72 | 37 |
| Buildings / with `height` | 161,529 / 86.6% | 139,697 / 0.10% | 35,820 / 0.04% |

**What it means for the map**
- **Roads**:
  - OSM gives topology and names.
  - Width and incline are essentially absent everywhere (under 1% of km), so road geometry has to
    come from lidar. `road-surface-method.md` shows that works.
  - Bridges carry `layer` almost always; tunnels only 30–45% of the time, so tunnel stacking needs
    `structures.md`, not OSM alone.
- **Curbs**: OSM `kerb` nodes are almost all crossing ramps (lowered/flush), which agrees with
  `osm-completeness.md`. Curb lines come from lidar or DataSF.
- **Guard rails**: 2.9 km in all of SF is far below reality. Detect them in lidar or place them by
  rule along drops and ramps.
- **Cable cars**: tagged `railway=tram gauge=1067 electrified=no`, 78 ways, 15.2 km. The three
  lines are SFMTA `route=tram` relations (Powell/Hyde 1959009/3433158, Powell/Mason
  1959010/3433157, California 2852264/2852265). Muni streetcars are `gauge=1435
  electrified=contact_line`. Hyde and Taylor carry `embedded_rails` on 21 road ways.
- **Oakland's 17 `funicular` ways** are the BART Oakland Airport Connector, tagged `route=monorail`
  in its relations. Not a street feature.

# Building heights and roof shapes from 3DEP lidar: method spec (Oakland / Berkeley / Emeryville + SF refresh)

Researched 2026-10-26. Tags: **[CONFIRMED]** = read from a primary source or measured by me this session; **[ESTIMATE]** = my arithmetic or judgement; **UNCONFIRMED** = not verified. PDAL, GDAL, rasterio, laspy and DuckDB were not installed when this was written, so no PDAL pipeline below was executed then (the probes in `lidar-probes.md` have since run on real data). The pure numpy/scipy routines in section 7 were run on synthetic roofs only. Real-world roof accuracy is unmeasured.

## 0. Findings that change the plan

| # | Finding | Evidence |
|---|---|---|
| 1 | **Neither SF nor Alameda lidar has a building class (6).** SF B23 uses classes 1, 2, 4, 7, 9, 17, 18, 20; Alameda 2021 uses 1, 2, 7, 9, 17, 18, 20 (no 4, 5, 6). Buildings sit in class 1 together with trees, cars and clutter. Heights must be **footprint-driven**; nothing can be selected by class. | [SF project report](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/CA_SanFrancisco_B23/USGS_CA_SanFrancisco_B23_Project_Report.pdf) (Classifications Used table), [Alameda technical report](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/CA_AlamedaCounty_2021_B21/CA_AlamedaCo_3_2021/reports/Alameda_Technical_Data_Report_Final_Signed.pdf) (Table 9). Reports describe classes delivered, not a histogram of the actual points: confirm with the `filters.stats` check in 3.1. |
| 2 | **Oakland, Berkeley, Emeryville and Alameda are NOT in `CA_AlamedaCo_1_2021`.** That project's EPT bounds start at x = -13601816 (EPSG:3857) = lon -122.18, east of Berkeley (-122.26) and Oakland (-122.27). They are inside `CA_AlamedaCo_2_2021` and `CA_AlamedaCo_3_2021`, which overlap each other. Contradicts MAP_RESOURCES.md, which lists `_1` for Oakland/Berkeley. Use one of `_2`/`_3` per tile, never both (double surfaces). | `ept.json` bounds: [`_1`](https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_1_2021/ept.json), [`_2`](https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_2_2021/ept.json), [`_3`](https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_3_2021/ept.json); point-in-bounds test of 8 landmarks run by me. |
| 3 | **EPT coordinates are EPSG:3857, so `resolution` and every PDAL distance option is in inflated metres.** At lat 37.8 one 3857 metre = 0.790 ground metres (scale factor 1.265). `resolution: 1.0` means ~0.79 m on the ground. Reproject to a metric CRS (EPSG:6339 or EPSG:7131) *before* `writers.gdal`, or its `resolution` will not be metres either. | `ept.json` `srs.horizontal = 3857`, no vertical; [readers.ept](https://pdal.io/en/stable/stages/readers.ept.html) says resolution is "in the dataset's CRS units". |
| 4 | **Overture already carries heights for ~68% of East Bay buildings, but almost all are Microsoft ML estimates, not lidar (0 USGS-lidar-sourced heights in the East Bay bbox)**; roof_shape exists for only 0.18%. In SF, 94.6% have a height, but 142,417 (PBF recount 2026-10-26) (139,822 in the SF city polygon) of 170,024 (PBF recount 2026-10-26) (161,529 city polygon) are OSM-tagged heights that were imported from the 2010-era DataSF lidar (circular, stale). Overture is a fallback and a cross-check, not a substitute. | Section 2. |
| 5 | **SF vintage:** B23 was flown in a single day, 2023-04-20, QL0, hydro-flattened, DEM GSD 0.25 m. **East Bay vintage is mixed:** summer 2021 QL0/QL1, plus a 2019 "Western Alameda" QL1 upgrade at the project borders. Anything built after the flight is missing from the lidar (5 years of East Bay construction). EPT carries `GpsTime`, so each building can be dated from its own points. | SF report; Alameda report Table 1 (2021: 06/21, 06/22, 06/30, 07/02, 07/03; 2019: 07/02, 07/03, 07/05, 07/06). |
| 6 | DataSF's heights are exactly the footprint-zonal-statistics method this spec reproduces (50 cm cells, median of height-above-ground per footprint, from Pictometry-era 2010 lidar), so the DataSF table doubles as a validation set for SF. | [DataSF schema](https://data.sf.gov/api/views/ynuv-fyni.json) (`hgt_median_m`, `peak_1st_m`, `gnd_min_m`, `p2010_name` = `SanFranB_0269.flt`). |

## 1. Source facts: lidar projects

| Item | SF `CA_SanFrancisco_1_B23` | Alameda `CA_AlamedaCo_2_2021` / `_3_2021` |
|---|---|---|
| Points (EPT) | 13,088,433,078 | `_2` 26,097,078,802; `_3` 35,811,005,634 (`_1` 39.6 B, not relevant) |
| Quality level | QL0 (work unit 300449) | QL0 (20 pulses/m², 0.22 m spacing) and QL1 (8 pulses/m², 0.35 m); which sub-project is which UNCONFIRMED. Root-hierarchy depth is greater in `_3` at Berkeley campus and Alameda (depth 7 vs 4), suggesting `_3` is the denser one there [ESTIMATE]. |
| Collection | 2023-04-20, Riegl 1560ii/ii-s | 2021-06-21..2021-07-03 (+ 2019-07 upgrade areas) |
| Tested accuracy | Point cloud NVA RMSEz 1.73 cm, NVA 95% 3.38 cm, VVA 95th pct 11.66 cm; DEM NVA RMSEz 1.63 cm | NVA 4.1 cm (95%) vs classified LAS; vegetated VVA 10.6 cm; first-return density QL0 61 pts/m², QL1 30 pts/m² (Table 11/12 text) |
| Datum | EPSG:7131 NAD83(2011) / San Francisco CS13 (Bay-Area-wide metre CRS per [epsg.io](https://epsg.io/7131)), vertical NAVD88 GEOID18 (EPSG:5703) | NAD83(2011), NAVD88 GEOID18 |
| Classes in report | 1, 2, 4, 7, 9, 17, 18, 20 | 1, 2, 7(W), 9, 17, 18(W), 20 (1-W edge clip also present) |
| EPT schema | X Y Z Intensity ReturnNumber NumberOfReturns ScanDirectionFlag EdgeOfFlightLine Classification ScanAngleRank UserData PointSourceId GpsTime ScanChannel ClassFlags | same |
| Measured density | 13.09 B points / (21,110 x 19,766 m in 3857 x cos²(37.8°)=0.624) = ~260 km² ground = **~50 pts/m² average** (includes water and flightline overlap) | n/a |
| Measured EPT cost | 10.4 bytes/point of LAZ (two depth-5 nodes of ~110k points, 1.1-1.2 MB each, 2.7-2.9 MB/s single stream, 0.4 s each) | same schema, assume similar |

Notes
- Class 17 (bridge deck) exists in both: 29.5 M (QL0) and 2.1 M (QL1) points in Alameda. That is the deck-profile source for the Bay Bridge and overpasses; it is also why those decks must not be treated as ground or building.
- Alameda lists "withheld" variants (1-W, 7-W, 18-W). In LAS 1.4 the withheld bit lives in `ClassFlags` (bit value 4). Whether Entwine kept those points in EPT is UNCONFIRMED; check in 3.1 and drop them if present.
- The z extent in `ept.json` (-10345..10765 m) is noise; always clip Z and drop classes 7 and 18.
- Overture's own lidar-height work states buildings are classified separately in only about 15% of USGS projects, so tree overhang inflates heights ([route-fifty summary](https://route-fifty.com/digital-government/2023/05/building-better-maps-open-data-building-heights/386806), via search snippet; the [whitepaper PDF](https://project.linuxfoundation.org/hubfs/Overture%20Maps/Building%20Heights%20Whitepaper_041423.pdf) exceeds the fetch size limit, so I did not read it fully).

## 2. Overture Maps check (release 2026-10-21.0, queried by me with pyarrow row-group reads on `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/`)

Schema ([reference](https://docs.overturemaps.org/schema/reference/buildings/building/)) has `height`, `min_height`, `num_floors`, `roof_shape`, `roof_height`, `roof_direction`, `has_parts`, plus a separate `type=building_part` table (4.49 M rows, one 0.6 GB file). Building files: 512 parquet files, ~277 GB; the Bay Area lives in `part-00032` and `part-00033`, 38 row groups (~0.5 MB each for the columns I read). Row-group `bbox` statistics make small-area reads cheap.

**Coverage by bbox (counts of `bbox.xmin/ymin` inside the box):**

| Area | Buildings | with `height` | height from Microsoft ML | height from USGS Lidar | with `num_floors` | with `roof_shape` |
|---|---|---|---|---|---|---|
| Phase 1 SF (-122.53..-122.35, 37.70..37.84) | 171,371 | 162,068 (94.6%) | 5,274 | 12,942 | 3,208 | 315 (0.18%) |
| Phase 2 East Bay (-122.38..-122.17, 37.76..37.90) | 180,119 | 121,891 (67.7%) | 118,069 | **0** | 3,557 | 323 (0.18%) |
| Berkeley sample (-122.30..-122.24, 37.855..37.885) | 21,107 | 15,079 (71%) | ~14.9k | 0 | 1,340 | 201 |
| Oakland downtown (-122.29..-122.255, 37.79..37.82) | 3,408 | 1,582 (46%) | 1,468 | 0 | 567 | 15 |
| Emeryville (-122.295..-122.275, 37.829..37.845) | 3,265 | 2,183 (67%) | ~2.1k | 0 | 103 | 7 |
| `building_part` rows in the two bboxes | SF 1,647 / East Bay 629 | height on 969 / 70 | | | | roof_shape on 103 / 140 |

(The East Bay bbox overlaps the east edge of SF and Treasure Island. The remaining 142,417 (PBF recount 2026-10-26) SF heights have no per-property source tag: they are OSM `height` tags.)

What the heights are
- Footprints are 98-99% OpenStreetMap (`sources[].dataset`); heights in the East Bay are `Microsoft ML Buildings`, license field `ODbL-1.0` in Overture, record `version` 2026-08-11. Microsoft's own repo states heights come from a neural network trained on imagery paired with height measurements, averaged inside each polygon, and gives **no accuracy metric** ([github](https://github.com/microsoft/globalmlbuildingfootprints), license CDLA Permissive 2.0 there; Overture relabels it ODbL).
- Median Berkeley height 5.0 m, p90 6.5 m (plausible for 1-2 storey fabric). Hand-mapped towers are correct: Overture's tallest are Sather Tower 93.6 m and Ordway Building 123 m (these are OSM values with a `names` entry, not independent confirmation).
- Overture USGS-lidar-sourced heights exist only where someone ran the 2023 Overture lidar job: 12.9k in SF, none in the East Bay. Vintage of those SF values is UNCONFIRMED (the source record has no `version`, `update_time` or `license`).

Quality probe (SF, vs DataSF `hgt_median_m`, matched by Overture centroid inside a DataSF footprint; **indicative only**: footprints are split differently, n is small, and the OSM-tagged heights are derived from DataSF, so that row is circular):

| Area / Overture height source | matched n | bias (Overture - DataSF) | MAE | median abs err | p90 abs err |
|---|---|---|---|---|---|
| Sunset, OSM-tagged (circular) | 1,025 | -0.2 m | 1.6 m | 1.0 m | 3.5 m |
| Sunset, USGS Lidar | 74 | +2.0 m | 2.7 m | 1.9 m | 5.8 m |
| Sunset, Microsoft ML | 15 | -0.9 m | 1.7 m | 1.8 m | 2.8 m |
| Mission, USGS Lidar | 60 | +0.1 m | 2.6 m | 2.1 m | 5.7 m |
| Mission, Microsoft ML | 16 | -2.2 m | 3.0 m | 2.0 m | 5.4 m |
| FiDi, USGS Lidar | 69 | -4.8 m | 10.5 m | 4.3 m | 28 m |
| FiDi, OSM-tagged | 303 | +2.5 m | 17.9 m | 3.8 m | 54.9 m |
| FiDi, Microsoft ML | 8 | -17.8 m | 18.0 m | 13.3 m | 34 m |

Reading it: Overture heights are good enough for low-rise fabric (typical 1-3 m error, which is the same size as a pitched-roof ambiguity), and bad for towers and multi-part buildings (tens of metres, because a whole-footprint height replaces stepped parts). The USGS-lidar heights in low-rise SF run ~+2 m high in the Sunset, consistent with a high-percentile or max roof statistic that includes ridge and trees. No equivalent probe is possible in the East Bay without our own lidar numbers, which is the point of this pipeline: compute ours, then report its agreement with Overture/Microsoft as a QA metric.

Reproducible probe scripts used (not committed): pyarrow `S3FileSystem(anonymous=True, region="us-west-2")`, footer scan of all 512 files (~2 min) to find row groups whose `bbox.xmin/ymin` ranges intersect, then `ParquetFile.read_row_groups([...], columns=[...])`.

## 3. Pipeline overview

```
footprints (Overture/OSM, WGS84)  ──┐
                                     ├─> per-tile: rasterize ids ─> zonal stats ─> roof class ─> parts ─> JSON/bin rows
EPT lidar (3857) ─PDAL─> DSM/DTM ───┘                                   │
        (reproject to EPSG:6339)       ground ring + registration shift  └─> QA vs DataSF / Overture / landmarks
```

Design decisions
1. **Footprint-driven, raster-based.** One PDAL pass per 500 m tile makes a 0.5 m max-surface (DSM), a single-return surface, a min/ground surface, and a point-count raster. All per-building maths then runs in numpy on those rasters (fast, vectorised, restartable). Point-level work (HAG, plane RANSAC) is a second pass restricted to buildings flagged complex.
2. **Ground per building, not global HAG.** In SF, building bases sit on slopes; store `z_base` = low percentile of ground in a 1-4 m ring (3D BAG uses the 5th percentile of ground points within 4 m: [attributes](https://docs.3dbag.nl/en/schema/attributes/)) and absolute `z_roof` in NAVD88, and render a skirt from terrain up. Do not store a single "height".
3. **Robust statistic per footprint.** Median and p90 beat mean/mode/range for lidar building heights ([arXiv 2505.14747](https://arxiv.org/pdf/2505.14747) via search summary; the PDF itself was over the fetch limit). The OSM SF import used median ([wiki](https://wiki.openstreetmap.org/wiki/San_Francisco_Building_Height_Import)) and recorded a 2-3 storey house tagged ~14 m because of trees.
4. **Footprint registration check** (OSM/Microsoft footprints are traced from imagery; NAD83(2011)<->WGS84 can also differ by 1-2 m, magnitude UNCONFIRMED): estimate a per-tile (dx, dy) by maximising roof-minus-ring contrast (snippet 6.4) and apply it before zonal stats. Always erode footprints 0.5-1.0 m inward for roof statistics.

### 3.1 Confirm classes in actual points (run first, ~1 MB of data)

```json
[
  { "type": "readers.ept",
    "filename": "https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_3_2021/ept.json",
    "bounds": "([-13611800, -13611300], [4558300, 4558800])",
    "resolution": 0.3 },
  { "type": "filters.stats", "dimensions": "Classification,ClassFlags,NumberOfReturns", "enumerate": "Classification,ClassFlags" }
]
```
Run as `pdal pipeline stats.json --metadata stats.meta.json`. Bounds are 3857 metres around Berkeley campus; `enumerate` on `filters.stats` is from memory of the PDAL docs (UNCONFIRMED). Expect classes {1,2,9,17,...} and no 6 and no 5. If `ClassFlags` shows the withheld bit, drop it in the range filter.

### 3.2 Tile DSM/DTM pass (PDAL pipeline JSON)

`ground_res` 0.5 m => EPT `resolution` = 0.5 / cos(37.8°) = **0.633**. Bounds go in as a JSON object with its own `crs` (readers.ept docs: only the object form carries a `crs`), so you can write tiles in UTM and let PDAL transform.

```json
[
  { "type": "readers.ept",
    "filename": "https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_3_2021/ept.json",
    "bounds": { "minx": 563000, "miny": 4189500, "maxx": 563520, "maxy": 4190020, "crs": "EPSG:6339" },
    "resolution": 0.633,
    "requests": 15 },
  { "type": "filters.range",
    "limits": "Classification![7:7],Classification![18:18],Z[-30:1000]" },
  { "type": "filters.reprojection", "in_srs": "EPSG:3857", "out_srs": "EPSG:6339" },
  { "type": "writers.gdal",
    "filename": "tile_563000_4189500_dsm.tif",
    "resolution": 0.5,
    "output_type": "max",
    "window_size": 2,
    "radius": 0.71,
    "bounds": "([563010, 563510], [4189510, 4190010])",
    "nodata": -9999,
    "data_type": "float32",
    "gdaldriver": "GTiff",
    "override_srs": "EPSG:6339" }
]
```
Notes
- `bounds` for the reader is the tile plus 10 m buffer; the writer `bounds` is the exact 500 m tile (grid-aligned), so tiles butt together. UTM coordinates above are placeholders; compute them with pyproj (6.1).
- `max` with `window_size` 2 fills single-cell holes. Use `output_type: "min,max,count,stdev"` to get several bands in one TIFF; band order/descriptions UNCONFIRMED, check with `gdalinfo` once.
- `Classification![7:7],Classification![18:18]` uses the documented negation form ([filters.range](https://pdal.io/en/stable/stages/filters.range.html)); on one dimension multiple ranges are ORed, so two separate negations behave as "not 7 OR not 18" (always true) if PDAL ORs them. **Verify on a tile**; the safer form is a single expression: replace the range stage with `{ "type": "filters.expression", "expression": "Classification != 7 && Classification != 18 && Z >= -30 && Z <= 1000" }` (operators used in the [expression docs](https://pdal.io/en/stable/stages/filters.expression.html) example are `>=`, `<=`, `==`, `&&`; `!=` is UNCONFIRMED).
- Second run (or a second writer branch) for the **roof surface that ignores trees**: add `{ "type": "filters.range", "limits": "NumberOfReturns[1:1]" }` before the writer and write `*_dsm_single.tif`. Roofs, walls and pavement are mostly single-return; canopy yields multi-return pulses. Use it as the primary roof surface, fall back to the all-returns DSM where the single-return surface has <50% coverage in the footprint.
- Ground surface: prefer the USGS 1 m bare-earth DEM already listed in MAP_RESOURCES (hydro-flattened, QC'd, covers the ground under buildings by interpolation). If you need to derive it, same pipeline with `"limits": "Classification[2:2]"`, `output_type: "idw"` (or `mean`), `window_size: 8`, `resolution: 1.0`.

### 3.3 Point-level HAG (second pass, flagged buildings only)

Ground class 2 exists in both projects, so HAG filters work.

```json
[
  { "type": "readers.ept",
    "filename": "https://usgs-lidar-public.s3.amazonaws.com/CA_SanFrancisco_1_B23/ept.json",
    "polygon": "POLYGON((-13627650 4547100, -13627550 4547100, -13627550 4547200, -13627650 4547200, -13627650 4547100))/EPSG:3857",
    "resolution": 0.25 },
  { "type": "filters.expression", "expression": "Classification != 7 && Classification != 18" },
  { "type": "filters.hag_delaunay", "count": 10, "allow_extrapolation": true },
  { "type": "filters.range", "limits": "HeightAboveGround[1.5:]" },
  { "type": "writers.las", "filename": "bldg_pts.laz", "extra_dims": "HeightAboveGround=float32" }
]
```
- `readers.ept` `polygon` accepts WKT with a `/EPSG:xxxx` suffix; several polygons can be passed as an array and are unioned ([docs](https://pdal.io/en/stable/stages/readers.ept.html)). Use it to pull only the buffered footprints of flagged buildings.
- `filters.hag_delaunay` triangulates ground, so it interpolates under big roofs; it requires prior ground classification (present) and fails if nearby ground lies all on one side, falling back to the nearest ground Z ([docs](https://pdal.io/en/stable/stages/filters.hag_delaunay.html)). `filters.hag_nn` (`count`, `max_distance`, `allow_extrapolation`, `class`) is cheaper but gives the nearest ground, which on a SF slope can be the neighbouring street ([docs](https://pdal.io/en/stable/stages/filters.hag_nn.html)). Prefer Delaunay for HAG, but do not use HAG as the building height: it is wrong on sloped lots (DataSF example record: `gnd1st_delta` 14.51 m vs `hgt_median_m` 12.76 m).
- `filters.normal` (knn 8; outputs NormalX/Y/Z, Curvature) and `filters.covariancefeatures` (outputs Planarity, Linearity, Scattering, Verticality) are available for roof-plane work ([normal](https://pdal.io/en/stable/stages/filters.normal.html), [covariancefeatures](https://pdal.io/en/stable/stages/filters.covariancefeatures.html)). `filters.overlay` can write a polygon attribute into a point dimension ([docs](https://pdal.io/en/stable/stages/filters.overlay.html)); dimension-width limits UNCONFIRMED, so keep per-tile local ids below 65,535 if you target a 16-bit dimension.

## 4. Per-footprint zonal statistics: spec

Inputs per tile: footprints (polygons, UTM), DSM (all returns), DSM_single (NumberOfReturns==1), DTM (USGS 1 m DEM resampled to 0.5 m, bilinear), point-count raster.

Per building (after registration shift and 0.75 m inward erosion):

| Field | Definition |
|---|---|
| `z_base` | 10th percentile of DTM in the ring 1..4 m outside the footprint (3D BAG uses 5th percentile of ground points within 4 m); fallback min of DTM inside footprint |
| `z_roof_p10/p50/p90/p95/max` | percentiles of roof surface (DSM_single, else DSM) inside eroded footprint, absolute NAVD88 |
| `h_p50`, `h_p90`, `h_max` | `z_roof_* - z_base` |
| `spread` | `p95 - p10` of roof surface (roof elevation spread: flat ~0.2-0.5 m, pitched >1 m) |
| `cover` | fraction of footprint cells with a valid surface |
| `single_frac` | fraction of lidar points in footprint with NumberOfReturns==1 (tree contamination indicator) |
| `veg_flag` | `single_frac < 0.7` or `cover < 0.6` or (`spread` large and roughness high) |
| `lidar_date` | median `GpsTime` of points in footprint (needs a point pass, or tile-level date) |
| `mismatch_flag` | `h_p50 < 1.5 m` while Overture/OSM height > 3 m (new construction after flight, or demolished) |

Rendering rule of thumb: flat roof -> box to `z_roof_p50`; pitched -> eave at `z_roof_p10`, ridge at `z_roof_p95`; the classifier in 7 sets the shape.

## 5. Multi-part buildings, towers, setbacks

1. If the footprint has OSM `building:part` / Overture `building_part` children (SF 1,647; East Bay 629 in the bboxes), run the zonal stats per part and subtract nothing from the parent. These are too few to cover the fabric, so do not rely on them.
2. Otherwise **plateau splitting from the lidar itself** (tested on synthetic data in 7.2): histogram of roof height above base in 0.5 m bins; a run of bins whose share of the footprint is >= 0.4% is one level; between levels the wall cells are sparse, so setbacks separate cleanly. Each level is opened with a 3x3 element, labelled, and kept if area >= 12 m². A gabled roof stays a single part (checked). Output: stacked prisms sorted by level, polygon simplified (Douglas-Peucker 0.5 m), at most 8 parts per building. Synthetic test: 12 m podium + 40 m tower + 46 m penthouse returned exactly three levels with correct areas (300 / 84 / 16 m²).
3. Prisms stack from `z_base`; the upper part's footprint is the level mask, not an offset of the parent.
4. Overhangs and podium canopies: a level with area < 12 m² is dropped into its neighbour. Bridges between towers (SF) will merge; accept.

## 6. Runnable snippets (Python; rasterio/geopandas/pyproj/shapely/pdal bindings from the planned `bake` env; scipy is also needed for `parts.py`, which is NOT on the MAP_RESOURCES package list, so adding it is your call)

### 6.1 Tile grid and PDAL driver

```python
import json, math, pdal
from pyproj import Transformer

EPT = {"east": "https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_3_2021/ept.json",
       "sf":   "https://usgs-lidar-public.s3.amazonaws.com/CA_SanFrancisco_1_B23/ept.json"}
GROUND_RES = 0.5
EPT_RES = GROUND_RES / math.cos(math.radians(37.8))     # 0.633: EPT resolution is in 3857 metres

def tile_pipeline(ept, x0, y0, tile=500, buf=10, single=False):
    """x0,y0 = tile origin in EPSG:6339 (UTM 10N, NAD83(2011)); returns a PDAL pipeline dict."""
    stages = [
        {"type": "readers.ept", "filename": ept, "resolution": EPT_RES, "requests": 15,
         "bounds": {"minx": x0 - buf, "miny": y0 - buf, "maxx": x0 + tile + buf, "maxy": y0 + tile + buf, "crs": "EPSG:6339"}},
        {"type": "filters.expression",
         "expression": "Classification != 7 && Classification != 18 && Z >= -30 && Z <= 1000"},
    ]
    if single:
        stages.append({"type": "filters.range", "limits": "NumberOfReturns[1:1]"})
    stages += [
        {"type": "filters.reprojection", "in_srs": "EPSG:3857", "out_srs": "EPSG:6339"},
        {"type": "writers.gdal", "filename": f"out/{x0}_{y0}_{'dsm1' if single else 'dsm'}.tif",
         "resolution": GROUND_RES, "output_type": "max,count", "window_size": 2, "radius": 0.71,
         "bounds": f"([{x0}, {x0 + tile}], [{y0}, {y0 + tile}])", "nodata": -9999,
         "data_type": "float32", "override_srs": "EPSG:6339"},
    ]
    return {"pipeline": stages}

def run_tile(ept, x0, y0, **kw):
    p = pdal.Pipeline(json.dumps(tile_pipeline(ept, x0, y0, **kw)))
    return p.execute()          # returns point count; catch and log exceptions per tile
```
Benchmark exactly one 500 m downtown tile, time it, and scale the estimates in 9.

### 6.2 Zonal percentiles in one sort (tested on synthetic arrays)

```python
import numpy as np
def zonal_percentiles(lab, val, qs=(5, 10, 50, 90, 95)):
    m = (lab > 0) & np.isfinite(val)
    l, v = lab[m], val[m]
    o = np.lexsort((v, l)); l, v = l[o], v[o]
    ids, start, cnt = np.unique(l, return_index=True, return_counts=True)
    return ids, cnt, {q: v[start + np.round(q / 100 * (cnt - 1)).astype(int)] for q in qs}
```
Label raster: `rasterio.features.rasterize(((geom, id) for ...), out_shape=dsm.shape, transform=dsm_transform, all_touched=False, dtype="int32")` with footprints eroded 0.75 m (`geom.buffer(-0.75)`); the ground ring label is `buffer(4) - buffer(1)` of the original footprint with cells of other buildings masked out.

### 6.3 Tile-level numbers to store per building

```python
ids, n, z = zonal_percentiles(lab_roof, dsm1_or_dsm)          # roof elevation percentiles
_, _, g   = zonal_percentiles(lab_ring, dtm, qs=(10, 50))      # ground in 1..4 m ring
base = np.where(np.isfinite(g[10]), g[10], dtm_min_inside)     # fallback
h50, h90, hmax = z[50] - base, z[90] - base, z[95] - base
```
(Join `g` to `ids` by id before subtracting; arrays are indexed by sorted unique id.)

### 6.4 Registration shift per tile (footprint vs lidar)

```python
def best_shift(ndsm, foot_mask, ring_mask, max_m=3.0, cell=0.5):
    """Integer-cell search for the footprint shift that maximises mean nDSM inside minus mean in the ring."""
    best, arg = -1e9, (0, 0)
    r = int(max_m / cell)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            f = np.roll(foot_mask, (dy, dx), (0, 1)); g = np.roll(ring_mask, (dy, dx), (0, 1))
            s = np.nanmean(ndsm[f]) - np.nanmean(ndsm[g])
            if s > best: best, arg = s, (dx * cell, dy * cell)
    return arg        # apply with shapely.affinity.translate to the tile's footprints
```
Use only tiles with >= 200 buildings; apply a median shift per tile, and log it: a map of shifts is also a free consistency check on the NAD83(2011) vs WGS84 question.

## 7. Roof form classification

### 7.1 Method (DSM slope/aspect histogram, no point-level work)

Per building on the single-return DSM at 0.5 m, 3x3 smoothed, inner 1 m eroded:

| Class (Overture `roof_shape` vocabulary) | Rule |
|---|---|
| `flat` | >=80% of cells slope < 8 deg, or <20% of cells slope >= 10 deg |
| `skillion` (shed) | one aspect cluster holding >= 12% of sloped cells, all else flat; ridge direction = aspect +/- 90 |
| `gabled` | two aspect clusters about 180 +/- 35 deg apart; `roof_direction` = ridge azimuth (aspect + 90) mod 180 |
| `half_hipped` | three clusters |
| `hipped` | four clusters, footprint elongation >= 1.25 |
| `pyramidal` | four clusters, footprint elongation < 1.25 |
| `complex` | everything else (mixed aspects, cross-gables, domes, mansard, barrel); render as LoD1 prism at p50 plus small roof_height |

Overture's roof_shape values seen in the data: flat, hipped, gabled, saltbox, half_hipped, pyramidal, mansard, dome, skillion. Cluster tolerance, 12% mass threshold and 8/10 deg slopes are untuned guesses.

Known weaknesses: low-pitch roofs under ~9 deg classify as flat; cleaned lidar noise at 0.5 m cells is ~4 deg per cell before smoothing; dormers and chimneys fragment small roofs (suppress buildings < 30 m² roof area); roofs partly under canopy fail the planarity assumption (use `veg_flag`). For high-value or complex buildings, refine with plane fitting: either [roofer](https://github.com/3DBAG/roofer) (CityJSON LoD1.2/1.3/2.2 from a point cloud plus roof print; GPLv3; Windows build and class requirements UNCONFIRMED, Docker image exists per its docs) used strictly as an offline tool, or a numpy RANSAC (3-point planes, 0.15 m inlier threshold, 8 planes max) on the section 3.3 point set. 3D BAG's roof-type output is `slanted` / `horizontal` / `multiple horizontal` ([attributes](https://docs.3dbag.nl/en/schema/attributes/)), a coarser vocabulary than needed here. I found no maintained open-source classifier for gable vs hip vs shed; a review paper notes few studies exist beyond flat vs inclined ([SPIE 2019 via search](https://spiedigitallibrary.org/conference-proceedings-of-spie/11174/2532044/A-semi-automatic-approach-for-roof-top-extraction-and-classification/10.1117/12.2532044.full?SSO=1)), RANSAC plane extraction reaches ~85-92% F-score on test areas ([Hacettepe thesis via search](https://avesis.hacettepe.edu.tr/yonetilen-tez/51897a1a-37f9-433a-a85f-8a8ff9ee7131/automatic-roof-plane-extraction-from-lidar-data-using-ransac-algorithm)).

### 7.2 Code (numpy; run on synthetic roofs: flat, gabled, skillion, hipped, pyramidal all classified correctly, ridge azimuth 90.0 for the gable)

```python
import numpy as np

def box3(a):
    p = np.pad(a, 1, mode="edge")
    return sum(p[i:i + a.shape[0], j:j + a.shape[1]] for i in range(3) for j in range(3)) / 9.0

def erode(mask, n=2):
    m = mask.copy()
    for _ in range(n):
        p = np.pad(m, 1, constant_values=False)
        m = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return m

def classify_roof(dsm, mask, cell=0.5, flat_deg=8.0, sloped_deg=10.0, peak_frac=0.12):
    z = box3(np.where(np.isfinite(dsm), dsm, np.nanmedian(dsm[mask])))
    gy, gx = np.gradient(z, cell)                       # rows run south, cols run east
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    asp = np.degrees(np.arctan2(-gx, gy)) % 360         # downslope azimuth, clockwise from north
    core = erode(mask, 2)
    if core.sum() < 20: return "unknown", None, {}
    sl, af = slope[core], asp[core]
    sloped = sl >= sloped_deg
    if (sl < flat_deg).mean() >= 0.8 or sloped.mean() < 0.2: return "flat", None, {}
    hist, _ = np.histogram(af[sloped], bins=36, range=(0, 360))
    h = np.convolve(np.r_[hist[-2:], hist, hist[:2]], np.ones(5) / 5, mode="same")[2:-2]
    peaks = sorted([i for i in range(36) if h[i] >= h[i - 1] and h[i] >= h[(i + 1) % 36]], key=lambda i: -h[i])
    kept = []
    for i in peaks:                                      # merge peaks closer than 40 deg
        if all(min(abs(i - j), 36 - abs(i - j)) * 10 >= 40 for j in kept): kept.append(i)
    mass = lambda i: sum(hist[(i + k) % 36] for k in range(-3, 4)) / hist.sum()
    kept = [i for i in kept if mass(i) >= peak_frac]
    def circ(i):
        c0 = i * 10 + 5; d = (af[sloped] - c0 + 180) % 360 - 180; w = np.abs(d) <= 35
        return float((c0 + (d[w].mean() if w.any() else 0)) % 360)
    az = sorted(circ(i) for i in kept); n = len(az)
    ys, xs = np.nonzero(mask)
    ev = np.sort(np.linalg.eigvalsh(np.cov(np.vstack([xs, ys])))); elong = float(np.sqrt(ev[1] / max(ev[0], 1e-9)))
    if n == 1: return "skillion", (az[0] + 90) % 180, {}
    if n == 2:
        d = abs(az[0] - az[1]); d = min(d, 360 - d)
        return ("gabled", (az[0] + 90) % 180, {}) if abs(d - 180) <= 35 else ("complex", None, {})
    if n == 3: return "half_hipped", None, {}
    if n == 4: return ("pyramidal" if elong < 1.25 else "hipped"), None, {}
    return "complex", None, {}
```

Plateau splitter (needs `scipy`):

```python
import numpy as np
from scipy import ndimage as ndi

def split_parts(h, mask, cell=0.5, bin_m=0.5, min_area_m2=12.0, gap_frac=0.004, max_parts=8):
    v = h[mask & np.isfinite(h)]
    if v.size == 0: return []
    lo = np.floor(v.min() / bin_m) * bin_m
    nb = int(np.ceil((v.max() - lo) / bin_m)) + 1
    hist = np.bincount(((v - lo) / bin_m).astype(int), minlength=nb)
    on = hist / v.size >= gap_frac
    parts, i = [], 0
    while i < nb:
        if not on[i]: i += 1; continue
        j = i
        while j + 1 < nb and on[j + 1]: j += 1
        m = mask & (h >= lo + i * bin_m) & (h < lo + (j + 1) * bin_m)
        lab, n = ndi.label(ndi.binary_opening(m, structure=np.ones((3, 3))))
        for k in range(1, n + 1):
            mk = lab == k; a = mk.sum() * cell * cell
            if a >= min_area_m2: parts.append(dict(level_m=float(np.median(h[mk])), area_m2=float(a), mask=mk))
        i = j + 1
    return sorted(parts, key=lambda p: -p["level_m"])[:max_parts]
```
(`h` is height above base. Convert each part mask to a polygon with `rasterio.features.shapes`.)

## 8. Trees over roofs, ground clutter, other error sources

| Problem | Mitigation | Residual |
|---|---|---|
| Canopy overhangs roof edge or covers roof (Berkeley/Oakland hills, SF Sunset, Presidio) | Prefer `NumberOfReturns==1` surface; eroded footprint (0.75 m); median not max; flag `single_frac < 0.7` / `cover < 0.6`; if class 4/5 exists (SF lists 4) drop it, but do not rely on it | 5-15% of hillside buildings still wrong by >3 m [ESTIMATE]. Fall back to Overture/Microsoft height or neighbour median and mark `veg_flag` |
| Pitched roofs: median != eave or ridge | Store p10 (eave) and p95 (ridge) | Roof pitch is only recoverable at ~8-10 deg and above |
| HVAC, parapets, elevator penthouses | median is robust; penthouses survive as small plateaus (>12 m² only) | Small rooftop structures vanish |
| Footprint misregistration 1-3 m | Section 3 item 4, erode footprints | Rows/terraces on hills remain ambiguous |
| Sloped lots | Ring-percentile base; skirt to terrain | Basements/garages invisible |
| Temporal gap | `mismatch_flag`; `lidar_date` from GpsTime; East Bay misses post-mid-2021 construction, SF misses post-April-2023 | New towers appear as holes; fall back to Overture/OSM height and draw as flagged |
| Glass/water/specular returns, mid-air noise | Drop classes 7/18, `Z` clip, single-return surface | Occasional spikes at glass towers |
| Bridge decks and overpasses | Class 17 only; never in building DSM; footprints overlapping class-17 clusters are skipped | Piers need OSM bridge data |
| Moving objects (vehicles, cranes, ships at Port of Oakland) | Footprint filter excludes them; cranes are not footprints | Need separate landmark handling |

## 9. Compute and disk estimate for ~400 km² (one laptop) [ESTIMATE unless noted]

Inputs: measured 10.4 B/pt LAZ; measured ~50 pts/m² (SF); building counts measured above (170,024 (PBF recount 2026-10-26) SF + ~180k East Bay = ~350k footprints).

| Strategy | Points | LAZ transferred | Notes |
|---|---|---|---|
| Full density, 400 km² | ~20 B | ~210 GB | Not needed for footprints; only for point-level pass on small areas |
| EPT `resolution` 0.633 (0.5 m ground), 400 km² | ~2.1 B (area / g² x 1.33 levels) | ~22 GB | Recommended for DSM/nDSM; 500 m tile ~0.5-1 M points, RAM <1 GB |
| EPT `resolution` 1.27 (1 m ground) | ~0.5 B | ~5.5 GB | Pre-screening, DTM-only |
| Point pass, flagged buildings only (~10-15% of footprints, plus 10 m buffer) | ~0.3-0.8 B | ~3-8 GB | HAG + RANSAC |

- **Wall time:** network at the measured 2.7-2.9 MB/s single stream would be ~2 h for 22 GB; with PDAL's default 15 parallel requests (the `requests` option) probably 5-10x faster, so ~15-30 min is possible, but I did not measure parallel throughput. CPU is the other limit: LAZ decode plus filters at ~1-3 M points/s/core gives roughly 1-3 h wall with 4-6 workers for the 0.5 m pass. **Plan 2-6 h for the first full run (one afternoon) and 10-40 h if you try full density.** Time one 500 m tile and multiply by ~1,000 land tiles (the 400 km² of the bbox is ~1,600 tiles; skip tiles with no footprints).
- **Per-building Python stage:** ~350k footprints, vectorised zonal stats plus classifier at ~1-5 ms per building = ~6-30 min total.
- **Disk:** the lidar is streamed, nothing stored. Rasters per 500 m tile at 0.5 m = 1 M cells x 4 B = 4 MB per layer; 1,000 tiles x 4 layers = ~16 GB uncompressed, ~6-9 GB deflated; delete tiles after stats if disk matters. Keep: per-building rows (~350k x ~120 B = ~40 MB), QA overlays, and the 1 m DTM for physics (~1.6 GB at 1 m). Peak scratch <30 GB.
- **Repeatability:** write each tile's outputs to `out/{x0}_{y0}_*.tif` plus a `.done` marker; EPT reads are idempotent, so interrupted runs resume.

## 10. Expected accuracy [ESTIMATE; to be replaced by the validation numbers below]

| Quantity | Expectation | Basis |
|---|---|---|
| Sensor vertical accuracy | 2-4 cm RMSE open ground; ~10 cm vegetated | Reports in section 1 (tested NVA 1.73 cm SF, 4.1 cm 95% Alameda; VVA 10.6-11.7 cm) |
| Flat-roof building height | +/-0.3-0.7 m for >85% of buildings, when footprint is registered | Sensor error is negligible, error is footprint registration and clutter |
| Pitched roof (median vs ridge/eave) | +/-1-2 m depending on statistic chosen (store p10/p95) | Geometry |
| Tree-contaminated buildings | 5-15% of hillside/leafy buildings with >3 m error before flags | OSM wiki documents a 14 m error on a 2-3 storey house; Overture notes the same failure |
| Tall buildings | within ~1% of true height at the roof peak | OSM wiki landmark check: Sutro 286.4 vs 283.3 m, Transamerica 258.5 vs 258.1 m, Ferry Building 71.4 vs 75 m tower (3.6 m gap unexplained) |
| Roof form classification | high on large/simple roofs (flat vs pitched >90% expected); gable vs hip ~70-85% expected | Synthetic clean-roof test passes 5/5, real data untested; literature RANSAC F-scores 85-92% |
| Overture lidar-sourced heights | "within about 50 cm" claimed by Overture staff, measured here: ~2-3 m MAE in SF low-rise vs DataSF | [Overture news piece via search](https://overturemaps.org/building-better-maps-with-open-data-on-building-heights/) (page itself returned 404 to me); section 2 table |

**Validation protocol (do before bulk run)**
1. **Landmark table:** 20 buildings with known roof heights (Sutro Tower, Transamerica, Salesforce Tower, Ferry Building, Campanile, Oakland Ordway/Kaiser Center, a few Berkeley and Emeryville mid-rises, etc.); fail the run if any tall building deviates by >2% or 3 m. Independent heights for most of these are UNCONFIRMED here.
2. **SF cross-check:** compare new B23 heights to DataSF `hgt_median_m` for matched footprints. Expect agreement within ~1 m on unchanged low-rise and flag differences > 3 m as construction or tree changes (13+ years of change). This is a free ~170k-building test of the whole pipeline and of the registration step.
3. **East Bay cross-check:** compare to Microsoft-ML heights in Overture on 1,000 random buildings; report bias and MAE by height class (the numbers become the published QA of both datasets).
4. **Ground-truth sample:** 100 East Bay buildings hand-checked against the NAIP imagery already in the plan (and Street View by eye only; no tracing).
5. **Plane check:** 100 buildings hand-labelled for roof shape from NAIP (0.6 m); report the confusion matrix for the 6.1 rules and tune thresholds on 50, test on 50.

## 11. Conflict resolution rules for the shipped height

1. If lidar has `cover >= 0.6`, `single_frac >= 0.7`, `lidar_date` after footprint creation, no `mismatch_flag`: use lidar `z_roof_p50` / `z_base`.
2. If `veg_flag`: use lidar if within 3 m of Overture/Microsoft or neighbour median; otherwise use Overture height with `source: ml`.
3. If `mismatch_flag` (lidar low, source tall): keep source height, mark `new_construction`; if lidar tall, footprint missing: ignore (demolished).
4. Towers with `building_part` or multiple plateaus: always use the lidar parts, never the whole-footprint Overture height (section 2 shows tens-of-metres errors).
5. Record `source` per building: `lidar`, `lidar+veg`, `ml`, `osm`, `manual`.

## 12. Licensing check

| Item | Licence | Consequence |
|---|---|---|
| USGS 3DEP lidar, USGS DEM | US public domain | Derived heights/roof planes redistributable |
| Overture buildings (OSM + Microsoft ML + USGS Lidar entries) | ODbL-1.0 per `sources[].license` (USGS Lidar entries have none) | Heights taken from Overture carry ODbL share-alike like the footprints; lidar-computed heights on OSM footprints are an ODbL derivative anyway because of the footprints (already in MAP_RESOURCES) |
| Microsoft building footprints/heights | CDLA Permissive 2.0 on [github](https://github.com/microsoft/globalmlbuildingfootprints); ODbL as relabelled by Overture | Treat as ODbL when taking from Overture |
| DataSF building footprints | PDDL | OK |
| roofer / geoflow | GPLv3 | Use as an offline tool only; GPL does not cover generated data in my reading (UNCONFIRMED legally) |
| My own code in this file | Freely reusable | n/a |

## 13. Open questions / UNCONFIRMED

1. Actual class histogram of the points (3.1): no class 6 or 5 expected; confirm `ClassFlags` withheld handling.
2. Which of `CA_AlamedaCo_2_2021` / `_3_2021` is QL0 over Berkeley, Oakland and Alameda, and where the 2019 upgrade data sit (Oakland/Emeryville shore?). Compare node counts on a test tile or read per-point `GpsTime`.
3. Whether PDAL accepts the JSON `bounds` + `crs` for `readers.ept` exactly as written and whether `Classification![7:7],Classification![18:18]` is AND (use `filters.expression` if not); whether `filters.stats` supports `enumerate` as written.
4. `writers.gdal` multi-band order for `output_type: "max,count"` and whether `window_size` fills as expected on rooftops.
5. NAD83(2011) vs WGS84 horizontal offset in the EPT/3857 data and in OSM/Overture (1-2 m expected; measure with section 6.4).
6. Parallel-request throughput of the `usgs-lidar-public` bucket from this machine and PDAL decode rate; benchmark one tile.
7. Whether roofer builds on Windows (Docker image exists), and its input class requirements, if you want LoD2.2 for landmarks.
8. Vintage and method of Overture's 12.9k USGS-lidar heights in SF; their error vs our B23 numbers.
9. Overpass API was unreachable from here during this session (connection timeouts to overpass-api.de and overpass.kumi.systems), so OSM tag counts (`height`, `building:levels`, `roof:shape`, `building:part`) come only from the Overture mirror above, not live OSM.
10. Landmark true heights for the validation list (most need an independent source).

## Fact-check

Independent check on 2026-10-26 of five claims in sections 0-2, 9. Method: PDFs downloaded and text-extracted with pdftotext; `ept.json` files fetched; Overture parquet re-queried with pyarrow (anonymous S3); one EPT node downloaded (1.2 MB) and its LAS header read.

| # | Claim | Verdict | Correction / source |
|---|---|---|---|
| 1 | SF B23 classes 1,2,4,7,9,17,18,20; Alameda 2021 classes 1,2,7,9,17,18,20; no class 6 or 5, so heights must be footprint-driven | **Confirmed** | SF report "Classifications Used" lists exactly 1,2,4,7,9,17,18,20 ([SF report](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/CA_SanFrancisco_B23/USGS_CA_SanFrancisco_B23_Project_Report.pdf)). Alameda Table 9 lists 1, 1-W, 2, 7-W, 9, 17, 18-W, 20 ([Alameda report](https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/CA_AlamedaCounty_2021_B21/CA_AlamedaCo_3_2021/reports/Alameda_Technical_Data_Report_Final_Signed.pdf)); its Appendix B (2019 Western Alameda) Table 7 lists only 1, 2, 7. Caveat: these are classes delivered per the reports, not a histogram of actual points; the "footprint-driven" conclusion follows from the absence of class 6, but section 3.1 is still needed. In Alameda, 7 and 18 appear only as withheld ("-W") variants. |
| 2a | EPT is EPSG:3857, so `readers.ept` resolution is in inflated metres (1 unit about 0.79 ground m at lat 37.8) | **Confirmed** | All four `ept.json` have `srs.horizontal = 3857`. PDAL docs: resolution "units correspond to resource coordinate system units" ([readers.ept](https://pdal.io/en/stable/stages/readers.ept.html)). cos(37.8 deg) = 0.7902. The docs also confirm that only the JSON-object `bounds` form accepts a `crs` member. |
| 2b | Oakland, Berkeley, Emeryville fall inside `_2` and `_3`; `_1` starts at lon -122.18, east of them | **Confirmed** | `_1` bounds x -13601816..-13523998 = lon -122.187..-121.488 ([ept.json](https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_1_2021/ept.json)). `_2` x -13624196..-13564118 (lon -122.388..-121.849) and `_3` x -13619047..-13542821 (lon -122.342..-121.657), both overlapping ([_2](https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_2_2021/ept.json), [_3](https://usgs-lidar-public.s3.amazonaws.com/CA_AlamedaCo_3_2021/ept.json)). Mercator x of Berkeley (-122.26, 37.87) = -13609921, Oakland (-122.27, 37.80) = -13611034, Emeryville = -13612704, y 4.551-4.561 M: all west of `_1` and inside `_2` and `_3` bounds (including `boundsConforming` y ranges). Bounding-box test only; data presence at those exact spots not sampled. |
| 3a | Overture 2026-10-21.0: East Bay bbox 180,119 buildings, 121,891 with height (67.7%), 118,069 height from Microsoft ML, 0 from USGS Lidar, roof_shape on 323 (0.18%); SF 94.6% with height | **Confirmed** | Re-run: East Bay 180,119 / 121,891 (67.7%) / roof_shape 323 (0.18%); 118,069 have a `/properties/height` source of Microsoft ML Buildings (another 3,435 are Microsoft-only footprints with a height, 387 OSM-only); zero USGS Lidar. SF bbox: 171,371 / 162,068 (94.6%) / roof_shape 315; USGS Lidar 12,942. Source: `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/part-00032, part-00033` (read by me). |
| 3b | In SF about 143k heights are OSM tags imported from the "2010-era DataSF lidar" | **Unverifiable as worded** | 162,068 - 6,734 (Microsoft) - 12,942 (USGS) leaves about 142.4k, so the arithmetic holds, but the provenance is only partly supported. The [OSM import wiki](https://wiki.openstreetmap.org/wiki/San_Francisco_Building_Height_Import) says heights come from the SF city lidar-derived footprint dataset (2016 release, median value), and gives the source lidar year as 2010 in one section and 2014 in another. It cites 143,953 buildings *without* a height tag at import time, not a count of tags actually imported. The 12,942 / 6,734 split depends on source-record matching (my looser match gave 6,734 for Microsoft in SF; the original note says 5,274), so treat as approximate. Say "city-lidar-derived, 2010 or 2014" rather than "2010-era". |
| 4 | SF B23: single day 2023-04-20, QL0, Riegl 1560ii, point-cloud NVA RMSEz 1.73 cm. Alameda 2021: 21 Jun to 3 Jul 2021 plus 2019 QL1 upgrade at borders; vintage mixed | **Confirmed** | SF report: collection start and end 04-20-2023, Quality Level 0, Riegl 1560ii/ii-s, tested NVA RMSEz 1.73 cm (NVA 95% 3.38 cm, VVA 11.66 cm). Alameda Table 1: 2021 flights 06/21, 06/22, 06/30, 07/02, 07/03 (plus 06/23 and 07/01 on the QL1+ row; one date is misprinted "06/30/2121"); the report says NV5 upgraded 2019 Western Alameda data on the borders. Correction: the 2019 dates run 07/02 to 09/05/2019 (Appendix B: 07/02 to 08/15), wider than July only. "Sensor error negligible vs method error" is judgement, consistent with tested NVA 1.7 cm (SF) and 4.1 cm at 95% (Alameda). |
| 5a | EPT LAZ costs about 10.4 bytes/point | **Confirmed on one node** | Downloaded `ept-data/5-19-21-15.laz` ([link](https://usgs-lidar-public.s3.amazonaws.com/CA_SanFrancisco_1_B23/ept-data/5-19-21-15.laz)): 1,185,582 bytes, LAS header point count 113,733, so 10.42 B/point. I did not verify the second node (my guessed neighbour returned 404). Two depth-5 nodes are a thin sample; deeper nodes may compress differently. |
| 5b | SF averages about 50 pts/m2 (13.09 B points over about 260 km2) | **Confirmed (arithmetic)** | Points 13,088,433,078; `boundsConforming` x 21,108 m by y 19,766 m in 3857 units x cos^2(37.8 deg) = 260.5 km2, giving 50.2 pts/m2. This is an average over the bounding box including water and overlap, not over land. |
| 5c | Full density for 400 km2 is about 210 GB; about 22 GB at 0.5 m ground resolution | **Full-density figure confirmed (arithmetic); 22 GB unverifiable** | 400e6 m2 x 50.2 x 10.4 B = about 209 GB. The 22 GB figure rests on an assumption of about 1 point per 0.5 m cell times 1.33 levels (1.6e9 x 1.33 x 10.4 = 22 GB) and on 10.4 B/point holding for sparse nodes; not measured. Section 9 already labels it ESTIMATE. |

- PBF recount 2026-10-26: OSM counts re-verified against a Geofabrik extract; see probes/osm_recount_vs_notes.json.

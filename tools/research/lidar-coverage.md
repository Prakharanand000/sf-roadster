# Lidar and DEM coverage, Phases 1-3

Researched 2026-10-26. Metadata-only requests (ept.json, ept-hierarchy root, per-tile `info/*.json`, TNM product listings, S3 bucket listing). No point data and no DEM tiles were downloaded. Anything not directly observed is marked UNCONFIRMED.

Base URL for all EPT projects: `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/<name>/ept.json`. Bucket listing used to enumerate projects: `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/?delimiter=/&prefix=CA_`.

## 0. Findings that change the bake plan

1. **No building (6) or vegetation (3/4/5) class exists in the Bay Area EPT sources we checked.**
   - SF B23 lists only 1, 2, 7, 9, 17, 18, 20: https://www.fisheries.noaa.gov/inport/item/73386. The USGS project report does list class 4 for SF B23, so the class set was unresolved until checked on real points. Resolved 2026-10-26: no class 3, 4, 5 or 6 in 12 sample boxes across SF B23 and Alameda `_2`/`_3` (lidar-probes.md §1) (corrected 2026-10-26).
   - Alameda 2021 (QL0 and QL1) lists only 1, 2, 7, 9, 17, 18, 20, with per-class point counts in the NV5 report: https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/CA_AlamedaCounty_2021_B21/CA_AlamedaCo_3_2021/reports/Alameda_Technical_Data_Report_Final_Signed.pdf (Table 9, p. 14). Class 1 is defined there as "vegetation and anthropogenic features".
   - Western Alameda 2019 (= `CA_AlamedaCo_2_2021`) lists only 1, 2, 7 (same PDF, Appendix B, Table 7).
   - Consequence: buildings and trees must be derived. Use class 1 minus footprints for canopy, and (DSM minus DTM) inside footprints for building heights and roofs. Plan on **ground (2), water (9), bridge deck (17) and "everything else (1)"** as the only usable classes.
   - UNCONFIRMED empirically: I did not read a point node. A single root-node sample (~1 MB) would confirm the class histogram before any large crop.
2. **Marin south of lat 38.1 has no EPT in the bucket.** Listing of `CA_*` shows no Marin project, and `CA_NorthernCA_1_B22` starts at lat 38.109. Marin lidar exists only as LAZ tiles on rockyweb (`CA_NoCAL_3DEP_Supp_Funding_2018_D18`, 231 tiles, 13.29 GB, plus `ARRA_CA_GOLDENGATE_2010`, 90 tiles, 9.14 GB; see section 5) (corrected 2026-10-26). The SF project bbox does reach lat 37.837, so it covers the Golden Gate south anchorage and the very southern Marin Headlands edge.
3. **EPT coordinates are EPSG:3857 (Pseudo-Mercator).** Horizontal distances are inflated by 1/cos(lat) = 1.2655 at SF. Z is true metres, NAVD88. Alameda source is feet, but the EPT copy was converted (checked: tile `w6030n2109` source Z -31.99..245.31 ftUS shows as -9.75..74.77 in the EPT info, which is the same range in metres). Any `readers.ept` `resolution` value is in 3857 units, so scale it by 1.2655.
4. **`CA_ContraCosta_1_2022` is not useful for Phase 2 or 3.** Its bbox is lon -121.924..-121.613 (inland: Walnut Creek and Concord). Richmond, El Cerrito and the shoreline are outside it.
5. **`CA_AlamedaCo_1_2021` barely touches Phase 2.** Its west edge is lon -122.187. Phase 2 is served by `_2` (west Alameda, Oakland, Berkeley, Alameda island) and `_3`.
6. The NOAA record says SF tiles are 1000 m, but the tile ids and bounds show 500 m tiles (tile `04250230` spans x 42500..43000, y 23000..23500 in CS13 metres). The "654 tiles" figure is right, so the covered area is about 654 x 0.25 = 163 km² including water. The NOAA text says about 53 sq mi (137 km²), which looks like the nominal land area.

## 1. EPT project metadata (a)

All 3857, `dataType: laszip`, `span` 128 unless noted. Bbox is `boundsConforming` converted to lat/lon by me. "avg pts/m²" is points divided by the rectangular bbox area after undoing the 1.2655 scale, so it is a lower bound for land (rectangles include water and empty corners).

| EPT project | Points | Bbox (lat, lon) | avg pts/m² (bbox) | URL |
|---|---|---|---|---|
| `CA_SanFrancisco_1_B23` | 13.09 B | 37.697..37.837, -122.516..-122.326 | 50.2 | https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/ept.json |
| `CA_AlamedaCo_1_2021` (2021 QL1) | 39.58 B | 37.465..37.857, -122.187..-121.488 | 14.7 | .../CA_AlamedaCo_1_2021/ept.json |
| `CA_AlamedaCo_2_2021` (2019 QL1, upgraded) | 26.10 B | 37.447..37.874, -122.347..-121.890 | 13.6 | .../CA_AlamedaCo_2_2021/ept.json |
| `CA_AlamedaCo_3_2021` (2021 QL0) | 35.81 B | 37.577..37.913, -122.342..-121.657 | 15.9 | .../CA_AlamedaCo_3_2021/ept.json |
| `CA_ContraCosta_1_2022` | 7.58 B | 37.751..37.990, -121.924..-121.613 | 10.4 | .../CA_ContraCosta_1_2022/ept.json |
| `CA_CaliforniaGaps_3_B23` | 55.84 B | 34.691..37.709, -122.522..-119.999 | 0.7 | .../CA_CaliforniaGaps_3_B23/ept.json |
| `CA_CaliforniaGaps_1_B23` | 53.75 B | 35.285..37.506, -121.421..-119.999 | 1.7 | not Bay Area, skip |
| `CA_CaliforniaGaps_4_B23` | 149.29 B | 33.426..34.985, -120.001..-114.493 | 1.7 | not Bay Area, skip |
| `CA_NorthernCA_1_B22` | 95.95 B | 38.109..38.854, -123.535..-122.348 | 11.2 | north of Marin, no overlap with Phase 3 |
| `CA_NorthCoastRanges_2_B23` | 186.42 B | 38.154..39.442, -123.384..-121.994 | 10.8 | north of Marin |
| `CA_NorthernCA_2,3,4,5,7,8_B22`, `CA_NorthCoastRanges_1_B23` | n/a | all lat >= 38.1 (mostly >= 40) | n/a | irrelevant |
| `CA_NorthernCA_6_B22` | n/a | n/a | n/a | `ept.json` returns 404 (NoSuchKey) |
| `CA_SantaClaraCounty_2020` | 170.42 B | 36.854..37.525, -122.252..-121.160 | 23.6 | South Bay, later |
| `CA_SolanoCounty_1_A23` | 43.64 B | 38.031..38.540, -122.408..-121.593 | 10.8 | north of Phase 3 |
| `CA_AlamedaCo_2006`, `CA_ContraCostaCo_2007` | ~0 | `AlamedaCo_2006` bbox is in Colorado (39.8, -105.7), `ContraCostaCo_2007` has 0.01 B points | n/a | broken or empty, ignore |

Facts shared by SF and Alameda ept.json:
- Dimensions: X, Y, Z (scale 0.01), Intensity, ReturnNumber, NumberOfReturns, ScanDirectionFlag, EdgeOfFlightLine, **Classification**, ScanAngleRank, UserData, PointSourceId, GpsTime, ScanChannel, **ClassFlags**.
- `ClassFlags` carries the withheld/overlap bit. Drop withheld points (edge clips, overlap, and noise 7-W/18-W per the NV5 Table 9).
- The SRS block says EPSG:3857 with no vertical; the vertical is NAVD88 metres (SF: Geoid18, https://www.fisheries.noaa.gov/inport/item/73386).
- Source CRS: SF is NAD83(2011) / San Francisco CS13 (EPSG:7131) + NAVD88 Geoid18 (m), from the per-tile info https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/info/USGS_LPC_CA_SanFrancisco_B23_04250230.json . Alameda is California zone 3 ftUS + NAVD88 ftUS.

Project quality and accuracy:

| Project | Quality / density | Vertical accuracy | Source |
|---|---|---|---|
| SF B23 (collected 2023-04-20) | NPS 0.15 m, density listed 44 (average 44.44; this is total/first-return pulse density; measured on real points 2026-10-26: 121–154 pts/m² all returns and 31–42 pts/m² ground (class 2) over mixed SF blocks, see lidar-probes.md §1) (corrected 2026-10-26), spec LBS 2023 Rev A | NVA RMSEz 1.73 cm, VVA 95th pct 11.66 cm; horizontal 0.12 m at 95% | https://www.fisheries.noaa.gov/inport/item/73386 |
| Alameda 2021 QL0 (`_3`) | 20 pulses/m² designed; report first-return density 61.3 pts/m² average (figure as printed) | NVA RMSEz 2.1 cm project-wide (InPort) | https://www.fisheries.noaa.gov/inport/item/71712 and the NV5 PDF above |
| Alameda 2021 QL1 (`_1`) | 8 pulses/m² designed; report first-return density 30.3 pts/m² | same | same |
| Western Alameda 2019 (`_2`) | 20 pulses/m² designed; first-return 46.5 pts/m², ground 6.9 pts/m² | NVA 0.059 m (report) | NV5 PDF Appendix B |

Mapping of EPT names to collections (from the InPort page https://www.fisheries.noaa.gov/inport/item/71712): `_1` = 2021 QL1 (376 sq mi), `_2` = 2019 QL1 upgraded to 3DEP (216 sq mi), `_3` = 2021 QL0 (186 sq mi). Point totals corroborate this: NV5 Table 9 sums to about 35.8 B (QL0) and 39.6 B (QL1), matching EPT `_3` and `_1` exactly. This confirms `_3` is the QL0 project, as MAP_RESOURCES says.

License: InPort lists "Access constraints: None" and no named license for both SF and Alameda; USGS-produced data is a US Government work (public domain). I did not find an explicit license text, so keep the `ATTRIBUTION` line "USGS 3DEP" and cite the project ids.

## 2. ASPRS classes present (b)

| Class | SF B23 | Alameda 2021 (`_1`, `_3`) | W. Alameda 2019 (`_2`) | Gaps B23 / Marin B5b |
|---|---|---|---|---|
| 1 Unclassified (buildings, trees, everything not ground) | listed | listed (about 80% of points) | listed | UNCONFIRMED |
| 2 Ground | listed | listed (QL0 4.22 B, QL1 6.76 B) | listed | UNCONFIRMED |
| 3/4/5 Vegetation | **not listed** | **not listed** | **not listed** | UNCONFIRMED |
| 6 Building | **not listed** | **not listed** | **not listed** | UNCONFIRMED |
| 7 Low noise | listed | listed (flagged withheld) | listed | UNCONFIRMED |
| 9 Water | listed | listed (QL0 99.5 M, QL1 39.6 M) | not listed | UNCONFIRMED |
| 17 Bridge deck | listed | listed (QL0 29.5 M, QL1 2.1 M) | not listed | UNCONFIRMED |
| 18 High noise | listed | listed (withheld) | not listed | UNCONFIRMED |
| 20 Ignored ground (near water breaklines) | listed | listed (QL0 2.1 M) | not listed | UNCONFIRMED |

Sources: https://www.fisheries.noaa.gov/inport/item/73386 (SF); NV5 PDF Table 9 and Appendix B Table 7 (Alameda). The SF record says final class statistics were verified per tile but does not publish the counts, so "listed" means documented, not that every class has points (UNCONFIRMED).

Implications for the bake:
- Class 17 bridge deck is documented for both SF and Alameda: use it to pull Bay Bridge, Golden Gate, Bay Bridge Oakland approaches and viaduct deck profiles. QL0 Alameda has 29.5 M deck points.
- Ground points are sparse under buildings and trees (NV5 reports ground density 7-9 pts/m² against 30-60 first returns). A 1 m DEM from USGS is the safer ground surface; use lidar ground only for refinement.
- Ground class 2 plus the "ignored ground" class 20 near shorelines mean water-edge ground can be missing, so combine with the DEM near the shore.

## 3. 1 m DEM tile counts and sizes (c)

Query used (TNM, sequential, 3 s apart): `https://tnmaccess.nationalmap.gov/api/v1/products?datasets=Digital Elevation Model (DEM) 1 meter&bbox=<minLon,minLat,maxLon,maxLat>&max=100&outputFormat=JSON`. Tiles are ~10 km UTM 10N cells named `x<E>y<N>` (e.g. `x55y419`). Several lidar projects overlap the same cell, so the table gives both the **preferred** set (newest and best project per cell) and the raw overlapping total. TNM reported that 4-7 matching items per query were dropped because they have no download URL (UNCONFIRMED which cells), but the preferred set still covers every cell of each bbox.

| Area (bbox lon,lat) | Cells | Preferred set (MB) | All overlapping items (MB) | Preferred projects |
|---|---|---|---|---|
| Phase 1: -122.53,37.70,-122.35,37.84 | 4 (x54-55, y418-419) | **523** | 1,018 (12 items) | all `CA_SanFrancisco_B23` (2024-08-26) |
| Phase 2: -122.38,37.76,-122.17,37.90 | 9 (x55-57, y418-420) | **1,576** | 2,884 (20 items) | x55y418, x55y419 from SF B23; the other 7 cells from `CA_AlamedaCounty_2021_B21` (2022-08-10) |
| Phase 3 Marin: -122.55,37.80,-122.40,37.95 | 9 (x53-55, y419-421) | **1,471** | 2,131 (20 items) | `CA_NoCAL_3DEP_Supp_Funding_2018_D18` for 5 cells (corrected 2026-10-26) (316 and 393 MB tiles at x53y420 and x53y421), SF B23 for x54y419 and x55y419, Alameda B21 for x55y420 (7 MB) |
| Phase 3 Peninsula/San Mateo: -122.45,37.45,-122.20,37.72 | 16 (x54-57, y415-418) | **3,385** | 4,024 (23 items) | `CA_CaliforniaGaps_B23` (2025-08-20) for 9 cells, SF B23 for 2, Alameda B21 for 3, Santa Clara 2020 for 2 |

Per-cell figures behind these sums are in the TNM output; the largest single cells are x57y418 Alameda 377 MB, x55y415 Gaps 384 MB, x56y419 Alameda 365 MB, x54y418 SF 177 MB.

Notes:
- The preferred Phase 1 set is only 4 cells, about 0.5 GB, so the full SF DEM is cheap. Phase 1 plus Phase 2 together is 11 distinct cells because x55y418 and x55y419 are shared: about 1.87 GB (523 + 1,576 - 233).
- Cell footprints are about 0.114 x 0.09 degrees, so edge cells include mostly water or neighbouring county; sizes are not proportional to land area.
- Tile publication dates: SF B23 2024-08-26, Alameda B21 2022-08-10, Gaps B23 2025-08-20 (from the TNM `publicationDate`).
- DEM CRS and datum (UTM 10N, NAVD88) are taken from MAP_RESOURCES.md; I did not open a tile (UNCONFIRMED by me).
- One 2018 DEM cell is a different vintage: use the 2018 DEMs only for Marin, since the QL1 2018 set is the newest there.

## 4. Download volume estimates (d)

Calibration, measured from metadata:
- One SF tile: `USGS_LPC_CA_SanFrancisco_B23_04250230.laz` is 45,803,198 bytes (TNM) for 8,688,564 points (info JSON) = **5.27 bytes per point** (LAZ 1.4 format 6, all 15 dimensions). The whole project sums to 74.24 GB for 13.09 B points = 5.67 B/pt. I use **5.5 B/pt** for full-attribute LAZ. A slimmed crop (X, Y, Z, class, return number) would be smaller, perhaps about 3 B/pt (UNCONFIRMED).
- Source tile sizes per km²: SF about 460 MB/km² (74.24 GB over 163 km² of tiles); Alameda about 240 MB/km² (62.27 GB over 310 tiles of ~0.84 km², tile `w6030n2109` is 3000 ft square).
- EPT `resolution` (PDAL `readers.ept`, https://pdal.io/en/stable/stages/readers.ept.html) is a grid cell edge in dataset CRS units, so it picks a tree depth. Spacing at depth d is `cube_width / 128 / 2^d` in 3857 metres:

| Project | cube width | d7 (3857 m / true m) | d8 | d9 | d10 |
|---|---|---|---|---|---|
| SF B23 | 21,110 | 1.29 / 1.02 | 0.64 / 0.51 | 0.32 / 0.25 | 0.16 / 0.13 |
| Alameda `_1` | 77,818 | 4.75 / 3.75 | 2.37 / 1.88 | 1.19 / 0.94 | 0.59 / 0.47 |
| Alameda `_2` | 60,078 | 3.67 / 2.90 | 1.83 / 1.45 | 0.92 / 0.73 | 0.46 / 0.36 |
| Alameda `_3` | 76,226 | 4.65 / 3.68 | 2.33 / 1.84 | 1.16 / 0.92 | 0.58 / 0.46 |
| Gaps `_3` | 416,484 | 25.4 / 20.1 | 12.7 / 10.0 | 6.4 / 5.0 | 3.2 / 2.5 |

- Observed density by depth, SF downtown sample (four depth-6 nodes around Union Square, 0.27 km² of plan area, hierarchy files fetched: `.../CA_SanFrancisco_1_B23/ept-hierarchy/6-36-40-31.json` and neighbours): cumulative points per plan m² are about 1 at depth 6, **4.8 at depth 7**, **24 at depth 8**, 153 at depth 10 (deeper nodes exist and were not counted). Depth 7 includes facades and tree layers, so it matches the 4 pts/m² target for SF. For Alameda the cube is larger, so the equivalent depth is 9 or 10 (UNCONFIRMED: I did not sample an Alameda subtree).
- The root hierarchy file itself is tiny (SF 63 KB, Alameda `_1` 634 KB), and has 2,235 depth-6 subtree files for SF, so full per-node counts need thousands of small requests. I sampled four.

Estimates (EPT crops of the phase bbox):

| Phase | Source tiles intersecting the bbox (TNM LPC, rockyweb) | Full density | Thinned to about 4 pts/m² |
|---|---|---|---|
| 1 | 645 tiles of `CA_SanFrancisco_B23`, 74.24 GB (the whole project: 645 of 654 tiles) | about **74 GB**, 13.1 B points | about **2-3.5 GB**, 0.5-0.65 B points. Low end from the depth-7 downtown sample (about 3% of full volume), high end from 4 pts/m² x 161 km² of tile area x 5.5 B/pt |
| 2 (Bay Bridge, Treasure Island, Oakland, Emeryville, Berkeley, Alameda) | `_2` 153 tiles 28.63 GB, `_3` 139 tiles 32.31 GB, `_1` 18 tiles 1.33 GB, SF B23 47 tiles 1.68 GB | about **64 GB** | about **3-6 GB**: 4 pts/m² over 271 km² of tile area is the 6 GB ceiling; about half of it is water, so land-only is nearer 3 GB (UNCONFIRMED land share) |
| 3 Marin | `CA_NoCAL_3DEP_Supp_Funding_2018_D18` 231 tiles 13.29 GB (LAZ only, no EPT) (corrected 2026-10-26), `_B5b_2018` 65 tiles 0.41 GB, SF B23 65 tiles 4.11 GB, ARRA GoldenGate 2010 90 tiles 9.14 GB (older) | about 17 GB (D18 + SF B23) (corrected 2026-10-26) | about 0.5-1 GB (scale by 22 MB per km²) |
| 3 Peninsula / San Mateo | `CA_CaliforniaGaps_B23` 364 tiles 32.06 GB (EPT `CA_CaliforniaGaps_3_B23`), SF 4 tiles 0.11 GB | about 32 GB | about 1-2 GB |

Notes:
- The tile sums are the LAZ size of every tile that touches the bbox, so a real crop reads somewhat less, but EPT nodes are read whole, so expect the same order of magnitude.
- Rule of thumb for planning: 4 pts/m² x 5.5 B/pt = **22 MB per km² of covered area**, against 240-460 MB per km² at full density.
- Do not download anything for Phase 1 beyond what the bake needs. At the observed 5.3-5.7 B/pt, even one SF km² at full density is about 0.46 GB.
- Query used for tile totals (TNM LPC, paged, 3 s apart): `datasets=Lidar Point Cloud (LPC)&bbox=...`. Bboxes: Phase 1 -122.53,37.70,-122.35,37.84; Phase 2 -122.38,37.76,-122.17,37.90; Marin -122.55,37.80,-122.40,37.95; Peninsula -122.55,37.50,-122.30,37.70.

## 5. Coverage by region (Phases 1-3)

| Region | Best lidar source | EPT available? | Notes |
|---|---|---|---|
| All of SF (Phase 1) | `CA_SanFrancisco_B23` (2023, about 44 pts/m²; this is total/first-return pulse density; measured on real points 2026-10-26: 121–154 pts/m² all returns and 31–42 pts/m² ground (class 2) over mixed SF blocks, see lidar-probes.md §1) (corrected 2026-10-26) | yes | Bbox ends at lon -122.326, so Yerba Buena and Treasure Island are inside; the Oakland shore is not. |
| Bay Bridge west span and SF anchorage | SF B23 | yes | Class 17 documented. |
| Bay Bridge east span | SF B23 reaches lon -122.326; Alameda `_2` (west edge -122.347) and `_3` (west edge -122.342) cover the east end and Oakland touchdown | yes | The two projects overlap over the span; UNCONFIRMED which one has the denser deck points. |
| Oakland, Emeryville, Alameda island, Berkeley | `_2` (2019 QL1 upgraded), `_3` (2021 QL0) | yes | `_3` is the best density but it only reaches lat 37.913. Berkeley's north edge (37.905) is inside. |
| Richmond, El Cerrito | LAZ only: `CA_CONTRACOSTACO_2007` (old), `CA_NoCAL_3DEP_Supp_Funding_2018_D18` | no (UNCONFIRMED) | Not in Contra Costa 2022. |
| Marin Headlands, Sausalito | `CA_NoCAL_3DEP_Supp_Funding_2018_D18` (2018 QL1) plus the strip (corrected 2026-10-26) inside SF B23 | **no** | Only the southern edge is in SF B23 EPT. Plan on a PDAL job over LAZ tiles (each ~78 MB) or a DEM-only Marin. |
| San Mateo coast, SFO | `CA_CaliforniaGaps_B23` | yes (`CA_CaliforniaGaps_3_B23`, lat up to 37.709) | Only 7% of its coarse points fall in my San Mateo test box, so check it before relying on it; class list UNCONFIRMED. |
| Richmond-San Rafael Bridge, San Mateo Bridge, Dumbarton | 2018 D18 (RSR), Gaps B23 / Alameda (San Mateo and Dumbarton) | partial | Class 17 coverage UNCONFIRMED. |
| South Bay | `CA_SantaClaraCounty_2020` (170 B points) | yes | Later phase. |

## 6. Open questions

1. Do SF B23 and Alameda nodes really contain no class 6 or 3-5 points? One root-node sample (about 1 MB) would settle it for each project.
2. Is there any EPT for Marin south of lat 38.1, or a mirror (e.g. on Planetary Computer or OpenTopography)? I only enumerated `CA_*` in the one bucket.
3. Which Alameda project (`_2` or `_3`) is the better source for Oakland and Berkeley? Needs a per-area density map from the tile info JSONs (each tile has a point count and bounds).
4. Do the DEM cells that TNM dropped for "no download URL" (4-7 per query) matter anywhere in the bboxes?
5. Does `CA_CaliforniaGaps_3_B23` really cover the San Mateo peninsula and SFO, and with which classes?
6. Is the 2018 Marin QL1 lidar classified for buildings or bridge decks (relevant to Sausalito and the Richmond-San Rafael Bridge)?

## Fact-check

Independent check on 2026-10-26 against NOAA InPort, the EPT metadata, the NV5 report PDF, S3 listing and TNM API. Nothing else in this file was changed.

1. **Class lists (SF B23, Alameda 2021 = 1,2,7,9,17,18,20; W. Alameda 2019 = 1,2,7; no class 6 or 3-5). Verdict: confirmed.** InPort 73386 and 71712 list exactly 1, 2, 7, 9, 17, 18, 20. NV5 report Table 9 (Alameda 2021) and Table 7 (Western Alameda, report part 2) match. Small caveat: the InPort SF record also says "Class 10" for ignored ground in its processing text but uses code 20 in its class list. Sources: https://www.fisheries.noaa.gov/inport/item/73386 ; https://www.fisheries.noaa.gov/inport/item/71712 ; the NV5 PDF cited above.
2. **SF B23 numbers (13,088,433,078 points, bounds, 654 tiles, 500 m tiles, ~74 GB, 5.3-5.7 B/pt). Verdict: confirmed.** ept.json gives 13088433078 points; bounds converted from 3857 give lat 37.697..37.837, lon -122.516..-122.326; InPort says 654 tiles of "1000 m" while tile 04250230 spans x 42662..43000, y 23000..23500 (500 m); the tile has 8,688,564 points and TNM sizeInBytes 45,803,198 (5.27 B/pt); TNM lists 645 tiles at 74.24 GB in the Phase 1 box (5.67 B/pt). Sources: https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/ept.json ; .../info/USGS_LPC_CA_SanFrancisco_B23_04250230.json ; https://tnmaccess.nationalmap.gov/api/v1/products
3. **EPT is EPSG:3857, scale 1/cos(lat) ~1.2655, Z in true metres. Verdict: confirmed.** ept.json srs is EPSG:3857; 1/cos(37.77) = 1.2651 (1.2655 is correct at lat 37.78, immaterial). Alameda tile w6030n2109 source Z -31.99..245.31 ftUS appears as -9.75..74.77 in the EPT info. Not independently re-checked: that `readers.ept` resolution is in dataset CRS units (PDAL docs not re-read).
4. **Alameda mapping and Contra Costa. Verdict: confirmed (with one inference).** Point counts: `_1` 39,579,348,591; `_2` 26,097,078,802; `_3` 35,811,005,634. NV5 Table 9 class sums are about 35.8 B (QL0) and 39.6 B (QL1), matching `_3` and `_1`. `_2` = 2019 QL1 upgraded is by elimination (InPort does not name EPT ids). Contra Costa 2022 bbox is lon -121.924..-121.613, lat 37.751..37.990, so inland.
5a. **No Marin EPT south of lat 38.1; NorthernCA_1 starts at 38.109. Verdict: confirmed.** The `CA_` prefix listing of the bucket has no Marin project; `CA_NorthernCA_1_B22` bbox lat 38.109..38.854.
5b. **Marin lidar is `CA_NoCal_Wildfires_B5b_QL1_2018`, 166 tiles, 12.9 GB. Verdict: wrong.** TNM LPC for the Marin box (-122.55,37.80,-122.40,37.95) has no project by that name. The Marin LAZ tiles come from `CA_NoCAL_3DEP_Supp_Funding_2018_D18`: 231 tiles, 13.29 GB in that box (plus older ARRA_CA_GOLDENGATE_2010 90 tiles 9.14 GB, SF B23 65 tiles 4.11 GB). "B5b" is the label on the 1 m DEM products only. The conclusion "LAZ only, no EPT" stands. Also, the section 4 and 5 rows that cite B5b for lidar (166 tiles, 12.88 GB, 17 GB total) should use the D18 figures.
5c. **1 m DEM preferred sets: P1 523 MB, P2 1,576 MB, Marin 1,471 MB, Peninsula 3,385 MB. Verdict: P1 confirmed; P2 and Marin essentially confirmed; Peninsula not reproduced.** P1: SF B23 cells 177+112+148+86 = 523 MB. P2: 9 cells sum to 1,574 MB by my rounding. Marin: 9 cells, about 1,471 MB only if the 6 MB B5b QL1 tile is chosen for x55y421, which is a judgement call (other candidates are 11 MB and 178 MB). Peninsula: choosing the same preference rule (Gaps 9 cells 2,225; SF 2 cells 325; Alameda 3 cells 682; Santa Clara 2 cells 407) gives about 3,639 MB, not 3,385; I could not reproduce the figure. "Preferred" is subjective, and TNM item counts now differ slightly (e.g. 19 items for the P1 box).

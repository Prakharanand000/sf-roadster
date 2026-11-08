## Accuracy validation plan: a test spec the bake must pass

Researched 2026-10-26. Scope: MAP side (tools/, data/, src/world/). Every number has a URL. "UNCONFIRMED" marks anything not verified. "PROPOSED" marks a tolerance we choose (an engineering decision, not a published figure); calibrate it on the first real bake and then freeze it.

### 0. Ground rules for the harness

**0.1 Three sources of truth, kept independent.** A test is only worth something if the reference did not feed the bake.

| Reference | Fed the bake? | What it can prove |
|---|---|---|
| USGS 3DEP lidar (ground returns) | Yes (it is the terrain) | Only that the bake pipeline (datum, projection, resampling, road-profile extraction) is lossless. It does not prove the lidar is right. Say so in the report. |
| NGS survey marks, NAVD88 | No | Absolute vertical truth of the terrain. |
| comma2k19 GNSS/INS poses | No | Highway grade and curvature of real driven roads (a different measurement system). |
| DataSF centrelines `3psu-pn9h` | Yes if used to snap, otherwise no | Planimetric agreement of OSM-derived roads. Decide: if the bake snaps to DataSF, test against OSM instead. |
| Published grades / heights / clearances | No | Sanity checks of last resort (decades-old surveys, different definitions). |
| WGS84 geodesics (pyproj `Geod`) | No | Projection scale and azimuth. |

**0.2 Vertical datum must be explicit.** CONTRACTS.md says "Water level is y = 0" but does not say which datum that is (checked `CONTRACTS.md` lines 44-50). The 2023 SF lidar is NAVD88, Geoid18, metres ([NOAA InPort record](https://www.fisheries.noaa.gov/inport/item/73386)). At San Francisco CO-OPS station 9414290, relative to station datum: NAVD88 = 1.804 m, MSL = 2.773 m, MHW = 3.416 m, MHHW = 3.602 m, epoch 1983-2001 ([CO-OPS datums API](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290/datums.json?units=metric)). Therefore:

- MSL is 0.969 m above NAVD88 (2.773 - 1.804).
- MHW is 1.612 m above NAVD88.
- MHHW is 1.798 m above NAVD88.
- Rule: the bake must write `datum: { vertical: "NAVD88/GEOID18", y0_navd88: <m> }` into `data/world.json`, with `y = H_navd88 - y0_navd88`. Every vertical test below converts through `y0_navd88` and fails if the field is missing. A silent 0.97 m offset (NAVD88 zero vs MSL zero) is exactly the kind of bug these tests exist to catch.

**0.3 Two layers.**

- **Layer A, offline oracle (Python, runs inside the bake env).** Touches EPT, DataSF, NGS and comma2k19. Writes small, committed JSON fixtures to `tools/validation/fixtures/` and a metrics report `data/validation_report.json`. Needs pdal/pyproj/shapely, which the bake env already lists in `tools/MAP_RESOURCES.md` section 3.
- **Layer B, runtime test (Node, no dependencies).** `tools/test_world.mjs --accuracy` loads the shipped `data/world.json` plus tile files through the same `createWorldData` / `Q` API the game uses, reads the fixtures, and asserts. This tests what the player actually gets (after quantisation, LOD, tiling), which Layer A cannot.

Fixtures are the contract between the layers. They are small enough to commit (each under a few hundred KB, except lidar points, which is capped at 5,000 points).

**0.4 Gate vs advisory.** Each check is `GATE` (fails the process, exit code 1) or `ADVISORY` (prints a warning and records to the report). Published-number comparisons are advisory unless noted, because the published numbers are old or use different definitions.

---

### 1. Steep-street grades (checks V1)

**1.1 Published values, with their definitions.**

| Street and block | Published grade | Source and caveat |
|---|---|---|
| Filbert, Hyde to Leavenworth | 31.5% | Same figure in the [7x7 list](https://www.7x7.com/the-real-top-10-list-of-steepest-streets-in-san-francisco-1786501295.html) (Bureau of Engineering list, called outdated by the article), [Data Pointed](https://www.datapointed.net/2009/11/the-steeps-of-san-francisco/) and [Wikipedia](https://en.wikipedia.org/wiki/List_of_steepest_roads_and_streets). Wikipedia states the city map shows a 65 ft descent over a half-block of 206.25 ft. That is 19.8 m over 62.9 m, so 31.5% is a **mean over the whole half-block**, not a peak. |
| 22nd, Church to Vicksburg | 31.5% | Same sources. Runs one-way downhill (Wikipedia). |
| Jones, Union to Filbert | 29% | 7x7 (old Bureau of Engineering list). Not in the Data Pointed top 10. |
| Jones, Green to Union | 26% | 7x7. |
| Jones, Pine to California | 24.8 (unit not stated in the article) | 7x7. |
| Duboce, Buena Vista to Alpine | 27.9% | 7x7. |
| Webster, Vallejo to Broadway | 26% | 7x7. |
| Fillmore, Vallejo to Broadway | 24% | 7x7. |
| Bradford above Tompkins | 40-41% | 7x7 and Wikipedia (a 30 ft stretch, unofficial survey). Too short to be a drivable-physics test. Advisory only. |
| Broderick, Broadway to Vallejo | just under 35% (96 ft climb in 275 ft) | Wikipedia. Sidewalk-only, so not a road test. |
| Lombard, Hyde to Leavenworth ("crooked block") | the hill's natural grade is 27% | [Wikipedia](https://en.wikipedia.org/wiki/Lombard_Street_(San_Francisco)): block runs Hyde to Leavenworth, about 600 ft (180 m) along the curves, straight-line 412.5 ft (125.7 m), eight sharp turns, centre 37.80194, -122.41889. **The page does not give the grade of the crooked block itself.** |

Alternative published list (NED plus field survey): Data Pointed top 10 by hand-measured grade is Prentiss 37%, Nevada 36%, Baden 34%, Ripley 31.5%, Filbert 31.5%, 22nd 31.5%, 24th 30%, Kearny 30% (unconfirmed by the author), Holyoke 30%, 25th 30%. The author notes hand measurement with a level, no error margins, and that grade depends on the window length. Note Prentiss, Nevada, Baden are not conventional streets, so skip them.

**1.2 What the Lombard numbers imply (derived, not sourced).**

- Natural grade 27% over the 125.7 m straight-line gives a drop of about 33.9 m.
- Spread over 180 m of road, the mean road grade of the crooked block is about 18.8%.
- These are only a consistency check on the lidar-measured profile. Use the lidar oracle (1.3) as the primary reference.
- No published grade for the crooked block was found. UNCONFIRMED whether a source exists in the SF Public Works records.

**1.3 Method.**

1. Layer A builds a fixture `steep_streets.json`. For each block, pull the DataSF centreline by name and cross streets (the dataset has `streetname`, `f_st`, `t_st`, and `line` fields, confirmed on [the live dataset](https://data.sf.gov/resource/3psu-pn9h.json)). Example SoQL: `?$where=streetname='FILBERT ST' AND f_st='HYDE ST'` (and the reverse direction).
2. For the same polyline, sample the **raw lidar ground returns** (class 2) every 1 m, using a 1 m-wide strip and the median z per station. That gives an independent oracle profile `z_oracle(s)` (NAVD88). Store it in the fixture.
3. Layer B samples the baked road surface at the same stations using `Q.surfaceHeight(x, z, yRef)` (the physics-facing call, per CONTRACTS.md), starting `yRef` high so it selects the road deck and not a roof. Convert with `y0_navd88`.
4. Metrics per block:
   - `mean_grade = (z(end) - z(start)) / L` on the along-road length.
   - `max_grade_10m`: the maximum of the rise/run over any 10 m window.
   - `profile_rms`: RMS of `z_baked(s) - z_oracle(s)` after removing a single constant (for the datum-free part), plus the raw RMS (which includes the datum).
   - `max_step_2m`: the largest height change between consecutive 2 m samples (same as the existing `tools/check_grades.mjs`).

**1.4 Tolerances.**

| Check | Tolerance | Status |
|---|---|---|
| `mean_grade` baked vs lidar oracle | within 0.7 percentage points (about 0.4 m over a 63 m block) | GATE, PROPOSED |
| `max_grade_10m` baked vs lidar oracle | within 2.0 percentage points | GATE, PROPOSED |
| `profile_rms` baked vs oracle | at most 0.15 m, max single-point error 0.5 m | GATE, PROPOSED |
| `mean_grade` baked vs published (table 1.1) | within 3.0 percentage points | ADVISORY (old surveys, hand measurements) |
| Filbert and 22nd specifically | `mean_grade` in 28.5%..34.5% | ADVISORY; the definition matches the Wikipedia 65 ft / 206.25 ft statement |
| Lombard crooked block | polyline length 160-200 m, at least 7 direction reversals, net drop 28-40 m, mean grade 15-23% | GATE for length and turn count (published), ADVISORY for drop (derived) |
| Sign of grade | uphill/downhill direction matches the oracle on all blocks | GATE |

Why these tolerances: the 2023 SF lidar was tested at 1.73 cm NVA RMSEz against a 10 cm class requirement ([NOAA InPort](https://www.fisheries.noaa.gov/inport/item/73386)), so lidar noise over a 63 m block is a few millimetres of grade. The real errors are horizontal (centreline off the true street by a metre shifts the profile) and resampling (an 8 m terrain cell cannot represent a 63 m block at 31.5%, so the road profile must be its own 1-2 m-spaced polyline, not read off the terrain mesh).

**1.5 Extra physics-relevant check (PROPOSED).** On the same blocks, require `|grade(s+2 m) - grade(s)| <= 8 percentage points` except at intersections flagged as crests or sags, so the road profile has no kinks that would launch a car. UNCONFIRMED what real vertical-curve data looks like at these blocks; calibrate on the lidar oracle.

---

### 2. NGS survey control marks vs baked terrain (checks V2)

**2.1 API (verified live 2026-10-26).** [NGS Data Explorer API docs](https://geodesy.noaa.gov/web_services/) list the service; the endpoint details are on the [NDE page](https://geodesy.noaa.gov/web_services/data-explorer.shtml):

- Base `https://geodesy.noaa.gov/api/nde/`
- `/pid?pid=AB1234,JV2187` (comma-separated 6-character IDs)
- `/bounds?minlat=..&maxlat=..&minlon=..&maxlon=..` (decimal degrees, west negative)
- `/radial?lat=..&lon=..&radius=..&units=METER` (default units MILE)
- `/meta` field descriptions
- **Returns at most 500 marks per bounds or radial query.** Tile the area (for example 0.02 degree cells) and merge.
- Fields: `pid`, `name`, `lat`, `lon`, `ellipHeight`, `posDatum`, `posSource`, `posOrder`, `orthoHt`, `vertDatum`, `vertSource`, `vertOrder`. No stability field is documented, only the full text datasheet has that.

**Live samples I fetched.**

- Radial 500 m around City Hall (37.7749, -122.4194) returned 4 marks: HT3091 "SAN FRANCISCO CTY HALL STEEPLE" (no height), HT0771 "R C OF SF" 12.74 m NAVD 88, HT0769 "Q C OF SF" 16.24 m, HT0770 "C 995" 14.31 m. These three have **blank `vertOrder` and blank `posOrder`**, which means low or unstated quality. Treat them as advisory, not truth.
- Bounds over the Phase 1 box (37.70..37.84, -122.53..-122.35) returned a very large payload (the page was 526,239 characters; only the first 72 records were inspected). In those 72: 55 had a NAVD 88 `orthoHt` and only 2 had a `vertOrder` (both "1"): HT0685 "SB 1 4745" (37.7942222, -122.3925, 3.101 m) and HT0717 "U 108" (37.8073083, -122.4281, 33.938 m). So **the proportion of strict (ordered) marks is small**. The full count and distribution are UNCONFIRMED; the fixture builder must report them.
- The SF datum conversions: NGS's [GEOID API](https://geodesy.noaa.gov/api/geoid/ght?lat=37.7749&lon=-122.4194) returns GEOID18 height -32.535 m at downtown SF. Not needed for NAVD88 marks, but needed for comma2k19 (section 4).

**2.2 Filtering (Layer A).**

1. Keep marks with `vertDatum == "NAVD 88"` and numeric `orthoHt`.
2. Drop names containing STEEPLE, TOWER, TANK, ROOF, SPIRE, STACK, or marks inside a building footprint (rooftop and structure marks are not ground).
3. Drop marks that fall in water polygons or on bridge decks.
4. Split into **strict** (`vertOrder` in {1, 2}) and **loose** (everything else).
5. Reject marks where the lidar ground within 3 m varies by more than 0.5 m (steep local slope makes a 1-2 m horizontal error into a large vertical error).
6. For each remaining mark, compute the oracle: lidar ground median within 1 m (so this also compares NGS vs lidar directly, independent of the bake). Record `lidar_minus_ngs`.

**2.3 Tolerances.**

| Check | Tolerance | Status |
|---|---|---|
| Strict marks: `|baked - NGS|` | at most 0.15 m, and at least 90% under 0.10 m | GATE, PROPOSED (lidar class 10 cm RMSEz, [InPort](https://www.fisheries.noaa.gov/inport/item/73386) tested 1.73 cm, plus mark and resampling error) |
| Loose marks: `|baked - NGS|` | at least 85% within 0.30 m; list the outliers | ADVISORY, PROPOSED |
| Bias (mean of `baked - NGS`) over strict marks | within 0.05 m | GATE, PROPOSED (catches a datum or geoid mistake) |
| Mean of `lidar_minus_ngs` | reported; if its bias is much larger than the bake bias, the lidar or the mark is the problem, not the bake | diagnostic |

Caveats to record in the report: NGS marks move (subsidence on Bay fill such as Mission Bay and Treasure Island, destroyed monuments, readjusted heights). A persistent outlier cluster on fill is a finding about the mark, so the report must list them rather than fail silently. Phase 2 (Oakland, Berkeley) uses the Alameda `CA_AlamedaCo_2_2021` (2019 QL1, upgraded) or `CA_AlamedaCo_3_2021` (2021 QL0) EPT project, one per tile and never both, choice pending a per-tile density map (corrected 2026-10-26); their accuracy reports were not fetched (UNCONFIRMED); run the same test per project.

---

### 3. Lidar-vs-bake RMS on random road points (checks V3)

**3.1 Sampling.** Layer A draws N = 5,000 points uniformly by road length from the **baked** road set (not from the source ways), stratified by neighbourhood (so Sunset flats and Twin Peaks hills both count). Exclude points within 10 m of a bridge, tunnel, or overpass flag (those have their own tests). For each point, store the lidar oracle: median of ground-classified returns (class 2) within 0.5 m, requiring at least 5 returns, in NAVD88. Fetch via the EPT bucket (`s3://usgs-lidar-public`, project names in `tools/MAP_RESOURCES.md`) with PDAL `readers.ept` and a bounds crop; do not download whole projects.

Classification note (UNCONFIRMED): whether project B23 carries class 11 (road surface); if it does, prefer class 2+11 on pavement. Check the project's LAS classification counts first.

**3.2 Metrics and tolerances (all PROPOSED; calibrate on the first bake).**

| Metric | Tolerance | Status |
|---|---|---|
| RMS of `(y_baked + y0_navd88) - z_lidar` over all road points | at most 0.15 m | GATE |
| 95th percentile of absolute error | at most 0.30 m | GATE |
| Maximum absolute error | at most 1.0 m (list the worst 20 with lat/lon) | GATE |
| Mean error (bias) | within 0.03 m | GATE |
| Same, but on points with road grade above 15% | RMS at most 0.25 m | ADVISORY |

Where the physics reads the surface (`Q.surfaceHeight` on roads) the tolerance applies; where a car is on the terrain mesh only (parks, grass, beaches) use RMS at most 0.5 m for an 8 m cell mesh and 0.25 m for a 1-2 m mesh.

**3.3 Independence caveat.** Because the bake consumes the same lidar, V3 proves the pipeline, not the lidar. To add an independent leg, also compare the lidar oracle to the [USGS 1 m bare-earth DEM](https://tnmaccess.nationalmap.gov/api/v1/products) tiles for the same project (a different derived product; per MAP_RESOURCES.md the DEM is UTM 10N, NAVD88) on a small test area only, mindful of the 60-400 MB tile size (do not fetch within this plan; run when the bake machine does).

---

### 4. comma2k19 highway grade and curvature (checks V4)

**4.1 Dataset facts (all from the [GitHub README](https://github.com/commaai/comma2k19) and the [Academic Torrents page](https://academictorrents.com/details/65a2fbc964078aff62076ff4e103f18b951c5ddb)).**

- MIT licence. 2,019 one-minute segments, over 33 hours, on a 20 km stretch of Highway 280 between San Jose and San Francisco. So **the route is mostly south of the Phase 1 box (south edge 37.70); how much of it falls inside Phase 1-2 is UNCONFIRMED.** Scan all segments' positions first (4.4).
- Distribution is **a torrent only** (hash `65a2fbc964078aff62076ff4e103f18b951c5ddb`). The torrent lists 10 files, `Chunk_1.zip` to `Chunk_10.zip`, 8.73, 9.05, 9.41, 9.49, 9.81, 9.53, 9.29, 9.63, 9.77 and 9.90 GB, total 94.62 GB.
  - Chunks 1 and 2 are a RAV4 (dongle id `b0c9d2329ad1606b`); chunks 3 to 10 are a Civic (`99c94dc769b5d96e`).
  - **A single chunk is therefore 8.7-9.9 GB, far above the 20 MB research limit, so nothing was downloaded here.** I found no HTTP or Hugging Face mirror (search returned only unrelated CommaQA datasets).
- Layout:
  ```
  Chunk_n/<dongle_id>|<start_time>/<segment_number>/
    preview.png, raw_log.bz2, video.hevc
    processed_log/   (IMU, CAN, GNSS numpy arrays; timestamps + values)
    global_pos/      frame_times, frame_gps_times, frame_positions (ECEF m),
                     frame_velocities (ECEF m/s), frame_orientations (quaternion ECEF to camera [forward,right,down])
  ```
  The repo's `Example_1/` contains one segment: `b0c9d2329ad1606b|2018-08-02--08-34-47/40`. Its size was not shown on the page (UNCONFIRMED; the video file probably makes it large).
- Pose provenance: "tightly coupled INS/GNSS/Vision optimizer that relies on data processed by Laika"; Laika is claimed "40% more accurate" than the raw GNSS module. **No absolute accuracy figure is published**, so treat absolute height as metre-class and use relative measures (grade over long windows, curvature) for the test.
- Windows trap: `|` in folder names is illegal on NTFS/exFAT. The repo provides `utils/unzip_msft_fs.py <dataset dir> <goal dir>` which extracts in parallel and swaps `|` for `_`. (The README names only this utility; no coordinate helpers.) The repo's `notebooks/` include `position_benchmark.ipynb`, `processed_readers.ipynb`, `raw_readers.ipynb` and `camera_intrinsics.txt`.

**4.2 How to get one chunk (for the human to run, not done here).**

1. Open the torrent in any client that supports per-file selection. Select only `Chunk_1.zip` (8.73 GB, smallest). Deselect the other nine. Needs about 9 GB free; MAP_RESOURCES.md notes 208 GB free.
2. Do not unzip everything. Extract only the five `global_pos` files per segment using Python `zipfile` (rename `|` to `_` while writing). A segment's `global_pos` is five small arrays, so a whole chunk's poses should be tens of MB. The exact on-disk filenames and whether they carry a `.npy` extension are UNCONFIRMED; open one with `numpy.load`.
3. Commit only the derived fixture (section 4.5), never the zip.

**4.3 Pose to map coordinates.**

1. `frame_positions` (ECEF, WGS84) to geodetic: `pyproj.Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True)` gives lon, lat, ellipsoidal height `h`.
2. NAVD88 height `H = h - N`, with `N` the GEOID18 undulation (about -32.5 m near downtown; call the [NGS GEOID API](https://geodesy.noaa.gov/api/geoid/ght?lat=37.7749&lon=-122.4194) per point or per 1 km, or use PROJ's `us_noaa_g2018u0` grid if present in the bake env; its availability is UNCONFIRMED). Skipping this step is a 32 m error.
3. Project lat/lon with the bake's own projection (from `world.json`) to world x, z.
4. Map-match each trace to the correct directional carriageway (I-280 is two OSM ways; do not match a southbound trace to the northbound way, the carriageways may differ in height and offset).

**4.4 Metrics and tolerances (PROPOSED; calibrate, then freeze).**

| Metric | Definition | Tolerance | Status |
|---|---|---|---|
| Coverage | segments with at least 80% of frames inside the baked area | report count; test is vacuous if 0 | gate on "at least 20 segments", else SKIP loudly |
| Lateral offset | distance from each frame to the baked carriageway centreline | median at most 3 m, 95th percentile at most 6 m (a lane is about 3.66 m, Caltrans HDM figure as quoted in MAP_RESOURCES.md, not re-verified here; car sits 1.8-5.5 m off the carriageway centre depending on lane) | GATE |
| Grade | rise/run of smoothed `H` over 200 m windows vs baked grade at the matched positions | RMS at most 0.8 percentage points, 95th percentile at most 2.0 | GATE after calibration |
| Height bias | mean(`H` - baked + `y0`) over all matched frames | within 3 m (GNSS vertical class) | ADVISORY |
| Curvature | planar curvature from the heading rate vs baked curvature in 100 m windows; compare on straights and curves separately | agree on curve direction in at least 95% of windows where `abs(curvature) > 1/800 m`; radius within 25% on the largest curves | ADVISORY first |

Median across repeated passes of the same road will cut GNSS noise; combine all segments covering a given stretch before computing grade error. A repeat-pass standard deviation is itself a useful measure of the reference's noise floor, so report it next to every error figure.

**4.5 Fixture.** `tools/validation/fixtures/comma_i280.json`: for each used segment, decimated (1 Hz) arrays of `lat`, `lon`, `H_navd88`, and the heading, plus the segment id. A few hundred KB.

---

### 5. Building heights vs the tallest list (checks V5)

**5.1 Reference list (Wikipedia, retrieved 2026-10-26).** SF: [List of tallest buildings in San Francisco](https://en.wikipedia.org/wiki/List_of_tallest_buildings_in_San_Francisco). The page says its heights "include spires and architectural details" and exclude antenna masts, so these are **architectural heights, not roof heights**. Rank 30 (St. Regis Museum Tower) was cut off in the text I could read, so its height is UNCONFIRMED. Cross-check against [CTBUH](https://www.skyscrapercenter.com/city/san-francisco) (not fetched; UNCONFIRMED).

| # | Building | m | ft | Floors | Year |
|---|---|---|---|---|---|
| 1 | Salesforce Tower | 326 | 1,070 | 61 | 2018 |
| 2 | Transamerica Pyramid | 260 | 853 | 48 | 1972 |
| 3 | 181 Fremont | 246.9 | 810 | 56 | 2018 |
| 4 | 555 California Street | 237.4 | 779 | 52 | 1969 |
| 5 | 345 California Center | 211.8 | 695 | 48 | 1986 |
| 6 | Millennium Tower | 196.6 | 645 | 58 | 2009 |
| 7 | The Avery | 188.4 | 618 | 56 | 2019 |
| 8 | Park Tower at Transbay | 184.5 | 605 | 43 | 2018 |
| 9 | One Rincon Hill | 184.4 | 605 | 54 | 2008 |
| 10 | 101 California Street | 183 | 600 | 48 | 1982 |
| 11 | Salesforce West (50 Fremont) | 183 | 600 | 43 | 1985 |
| 12 | 575 Market Street | 174.7 | 573 | 40 | 1975 |
| 13 | Four Embarcadero Center | 173.7 | 570 | 45 | 1984 |
| 14 | One Embarcadero Center | 173.4 | 569 | 45 | 1970 |
| 15 | 44 Montgomery Street | 172.3 | 565 | 43 | 1967 |
| 16 | Spear Tower (One Market Plaza) | 172 | 564 | 42 | 1976 |
| 17 | One Sansome Street | 168 | 550 | 43 | 1984 |
| 18 | The Harrison | 165 | 541 | 45 | 2014 |
| 19 | One Front Street | 164 | 538 | 38 | 1982 |
| 20 | McKesson Plaza | 161.2 | 529 | 38 | 1969 |
| 21 | First Market Tower | 161.2 | 529 | 38 | 1972 |
| 22 | 425 Market Street | 159.7 | 524 | 38 | 1973 |
| 23 | 706 Mission (Four Seasons Private Residences) | 155.5 | 510 | 43 | 2020 |
| 24 | One Montgomery Tower | 152.4 | 500 | 38 | 1982 |
| 25 | 333 Bush Street | 150.9 | 495 | 43 | 1986 |
| 26 | Hilton San Francisco Union Square | 150.3 | 493 | 46 | 1971 |
| 27 | PG&E Building | 150 | 492 | 34 | 1971 |
| 28 | 50 California Street | 148.4 | 487 | 37 | 1972 |
| 29 | 555 Mission Street | 148.4 | 487 | 33 | 2008 |
| 30 | St. Regis Museum Tower | UNCONFIRMED | | | |

Oakland, from [Wikipedia](https://en.wikipedia.org/wiki/List_of_tallest_buildings_in_Oakland,_California) (retrieved the same day): Ordway Building 123.1 m (404 ft, 1970), Atlas 122.9 m (403 ft, 2020), 1900 Broadway 120.4 m (395 ft, 2024), Kaiser Center 118.7 m (389 ft, 1960), 17th and Broadway 114.3 m (375 ft, 2019), Lake Merritt Plaza 113.1 m (371 ft, 1988), 1111 Broadway 109.7 m (360 ft, 1990), Kaiser Engineering Building 102.4 m (336 ft, 1984), Clorox Building 100.6 m (330 ft, 1976), Ronald V. Dellums Federal Building North 100.0 m (328 ft, 1994); the Dellums Federal Building South and the Elihu M. Harris State Office Building also stand at 100.0 m (328 ft), tied for tenth.

**5.2 Why this test catches a known bug.** [DataSF footprints `ynuv-fyni`](https://data.sf.gov) carry 2010-era lidar heights (per `tools/MAP_RESOURCES.md`). Salesforce Tower, 181 Fremont, Park Tower, The Avery, 706 Mission, Atlas and 1900 Broadway were completed after 2010-ish, so a bake that only uses DataSF heights fails this test by design; it forces the 2023-lidar recompute.

**5.3 Method.**

1. Match by name in the baked building properties (OSM `name` or `wikidata` kept through the bake). Fallback: matching by footprint centroid within 40 m of a fixture coordinate (coordinates for each building to be filled by the fixture builder from OSM; I did not verify any coordinates).
2. Baked height = `D.B.top[k] - D.B.gmin[k]` (the same fields the existing `tools/test_world.mjs` uses for the tallest building).
3. Rank test, needing no coordinates: the baked top-30 by height must share at least 28 names with the list above.

**5.4 Tolerances (PROPOSED).**

| Check | Tolerance | Status |
|---|---|---|
| Ratio baked / listed, ordinary roof | within 0.95 to 1.03 | GATE for at least 90% of matched buildings |
| Ratio for buildings with a crown, spire or sculpted top (Transamerica has a spire; Salesforce Tower has a crown; exact roof heights UNCONFIRMED) | 0.80 to 1.03 | GATE |
| Absolute error for any single building | at most 15 m | GATE |
| Tallest in SF is Salesforce Tower and in Oakland is the Ordway Building | exact | GATE |
| Set overlap of top-30 names | at least 28 | GATE |
| Floor-count sanity: `height / floors` between 2.8 and 5.5 m for all 40 | all | ADVISORY (catches a feet/metres mix-up) |

The "listed" figure is a ground-to-architectural-top figure and the baked figure is footprint-extruded, so hillside sites (Nob Hill, Rincon Hill) depend on the `gmin` definition: use the lowest ground at the footprint. Report the ratio for every building so a human can eyeball it.

---

### 6. Bridge deck and tunnel clearances (checks V6)

**6.1 Reference numbers.**

| Structure | Number | Source |
|---|---|---|
| Golden Gate, clearance under the main span | 220 ft (67.1 m) at high tide; averages 220 ft (67 m) above high water | [Wikipedia](https://en.wikipedia.org/wiki/Golden_Gate_Bridge) (also repeated in `tools/MAP_RESOURCES.md` as MHHW; which tidal datum is UNCONFIRMED) |
| Golden Gate, main span / tower height / length | 4,200 ft (1,280 m) / 746 ft (227.4 m) above water / 8,980 ft (2,737 m abutment to abutment, 8,981 ft later in the article) | Wikipedia |
| Bay Bridge, west span under-clearance | 220 ft (67 m) | [Wikipedia](https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge) |
| Bay Bridge, east span under-clearance | 190 ft (58 m) | Wikipedia |
| Bay Bridge, clearance above each deck | westbound 14 ft (4.3 m), eastbound 14.67 ft (4.47 m); Yerba Buena Tunnel both decks 16 ft (4.9 m) | Wikipedia |
| Yerba Buena Tunnel | 540 ft (about 160-165 m); bore 76 ft x 58 ft (23 m x 18 m); interior 66 ft x 53 ft (20 m x 16 m) | Wikipedia |
| Bay Bridge spans and towers | west: two 2,310 ft (704 m) main spans; east main span 1,400 ft (430 m); west tower 526 ft (160 m); east tower 525 ft (160 m) | Wikipedia |

The previous Wikipedia fetches did not give deck heights above water for the Bay Bridge (UNCONFIRMED) and the deck thickness of the Golden Gate (UNCONFIRMED), so I do not invent a "deck top" figure. The clearance is to the **underside** of the structure, and lidar sees only the top surface.

**6.2 Converting clearance to a testable number (derived).** Using the CO-OPS values in 0.2: MHW is 1.612 m above NAVD88, so the Golden Gate's underside should be at roughly 1.612 + 67.1 = 68.7 m NAVD88 (about 68.9 m if the figure means MHHW, a 0.19 m difference). The deck surface sits above the underside by the thickness of the stiffening truss and deck; UNCONFIRMED how much (the stiffening truss depth is about 25 ft in my recollection, not sourced). So the deck surface at mid-span is expected a few metres above 68.7 m NAVD88. The existing test accepts 64 to 72 m above y = 0 (`tools/test_world.mjs`); with y0 added that range should be re-derived from the lidar.

**6.3 Method.**

- **Primary oracle is the lidar:** the first return along the deck centreline, taken from the raw point cloud, with a deck-vs-cable classification (cables are thin and high; take the lowest dense surface that is road-width). The published numbers only confirm the oracle.
- Layer B reads `Q.surfaceHeight(x, z, 1e4)` at stations every 10 m along each structure's centreline (taken from the fixture, not from the bake's own bridge object) plus the water or ground level under it from `Q.heightAt`.

**6.4 Tolerances (PROPOSED).**

| Check | Tolerance | Status |
|---|---|---|
| Golden Gate: deck surface along every 10 m station vs lidar first-return oracle | RMS at most 0.5 m, max 1.5 m (suspension decks deflect with load and temperature; the 1987 crowd test flattened the centre span ([Wikipedia](https://en.wikipedia.org/wiki/Golden_Gate_Bridge)); the lidar date matters) | GATE |
| Golden Gate: clearance = deck surface minus truss/deck thickness minus MHW. Because thickness is UNCONFIRMED, compare instead `underside_estimate_navd88` to 68.7 +/- 2 m | within 2 m | ADVISORY |
| Golden Gate: tower tops 227.4 m above water at both towers | +/- 3 m vs lidar tower-top max | ADVISORY |
| Golden Gate: main span (tower centre to tower centre) 1,280 m | within 1% (12.8 m; positions come from OSM nodes or lidar) | ADVISORY |
| Bay Bridge: west span has two distinct decks at every station; vertical gap between the two `surfaceHeight` results (called with `yRef` set to each deck) is at least 4.9 m (the tunnel's 16 ft clearance) | all stations | GATE |
| Bay Bridge: both decks present and continuous on the west span, the YBI tunnel and the east span (no gap longer than 20 m in the road polyline) | exact | GATE |
| Under-clearance West span 67 m, East span 58 m at mid-span | +/- 3 m after datum conversion | ADVISORY |
| Yerba Buena Tunnel: length | 160-170 m | ADVISORY |
| Every tunnel in the bake (YBI, Broadway, Stockton, Presidio Parkway, Caldecott later): headroom `roof_y - road_y` at least 4.3 m (14 ft, the westbound clearance figure above) everywhere along the road centreline | all stations | GATE; actual tunnel dimensions for SF's other tunnels are UNCONFIRMED (not researched) |
| No station in a tunnel where `Q.surfaceHeight(x,z,yRef = road_y + 1)` returns terrain above the road (the "never below terrain" clamp issue in MAP_RESOURCES.md) | all stations | GATE (needs the physics contract change) |
| Bridges flagged `bridge=yes` in OSM are higher than the terrain beneath them by at least 3 m where over water or a road | all stations | GATE |

---

### 7. Planimetric accuracy vs DataSF centrelines (checks V7)

**7.1 Reference.** [DataSF "Streets - Active and Retired" `3psu-pn9h`](https://data.sf.gov/api/views/3psu-pn9h): street centrelines extracted from the Department of Public Works Basemap, 33 columns, refreshed daily (`data_as_of` 2026-10-26 on the live API), PDDL licence. Confirmed from the live rows:

- Fields: `cnn`, `street`, `st_type`, `streetname`, `f_st`, `t_st`, `layer` (values seen: PRIVATE, UPROW), `oneway`, `classcode`, `active`, `accepted`, `jurisdiction`, `line` (GeoJSON LineString in lon/lat).
- **No elevation / z-level field**, so it cannot tell stacked roads apart. **The metadata contains no positional-accuracy statement**, so the DPW Basemap accuracy is UNCONFIRMED.

**7.2 Metrics.**

1. Sample every baked road polyline every 5 m (only roads that have a `name`, exclude freeways and ramps unless the DataSF row exists, and exclude `layer` values that are not public streets).
2. Distance from each sample to the nearest DataSF centreline with the same normalised street name within 30 m (use `streetname_gc`; handle `ST`/`STREET`, numbered streets, and `AVE`); also compute the unfiltered nearest distance as a diagnostic.
3. Reverse direction (coverage): for each active DataSF row, with `classcode` indicating a drivable street (values UNCONFIRMED), fraction of its length within 10 m of a baked road.

**7.3 Tolerances (PROPOSED; DPW accuracy unknown).**

| Metric | Tolerance | Status |
|---|---|---|
| Median offset | at most 1.5 m | GATE |
| 95th percentile | at most 4.0 m | GATE |
| 99th percentile | at most 8.0 m | ADVISORY; list the worst 20 street segments |
| Maximum | at most 15 m (beyond that the match is wrong, not inaccurate) | ADVISORY |
| Coverage: share of active public DataSF length within 10 m of a baked road | at least 97% | GATE |
| Divided roads and one-way pairs | accept the offset to either carriageway: use half the median width as a floor, `tol = max(tol, 0.5 * median_width)` | rule |

If the bake snaps OSM geometry to DataSF, this test is circular; then run it against OSM unsnapped as the reference. East Bay (Phase 2) has no DataSF equivalent (MAP_RESOURCES.md found none), so use Alameda County or OSM versus lidar road edges there; the exact county centreline dataset is UNCONFIRMED.

---

### 8. Projection check against known distances (checks V8)

**8.1 What is wrong now.** `tools/geo.py` uses `KX = 111320 * cos(LAT0)` and `KZ = 110540`. `tools/MAP_RESOURCES.md` already records that this is short by 0.41% (north-south) and 0.13% (east-west), roughly 40-50 m across SF. V8 turns that finding into a regression test.

**8.2 Reference.** WGS84 geodesics from [`pyproj.Geod`](https://pyproj4.github.io/pyproj/stable/api/geod.html): `Geod(ellps='WGS84').inv(lon1, lat1, lon2, lat2)` returns forward azimuth, back azimuth and distance in metres. Do **not** use UTM 10N coordinates directly: the central meridian is -123 and SF sits at about -122.4. My own estimate from the standard transverse Mercator scale formula (derived, not sourced) is k about 0.99963, so a UTM-based world would be 0.037% short (3.7 m per 10 km). Prefer a local transverse Mercator at the world origin with k0 = 1; at 16 km from the origin the scale error is below 2e-6.

**8.3 Method.**

1. Layer A draws 300 random pairs inside Phase 1 and 300 inside Phase 1-2, with separations from 0.2 to 20 km, and stores `{lat1, lon1, lat2, lon2, geodesic_m, azimuth_deg}` in `projection_pairs.json`.
2. Layer B projects each endpoint with the projection described in `world.json` (a declared `projection` block with its constants; the test must read it, never hard-code it) and compares the Euclidean distance and the bearing.
3. Also test that the declared projection round-trips: `unproj(proj(p))` within 1 mm.
4. Anchor checks against published distances, using positions of the structures from OSM/lidar rather than recalled coordinates:
   - Golden Gate tower centre to tower centre: 1,280 m ([Wikipedia](https://en.wikipedia.org/wiki/Golden_Gate_Bridge)).
   - Golden Gate abutment to abutment: 2,737 m (8,981 ft, same page).
   - Bay Bridge west section: 3,141 m (10,304 ft) and each of its two main spans 704 m ([Wikipedia](https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge)).
   - The published values only check that the source data are sane; the geodesic comparison is the real test.

**8.4 Tolerances.**

| Check | Tolerance | Status |
|---|---|---|
| Relative distance error versus the WGS84 geodesic, all pairs | at most 0.01% (1 m per 10 km); the current constants give about 0.4% (N-S) and would fail | GATE, PROPOSED |
| Absolute error for a pair under 1 km | at most 0.5 m | GATE |
| Bearing error | at most 0.1 degree | GATE |
| Max error for any single pair, any phase | at most 3 m for distances under 20 km | GATE |
| Round trip | at most 1 mm | GATE |
| Anchors against published distances | within 1% (OSM node placement error dominates) | ADVISORY |

---

### 9. How `tools/test_world.mjs` runs these

The current file (`tools/test_world.mjs`, 113 lines, plain Node, no libraries) has an `ok(cond, msg)` helper and hard-codes the old projection in its local `proj`. Two changes:

1. **Stop hard-coding `proj`.** Read the projection block from `index.projection` (and fail if it is missing) so tests follow the bake.
2. **Add an accuracy mode.** `node tools/test_world.mjs --accuracy [--tier=gate|all] [--json=out.json]`, default off so the existing sanity run stays quick.

Proposed structure (sketch, not applied; I wrote no code):

```js
// tools/test_world.mjs (additions)
const args = new Set(process.argv.slice(2));
const FIX = path.join(root, 'tools/validation/fixtures');
const fx = (n) => JSON.parse(readFileSync(path.join(FIX, n), 'utf8'));
const metrics = {};                                         // written to --json
const check = (id, tier, cond, msg) => { /* tier: 'gate' | 'advisory'; advisory never increments fails */ };
const yBake = (x, z, yRef) => Q.surfaceHeight(x, z, yRef) + index.datum.y0_navd88;   // NAVD88 metres

if (args.has('--accuracy')) {
  // V1 steep streets: fixtures give polyline (world x,z computed through index.projection) + z_oracle[]
  for (const s of fx('steep_streets.json').blocks) { /* sample every 1 m, compute mean/max10m/rms, check() */ }
  // V2 NGS marks
  const r = fx('ngs_marks_sf.json').marks.map(m => yBake(...proj(m.lat, m.lon), 1e4) - m.orthoHt);
  /* strict vs loose, bias, % within */
  // V3 random lidar road points
  /* rms, p95, max, bias over fx('lidar_road_points.json') */
  // V4 comma2k19 traces
  /* offset to Q.roads polylines, grade over 200 m windows; SKIP (not pass) if fewer than 20 segments */
  // V5 buildings: name match into D.B (needs names exported), rank overlap, ratio table
  // V6 structures: stations along bridge/tunnel centrelines, deck stacking, headroom
  // V7 planimetric: fx('centrelines_sample.json') nearest-distance from Q.roads samples (spatial hash)
  // V8 projection: fx('projection_pairs.json') distance, bearing, round trip
}
```

Requirements this places on the bake / World API (to coordinate with the physics owner where marked **[physics]**):

- `world.json` must carry `projection` (type, origin, constants, k0) and `datum` (`vertical`, `y0_navd88`).
- Building records need a stable id and name (or `wikidata`) exported, not only the geometry arrays `D.B.*`.
- Bridges, viaducts and tunnels need a structure id plus centreline in `world.json` so V6 can sample them; for stacked decks the test must be able to ask `surfaceHeight` with different `yRef` values and get different decks. **[physics]** (stacked-deck behaviour and the tunnel clamp are contract changes, per MAP_RESOURCES.md items 6-7.)
- With tile streaming, the test loads tiles on demand (a `loadTileFor(x, z)` helper) rather than assuming one global heightfield; the fixture-driven design avoids touching more tiles than needed.

**Fixture builders** (Layer A, new, in `tools/validation/`): `fetch_ngs_marks.py` (tiled `/bounds` calls, sleep 2 s between requests, cache raw JSON in `tools/cache`), `make_lidar_oracle.py` (PDAL EPT crops for V1, V3, V6), `make_centrelines.py` (SoQL on `3psu-pn9h`), `make_projection_pairs.py` (`Geod.inv`), `make_comma_fixture.py` (extract `global_pos`, ECEF to NAVD88). Each writes a header `{source, retrieved, license, n}` so provenance is in the fixture.

**Report.** `data/validation_report.json` stores every metric with its tolerance and tier, so regressions between bakes are diffable. CI/pre-release rule: zero GATE failures; ADVISORY deltas listed in the release notes.

### 10. Summary of gates

| ID | Check | Primary metric | Gate tolerance |
|---|---|---|---|
| V1 | Steep streets (Filbert, 22nd, Jones x3, Duboce x2, Webster, Fillmore, Lombard) | mean grade vs lidar oracle | within 0.7 percentage points; published within 3 (advisory) |
| V2 | NGS marks | strict marks, abs error | at most 0.15 m, bias within 0.05 m |
| V3 | Lidar vs bake, 5,000 road points | RMS / p95 / max | 0.15 / 0.30 / 1.0 m |
| V4 | comma2k19 | grade RMS, lateral offset p95 | 0.8 percentage points, 6 m |
| V5 | Tallest 30 SF + Oakland 10 | ratio baked/listed | 0.95-1.03 (0.80-1.03 for crowns) |
| V6 | Bridges and tunnels | deck vs lidar RMS, stacked-deck gap, headroom | 0.5 m, at least 4.9 m, at least 4.3 m |
| V7 | DataSF centrelines | median / p95 offset, coverage | 1.5 m / 4 m, 97% |
| V8 | Projection | relative distance error | 0.01% |

### 11. UNCONFIRMED register

- Absolute accuracy of comma2k19 `global_pos` (not published); exact filenames/extensions inside `global_pos`; how much of the I-280 stretch lies inside the Phase 1-2 boxes; size of `Example_1`.
- Whether any HTTP mirror serves single comma2k19 segments (none found).
- Number of NGS marks with `vertOrder` 1 or 2 across SF (only 72 records inspected) and their stability; accuracy reports of `CA_AlamedaCo_2_2021` and `CA_AlamedaCo_3_2021` (corrected 2026-10-26).
- Whether CA_SanFrancisco B23 contains lidar class 11; the project's QL (InPort cites a 10 cm RMSEz class and a tested 1.73 cm NVA RMSEz but not "QL1" or "QL2").
- Golden Gate stiffening-truss/deck thickness and which tidal datum the 220 ft figure uses; Bay Bridge deck heights above water; dimensions of SF's tunnels other than Yerba Buena.
- DPW Basemap positional accuracy; DataSF `classcode` meanings and the full `layer` value list.
- Roof (not architectural) heights of the spired/crowned towers; St. Regis Museum Tower height; CTBUH figures.
- Any published grade for Lombard's crooked block itself.
- PROJ's `us_noaa_g2018u0` grid availability in the bake environment.
- All PROPOSED tolerances above need calibration on the first real bake.

### 12. Sources

- [MAP_RESOURCES.md](../MAP_RESOURCES.md) (local).
- Grades: [7x7](https://www.7x7.com/the-real-top-10-list-of-steepest-streets-in-san-francisco-1786501295.html), [Data Pointed](https://www.datapointed.net/2009/11/the-steeps-of-san-francisco/), [Wikipedia steepest roads](https://en.wikipedia.org/wiki/List_of_steepest_roads_and_streets), [Wikipedia Lombard Street](https://en.wikipedia.org/wiki/Lombard_Street_(San_Francisco)).
- NGS: [web services](https://geodesy.noaa.gov/web_services/), [NDE API](https://geodesy.noaa.gov/web_services/data-explorer.shtml), [live radial query](https://geodesy.noaa.gov/api/nde/radial?lat=37.7749&lon=-122.4194&radius=500&units=METER), [GEOID API](https://geodesy.noaa.gov/api/geoid/ght?lat=37.7749&lon=-122.4194).
- Lidar: [NOAA InPort 2023 USGS Lidar San Francisco](https://www.fisheries.noaa.gov/inport/item/73386).
- Tidal datums: [CO-OPS 9414290](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290/datums.json?units=metric).
- comma2k19: [GitHub](https://github.com/commaai/comma2k19), [raw README](https://raw.githubusercontent.com/commaai/comma2k19/master/README.md), [Academic Torrents](https://academictorrents.com/details/65a2fbc964078aff62076ff4e103f18b951c5ddb).
- Buildings: [SF list](https://en.wikipedia.org/wiki/List_of_tallest_buildings_in_San_Francisco), [Oakland list](https://en.wikipedia.org/wiki/List_of_tallest_buildings_in_Oakland,_California).
- Bridges: [Golden Gate Bridge](https://en.wikipedia.org/wiki/Golden_Gate_Bridge), [Bay Bridge](https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge).
- DataSF: [dataset metadata](https://data.sf.gov/api/views/3psu-pn9h), [live rows](https://data.sf.gov/resource/3psu-pn9h.json).
- Geodesics: [pyproj Geod](https://pyproj4.github.io/pyproj/stable/api/geod.html).

## Fact-check

Independent re-check on 2026-10-26 by fetching each cited source.

| # | Claim | Verdict | Correction / source |
|---|---|---|---|
| 1a | Filbert (Hyde-Leavenworth) 31.5% = 65 ft over 206.25 ft | Confirmed, with a wording caveat | [Wikipedia](https://en.wikipedia.org/wiki/List_of_steepest_roads_and_streets) calls 31.5% the "maximum gradient" and says the city map's 65 ft drop over a 206.25 ft half-block gives the same figure. 65/206.25 = 31.5%, so "mean over the half-block" is our arithmetic reading, not a wording the source uses. |
| 1b | Lombard: ~600 ft, 8 turns, natural grade 27%, no block grade | Confirmed | [Wikipedia](https://en.wikipedia.org/wiki/Lombard_Street_(San_Francisco)): about 600 ft (180 m), eight sharp turns, 27% natural grade, no grade stated for the block. |
| 2a | NDE API has /bounds, /radial, /pid; max 500 per query | Confirmed for bounds and radial | [NDE page](https://geodesy.noaa.gov/web_services/data-explorer.shtml) states the 500 limit for bounds and radial. It does not state a limit for /pid. |
| 2b | Fields include orthoHt, vertDatum, vertOrder | Confirmed | Same page and the live radial query. Live City Hall radial query returned 4 marks, 3 with orthoHt and blank vertOrder. |
| 2c | 72-mark sample, only 2 with a vertOrder | Unverifiable | Not re-run (bounds payload is large). Treat as a non-reproducible sample count. |
| 3a | comma2k19 is MIT, torrent only, 10 chunks of 8.73-9.90 GB, 94.6 GB total | Confirmed | [Academic Torrents](https://academictorrents.com/details/65a2fbc964078aff62076ff4e103f18b951c5ddb): 10 files, 94.62 GB, MIT. The [GitHub README](https://github.com/commaai/comma2k19) names only the torrent link and does not mention mirrors. "No mirror exists" is absence of evidence only. |
| 3b | ~20 km of I-280 San Jose to SF; global_pos has ECEF frame_positions | Confirmed | README: "20km section" of 280; frame_positions are ECEF metres. |
| 3c | GEOID18 -32.535 m at downtown SF | Confirmed | [NGS GEOID API](https://geodesy.noaa.gov/api/geoid/ght?lat=37.7749&lon=-122.4194): geoidHeight -32.535, GEOID18, error 0.03 m. |
| 3d | Comma heights are ellipsoidal | Unverifiable | The README says positions are ECEF, which implies ellipsoidal height after conversion. No explicit statement was found. |
| 4a | Station 9414290: NAVD88 1.804, MSL 2.773, MHW 3.416 (station datum) | Confirmed | [CO-OPS datums](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290/datums.json?units=metric); MHHW 3.602, epoch 1983-2001. |
| 4b | NAVD88 is 0.969 m below MSL and 1.612 m below MHW | Confirmed (arithmetic) | 2.773-1.804 = 0.969; 3.416-1.804 = 1.612. |
| 4c | 2023 SF lidar NAVD88/Geoid18, tested NVA RMSEz 1.73 cm (41 checkpoints) | Partly wrong | [InPort](https://www.fisheries.noaa.gov/inport/item/73386): NAVD88 (Geoid18) metres and tested NVA RMSEz 1.73 cm are correct. The 41 checkpoints are 30 NVA points plus 11 VVA points (Tall Weeds), so the NVA figure rests on 30 points, not 41. |
| 5a | Golden Gate clearance 220 ft (67.1 m) | Confirmed | [Wikipedia](https://en.wikipedia.org/wiki/Golden_Gate_Bridge): 220 ft (67.1 m) at high tide. The tidal datum is not specified. |
| 5b | Bay Bridge west 220 ft, east 190 ft; tunnel decks 16 ft (4.9 m) | Confirmed | [Wikipedia](https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge). |
| 5c | Salesforce 326 m, Transamerica 260 m, 181 Fremont 246.9 m | Confirmed | [Wikipedia SF list](https://en.wikipedia.org/wiki/List_of_tallest_buildings_in_San_Francisco): 326.1 m, 260 m, 246.9 m. Salesforce is 326.1, rounded to 326 in the claim. |
| 5d | Oakland Ordway 123.1 m | Confirmed | [Wikipedia Oakland list](https://en.wikipedia.org/wiki/List_of_tallest_buildings_in_Oakland,_California). |
| 5e | DataSF 3psu-pn9h has no z-level field and no positional-accuracy statement | Confirmed | [Dataset metadata](https://data.sf.gov/api/views/3psu-pn9h): 33 columns, none is elevation or z-level; the description has no positional-accuracy statement. |

Unverified or open: item 2c (72-mark sample) and the ellipsoidal-height wording in 3d. Wikipedia figures are secondary sources and can change; the CTBUH cross-check was not done.

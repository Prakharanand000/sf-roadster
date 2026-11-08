# Bay Area map: resources and plan (MAP side)

Scope: everything the MAP side (tools/, data/, src/world/) needs to take SF Roadster from the
current northern-SF box to a 1:1 Bay Area with lidar-accurate ground, roads, buildings and trees.
Physics stays with the physics owner; items that need their sign-off are marked **[physics]**.

Researched 2026-10-26 by a 27-agent swarm (11 researchers, each fact-checked, a three-design tile-format
panel with a judge, and a completeness critic) plus two lighting agents. "Unconfirmed" means a source was not
verified. **Real-data probes ran on 2026-10-26** (§11, gap 3): lidar classes, decks, a one-tile bake and an OSM
recount are in `research/lidar-probes.md`; the road-surface test is in `research/road-surface-method.md`.

**Decisions so far (2026-10-26):**
- True 1:1 scale, not Watch Dogs 2-style compression.
- Night lighting is a first-class goal.
- Waymo's open data was evaluated and is not usable (licence; §3 "Not usable").

---

## 0. Research index

All files are in `tools/research/`. Each research file ends with a Fact-check section.

| File | What it gives |
|---|---|
| `tile-format-proposal.md` | **The recommended tiled format (SFT1)**, the 15 contract changes for Prakhar, and the ordered migration plan. Start here. |
| `lidar-probes.md` | **Measured on real data**: lidar classes and densities, bridge decks on stacked structures, a one-tile bake benchmark, the OSM recount |
| `road-surface-method.md` | **Measured on real data**: road profile, grade, crown, gutters and curbs from lidar on five SF blocks, against today's terrain |
| `pilot-bake.md` | **In the game**: the Nob Hill + FiDi pilot (lidar ground + measured road ribbons, 4 km²), its gates, AI race comparison, sizes and known limits |
| `lidar-coverage.md` | Which 3DEP EPT/LAZ/DEM product covers which area, classes, sizes, download volumes |
| `building-heights-method.md` | PDAL DSM/DTM pipeline, per-footprint heights, roof classifier, compute estimate, validation protocol |
| `structures.md` | Every bridge, viaduct and tunnel in Phases 1–2 (Caltrans + OSM), tunnel specs, deck extraction recipe |
| `landmarks.md` | 60 hero landmarks with Wikidata coordinates/QIDs, heights, HABS/HAER refs, and code constants that are wrong (§D) |
| `style-kits.md` | 25 procedural building style kits and the rule table that assigns them from assessor/zoning data |
| `osm-completeness.md` | What OSM can and can't be trusted for, per tag, per city |
| `road-markings.md` | CA MUTCD 2026 marking specs and the SFMTA layers that place them |
| `vegetation.md` | 25 SF tree species kits, park/hillside plant communities, seasonal colour, canopy-from-lidar method |
| `street-furniture.md` | 19 prop categories ranked, with datasets, counts, licences, densities |
| `water-shoreline.md` | Tidal datums, bathymetry, shoreline, currents, ferries |
| `validation.md` | Accuracy test spec V1–V8 with tolerances and the oracle/fixture design |
| `night-lighting-data.md` | Real-world light data: streetlights, colours, landmarks, signals |
| `night-lighting-rendering.md` | Current lighting code audit and the recommended night architecture |

---

## 1. Fix these first (current code blocks expansion)

| # | Problem | Where | Effect |
|---|---|---|---|
| 1 | Coordinates are packed as int16 quarter-metres, so the limit is ±8,192 m from Union Square | `tools/bake.py:1137` (`q25`) | Whole SF already overflows: Ocean Beach is ~9.1 km west and the south city line is ~8.8 km south. Oakland is ~12 km and Berkeley ~16 km. Needs tile-local coordinates. |
| 2 | Projection constants are short by 0.41% (N–S) and 0.13% (E–W) | `tools/geo.py:6-7`, CONTRACTS.md | The map is squashed ~40–50 m across SF. Use a local transverse Mercator in float64. Only the contract text changes, since no code outside src/world uses lat/lon. |
| 3 | The whole world loads at once: one bin, one heightfield, one ground canvas, every mesh | `worlddata.js`, `city.js:77-113`, `terrain.js` | ~400 km² comes to ~1 GB of runtime meshes, so it must stream tiles. |
| 4 | Hard cap of 62,000 buildings | `bake.py:700,723` | DataSF alone has 177k footprints. |
| 5 | Bay Bridge and Yerba Buena Island roads are dropped, and tunnels are dropped | `bake.py:263-281` | The East Bay becomes a separate road-graph island and the router ignores it. |
| 6 | Golden Gate is the only bridge deck; viaducts (I-80, US-101, I-280) are flattened onto the ground | `worlddata.js:85,217-240` | Needs a generic stacked-deck primitive. |
| 7 | Tunnels: the "never below terrain" clamp pushes cars out | `vehicle.js:802`, `worlddata.js:245` | **[physics]** Contract change. |
| 8 | Traffic spawns uniformly over all roads, with no spatial index | `traffic.js:200-212` | **[physics]** About 9x fewer successful spawns at 400 km². |
| 9 | Overpass bbox queries will time out at Bay Area size | `fetch_osm.py` | Replace with a Geofabrik PBF plus osmium. The swarm hit this: Overpass was overloaded or unreachable for most agents. |

SFT1 (§5) fixes 1–3 and 5–9. Item 4 is a bake change.

Float32 jitter: today vertices are absolute world coordinates, which is fine out to Oakland and
Berkeley (~2 mm precision) and starts to show past ~50 km. SFT1's per-tile origins remove it.

---

## 2. Decisions needed before the bulk bake

Each of these is baked into every tile, so changing it later means a full rebake.

| # | Decision | Options | Recommendation | Who |
|---|---|---|---|---|
| D1 | **Vertical datum** | (a) y = 0 at MSL: `y = NAVD88 − 0.969 m` (NOAA 9414290, epoch 1983–2001), sea at y = 0. This is in `tile-format-proposal.md` and `validation.md`. (b) y = 0 at NAVD88, water plane at +0.97 m (`water-shoreline.md`). | (a). Physics' water thresholds (`vehicle.js:269`, `y < 0.3`) keep working, and tides are render-only. Record `y0_navd88` in the manifest. | MAP owner + **[physics]** |
| D2 | **Lakes above sea level** (Lake Merced, Stow, Spreckels; Lake Merritt is tidal) | Today `inWater` never triggers there. Add `waterLevelAt(x,z)`, or accept it. | Measure lake surfaces from the 1 m DEM first, then decide | **[physics]** |
| D3 | **Source of truth per layer** | SF buildings: DataSF `ynuv-fyni` (PDDL; joins the assessor roll for style kits) vs OSM/Overture (ODbL). Road geometry: lidar, DataSF centrelines or OSM. | Buildings: DataSF footprints in SF (keeps most of that layer public domain), OSM/Overture elsewhere. Roads: OSM topology, lidar geometry, DataSF centrelines for validation only, so the V7 check isn't circular. | MAP owner |
| D4 | **Licence plan** (the repo is public) | — | Write `tools/research/licence-register.md` (source, licence, obligations, status per layer). Block every source whose licence is "not stated" until confirmed: Oakland `svwc-9r23` and `iqfp-6kz5`, Berkeley zoning, SFMTA colorcurb, SFEI shore inventory, Lyft GBFS, WETA GTFS. Add `data/LICENSE` (ODbL for the OSM-derived database) and an in-game attribution screen. Landmark trademark/likeness (Transamerica, Golden Gate) is unresearched. | MAP owner |
| D5 | **Map "as-of" date and closed roads** | Lidar is 2023 (SF) and 2019/2021 (East Bay); NAIP 2022; DataSF heights 2010; OSM 2026. | OSM as of the bake date. Roads closed to cars are non-drivable with barriers. Verify each: the Upper Great Highway park (2025), car-free JFK Drive, no private cars on Market St (2020), the Treasure Island redevelopment, new towers such as 1900 Broadway. Some tracks may use streets now closed. | MAP owner, tracks with **[physics]** |
| D6 | **Host limits and git history** | Phase 1+2 ≈ 165 MB in ≈ 2,800 files; Phase 3 ≈ 450–500 MB in ≈ 8,000 files (estimates) | Ask the integrator for the sandbox's byte, file-count and file-size limits before sizing tiles. Publish data from an orphan or squashed branch so rebakes don't bloat `main`. If the file count is capped, use 4×4 tile packs. | Integrator / Prakhar |
| D7 | **East Bay lidar per tile** | Alameda `_2` vs `_3`, and SF B23 vs Alameda over the Bay Bridge east span | Build a per-tile density map, then write the choice to `tools/lidar_sources.json`, which the bake reads. Never mix two projects in one tile. **Measured:** the project bboxes overstate coverage; at every sampled spot only one of `_2`/`_3` had points. Test real coverage per tile (EPT hierarchy lookup), not bboxes. | MAP |
| D8 | **Steep-street gate** | `tile-format-proposal.md` §2.7 gates Filbert/22nd at ±0.5 pp of the published 31.5%; `validation.md` treats published grades as advisory | Advisory. The published figures are rounded and we don't know where they were measured. The gate is the lidar profile. | MAP |

---

## 3. Datasets (verified unless noted; fact-check corrections applied)

### Elevation (ground truth for physics)
| Dataset | Covers | Res / year | Access | License |
|---|---|---|---|---|
| 3DEP lidar EPT `CA_SanFrancisco_1_B23` | All of Phase 1, plus edges of Alameda, Marin and San Mateo | April 2023, 13.1 B points. Documented ~44 pts/m²; **measured 121–154 pts/m² all returns, 31–42 ground** over mixed blocks (77 on an open plaza, 21 averaged over a dense Nob Hill tile) (`lidar-probes.md` §1) | `s3://usgs-lidar-public` (anonymous, us-west-2), viewer usgs.entwine.io | Public domain |
| 3DEP EPT `CA_AlamedaCo_2_2021` and `CA_AlamedaCo_3_2021` | **Oakland, Berkeley, Alameda** | QL1 and QL0. **Measured ground density 5–7 pts/m²**, 5–8× below SF. Their bboxes overstate coverage: at the sampled spots `_2` alone covers downtown Oakland and the Maze, and `_3` alone covers the Berkeley campus (D7). | same | Public domain |
| 3DEP EPT `CA_AlamedaCo_1_2021` | **Eastern Alameda County only** (starts at lon −122.187). Not Oakland or Berkeley. | 2021 | same | Public domain |
| 3DEP EPT `CA_ContraCosta_1_2022` | Contra Costa | 2022 | same | Public domain |
| 3DEP EPT `CA_SantaClaraCounty_2020` | South Bay (later phase) | 2020, 170 B points | same | Public domain |
| Marin lidar (south of lat 38.1) | Marin Headlands, Sausalito | No EPT. LAZ tiles only: `CA_NoCAL_3DEP_Supp_Funding_2018_D18` (231 tiles, 13.29 GB) and `ARRA_CA_GOLDENGATE_2010` (90 tiles, 9.14 GB) | TNM API | Public domain |
| USGS 1 m bare-earth DEM (GeoTIFF, UTM 10N, NAVD88). **Used for v2's 8 m ground** (`tools/dem1m_v2.py`); matches the raw SF lidar to a 3 mm median absolute difference (`research/dem1m-check.json`) | SF `CA_SanFrancisco_B23`; Oakland/Berkeley `CA_AlamedaCounty_2021_B21`; `CA_ContraCosta_B22`; Marin edge `CA_NoCAL_Wildfires_B5b_2018` (a DEM product label) | 1 m. Phase 1 is 523 MB (4 cells), Phase 2 1.58 GB, Marin 1.47 GB, Peninsula 3.39 GB | TNM API `tnmaccess.nationalmap.gov/api/v1/products` | Public domain |
| USGS CoNED topobathymetric DEM | Bay floor plus shore | 1/2/3 m by region, NAVD88. Whether a 2 m SF Bay tile exists is unchecked. | USGS EarthExplorer (Digital Elevation) | Public domain |
| USGS 1 m SF Bay bathymetry | Central Bay | ~0.9–1 GB zip per section, NAVD88 | ScienceBase | Public domain |

**Lidar facts that shape the pipeline** (`lidar-coverage.md`, `building-heights-method.md`):
- **Measured** (12 sample boxes in SF B23 and Alameda `_2`/`_3`): only classes 1, 2, 7, 9, 17, 18 and 20 occur. There is **no building class (6) and no vegetation class (3–5)**, so both must be derived. The class 4 in the SF report does not appear in the data.
- **Measured on I-280, the MacArthur Maze and the Bay Bridge approach:** a lower deck gets no returns directly under the deck above. It is seen only where it sticks out past it. Class 17 labels visible deck surfaces on any level, inconsistently, so split decks by Z against OSM `layer`, not by class (`lidar-probes.md` §2, §11 gap 2).
- In Alameda, withheld points include overlap and edge clips, not just noise. Drop withheld points everywhere.
- EPT is stored in EPSG:3857, so its resolution figures are inflated 1.2655× at this latitude.
- Volume: full-density lidar is ~74 GB for Phase 1 and ~64 GB for Phase 2. Thinned to ~4 pts/m² it is ~2–3.5 GB and ~3–6 GB. Crop through EPT rather than downloading whole projects.
  - Measured: one dense 512 m Nob Hill tile is 24 M points, 119 MB LAZ, 35 s to fetch.
- 2023 SF lidar accuracy: NAVD88/GEOID18, tested NVA RMSEz 1.73 cm on 30 checkpoints.

**Water datums** (NOAA CO-OPS, `water-shoreline.md`): at SF (9414290) and Alameda (9414750), MSL sits ~+0.97 m above NAVD88 (Alameda +0.981 m). MLLW is within 2–7 cm of NAVD88. MHHW is +1.80 m (SF) and +1.94 m (Alameda). Predicted Golden Gate currents peak around 3.3 kt.

### Buildings
| Dataset | Notes | License |
|---|---|---|
| DataSF Building Footprints `ynuv-fyni` | 177,023 footprints with lidar height stats (`hgt_median_m`, `peak_1st_m`, `gnd_min_m`, …). The heights are 2010-era, so post-2010 towers (Salesforce Tower, 181 Fremont…) need the 2023 lidar. | PDDL |
| DataSF Assessor roll `wv5m-vpq2` | 211,547 rows (2025): year built, stories, units, use code, zoning. Joins to footprints through `mblr`. Caveats: 33,272 rows have 0 stories; year 1900 appears 14,628 times, which may be a pre-1906/unknown default (unconfirmed); 10,683 have no year. | PDDL |
| DataSF Historic status `3tsw-4idn`, Land Use `c5ge-t6pj` | Landmark flags; retail floor area for shopfronts and window schedules | PDDL / CC0 |
| Overture Maps buildings, release 2026-10-21.0 | Merged OSM, Microsoft and Esri footprints. Has heights for 68% of East Bay buildings, but they are Microsoft ML estimates and none are lidar-sourced. | ODbL |
| Microsoft US Building Footprints | Footprints only, 2012–2020 imagery | ODbL |
| OSM `height` | 86.6% of SF buildings (city polygon; 83.8% over the SF bbox; source unverified, probably an import). Oakland 0.10%, Berkeley 0.04%. `building:levels` SF 2.0%, Oakland 1.0%, Berkeley 4.9%; `roof:shape` 0.1–0.6% (PBF recount 2026-10-26). | ODbL |
| Oakland `iqfp-6kz5` | Partial (10,651), story counts only | Not stated |
| Alameda County assessor characteristics | Year built for the East Bay, but paid and not redistributable | Not usable |

**So for Oakland and Berkeley (and for post-2010 SF) we compute heights and roof shapes ourselves**:
the lidar surface model minus the ground model inside each footprint. `building-heights-method.md` estimates
2–6 hours at 0.5 m for 400 km² (unbenchmarked). East Bay style kits must come from zoning, lidar, Overture/OSM
and census priors, because there's no open year-built source.

### Roads, curbs, markings, signals
| Dataset | ID / link | Use |
|---|---|---|
| OSM Geofabrik `norcal-latest.osm.pbf` | download.geofabrik.de (~624 MB, ODbL) | Road topology, names (90–94%), bridges/tunnels with layer. **Not** width (<0.5%), incline (~0%) or kerbs (crossing ramps only). |
| DataSF Streets (centrelines) | `3psu-pn9h` | Official geometry and CNN ids; validation reference |
| DataSF Curbs and Islands | `emxt-b6yg` | Curb lines and medians. Accuracy, geometry type and live status are unchecked. |
| DataSF Sidewalk Widths / Curb Ramps | `4g86-grxu` / `ch9w-7kih` | Road/sidewalk split; curb cuts |
| DataSF Speed Limits / Stop Signs / Traffic Signals | `3t7b-gebn` / `4542-gpa3` / `ybh5-27n2` (1,507) | Traffic logic and props |
| DataSF Street Signs | `m48z-6ji4` (144k) | Signage props |
| DataSF Pavement Condition Index | `5aye-4rtt` | Surface roughness and wear |
| SFMTA ArcGIS layers | see `road-markings.md` | Green bike lanes, red transit lanes, continental crosswalks, painted safety zones, most coloured curbs. Corner and hydrant red curbs have no data and need rules. |
| CA MUTCD 2026 (ch. 3A, 3H, 9E read) | dot.ca.gov | Marking specs. Chapter 3B (crosswalk/stop-line/arrow sizes) was not read, so those use federal 2009 numbers for now. |
| Caltrans State Highway Bridges + Local Bridges (NBI) | gisdata.dot.ca.gov | 122 bridges in the SF bbox, 222 in Phase 2, 364 in the union; 88 are ≥200 m (tabulated in `structures.md`) |
| Caltrans as-built plans | District 4 request (path unconfirmed) | Lower decks and tunnel interiors |

Oakland, Berkeley and Emeryville have no open curb, sidewalk, speed-limit, signal or stop-sign data (§11, gap 12).

### Road cross-section standards (Caltrans HDM, 2020)
- Lanes are 12 ft (3.66 m); 11 ft is allowed on urban conventional highways at 40 mph or less.
- Normal cross slope is 2% (crowned). Shoulders slope 2–5% away from the road.
- Curbs are 6 in (15 cm), or 8 in at 35 mph or less on request. The gutter is 2 ft (0.6 m) at ~8.33%.
- Superelevation goes up to 10% (12% in rare cases); urban roads use 4–6%.
- Maximum grades: freeway 3/4/6%, urban 6/7/9% (level/rolling/mountainous terrain). Ramps go up to 8%.
- SF streets ignore those limits. Filbert (Hyde–Leavenworth) and 22nd St (Noe–Vicksburg) are 31.5%. Lombard's crooked block has 8 hairpins on a 27% hill, red brick, about 600 ft of road.

### Bridges and tunnels
| Structure | Key numbers | Source |
|---|---|---|
| Golden Gate | Main span 1,280 m; roadway 18.9 m between curbs plus 3 m sidewalks; 67 m clearance (MHHW); towers 227 m above water | GGBHTD stats; HAER CA-31; LoC `ca3663` |
| Bay Bridge west span | Two 704 m suspension spans; towers 160 m (**code uses 150**); 17.5 m deck; upper deck westbound, lower eastbound. Upper-deck elevation along the span is not published (code caps it at 58 m), so take it from lidar. | LoC HAER `ca1352`: ~400 drawing copies |
| Yerba Buena tunnel | 165 m long, 23 m wide, 17.7 m high, two decks | Wikipedia + Caltrans |
| Bay Bridge east span (SAS) | Main span ~385 m; tower 160 m; approach grade ~1.7% | Wikipedia |
| SF vehicle tunnels | About 25 real tunnel ways: Broadway, Stockton, Presidio Parkway (Battery/Main Post; sources disagree on lanes), Fort Mason and others | `structures.md` |
| East Bay | Posey and Webster immersed tubes, Caldecott (bore 4 ~1,033 m), MacArthur Maze (3 levels), SR-24/I-980/I-580 (4 levels) | `structures.md`; interiors unsourced |

Deck profiles come from lidar class 17 along each OSM `bridge=yes` way; the numbers above are the
cross-check. `landmarks.md` §D lists more code constants that disagree with sources: Transamerica base 44 m (real ~53 m), City Hall
125×90 m (real 119×83 m), and the dome radius, deck width, upper-deck cap and Oracle Park ring.

### Trees and foliage
| Dataset | Rows | License |
|---|---|---|
| SF Street Tree Inventory `tkzw-k3nq` | 144,522 (species, DBH, plot size) | PDDL |
| Oakland Trees Along Sidewalks `svwc-9r23` | 42,666 (species, trunk diameter) | Not stated (D4) |
| Oakland Street Trees `4jcx-enxf` (2015) | 38,613 | CC0 |
| Berkeley City Trees 2013 (UC Berkeley GeoData) | Count unconfirmed | Unconfirmed |
| Lidar canopy height model | Parks, Presidio, GG Park, East Bay hills | Public domain |
| Annual NLCD (30 m, through 2024) / ESA WorldCover v200 (10 m) | Land cover | Public domain / CC BY 4.0 |

`vegetation.md` has 25 SF species kits (height, crown, shape, colour, bark, season) and the park and hillside plant communities.
There is no vegetation class in the lidar, so the canopy model is first returns minus DTM, masked by footprints.
Many kit heights are unconfirmed (SelecTree pages are JS-rendered and couldn't be read).

### Street furniture (`street-furniture.md`)
- **DataSF (PDDL, per-object points):**
  - parking meters 38,775
  - Muni stops 3,260 (991 with shelters)
  - trash cans 1,978
  - bike racks 6,035
  - Rec&Park assets (benches, lamps, hydrants in parks)
  - civic art and murals
- **No open data:** streetlights, utility poles, hydrants, newsracks, billboards. Use OSM, lidar pole detection and rules.
- **Oakland:** meters and bike parking only. **Berkeley:** nothing.
- **Bay Wheels:** 648 stations; licence unconfirmed.

### Landmarks and style
- `landmarks.md`: 60 hero landmarks (30 SF, 21 Bay Bridge/YBI/Oakland/Berkeley/Emeryville, 9 Marin/Alameda/bridges)
  with Wikidata coordinates and QIDs. HABS/HAER drawings on loc.gov are public domain. Wikimedia Commons files
  need a per-file licence check; CC BY-SA files can't ship.
- `style-kits.md`: 25 kits (Victorian family, Edwardian, Marina, Sunset stucco, deco/FiDi/supertall, SoMa lofts,
  Chinatown, Mission, Oakland, Berkeley, Emeryville) with a priority-ordered assignment table.

### Imagery and visual reference
- **NAIP 0.6 m, 4-band, 2022** via the Microsoft Planetary Computer STAC. Public domain, so it can be baked into ground and roof colour.
- Mapillary (CC BY-SA) for street-level reference.
- Google Street View and Maps: eyeballing only. Nothing may be traced or extracted.

### Ambient life ("animated city")
- BART GTFS: bart.gov/dev/schedules/google_transit.zip. No key needed.
- 511.org regional GTFS: **needs a free API key**, used at bake time only and never committed.
- WETA ferry GTFS: public, listed as ODC-BY (unconfirmed at source).
- Cable car and Muni rail lines come from OSM.
  - Cable car track is `railway=tram gauge=1067 electrified=no`: 78 ways, 15.2 km.
  - The three lines are SFMTA `route=tram` relations: Powell/Hyde 1959009/3433158, Powell/Mason 1959010/3433157, California 2852264/2852265.
  - Muni streetcars are `gauge=1435 electrified=contact_line`. There are no `railway=cable_car` ways (PBF recount 2026-10-26).

### Validation (`validation.md`)
- Spec V1–V8: steep streets, NGS survey marks (NDE API), lidar RMS, comma2k19 highway grades, top-30 SF and top-10
  Oakland building heights, bridge/tunnel clearances (≥4.3 m), DataSF centreline offsets, projection vs WGS84 geodesics.
- Two layers: a Python oracle writes small fixtures, and `node tools/test_world.mjs --accuracy` asserts against shipped data.
- Tolerances marked PROPOSED get calibrated on the first real bake, then frozen.

### Watch Dogs 2 reference
- Art director Sidonie Weber (Vice): 2+ years of reference trips, 33 districts, 36 architectural styles, 50 modelling kits, a 200+ landmark wishlist.
- Game director Danny Bélanger: "it's not 1:1. You have to make choices."
- Lessons to copy: district style kits, hand-modelled hero landmarks, designed vistas, cheap repeating ambient life.
- Where we differ: true 1:1, so longer distances and lower density per screen.

### Not usable (licence)
- Google Photorealistic 3D Tiles: the terms forbid caching, offline use and deriving geometry.
- Cesium OSM Buildings: no offline licence on the community plan.
- osmbuildings.org: non-commercial only, no bulk download.
- The commercial LoD2 downtown model (Precision Light Works).
- **Waymo Open Dataset:**
  - non-commercial only;
  - redistribution is limited to registered users, which rules out a public repo;
  - derived geometry stays bound by the terms;
  - map vectors have no lat/lon.
  - Private visual reference only, unless Waymo grants written permission.
- Argoverse 2 (CC BY-NC-SA), nuPlan (non-commercial). The Lyft Level 5 licence is unverified.
- Alameda County assessor characteristics (paid, no redistribution).

### Usable driving data
- **comma2k19** (MIT): real cars on I-280 from San Jose to SF, with poses, GNSS, IMU and CAN.
  - Torrent only, in 8.7–9.9 GB chunks. Nothing downloaded yet.
  - How much of it falls inside Phases 1–2 is unknown until the segment positions are scanned.

### Licence obligations
- OSM, Overture and Microsoft data are ODbL: attribution plus share-alike on the derived database.
- ESA WorldCover is CC BY. USGS, NAIP, NOAA and HAER are US government works. DataSF is PDDL (one CC0 set).
- Add every source to `ATTRIBUTION` in `src/world/city.js` and the README. See D4 for the plan still to write.

---

## 4. Night lighting

Full detail: `night-lighting-data.md` (what's real) and `night-lighting-rendering.md` (how to draw it).

**Data:**
- **No open streetlight inventory exists for SF, Oakland or Berkeley.** SF has ~43–45k lights and OSM has ~4% of them (1,801 in the SF bbox; Oakland bbox 886, Berkeley 91; PBF recount 2026-10-26).
  - Plan: generate lamps along road centrelines (~30–40 m spacing, unconfirmed) with the OSM lamps as anchors.
  - Upgrade path: detect poles in the 2023 lidar (not researched).
- **Colours:** SF LEDs ~3000K. Oakland probably 4000K (unconfirmed). Berkeley a 3000K/4000K mix. The Golden Gate roadway is amber sodium.
- **The Bay Lights 360** relaunched 2026-03-20: ~48,000 white LEDs on the north cable plane of the west span, dusk to dawn.
- **Salesforce crown, City Hall and Lake Merritt** are sourced. Coit, Transamerica, the Ferry Building and the other landmarks are still unconfirmed.
- **Signals:** SF has 1,507 (`ybh5-27n2`). Oakland and Berkeley have none found.
- **Window schedules:** drive them from Land Use `us3s-fp9q`/`fdfd-xptc`.

**Rendering:**
- r160 is forward-rendered, and changing the light count recompiles every shader. So:
  - a camera-following baked **light field** texture lights the ground;
  - instanced **glow quads** per tile;
  - a fixed pool of **6 PointLights** moved to the nearest lamps;
  - a **window schedule** shader driven by use class and hour;
  - neon and LED pattern shaders;
  - **wet-road** reflections that sample the light field.
- Bloom and tone mapping stay with the integrator (`env.js`).
- **Budget:** ~130 extra draw calls and ~30 MB of textures. Bake data is ~8.5 KB/km².
- The lighting team adds `LAMP`/`SIGN`/`SIGH` sections to SFT1 `r` tiles without a format version bump.

---

## 5. Tile format: SFT1 (recommended)

Full spec: `tile-format-proposal.md`. Three designs were scored out of 25: min-disruption 19, streaming-perf 16, accuracy-first 13.
The judge chose min-disruption as the base and grafted in the best parts of the other two.

- **Projection:** local transverse Mercator on NAD83(2011), float64, origin Union Square. The runtime never projects.
- **Datum:** see D1.
- **Levels:**
  - L0 is 512 m tiles split into a `q` file (everything physics reads) and an `r` file (visuals).
  - L1 is 2,048 m; it is also the collision fallback.
  - L2 is 8,192 m and always resident.
  - A global `net` file holds every bridge, viaduct, ramp and tunnel and never streams out, so the Golden Gate special case goes away.
- **Ground:** a 2 m lidar height grid plus road and sidewalk ribbons fitted to lidar (crown, superelevation, curbs with a 25 cm bevel). No L0 tiles over open water.
- **Packing:**
  - tile-local int16 at 1/32 m;
  - a global-lattice seam rule, so shared vertices decode identically in both tiles;
  - uint16 cm heights over a per-tile base;
  - per-section gzip; unknown sections are skipped;
  - hashed immutable file names.
- **Rendering:** CDLOD terrain on the same height arrays physics reads, HLOD buildings, explicit draw-call/triangle/memory budgets.
- **Size (estimate):** ~165 MB in ~2,800 files for Phases 1+2. The pilot bake replaces this with real numbers.
  - **Measured on one Nob Hill tile:** the height grid alone is 63.7 KB compressed (243 KB/km²). That is nearly the whole 250–300 KB/km² estimated for all `q` sections, so `q` will run larger on hilly urban tiles.
  - Raw height-grid size matched the estimate (134 KB per tile).

---

## 6. Contract changes for Prakhar **[physics]**

Not yet raised with him; a ready-to-send draft is `tools/contract-changes-draft.md` with the `CONTRACTS.md` diff in `tools/contracts-sft1.patch`. All physics edits are feature-detected, so either side can merge first; about 10 lines on his side in total.
Detail and exact edits: `tile-format-proposal.md` §3.

| # | Change | His edit |
|---|---|---|
| 1–2 | Projection text → transverse Mercator; vertical datum text (D1) | none |
| 3 | `surfaceHeight`/`normalAt`/`surfaceAt` cover any number of stacked decks, viaducts, ramps and tunnel floors | none |
| 4–5 | `heightAt` is bare earth, not a valid floor in tunnels; new `floorHeight(x,z)` | 1 line at `vehicle.js:802` |
| 6 | `groundHeight(x,z,yRef)` so AI doesn't read decks above it | ~4 lines in `ai.js` (:82, :123) |
| 7 | Road points become `[x,z,y]` plus `level` | `traffic.js` `placeCar` y seed; skip endpoint links >2 m apart in y |
| 8 | Tracks, checkpoints, grid and spawn gain y | none |
| 9 | New `roadsNear(x,z,r,out)` spatial index | `traffic.js` `_spawn` |
| 10 | Optional `ceilingHeight(x,z,y)` | optional |
| 11 | `collideCircle` also hits pillars, parapets, barriers and tunnel walls, and writes `out.top` | none (optional use at :886) |
| 12 | `surfaceAt` adds `'brick'` and `'dirt'` | none (fallbacks exist) |
| 13 | Streaming guarantee: queries stay synchronous, never throw or return NaN | none |
| 14 | Integrator-only: `ensure`/`isLoaded`, camera clamp, gate y, reset y | integrator |
| 15 | `deckAt`, `roadAt`, `createWorldData` are kept | none |
| L1 | `env` becomes `{night, time, hour, fogDensity, wetness}` | integrator |
| L2 | `world.signalPhase(intId, t)`: one pure function drives the signal lamps and traffic AI | traffic AI, optional |
| L3 | `world.lightField`, `world.skyGlow` | integrator |

**Physics questions the 1:1 data raises** (critic, gap 5). Each has a proposed default:
- **Pitched roofs:** drivable with their real normal. Today `vehicle.js:618` forces normals with n.y < 0.75 to straight up.
- **Props:** street trees, poles, meters and shelters are breakable thin solids within 300 m.
- **Speed humps, embedded rails and bascule bridges:** humps and rails are ribbon profile bumps; bascule bridges are static.
- **Nob Hill crests:** real 1:1 crests with the ~1.4× gravity decide whether cars launch. Prakhar drives the pilot and says.

---

## 7. Tools

- **Miniforge** `bake` env from conda-forge, spec in `tools/environment.yml` (tested 2026-10-26 with PDAL 2.10.2 and osmium-tool 1.19.1).
  - **Windows Smart App Control** blocks parts of conda-forge's Python (`unicodedata`, `_socket`) and the pyosmium wheel. On machines with it on:
    - run PDAL and osmium as **command-line tools** from the env;
    - do the Python side in a python.org Python venv with `numpy scipy matplotlib pillow pyproj laspy[lazrs]`.
    - `tools/probes/common.py` is written that way. Don't turn the policy off for this.
  - Lidar and OSM caches live outside the repo (`~/Downloads/sf-roadster-bakecache`), so nothing large gets committed.
- **Pilot bake:** `python tools/bake_pilot.py` (venv + the `bake` env's PDAL), then `node tools/test_pilot.mjs`.
  - `tools/pilot_shim/` runs any Node world test with the pilot loaded, without editing the test.
- **QGIS** for inspecting layers; **CloudCompare** (optional) for point clouds.
- **Blender**: for **hand-modelled** hero landmarks and the structures no dataset covers (lower decks, tunnel interiors; §11 gap 2), exported as glTF.
  - Not for importing the city: Blender-OSM/blosm extrudes OSM footprints to default heights (OSM has heights for about 0.1% of East Bay buildings) and drapes flat roads on ~30 m terrain.
  - Its output still carries ODbL data.
- In-game: three r160 already ships BatchedMesh, KTX2Loader + basis, the meshopt decoder and CSM. No new libraries; vendor the decoders locally.
- **Disk:** budget ~100 GB (208 GB free). Crop lidar through EPT rather than downloading whole projects.

---

## 8. Size budget

| Area | Baked raw / gzip |
|---|---|
| Today, 85 km² grid | 5.9 / 3.4 MB |
| ~400 km² of land, current format | ~50 / 28 MB |
| Phases 1+2 in SFT1 (lidar grid, ribbons, `r` content) | ~165 MB on host, ~2,800 files (estimate) |
| Measured: `HGT` section of one Nob Hill `q` tile | 134 KB raw / 63.7 KB gzip with the planar predictor (`lidar-probes.md` §3) |
| Measured: pilot overlay, 4.03 km² (2 m ground + 81 km of ribbons) | 3.66 MB raw / 2.17 MB gzip = 537 KB/km² (plain gzip; about 400 KB/km² with the grid predictor) |
| Phase 3 in SFT1 | ~450–500 MB, ~8,000 files (estimate; see D6) |

---

## 9. Plan

**Phase 0: foundation** (`tile-format-proposal.md` §4, steps 1–6)
1. Confirm host limits (D6).
2. Contract PR with Prakhar (§6). The MAP side first ships the additive members on today's single bin.
3. Swap the projection and datum in `geo.py`, then rebake today's area.
4. Tiled writer plus `src/world/tiles.js` in eager mode. Parity test against the old bin on 10⁶ random points, every track path and 10⁵ tile-border points.
5. **Pilot bake: Nob Hill + FiDi (~4 km²).** Measure gzip/km², decode ms per tile and fps. Run the gates.
   - **Done 2026-10-26, ahead of steps 1–4**, as an optional overlay on today's single bin (`tools/bake_pilot.py`, `src/world/pilot.js`, `pilot-bake.md`).
   - 16/16 pilot gates; existing world and physics tests pass; Prakhar's AI race finishes all three tracks through the box with 0 resets.
   - 537 KB/km² gzip (ground + ribbons). fps not yet measured in a visible window.
   - Re-bake it after step 3 (projection/datum).
6. Streaming on: workers, LRU, fallback chain, corridor pinning, CDLOD.

**Status 2026-10-26: the v2 world is built** (`research/v2-build-plan.md` has the log). Steps 3, 4 and 6
are done as a separate world behind `?world=v2` rather than a rebake of v1: `tools/geo2.py` (projection
and datum), `tools/bake_v2.py` (net + 512 m tiles for all of SF, YBI/TI, Oakland, Emeryville and
Berkeley), `src/world/v2/` (streaming). Phase 2's Bay Bridge (both spans, side by side) and the YBI
tunnel are in, drivable on a seventh track. The pilot is re-baked for v2 (`tools/bake_pilot_v2.py`).
Building heights come from lidar wherever OSM has none (`tools/lidar_heights_v2.py`). Since 2026-10-27
the 8 m ground under the whole map is lidar too (USGS's 1 m DEM, `tools/dem1m_v2.py`; M8 in the build
log). Still open: the 2 m ground and measured ribbons beyond the pilot box (`research/lidar-tiles-plan.md`;
all of SF is baked and staged, not switched: `research/lidar-tiles-runtime.md`, All of SF),
the elevated SF freeways (still draped), true stacked decks (contract change), fps in a visible window.

To try it: `python tools/serve_nocache.py 8174 .`, then http://localhost:8174/?world=v2 (the game) or
http://localhost:8174/dev/world-test.html?world=v2 (free camera). Without the flag both load today's
world. Tests: `node tools/test_world_v2.mjs`, `node tools/test_parity_v2.mjs`; the AI on v2:
`node --import ./tools/v2_shim/register.mjs dev/physics-ai-sf.mjs all`. To re-bake: `tools/dem1m_v2.py`
(once; the 1 m lidar DEM, 3.8 GB), `tools/bake_v2.py` (it pins decks to the existing lidar patches),
then `tools/bake_lidar_tiles.py` (the lidar tile patches and the buildings' lidar ground; patches are
fingerprinted to the net's roads), then optionally `tools/bake_pilot_v2.py` (the old pilot, used only
without data/v2/lidar/). Lidar patch gates: `node --expose-gc tools/test_lidar_v2.mjs`.

**Phase 1: all of SF**
- Uncapped buildings with a lidar height refresh.
- Structures in `net`: Central Freeway, I-80, US-101, I-280, the Bay Bridge west approach.
- Tunnels behind `features.tunnels`, switched on after Prakhar's `floorHeight` edit lands.
- Street trees, canopy, markings and street furniture.
- Night lighting sections.
- Validation V1–V8.

**Phase 2:** both Bay Bridge decks, the YBI tunnel, Treasure Island, Oakland, Emeryville and Berkeley. More tiles plus `net` additions; no format change.

**Phase 3:**
- Marin Headlands and Sausalito (LAZ only); Alameda.
- The Richmond–San Rafael and San Mateo bridges.
- Peninsula and South Bay as low-detail scenery.

---

## 10. Errata (fact-check results)

The fact-checkers marked these research claims wrong. Corrections are applied above and in the research files.

| Claim | Correction |
|---|---|
| Oakland/Berkeley lidar is `CA_AlamedaCo_1_2021` (was in this file and two research notes) | That project starts at lon −122.187. Use Alameda `_2`/`_3`. |
| Marin LAZ is `CA_NoCal_Wildfires_B5b_QL1_2018`, 166 tiles, 12.9 GB | It's `CA_NoCAL_3DEP_Supp_Funding_2018_D18`, 231 tiles, 13.29 GB. B5b is a DEM label. |
| CoNED is only available in viewers, with no stated datum | Downloadable via EarthExplorer; NAVD88 |
| SF lidar NVA 1.73 cm on 41 checkpoints | 30 NVA points (plus 11 VVA) |
| Assessor `number_of_stories` is populated on every row | 33,272 rows are 0 |
| After 1900, the next most common year built is 1925 | Next is null (10,683), then 1925 |
| Many tree species have a placeholder `mapdbh` max of 100 | Only 65 rows are 100; species maxima go above it |
| Presidio forest planted from 1883; blue gum, cypress, pine and redwood | Planting began 1886. Five species make up 90%, including blackwood acacia. |
| Bay Lights are off (`landmarks.md`) | Relaunched 2026-03-20 as Bay Lights 360 |
| Canopy model from lidar classes 3/4/5 | Those classes don't exist in these projects; use first returns minus DTM |
| SF B23 is ~44 pts/m² | **Measured** 121–154 all returns, 31–42 ground (`lidar-probes.md` §1). The 44 is probably single-pass nominal. |
| SF B23 may have class 4 (project report) | **Measured**: no class 3–6 in any of 12 sample boxes |
| Class 17 covers only the top deck | **Measured**: it also labels visible lower-deck edges, inconsistently; lower decks get no returns under the deck above |
| Alameda `_2`/`_3` overlap over Oakland/Berkeley, so pick per tile | **Measured**: at the sampled spots only one has points (downtown Oakland and the Maze `_2`, Berkeley campus `_3`) |
| `q` tiles ~250–300 KB/km² compressed, all sections | **Measured**: the height grid alone is 243 KB/km² on Nob Hill |
| OSM street lamps: SF 1,445–1,451 (~3%), Oakland 956, Berkeley 105 | **PBF recount**: 1,801 (~4%), 886, 91 over the same bboxes; the old query was partial |
| SF cable car tagging unresolved | `railway=tram gauge=1067 electrified=no`, 78 ways; SFMTA `route=tram` relations |
| ~165 `building_passage` roads | **PBF recount**: 177 highway ways in the SF bbox (173 in the city polygon) |

---

## 11. Open gaps (completeness critic) → next round

| # | Gap | Proposed task | Owner |
|---|---|---|---|
| 1 | **Road surface from lidar.** Partly closed 2026-10-26: `road-surface-method.md` measured five SF blocks, and the pilot (`pilot-bake.md`) applies it to 81 km of roads. Grades match the published ones, crown/gutter/curbs were found on straight blocks, and parked cars left no holes. | Remaining: East Bay density (5–7 ground pts/m²), junctions, superelevation, hairpins (2D curb breaklines), check against DataSF curbs `emxt-b6yg` | agent |
| 2 | **Hidden levels have no source**: the I-280 double deck, 280/101, the MacArthur Maze, the SR-24/I-980 stack, and the interiors of Broadway, Stockton, Presidio Parkway, Posey/Webster. **Measured:** no returns under upper decks; the visible edges give lower-deck height and outer width (`lidar-probes.md` §2). | Per-structure source table: HAER search, Caltrans as-built request, interpolation between visible edges, hand modelling in Blender | agent + a Caltrans request by the MAP owner |
| 3 | **Done 2026-10-26**: class histograms, class-17 crops, a one-tile benchmark and the OSM recount (`lidar-probes.md`). Not measured: fps in the game; that needs the pilot bake. | — | done |
| 4 | Contract changes not raised with Prakhar. **Draft ready 2026-10-26** (not sent): `tools/contract-changes-draft.md` plus `tools/contracts-sft1.patch` (exact CONTRACTS.md diff, checked to apply cleanly). | Send it; agree decisions A-D in the draft | MAP owner to send |
| 5 | Physics questions from 1:1 data | §6 list → Prakhar; research SFMTA hump profiles and the FRA rail-crossing inventory | agent + Prakhar |
| 6 | Vertical datum unresolved | D1 | MAP owner + Prakhar |
| 7 | Errata and per-tile lidar source | Errata done (§10). Lidar choice: D7 | agent |
| 8 | Source of truth and licence plan | D3, D4 | MAP owner |
| 9 | As-of date and closures | D5 | MAP owner |
| 10 | Host limits and git history | D6 | integrator |
| 11 | **No art pipeline**: facade grammar, CC0 or procedural materials, landmark workflow, ground materials, trademark-free signage | `art-pipeline.md`, prototyping `sf_edwardian_flat` end to end | agent |
| 12 | **Roadside solids**: guardrails, K-rail, parapets, retaining walls, stairways, cliffs, piers. 177 `building_passage` highway ways (SF bbox) would be blocked by footprint solids. OSM barriers are counted (`probes/osm_recount.json`): SF has 568 retaining-wall ways (32 km) but only 20 guard-rail ways (2.9 km), so guard rails need lidar or rules. | Specify lidar wall/rail detection; cut passages out of solids | agent |
| 13 | **No horizon beyond the playable area**: Marin, Tam, Angel Island, the Oakland skyline, Diablo | A ~60 km horizon ring from the 10 m DEM plus coarse Overture massing and a night skyglow mask | agent |
| 14 | East Bay attribute data missing (curbs, signals, speed limits, centrelines, year built) | Search the Alameda/Oakland/Berkeley ArcGIS hubs; record a substitute for each SF dataset | agent |
| 15 | Rail and transit structures: BART aerials and columns, Muni/Central Subway portals, cable car slots, street-running rails on Oakland's Embarcadero, Port cranes | Rail ways are counted from the PBF (`probes/osm_recount.json`); join BART/Caltrans structures and add them to `structures.md` | agent |
| 16 | Landmark night lighting (Coit, Transamerica, Ferry Building, Castro, Chinatown neon, Sather Tower…) | Targeted lighting pass | agent |

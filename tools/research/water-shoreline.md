## Water, shoreline and tide truth (researched 2026-10-26)

Legend: CONFIRMED = read directly from the cited page or API this session. UNCONFIRMED = secondary source, inference, or my own calculation.

---

### A. Vertical datums

Source (CONFIRMED, live NOAA metadata API, epoch 1983-2001, metres above Station Datum "STND"):
- SF 9414290 (37.806305, -122.46589, Fort Point / Presidio): https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290/datums.json?units=metric
- Alameda 9414750 (37.771954, -122.30026): https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414750/datums.json?units=metric

Raw values (m above STND) and the same values re-expressed relative to NAVD88 (value minus the station's NAVD88 entry; the subtraction is mine):

| Datum | SF raw | SF vs NAVD88 | Alameda raw | Alameda vs NAVD88 |
|---|---|---|---|---|
| MHHW | 3.602 | +1.798 | 3.027 | +1.941 |
| MHW | 3.416 | +1.612 | 2.838 | +1.752 |
| MTL | 2.792 | +0.988 | 2.099 | +1.013 |
| **MSL** | 2.773 | **+0.969** | 2.067 | **+0.981** |
| DTL | 2.712 | +0.908 | 2.022 | +0.936 |
| MLW | 2.168 | +0.364 | 1.361 | +0.275 |
| MLLW | 1.822 | +0.018 | 1.016 | -0.070 |
| NAVD88 | 1.804 | 0 | 1.086 | 0 |
| Great diurnal range (GT) | 1.78 | | 2.01 | |

Facts that matter:
- MLLW is essentially NAVD88 in SF (+1.8 cm) and 7 cm below it in Alameda. MSL is about +0.97 m above NAVD88 at both stations (0.969 vs 0.981, 1.2 cm apart). So one Bay-wide constant works for MSL.
- Tidal range: MLLW to MHHW is 1.78 m at SF and 2.01 m at Alameda (GT). The range grows into the South Bay, and Alameda is ~0.2 m larger than the Golden Gate.
- Epoch caveat: these are the 1983-2001 epoch. Sea level has risen since, so today's actual mean water is slightly higher. NOAA also publishes a superseded-epoch endpoint (`supersededdatums.json`, link exposed on https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290.json). The current-epoch values for 2026 are UNCONFIRMED.
- Do not confuse tidal datums with NAVD88: NOAA states tidal datums are local and not interchangeable with the fixed NAVD88 (https://tidesandcurrents.noaa.gov/benchmarks/9414767.html, Oakland Airport benchmark sheet).
- Lidar and DEM datum status: the 3DEP 1 m DEMs and the USGS 1 m Bay bathymetry DEMs are published in NAVD88 (Central Bay NAVD88 item: https://www.sciencebase.gov/catalog/item/607df15ad34e8564d67e3ae9). The USGS CoNED 2 m page does not state its datum (https://www.usgs.gov/core-science-systems/eros/coned/science/topobathymetric-elevation-model-san-francisco-bay-area), but the USGS EROS CoNED archive page states the vertical datum is NAVD88 (https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-coastal-national-elevation-database-coned) (corrected 2026-10-26). NOAA's SF Bay 1/3 arc-second DEM is explicitly NAVD88 (https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ngdc.mgg.dem%3A741).

**Recommendation (my judgement):**
1. Keep y=0 on NAVD88 for all terrain. Do not shift the DEM. Every USGS/NOAA product above is already NAVD88, so no per-tile offsets are needed.
2. Put the default (static) water surface at **y = +0.97 m (MSL)**, not y=0. A water plane at y=0 sits about 1 m below mean water and would expose mudflat and put every dock and pier edge ~1 m too high out of the water.
3. Optional tide animation: oscillate the surface between about +0.02 m (MLLW) and +1.80 m (MHHW) at SF; use +1.94 m max near Alameda/East Bay if you want a per-region range. Driving it from a real harmonic constituent set is possible via NOAA `harcon.json` (link exposed on the station metadata page above).
4. Shoreline pixel caveat (UNCONFIRMED): lidar over water is usually hydro-flattened to the water level on the day of the flight, which is not necessarily MSL. Check the lidar breakline/classification for 3DEP `CA_SanFrancisco_1_B23` before relying on a single constant for all lake and bay shoreline cells.

---

### B. Shoreline and edge sources

| Source | What it gives | Access and licence | Verdict |
|---|---|---|---|
| USGS CoNED SF Bay topobathymetric DEM | 2 m seamless land+bay-floor, 42 datasets 1922-2010 (older than 3DEP 2021/2023 lidar) | Downloadable via USGS EarthExplorer (Digital Elevation category), vertical datum NAVD88 (whether a 2 m SF Bay tile exists there is unchecked) (corrected 2026-10-26); also viewers: https://topotools.cr.usgs.gov/topobathy_viewer/ and https://apps.nationalmap.gov/viewer/ (CONFIRMED on https://www.usgs.gov/special-topics/coastal-national-elevation-database-applications-project/science/topobathymetric-0). No direct file URL found; a TNM API query with `q=topobathymetric` returned 0 products (https://tnmaccess.nationalmap.gov/api/v1/products?bbox=-122.53,37.70,-122.35,37.84&q=topobathymetric). Licence: USGS public domain (general; per-item page states none). | Land side is superseded by 2021/2023 lidar; use only as a fallback for tidal flats. **Exact download URL: UNCONFIRMED**, open question below. |
| USGS 1 m Bay bathymetry DEM v2.0 (Fregoso, Jaffe, Foxgrover 2021), DOI https://doi.org/10.5066/P9TJTS8M | Bay floor 1999-2020, split North/Central/South, MLLW and NAVD88 versions | ScienceBase. Central NAVD88: `CentralSFBay_DEM_Mosaic_NAVD88_1M.zip`, 962,525,101 bytes, https://sciencebase.usgs.gov/manager/download/ckpw4pf9300000o814cap8910 (CONFIRMED, https://www.sciencebase.gov/catalog/item/607df15ad34e8564d67e3ae9). Central MLLW zip is 919.85 MB (https://www.sciencebase.gov/catalog/item/606b73efd34e3d0429b204d3). Child IDs: North NAVD88 `5e1cb737e4b0ecf25c5f0bf6`, North MLLW `5e16baa2e4b0ecf25c57fc3a`, South MLLW `607df116d34e8564d67e3ae6`, South NAVD88 `607df17bd34e8564d67e3af0` or `...ae0` (the parent page lists both spellings; verify) (https://sciencebase.gov/catalog/item/5e0592d6e4b0b207aa094f2a). Item pages state no licence, only "not for navigation"; USGS data are normally public domain (licence text UNCONFIRMED). | Best bathymetry. **Each zip is ~0.9-1 GB, over the ~20 MB download limit for this research pass, so not fetched.** Needs a deliberate, approved download or a windowed read. |
| NOAA NCEI SF Bay 1/3 arc-second (~10 m) NAVD88 coastal DEM, 2010 | 10 m, covers -123.30..-121.85 E, 37.32..38.48 N, data 1922-2009 | NetCDF https://www.ngdc.noaa.gov/thredds/fileServer/regional/san_francisco_13_navd88_2010.nc ; subsetting at https://www.ngdc.noaa.gov/thredds/ncss/regional/san_francisco_13_navd88_2010.nc/dataset.html (CONFIRMED on the NCEI landing page). Not copyrighted (US government). | Good coarse fallback and a subset-able sanity check; the NCSS subset avoids a full download. |
| SFEI SF Bay Shore Inventory (2014-2016, updated 2020 variant) | Shore features within +10 ft of MHHW across 9 counties; attributes include elevation, FEMA accreditation, armoring type, wetland/beach fronting, ownership | https://www.sfei.org/data/sf-bay-shore-inventory-gis-data (my fetch returned HTTP 403, so the page is UNREAD). Search snippets say File Geodatabase and KMZ. Licence is listed as LGPL-3.0 by a secondary catalog (https://data.wrmp.org/catalog/San_Francisco_Bay_Shore_Inventory): UNCONFIRMED and a software licence on data, so **get written clarification from SFEI before shipping derivatives.** | Best source for seawall/riprap/pier edge classification and crest elevations; licence uncertain. |
| OSM `natural=coastline`, `man_made=pier`, `waterway=dock`, `leisure=marina` | Topology, labels, ferries | ODbL (Geofabrik PBF already in plan) | Use for classification; geometry accuracy is sub-lidar. |
| Overpass sample: `route=ferry` in 37.60..38.00, -122.60..-122.10 | 24 ways + 30 relations (count only) | https://overpass-api.de/api/interpreter (one `out count` query) | Ferry lines exist in OSM; not inspected for quality. |
| Port of SF pier footprints | A search for a Port or DataSF pier-footprint dataset found none (only a 2001 jurisdiction boundary shapefile and permits) | UNCONFIRMED, no source found | Derive pier footprints from OSM + DataSF Building Footprints `ynuv-fyni` + lidar decks. |

Embarcadero seawall height: **no published NAVD88 crest elevation found.** Secondary reporting says the seawall sits roughly 5 ft above average high tide and portions may need raising by up to 7 ft (SF Chronicle summary via https://planetizen.com/node/115308 and https://projects.sfchronicle.com/2016/sea-level-rise/part2), and the Port says 2 ft of rise has major consequences while 3 ft puts daily high tide onto the northbound Embarcadero (Port presentation shown in search results). The Port's engineering PDF (https://www.sfport.com/media/6775/download) exceeded the 10 MB fetch limit and was not read. **Recommendation: take the crest from the 2023 lidar DEM and cross-check it against MHHW +1.80 m (NAVD88) from section A.**

Lakes (levels not published in anything I found):
- Lake Merritt is a tidal estuary regulated by four tide gates, per a local expert (https://abc7news.com/post/heres-oaklands-iconic-lake-merritt-flooded-week-how-considered-tidal-estuary-expert/19793398/). No managed-level number found. UNCONFIRMED; derive from the 2021 Alameda lidar water surface. Reasonable bound: it responds to the Alameda 9414750 tides when gates are open.
- Stow Lake: constructed 1893 (https://en.wikipedia.org/wiki/Strawberry_Hill_(San_Francisco)); Strawberry Hill is 404 ft (123 m) NAVD88 on Wikipedia. Lake surface elevation UNCONFIRMED; Spreckels Lake not found. Derive both from the 3DEP lidar (lakes are normally hydro-flattened in the DEM).

---

### C. Ferry routes and terminals

- **SF Bay Ferry (WETA) GTFS**: producer URL https://gtfs.sanfranciscobayferry.com/gtfs.zip, 7 routes, service dates Oct 1 to Nov 1, 2026, last updated Oct 24, 2026 (CONFIRMED on https://mobilitydatabase.org/feeds/gtfs/mdb-3143).
- **Licence**: the Mobility Database entry links the Open Data Commons Attribution licence (https://opendatacommons.org/licenses/by/summary/). That is the aggregator's metadata; I did not find the terms on the agency's own site (https://www.sfbayferry.com/about-us/developer-resources returned an empty page). Treat as ODC-BY (attribution), which fits our rule, but **UNCONFIRMED at the source**; add an attribution line and ask WETA to confirm.
- **511.org alternative**: the regional feed needs a free API token, defaults to 60 requests per 3600 s, and its terms/data agreement are in separate PDFs not read here (https://511.org/open-data/transit). Prefer the direct WETA URL, which needs no key.
- Terminals to expect (general knowledge, UNCONFIRMED, take them from `stops.txt` of the GTFS): Ferry Building, Pier 41 (Fisherman's Wharf), Oracle Park, Mission Bay, Oakland Jack London Square, Alameda Main Street and Seaplane Lagoon, Harbor Bay, Vallejo, Richmond.
- Bake use: ferry paths from `shapes.txt` (if present) or OSM `route=ferry`; stops give terminal positions. Both are ambient-life data, not physics.

---

### D. Water animation and fog

**Golden Gate currents** (CONFIRMED, NOAA predictions API, station SFB1203 "Golden Gate Bridge, 0.46 nm E of", 37.82007, -122.473, bin 18 at 30 ft depth, from a 2012-13 survey: https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/SFB1203.json):
- Mean flood direction 69 degrees (inbound, ENE), mean ebb direction 257 degrees (outbound, WSW).
- Sampled days: 2026-11-09..11 peak flood 2.87 kt, peak ebb 2.79 kt; 2026-11-24..25 peak flood 2.98 kt, peak ebb 3.33 kt (afternoon ebb ~15:00, flood ~09:00 and ~22:00-23:00). Sample query: https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&station=SFB1203&begin_date=20261124&end_date=20261125&interval=MAX_SLACK&units=english&time_zone=lst_ldt&format=json&application=sfroadster
- Cycle: slack, flood/ebb ~every 6 h, with a weak ebb (~1 kt) alternating with a strong one (~3 kt) once a day (mixed semidiurnal).
- Secondary sources claim 4-6 kt peaks at the strongest springs (https://www.tradewindssailing.com/wordpress/general/planning-for-currents/) and note peak ebb exceeds peak flood in the Gate (USGS, https://pubs.usgs.gov/publication/70112515). Treat 5-6 kt as UNCONFIRMED; the NOAA station here is off the main channel centre.
- Use: flow-map shader direction 257 on ebb and 69 on flood, speed to ~3.3 kt (1.7 m/s) per the prediction, a 6 h phase; tune up if you want the stronger centre-channel flow.

**Open-ocean swell** (CONFIRMED snapshots, 2026-10-16 to 10-26):
- NDBC 46026, 18 nm W of SF, 53 m depth: Hs 3.6 ft (1.1 m), dominant period 13 s, average 7 s (https://www.ndbc.noaa.gov/station_page.php?station=46026).
- NDBC 46237 SF Bar: Hs 3.0 ft, dominant 14 s, direction WSW 240 true (https://www.ndbc.noaa.gov/station_page.php?station=46237). A multi-year climatology was not found; CDIP station 142 is the suggested archive (UNCONFIRMED, not queried).
- Outside the Gate: long-period (12-15 s) swell from the W/WSW, larger on the Bar and at the Gate mouth, strongly damped inside the Bay.

**Inside the Bay (wind waves):**
- Central Bay fetch Golden Gate to Berkeley flats ~8 nm; westerlies of 20 kt or more are common most afternoons April-October (https://www.baycrossings.com/the-winds-of-summer/). Strong westerly/northwesterly funneling through the Gate gives steep chop (https://www.usgs.gov/media/images/winds-and-associated-wave-heights-sf-bay, image caption only).
- No published typical Hs found. **My own fetch-limited estimate, UNCONFIRMED:** 20 kt wind over ~15 km gives Hs about 0.6-0.8 m with a 3-4 s period, i.e. short steep chop; mornings and winter are close to flat in sheltered areas (calmer in the evening, nights, and in the lee of land).
- Use: two-layer water: a long low swell visible only west of the bridge, and short wind chop scaled by a time-of-day wind term peaking mid/late afternoon.

**Fog (Karl)**:
- Season: historically May-October, now more like June-September (https://en.wikipedia.org/wiki/San_Francisco_fog). Winter has inland tule fog in the Central Valley.
- Daily cycle: marine layer usually clears back toward the coast by about noon; by mid/late afternoon onshore wind strengthens and pushes fog and stratus inland; at night it stays in place until the next morning (same page). Dawson/UC Berkeley says fog now lingers about 3 h/day less (secondary: https://en.wikipedia.org/wiki/San_Francisco_fog and https://watereducation.org/aquafornia-news/future-sfs-iconic-fog-appears-hazy-scientists-say).
- Entry gap: the Golden Gate is the largest gap in the Coast Range and the main fog entrance; fog moves on through the Bay toward Carquinez and the Valley (Wikipedia). It also comes over low terrain.
- Depth: marine layer typically ~1,000-2,000 ft thick in an inversion event, thinner with offshore high pressure, deeper with an approaching trough (https://www.kqed.org/science/1997579/bay-area-hikes-views-clouds-marine-inversion-layer; tops around 2,000 ft per https://www.aopa.org/news-and-media/all-news/2025/march/flight-training/weather-the-coastal-marine-layer).
- Heat spells flip the wind to north/northeast and push the layer offshore; it returns in a "southerly surge" (Wikipedia).
- Fog-horn proxy: Gate horns can sound over 5 h a day in summer vs under 0.5 h in March (https://www.parksconservancy.org/node/112; secondary).
- **Spatial map (UNCONFIRMED, general local knowledge, no source retrieved):** the Sunset/Richmond and Golden Gate Park are the fog-heaviest in summer; Twin Peaks, Sutro and Mount Davidson are often inside cloud; the Bay Bridge and downtown are intermittent; Oakland/Berkeley/Emeryville are usually clearer, with fog reaching the East Bay in the evening. A data source for this: the BayGEO GOES-based fog/low-cloud map and USGS Pacific Coastal Fog project (not retrieved).
- Use: a fog volume driven by season (peak ~July), hour (rolls in 15:00-21:00, clears by ~11:00-13:00), a west-to-east gradient from the Gate, and a height cap ~300-600 m (1,000-2,000 ft) so tower tops (Sutro, Salesforce, bridge towers) poke through at times.

---

### Licence summary for this topic

| Source | Licence | OK to ship derivatives? |
|---|---|---|
| NOAA tide/current data and NCEI DEM | US government, no copyright | Yes |
| USGS 1 m Bay DEM, CoNED, 3DEP | US government (no licence on item pages, normal USGS policy) | Yes (cite) |
| WETA GTFS | ODC-BY per Mobility Database (UNCONFIRMED at source) | Yes with attribution |
| OSM coastline, piers, ferries | ODbL | Yes with attribution + share-alike |
| SFEI Shore Inventory | LGPL-3.0 per a secondary catalog (UNCONFIRMED, unusual for data) | Ask SFEI first |

### Open questions
1. Direct, scriptable download for the CoNED 2 m SF Bay DEM and its vertical datum. Candidates: the CoNED viewer, or a TNM `datasets` query with the right dataset name.
2. Whether to download the USGS 1 m Bay bathymetry zips (about 0.9-1 GB each) or crop via NCEI NCSS or lidar-only.
3. SFEI shore inventory real licence and an unblocked download link.
4. The lake surface elevations (Merritt, Stow, Spreckels) and the Embarcadero seawall crest, from the lidar.
5. Current-epoch (2026) NOAA datums and whether the water plane should reflect them.
6. Strongest Golden Gate mid-channel current speeds (NOAA reference station near Point Diablo).
7. A sourced fog map for the district-level fog layout.

---

## Fact-check

Independent re-check on 2026-10-26 against the live sources.

1. **Datums at SF 9414290 and Alameda 9414750 (NAVD88-relative values)** - CONFIRMED. Raw NOAA values re-fetched (SF: MHHW 3.602, MSL 2.773, MLLW 1.822, NAVD88 1.804; Alameda: MHHW 3.027, MSL 2.067, MLLW 1.016, NAVD88 1.086; epoch 1983-2001). Subtractions give SF +1.798 / +0.969 / +0.018 and Alameda +1.941 / +0.981 / -0.070, all matching. Sources: https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290/datums.json?units=metric and https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414750/datums.json?units=metric
2. **USGS 1 m Bay DEM in NAVD88 and MLLW versions; Central NAVD88 zip is 962,525,101 bytes** - CONFIRMED. The ScienceBase JSON lists CentralSFBay_DEM_Mosaic_NAVD88_1M.zip with size 962525101 (https://www.sciencebase.gov/catalog/item/607df15ad34e8564d67e3ae9?format=json&fields=files). A separate MLLW item exists (https://www.sciencebase.gov/catalog/item/606b73efd34e3d0429b204d3). Far over the 20 MB cap.
3. **CoNED 2 m SF Bay DEM only via viewers, no stated datum, TNM API returned zero** - PARTLY WRONG. The TNM query returning zero products is confirmed (also zero for q=CoNED). But CoNED is downloadable via EarthExplorer (Digital Elevation category), not only viewers, and USGS states the vertical datum is NAVD88 (NAD83 horizontal), meters, 1/2/3 m depending on region, GeoTIFF. Whether a 2 m SF Bay tile specifically exists in EarthExplorer was not checked. Source: https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-coastal-national-elevation-database-coned
4. **WETA GTFS URL, 7 routes, ODC-BY per Mobility Database** - CONFIRMED as aggregator metadata (producer URL https://gtfs.sanfranciscobayferry.com/gtfs.zip, 7 routes, ODC-BY). Still UNCONFIRMED on the agency site. Source: https://mobilitydatabase.org/feeds/gtfs/mdb-3143
5. **SFB1203 flood 69 deg, ebb 257 deg, peaks 2.8-3.3 kt, strong/weak alternation; 4-6 kt secondary** - CONFIRMED for the NOAA parts. Nov 24-25 data: floods 2.86, 2.90, 2.81, 2.98 kt; ebbs -1.13, -3.28, -1.07, -3.33 kt, so the strong/weak alternation is in the ebb (floods stay near 2.9 kt). The 4-6 kt spring claim remains UNCONFIRMED (not rechecked). Source: the datagetter URL in the claim.

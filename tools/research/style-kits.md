# District architecture style kits and per-building assignment data

Researched 2026-10-26. Scope: ~25 procedural building style kits for SF, Oakland, Berkeley, Emeryville; the open datasets that let us assign a kit per building; concrete rules. Anything not verified is marked **UNCONFIRMED**. Kit visual descriptors are design inferences drawn from the cited style sources plus common knowledge of the cities (marked "design"); they are not measurements.

Method note: dataset facts below were read live from the portals' own metadata endpoints (`/api/views/<id>.json`, `/resource/<id>.json`) on 2026-10-26, so field names and counts are first-hand.

---

## 1. Datasets (verified)

### 1.1 San Francisco

| Dataset | ID / URL | Key fields | Licence | Notes |
|---|---|---|---|---|
| Assessor Historical Secured Property Tax Rolls | `wv5m-vpq2` https://data.sf.gov/api/views/wv5m-vpq2.json (SODA: https://data.sf.gov/resource/wv5m-vpq2.json) | `closed_roll_year`, `parcel_number`, `block`, `lot`, `property_location`, `use_code`, `property_class_code`(+`_definition`), `year_property_built`(text), `number_of_stories`, `number_of_units`, `number_of_rooms/bedrooms/bathrooms`, `zoning_code`, `construction_type`, `property_area`, `basement_area`, `lot_area`, `lot_frontage`, `lot_depth`, `assessor_neighborhood(_code)`, `analysis_neighborhood`, `supervisor_district`, `the_geom` (parcel centroid, may be blank) | PDDL (public domain dedication), shippable | 46 columns. Roll years 2007-2024 per description; live query shows `closed_roll_year` 2025 (211,547 rows), 2024 (212,653), 2023 (212,206). Updated annually (~August). Shapefile export is broken per description; use GeoJSON/CSV. |
| Building Footprints | `ynuv-fyni` https://data.sf.gov/api/views/ynuv-fyni.json | `sf16_bldgid`, `mblr` (parcel key), `p2010_name`, `hgt_median_m`, `peak_1st_m`, `gnd_min_m`, `shape` | PDDL | **No year, use, or address field. `mblr` is the only parcel link**, so every attribute comes from joining `mblr` to the roll / land use / historic datasets. Heights are 2010-era lidar (already in MAP_RESOURCES.md). |
| Historic Resource Status by Parcel | `3tsw-4idn` https://data.sf.gov/api/views/3tsw-4idn.json | `apn`, `name`, `lowstnum`, `highstnum`, `stname`, `sttype`, `ceqacode` (A/B/C), `ceqacodea10a11` (A/A*/B/C), `ceqacodereason`, `yearbuilt`, multipolygon geometry | PDDL | Updated 2026-10-25 per `rowsUpdatedAt`. A = Historical Resource; A* = Article 10/11 landmark or district; B = unknown; C = not. Statuses are "tentative". Good second source for year built and for flagging landmarks/districts. |
| San Francisco Land Use (current, quarterly) | `c5ge-t6pj` https://data.sf.gov/api/views/c5ge-t6pj/columns.json | `mapblklot`, `resunits`, `cie`, `med`, `mips`, `retail`, `pdr`, `visitor`, `total_comm` (all sq ft), `parking_lo`, `garage`, `open_space`, `residentia`, `geography_type` (parcel / multiple_parcels / analytical), `special_jurisdiction`, `major_mult` | CC0 1.0 | Updated 2026-08-17. Some rows are groups of parcels: join one-to-many risk. Gives square footage by use, which is what we need for "ground-floor retail" and "mixed use". |
| Land Use 2023 (archived) | `fdfd-xptc` https://data.sf.gov/api/views/fdfd-xptc.json | `mapblklot`, `restype`, `res`, `totalcomm`, `cie`, `med`, `mips`, `retail`, `pdr`, `visitor`, `resunits`, `landuse` | Public Domain US Gov | Archived March-2023 snapshot; has the single `landuse` category label and `restype`, which the current set lacks. Use as a fallback. |
| Zoning Map - Zoning Districts | `3i4a-hu95` | **UNCONFIRMED** (id seen via data.gov mirror https://catalog.data.gov/dataset/zoning-map-zoning-districts; columns not opened) | UNCONFIRMED | Not needed first: the roll's own `zoning_code` already gives zoning per parcel. |
| Zoning Map - Height and Bulk Districts | `h9wh-cg3m` | UNCONFIRMED columns | UNCONFIRMED | Useful as a tower/low-rise cross-check. Source of id: https://catalog.data.gov/dataset/zoning-map-height-and-bulk-districts |

Roll statistics (2024/2025 queries, SODA group-by):
- `use_code` counts (2024): SRES 155,027; MRES 36,339; COMM 6,066; MISC 5,544; COMR 4,371; IND 2,377; COMO 1,820; COMH 755; GOVT 354. `number_of_stories` has no nulls, but 33,272 rows in 2025 are 0, so it is not meaningfully populated on every row (corrected 2026-10-26); `year_property_built` is null for 10,683 rows in 2025 (about 5%) and mostly missing for COMM (2,316 of 6,066), MISC and GOVT.
- Top `property_class_code`: D (dwelling) 95,063; Z (condo) 52,216; F (flats and duplex) 17,934; A5 (5-14 unit apartments) 5,885; A 4,119; LZ (live/work condo) 3,117; C (commercial stores) 2,725; A15 (15+ units) 2,593; FS (flat and store <=4 units) 2,180; I (industrial) 1,796; O (office) 1,249; CO (co-op) 1,026; W (churches) 513; H2/H1/M/RH (hotels/motels/SROs) etc.
- Decade histogram of `year_property_built` (2025 roll): 1870s 158; 1880s 694; 1890s 1,476; **1900s 35,584**; 1910s 18,198; **1920s 33,699**; 1930s 14,598; 1940s 22,966; 1950s 13,158; 1960s 9,369; 1970s 6,283; 1980s 9,236; 1990s 8,634; 2000s 16,288; 2010s 7,668; 2020s 2,835.
- **Data-quality warning:** the single value `1900` occurs 14,628 times (the next most common value is null at 10,683, then 1925 at 5,541, 1907 at 4,974, 1908 at 4,894) (corrected 2026-10-26). That strongly suggests `1900` is a catch-all for "old/unknown", i.e. pre-1906 or undocumented. The 1900s decade also holds the post-earthquake building boom (1907, 1908 spikes). I could not find an official Assessor statement about the default (search found none), so treat `1900` as "pre-1906 or unknown" **(inference, UNCONFIRMED by the Assessor)**. The field description itself warns it "may blend original and newer construction".
- `construction_type` codes: D 151,588; NA 47,305; C 5,406; A 2,773; B 2,479; WOO 1,346; S 482; STE 160; REI 8. Code meanings not documented in the pulled metadata; **UNCONFIRMED**, but the pattern (D = dominant light wood frame for SF houses, A/B/C rising for steel/concrete) fits the BOE/Marshall&Swift classes. Do not rely on it for rules until decoded against a sample (e.g. check Transamerica Pyramid parcel).
- Sample row (2025): `0044023`, 2544 Leavenworth St, SRES class D, built 1900, 3 stories, 1 unit, zoning RH3, Russian Hill. Note `property_location` is a fixed-width string (`0000 2544 LEAVENWORTH ST0000`), so join by block+lot, not address.
- **Join traps:** (a) Condo parcels (class Z, ZBM, LZ, TS, etc.) get their own roll rows with their own lot numbers and often null/duplicated building attributes. The footprint `mblr` is the base parcel (map-block-lot). Aggregate roll rows by `block` + base lot (the first 3 lot characters; **UNCONFIRMED convention**, test on a known condo tower) and take max(stories), min(non-null year_built), sum(units). (b) `mblr` includes a right-of-way suffix per the footprint metadata; strip it. (c) `the_geom` in the roll is a centroid and "may be blank", so don't rely on it for spatial join; use the footprint's `mblr`.

Other SF sources worth knowing (not verified in depth):
- SF Planning Historic Preservation Bulletin 18 gives date ranges for SF styles: Stick/Eastlake 1880-1900, Queen Anne 1885-1910; the Italianate came in a flat-front 1860s version and a 1870s two-story-bay version. Source: https://sfplanning.org/sites/default/files/documents/preserv/bulletins/HistPres_Bulletin_18.PDF (summary via search; the PDF text could not be extracted by my tool, so other details in it are UNCONFIRMED) and the Alamo Square walking tour https://default.sfplanning.org/Preservation/walking_tours/Walking_Tour_ALAMO_SQUARE.pdf (bays turn from angled in the 1870s to boxy rectangular in the 1880s to ornate curved/asymmetrical in the 1890s).
- Article 10 landmarks dataset exists (catalog entry "Landmarks listed in Article 10 of the San Francisco Planning Code", https://catalog-old.data.gov/dataset/landmarks-listed-in-article-10-of-the-san-francisco-planning-code); id and fields not opened. The `ceqacodea10a11 = A*` flag in `3tsw-4idn` already covers Article 10/11 properties, so this is optional.

### 1.2 Alameda County (Oakland, Emeryville, Berkeley)

| Item | Finding | Licence / cost | Source |
|---|---|---|---|
| County Assessor bulk data | Assessment roll (parcel number, owner, address, assessed values, exemptions, tax rate area, **property use code**) is public; the building **characteristics (year built, stories, size, bedrooms) are NOT part of the roll** and are sold, free only to the owner with ID. | Fee schedule found is dated **2016-01-01**: roll CD $20; **entire property characteristic file $20,000**; per-parcel characteristics $5-$30. Current price UNCONFIRMED. Phone (510) 272-3787. No redistribution licence found: a purchased file would most likely carry restrictions, so **do not ship derived year-built values from it without written permission**. | https://aspawebq.acgov.org/forms/assessor/feeschedule.pdf (via search result; page text not fetched), https://aspawebq.acgov.org/assessor/resources/records.htm |
| County open data parcel boundaries | Boundaries only; an older OKF survey notes the file has no assessor information. | Unconfirmed; portal https://data.acgov.org/ listing could not be read | https://us-cities.survey.okfn.org/entry/alamedacounty/parcels.html |
| Commercial parcel vendors (ReportAll, Land Records) | Include year built, land use; ReportAll lists the county at $400 | Proprietary, not redistributable | https://reportallusa.com/store/california/6001 |
| Oakland open data (data.oaklandca.gov) | See next table | mixed | |
| Berkeley open data (data.cityofberkeley.info) | See next table | mixed | |
| Emeryville | No city GIS or open-data portal found; only commercial Zoneomics pages. Use Oakland/Alameda boundary data plus OSM and lidar. | n/a | search only |

Conclusion for the East Bay: **no redistributable per-building year-built dataset found.** We must infer era from (a) lidar roof/shape signatures and OSM/Overture tags, (b) neighbourhood-level era priors (Census year-built tables, 1923 Berkeley fire, Oakland survey districts), (c) zoning/general-plan land use for use type.

### 1.3 Oakland, Berkeley layers

| Layer | ID | Fields | Licence | Notes |
|---|---|---|---|---|
| Oakland Zoning (table) | `sph3-urcs` (maps `q8sz-29u5`, `ngyq-upwh`) https://data.oaklandca.gov/api/views/sph3-urcs.json | `basezone`, `overlay`, `znlabel`, `ordinance`, `effctvdate`, polygon | **Public Domain**, attribution City of Oakland Planning and Zoning Division | 1,147 polygons; description says minor changes effective Nov 2011, last catalog update 2024-04: possibly stale (post-2011 zoning such as Downtown/Broadway-Valdez specific plans may be missing). |
| Oakland General Plan Land Use | `fdhf-q9rm` (map `7xy4-dv3x`) https://data.oaklandca.gov/api/views/fdhf-q9rm.json | `gplancode`, `classifn`, `resolution`, `update` | **Public Domain** | Classification effective March 2011 per description. |
| Oakland Building Footprints | `iqfp-6kz5` (map `qvww-ev2w`) https://data.oaklandca.gov/api/views/iqfp-6kz5.json | `final_apn`, `apnid`, `bldgtype`, `nostory`, `numbldgs`, `comname` | Not stated (UNCONFIRMED) | From 2002-03 aerial imagery; partial (10,651 rows per MAP_RESOURCES.md). `final_apn` + `bldgtype` gives a use hint where present. |
| Berkeley Zoning | `iknk-w4qw` (map `2dtu-vge3`) https://data.cityofberkeley.info/api/views/iknk-w4qw.json | `zoneclass`, `zonedesc`, `zone`, `genplan`, `height`, `baseelev`, `lastupdate` | Not stated; metadata shows public read, attribution City of Berkeley Planning and Development. **Licence UNCONFIRMED**: ask or treat as public record; zone boundaries are public facts but verify before bundling raw geometry. | Updated 2026-08-12. Contains `genplan` and a `height` limit, which helps identify the Downtown/University Avenue mid-rises. |
| Berkeley landmarks / structures of merit / historic districts | City PDF list (search snippet says updated Oct 2025; the PDF itself not fetched): https://dev.berkeleyca.gov/sites/default/files/documents/COB%20Landmarks%20Updated%20Jan%202023_0.pdf | 346 listed landmarks as of 2022 (search summary) | Public record; no GIS layer found | Address list only; geocode ourselves. No Berkeley parcel/building dataset found in the city's catalog search (zero results for landmark/parcel/building/historic). |
| Oakland historic survey (OCHS ratings A-E, APIs, Local Register ~2,600 buildings) | https://www.oaklandca.gov/Planning-Building/Historic-Preservation/Historic-Preservation-Overview | No GIS layer found | n/a | Only descriptive; a GIS layer would need a Public Records request (UNCONFIRMED availability). |

### 1.4 Free fallbacks that cover all four cities

| Source | What it gives | Licence | Caveat |
|---|---|---|---|
| Overture Maps Buildings (https://docs.overturemaps.org/schema/reference/buildings/building/) | Optional `subtype`, `class` (current use), `num_floors`, `height`, `roof_shape`, `facade_material`, `roof_material`, `has_parts`, `sources[]` | ODbL (per MAP_RESOURCES.md); schema page itself states no licence | Fields are optional and sparse; I did not measure coverage in Oakland/Berkeley (UNCONFIRMED). |
| OSM `building=*`, `building:levels`, `start_date`, `building:material`, `roof:shape` | Same, hand-tagged | ODbL | Sparse; tag coverage unmeasured. |
| US Census ACS 5-year table B25034 "Year Structure Built" at block-group level (https://www.census.gov/data/developers/data-sets/acs-5year.html: Detailed Tables go down to block group) | Housing-unit counts by era per block group: bins from "built 1939 or earlier" up to recent decades. Variables confirmed to exist: B25034_010E (1940-49), B25034_011E (1939 or earlier). | US Government work (public domain) | The API now requires a key (page says so): use the bulk table downloads instead, or request a key. Block-group sample error is large; use only as a prior for the era of a block. |
| Lidar-derived signals | Roof form (flat vs pitched vs hip; ridge direction), footprint shape, lot coverage, height, party-wall adjacency (`gap to neighbour`), setbacks | Public domain | Our own bake step; no new data needed. |

---

## 2. The 25 style kits

Vocabulary: S = storeys; WR = window rhythm; GF = ground floor. "Era" = typical build years. Palette values are indicative sRGB hex chosen to match typical painted finishes (design). All kits are procedural: footprint extrusion + facade grammar + roof module; the table gives the parameters. Date ranges for the Victorian family follow SF Planning (Italianate flat-front 1860s, bay Italianate 1870s, Stick/Eastlake 1880-1900, Queen Anne 1885-1910: see section 1.1 sources); the rest are design ranges and are marked **(design)**.

| # | Kit id | Where | Era | Typical S | Facade / window rhythm | Bay windows | Materials, palette | Cornice / roof | GF treatment |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `sf_italianate` | Mission, Western Addition, Haight, Pacific Heights pockets | 1860-1885 | 2-3 | Tall narrow double-hung, 2 per floor, arched or hooded heads (design); vertical emphasis | Flat-front early; angled two-storey bay on 1870s houses | Redwood rustic siding, painted wood; muted creams/sage/grey #D8CFB8 #8A9A7B | Heavy bracketed cornice, flat roof behind parapet | Raised entry with stoop, 6-10 steps, small basement garage later |
| 2 | `sf_stick_eastlake` | Alamo Square, Western Addition, Haight, Noe | 1880-1900 | 2-3 | Rectilinear stick trim, paired windows, ornate friezes | Boxy rectangular two- or three-storey bays | Wood, polychrome (3-5 colour) painted ladies; #B7566B #E0C58A #4D6A7A | Flat/low gable with carved cornice, sunburst gable ornament | Stoop + entry hood |
| 3 | `sf_queen_anne` | Pacific Heights, Alamo Square, Haight, Bernal | 1885-1910 | 2-3 + attic | Irregular asymmetric massing, turret/tower (mix 15%), mixed window sizes | Curved/polygonal asymmetrical bays, wrap porch | Shingle + clapboard mix; saturated colours | Steep gable, conical turret roofs, shingled gables | Raised stoop, often small porch |
| 4 | `sf_edwardian_flat` | Richmond, Sunset (older part), Haight, Mission, Noe, Hayes Valley, Pacific Heights | 1900-1915 (peak 1907-1908 per roll counts) | 2-3 (flats stacked) | Rhythm of 3 windows on bay plus 1 door; classical details (columns, dentils) | Flat/boxed or shallow angled bay per floor | Stucco or wood siding; whites, creams, greys | Flat roof, simple projecting cornice with brackets/dentils | Garage door cut into basement (post-1915); stoops |
| 5 | `sf_row_house_stuccoed` | Richmond/Sunset (1920s-30s, e.g. West Portal) | 1920-1945 | 2 over garage | Two-window bay, arched entry, tile-ish canopy; repeated lots, 25 ft frontage | Slight curved bay or none | Smooth stucco in pastel; terracotta-red tile hood | Low-pitch tile roof, parapet | Garage full width at GF, entry to side |
| 6 | `sf_marina_style` | Marina, Cow Hollow (rebuilt for 1915 Expo area, fills in 1920s-30s) | 1920-1940 | 3 (2 flats over garage) | Mediterranean/Spanish revival: arched openings, wrought-iron balconies, round windows | Curved/cylindrical bay corners | Peach/salmon/ochre stucco; tile; #E8B896 #F3E1B5 | Red barrel-tile roof lines, low-pitch, shallow eaves | Double garage + entry arch. Style attribution: travel/real-estate sources say Mediterranean Revival dominates the Marina in 1920s-30s (https://www.nomadotravel.app/en/places/marina-district); "Marina Style" is a recognised local term but features unverified (https://diva.sfsu.edu/collections/kirkeberg/bundles/230403) |
| 7 | `sf_bungalow_craftsman` | Excelsior, Bernal, Glen Park, Sunset, Noe | 1905-1930 | 1-2 | Low gable, paired multi-pane windows, battered porch columns | Occasional | Shingle/clapboard; earthy #7E6B4E #A78A62 | Low-pitch gable, exposed rafters | Front porch, driveway |
| 8 | `sf_sunset_stucco_box` | Sunset, Parkside, Richmond outer | 1935-1955 (decades 1940s 22,966 roll rows) | 2 | Plain stucco, single picture window + small windows, repeating identical house | Rare | Pastel stucco; #E9D9B0 #B7D3C1 | Flat or shallow hip, garage-first | Garage at street, tiny entry |
| 9 | `sf_postwar_apartment` | Richmond, Nob, Lakeshore | 1945-1975 | 3-6 | Horizontal bands, balconies, ribbon windows | None | Stucco/brick/concrete; muted greys, tans | Flat roof, parapet | Open podium parking at GF |
| 10 | `sf_artdeco_tower` | Downtown, Nob Hill, Civic Center, Pacific Heights | 1925-1940 | 8-30 | Vertical piers, setbacks, geometric ornament, spandrel panels | n/a | Terra-cotta, limestone, cream/gold, black accents | Stepped crowns, spire | Lobby, retail, lit entrances |
| 11 | `sf_beaux_arts_civic` | Civic Center, Union Square, FiDi old core | 1895-1925 | 5-12 | Ordered classical grid, columns, stone base-shaft-capital | n/a | Granite/limestone; cream-grey | Heavy cornice, flat or dome | Stone base, large arched doors |
| 12 | `sf_fidi_midcentury_glass` | FiDi, Embarcadero Center, Union Sq area | 1960-1985 | 15-50 | Curtain wall grid or concrete spandrel, deep columns | n/a | Glass/aluminium; bronze or blue-grey; #7CA0B8 | Flat roof with mechanical penthouse | Plaza level, recessed lobby |
| 13 | `sf_modern_supertall` | SoMa/Transbay/FiDi | 2000-present | 40-60+ | Sleek curtain wall, vertical fins, tapered crowns | n/a | Glass, steel; Salesforce Tower crown LED | Tapered crown, cap lighting | Lobby + pedestrian plaza. Heights must come from 2023 lidar (post-2010 towers missing from footprint heights; see MAP_RESOURCES.md) |
| 14 | `sf_soma_warehouse_loft` | SoMa, Dogpatch, Potrero, Mission Bay edge | 1906-1930 (brick) / 1930-1960 | 3-6 | Large grid of tall multi-pane industrial windows, brick pilasters | None | Red/brown brick, concrete, steel sash; #8A4B3A | Flat roof, parapet, sawtooth for factories | Loading docks, roll-up doors |
| 15 | `sf_industrial_shed` | Bayview, Hunters Point, Dogpatch yards | 1940-present | 1-2 (high bay) | Blank metal/CMU walls, few windows | None | Corrugated metal, CMU, tilt-up; greys | Low-slope or gable | Roll-up doors, fenced yard |
| 16 | `sf_mission_mixed_use` | Mission St, Valencia, 24th St | 1900-1930 | 2-4 | Storefronts under flats; murals on blank side walls | Boxed bay on upper floors | Painted stucco/wood, bright paint, murals (Balmy/Clarion Alleys; mural content must be our own art) | Parapet + cornice | Awning, large glass storefront |
| 17 | `sf_chinatown` | Chinatown (Grant, Stockton, Jackson) | 1907-1930 | 3-6 | Dense, red/green balconies, recessed balconies, pagoda-style roof caps on corner towers | Few | Brick/stucco with polychrome painted trim; red #B22222, green, gold | Flat roofs with pagoda cap on landmarks | Signs, hanging lanterns, shopfront |
| 18 | `sf_victorian_commercial` | Haight, Hayes, Fillmore, Castro, Polk | 1890-1915 | 2-3 | Ground retail with Victorian flat above; tall upper windows | Boxed or curved over retail | Wood siding, stucco; colourful | Cornice | Storefront with transom |
| 19 | `sf_sro_hotel` | Tenderloin, Mission, SoMa | 1906-1930 | 4-8 | Rhythmic punched windows, fire escapes | Occasional | Brick/stucco; dull earth tones | Flat roof, bracketed cornice | Lobby + narrow retail |
| 20 | `sf_public_modern` | Civic, UCSF, SFSU, schools | 1960-1990 | 1-6 | Brutalist/mid-century blocks | n/a | Poured concrete, brick, glass | Flat roof | Plaza or lawn |
| 21 | `oak_craftsman_bungalow` | Oakland flatlands/hills (Rockridge, Temescal, Fruitvale, Dimond) | 1905-1925 (Craftsman Bungalow 1905-1925 per Oakland Rehab Right) | 1-2 | Wide eaves, tripled window groups, porch | Occasional | Wood siding/shingle; earth tones | Low-pitch gable, exposed rafters | Porch, driveway. Source: https://oaklandwiki.org/Architectural_History_of_Oakland |
| 22 | `oak_victorian_west_oakland` | West Oakland (Prescott, Ralph Bunche), Old Oakland, Lake Merritt | 1870-1905 | 2-3 | Italianate, San Francisco Stick, Queen Anne cottage | Yes | Wood, painted | Hip/gable; flat Italianate | Raised stoop. Style names from the 1978 "Rehab Right" guide cited in https://oaklandwiki.org/Architectural_History_of_Oakland |
| 23 | `oak_downtown_highrise` | Downtown Oakland, Uptown, Lake Merritt | 1910-1930 deco/classical; 1960-1990 glass; 2000+ | 6-40 | As SF kits 10/11/12/13 | n/a | Terra-cotta, glass | Crowns, e.g. deco tower tops | Retail GF |
| 24 | `bky_brown_shingle` | Berkeley hills, Northside, Scenic Park, Claremont | 1895-1923 | 2-3 | Unpainted redwood shingles, asymmetric windows, big roofs; First Bay Tradition (Maybeck, Coxhead, Morgan) | Few | Brown redwood shingle; #5B4630 | Steep gables, deep overhangs | Terraced hillside, garage added later. Source: https://en.wikipedia.org/wiki/First_Bay_Tradition. After the 1923 fire, many lost houses were replaced by stucco apartments in the southern part of the fire zone per search summary of Berkeley sources. |
| 25 | `ey_new_build` | Emeryville, Jack London Sq., Brooklyn Basin, Mission Bay SF edge | 1995-present | 4-8 over podium | Flat panelized facades, grid windows, boxy balconies, coloured accents panels | Rare | Stucco, fibre-cement, corrugated metal; #D0CBC1 + accent | Flat roof | Podium parking or ground retail |

Optional extras if budget allows (tracked as 26-30): `oak_industrial_brick` (West Oakland, Jack London, factories with brick/pilasters), `bky_downtown_midrise` (Berkeley zoning `height` field), `bky_campus_neoclassical` (UC Berkeley campus), `sf_public_housing_postwar`, `sf_victorian_commercial_corner_tower`.

Watch Dogs 2 context for scale: 33 districts, 36 styles, 50 kits (Vice interview cited in MAP_RESOURCES.md section 2). Our 25 kits plus 5 extras roughly match the style count; kits-per-district can be combined with per-kit parameter variation (see §4).

---

## 3. Assignment rules

### 3.1 Pipeline

1. Footprint polygon (SF: `ynuv-fyni`; East Bay: OSM/Overture/own lidar footprints).
2. Parcel key: SF footprint `mblr` (strip suffix) to block+lot. East Bay: spatial join to county parcel boundaries (parcel geometry from `data.acgov.org`, UNCONFIRMED) or Oakland footprint `final_apn`.
3. Attribute rows (SF only): roll aggregate (`year_property_built` min non-null, `number_of_stories` max, `number_of_units` sum, `use_code`, `property_class_code`, `zoning_code`, `construction_type`, `assessor_neighborhood`), land use aggregate (`retail`, `mips`, `pdr`, `visitor`, `resunits`, `total_comm`, `garage`), historic status (`ceqacodea10a11`, `yearbuilt`, `ceqacodereason`, `name`).
4. Lidar: measured height H, roof shape, lot coverage, adjacency.
5. Rule table below produces `kit_id`, then a hash of `sf16_bldgid` picks the variant (palette, bay type, window rhythm) deterministically.

### 3.2 Derived values

- `era_year` = first non-null of (roll `year_property_built`, historic `yearbuilt`); if the value is `1900` treat as "pre-1906 or unknown" and probabilistically assign Victorian (1880-1905) when use is residential in a Victorian-era neighbourhood, else Edwardian.
- `storeys` = roll `number_of_stories` (non-null on all rows, but 33,272 of the 2025 rows are 0, so treat 0 as missing) (corrected 2026-10-26) clipped to measured height H / 3.2 m; if they disagree by more than 1, trust lidar H (roll values for old multi-parcel buildings may be off).
- `GF_retail` = true if land use `retail` > 0 or class in {FS, FS5, AC, C, CM, CZ} or zoning in NCD/NCT/C-.
- `is_tower` = H > 45 m (about 14 storeys) or stories >= 15.
- `is_landmark` = historic `ceqacodea10a11 == 'A*'` or `name` non-null: apply `hero_landmark` (hand-modelled or higher detail) rather than a kit.

### 3.3 San Francisco rule table (first match wins)

Applies to rows where `use_code` and class are from the 2025 roll (counts verified above).

| Priority | Condition | Kit |
|---|---|---|
| 1 | Historic `A*` with `name` listed (landmarks) | `hero_landmark` (override, per-building model or high-detail kit chosen by hand) |
| 2 | use_code IND, or class I/IW/IXG/IG, or land-use `pdr` dominant | H<=9 m: `sf_industrial_shed`; else `sf_soma_warehouse_loft` |
| 3 | `is_tower` and era_year >= 2000 | `sf_modern_supertall` |
| 4 | `is_tower` and era_year 1960-1999 | `sf_fidi_midcentury_glass` |
| 5 | `is_tower` and era_year < 1945 | `sf_artdeco_tower` |
| 6 | use_code COMO / land-use `mips` dominant, era_year < 1925, 5-14 storeys | `sf_beaux_arts_civic` |
| 7 | use_code COMH class RH or H* hotel, era 1906-1930, stories 4-8 | `sf_sro_hotel` |
| 8 | assessor_neighborhood in Chinatown | `sf_chinatown` |
| 9 | use_code COMR/COMM with `GF_retail`, assessor_neighborhood in Mission/Inner Mission | `sf_mission_mixed_use` |
| 10 | `GF_retail`, residential above (class FS, FS5, AC), era_year < 1915 | `sf_victorian_commercial` |
| 11 | class A5/A15 or units >= 5, era_year 1945-1975 | `sf_postwar_apartment` |
| 12 | use_code SRES/MRES, era_year 1885-1910 or era_year == 1900, neighbourhood in Victorian districts (Alamo Square, Western Addition, Haight-Ashbury, Pacific Heights, Noe Valley, Mission, Bernal) | Italianate (<=1884 or hash), Stick (1880-1899), Queen Anne (1885-1910) pick by era buckets: era<1880: `sf_italianate`; 1880-1892: `sf_stick_eastlake`; 1893-1910 or 1900: `sf_queen_anne` (20% turret) |
| 13 | Residential, era 1900-1915 | `sf_edwardian_flat` |
| 14 | Residential, era 1920-1940, neighbourhood Marina/Cow Hollow/Presidio Heights | `sf_marina_style` |
| 15 | Residential, era 1920-1945, Richmond/Sunset/West Portal/Parkside | `sf_row_house_stuccoed` |
| 16 | Residential, era 1905-1930, class D, 1-2 stories, Bernal/Glen Park/Excelsior/Noe | `sf_bungalow_craftsman` |
| 17 | Residential, era 1935-1960, Sunset/Parkside/Excelsior/Outer Richmond | `sf_sunset_stucco_box` |
| 18 | use_code GOVT/COMM school (class E, EG), CIE land use | `sf_public_modern` |
| 19 | Fallback residential | `sf_edwardian_flat` if era < 1930 else `sf_sunset_stucco_box` |
| 20 | Fallback commercial | `sf_victorian_commercial` if era < 1930 else `sf_postwar_apartment` |

### 3.4 East Bay rules (no roll available)

| Condition | Kit |
|---|---|
| Lidar H > 45 m and inside Downtown Oakland zoning (`znlabel` D-*, CBD-*; zone strings UNCONFIRMED) | `oak_downtown_highrise` |
| Zoning M-* / `genplan` industrial | `oak_industrial_brick` (extra) or `sf_industrial_shed` |
| Emeryville polygon (bbox lon -122.31..-122.28, lat 37.825..37.845, approx.) and OSM/Overture `start_date`>=1995 or flat-roof lidar + podium signature | `ey_new_build` |
| Berkeley hills (elevation > 80 m) and `zoneclass` R-1H/R-1 and pitched-roof lidar | `bky_brown_shingle` |
| Berkeley zoning `height` field > 45 ft in C-DMU/C-U | `bky_downtown_midrise` (extra) |
| West Oakland (bbox) residential, pitched roof, lot frontage < 12 m | `oak_victorian_west_oakland` |
| Other Oakland/Berkeley/Alameda low-rise residential, 1-2 storeys, pitched roof | `oak_craftsman_bungalow` (default) |
| Dense 3-5 storey with flat roof, no `start_date` | `sf_postwar_apartment` (cross-use) |

Confidence: SF rules rely on verified fields; East Bay rules are heuristics because the assessor characteristics file is paid and not redistributable.

### 3.5 Verification plan (cheap)

- Sample 200 SF buildings per kit and check against Street View in-browser (eyeballing only, nothing extracted).
- Cross-check `year_property_built` vs historic `yearbuilt` agreement rate; log disagreement; decide priority.
- Confirm the `1900` bucket proportion in the final output per neighbourhood and make sure kits are not all Edwardian.

---

## 4. Variation and budget

- Per kit: 3-5 palettes, 2-3 bay variants, WR jitter ±10%, with a hash of `sf16_bldgid`. This gives 25 kits x 12+ variants without extra data.
- ~2 KB per procedural building descriptor (kit id u8, variant u8, storeys u8, facing yaw) is enough; ~180k SF footprints then add only ~0.4 MB uncompressed.
- Keep a `kit_override.json` (hand edits, hero landmarks, murals) in `data/` so manual QA survives re-bakes.

---

## 5. Licences summary

| Data | Licence | Shippable derived data? |
|---|---|---|
| SF Assessor roll `wv5m-vpq2`, Footprints `ynuv-fyni`, Historic `3tsw-4idn` | PDDL | Yes (attribution good practice) |
| SF Land Use `c5ge-t6pj` | CC0 | Yes |
| SF Land Use 2023 `fdfd-xptc` | US Gov works | Yes |
| Oakland Zoning `sph3-urcs`, General Plan `fdhf-q9rm` | Public Domain | Yes |
| Oakland BuildingFootprints `iqfp-6kz5` | not stated | UNCONFIRMED: treat as public record, confirm |
| Berkeley Zoning `iknk-w4qw` | not stated | UNCONFIRMED |
| Alameda County Assessor characteristics file | sold for a fee ($20,000 in the 2016 schedule); no redistribution licence found | **No**, unless written permission |
| Census ACS B25034 | US Government work | Yes (API key requirement is a user action) |
| Overture, OSM | ODbL | Yes with attribution and share-alike |

---

## 6. Open questions

1. What does the Assessor's `year_property_built = 1900` mean (default for pre-1906/unknown?). No official statement found.
2. Meaning of `construction_type` codes (D/C/A/B/S/STE/WOO/REI/NA) in the SF roll. Not documented in the pulled metadata.
3. Exact condo-to-base-parcel convention for joining roll lots to footprint `mblr`.
4. Berkeley zoning, Oakland footprints licence terms; Berkeley and Emeryville parcel layers (county open data hub listing not readable).
5. Does Alameda County offer the property characteristics file under a redistributable licence, or can a Public Records Act request for year-built-by-APN be made? Current price (2016 schedule only).
6. Oakland Cultural Heritage Survey GIS layer availability (APIs, Local Register).
7. Coverage of `start_date`, `building:levels`, Overture `class/num_floors` in the East Bay (unmeasured).
8. Whether a Census key request is acceptable (an account is needed); bulk table downloads as alternative.
9. SF Planning style details (Bulletin 18 PDF text not extracted) and hands-on field checks for Marina-style and Mission kits.

---

## Fact-check

Checked 2026-10-26 against live SODA / Socrata metadata endpoints (data.sf.gov, data.oaklandca.gov, data.cityofberkeley.info) and a web search for the Alameda fee schedule.

1. **Assessor roll `wv5m-vpq2` fields and completeness: PARTLY WRONG.** Fields year_property_built, number_of_stories, number_of_units, use_code, property_class_code, zoning_code, construction_type all exist; licence is PDDL; 2025 has 211,547 rows and 10,683 null year_property_built (confirmed). Correction: number_of_stories is non-null on every row, but 33,272 of the 2025 rows have the value 0, so it is "populated" only in the sense of non-null; treat 0 as missing before using it in rules. Source: https://data.sf.gov/api/views/wv5m-vpq2.json, https://data.sf.gov/resource/wv5m-vpq2.json?closed_roll_year=2025
2. **Footprints `ynuv-fyni` have no year/use/address field; only parcel link is `mblr`: CONFIRMED.** Columns are sf16_bldgid, area_id, mblr, p2010_* and lidar height stats, globalid, shape; licence PDDL. Source: https://data.sf.gov/api/views/ynuv-fyni.json
3. **`year_property_built` = 1900 occurs 14,628 times, next most common 5,541: PARTLY WRONG.** 1900 = 14,628 confirmed. The next most common value is null (10,683); the next non-null value is 1925 at 5,541 (then 1907 at 4,974). Interpretation as a pre-1906/unknown catch-all remains an unconfirmed inference. Source: https://data.sf.gov/resource/wv5m-vpq2.json (group by year_property_built, closed_roll_year=2025)
4. **Alameda County Assessor sells characteristics; 2016 schedule lists entire file at $20,000; no redistribution licence found: CONFIRMED (with limits).** A search result confirms the 2016-01-01 schedule lists the Entire Property Characteristic File at $20,000 (a $22,000 variant with 12 monthly updates also appears) and the records page says property characteristics can be purchased. Direct fetch of aspawebq.acgov.org failed (DNS), so the exact text, whether year built and stories are specifically named, and the absence of a redistribution licence are UNCONFIRMED. Sources: https://aspawebq.acgov.org/forms/assessor/feeschedule.pdf, https://aspawebq.acgov.org/assessor/resources/records.htm
5. **Licences and fields for 3tsw-4idn, c5ge-t6pj, sph3-urcs, fdhf-q9rm, iknk-w4qw: CONFIRMED.** 3tsw-4idn is PDDL with apn, ceqacode, ceqacodea10a11, yearbuilt (the "A*" meaning for Article 10/11 is not defined in the metadata, UNCONFIRMED here). c5ge-t6pj is CC0 1.0 with retail, pdr, mips, cie, med, total_comm fields. sph3-urcs and fdhf-q9rm are licensed Public Domain (attribution City of Oakland Planning and Zoning Division). iknk-w4qw has no licence field (attribution City of Berkeley Planning & Development). Sources: https://data.sf.gov/api/views/3tsw-4idn.json, https://data.sf.gov/api/views/c5ge-t6pj.json, https://data.oaklandca.gov/api/views/sph3-urcs.json, https://data.oaklandca.gov/api/views/fdhf-q9rm.json, https://data.cityofberkeley.info/api/views/iknk-w4qw.json

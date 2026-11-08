# Grade-separated structures, Phases 1-2 (SF + Bay Bridge + East Bay)

Researched 2026-10-26. Anything not cited or marked UNCONFIRMED came from the queries named in section 1.
Caltrans LENG is treated as metres (check: Golden Gate = 2742 m in the layer, ~2737 m real); the layer docs do not state the unit, so UNCONFIRMED.

## 1. Sources and live query results

| Source | Query | Result |
|---|---|---|
| Caltrans State Highway Bridges (13,261 bridges, extract 2024-03-12) https://gisdata.dot.ca.gov/arcgis/rest/services/CHhighway/State_Highway_Bridges/MapServer/0 | `returnCountOnly`, SF bbox 37.70..37.84 / -122.53..-122.35 | **122** |
| same | Phase-2 bbox 37.76..37.90 / -122.38..-122.17 | **222** |
| same | union bbox 37.70..37.90 / -122.53..-122.17, records pulled | **364** (SF 115, Alameda ~190, Contra Costa ~11, Marin ~11, San Mateo 5). 88 are >= 200 m long (section 3). |
| Caltrans Local Bridges https://gisdata.dot.ca.gov/arcgis/rest/services/CHhighway/Local_Bridges/MapServer/0 | counts | SF bbox 41, Phase-2 bbox 41, union 93 (SF 40, ALA 39, CC 8, MRN 6). Clearly a partial subset (SF has far more local overpasses): not a complete list. |
| OSM via Overpass, `way[highway][bridge][bridge!=no]`, out count (2026-10-26) | SF bbox / Phase-2 bbox | **772 ways / 901 ways** |
| OSM `way[highway][tunnel][tunnel!=no]`, out tags | SF bbox | **406 ways**, but 125 are steps and 177 (PBF recount 2026-10-26) are `building_passage` service/footway/busway (SF city polygon: 173; 208 `building_passage` ways of any kind in the bbox). 26 (PBF recount 2026-10-26) real vehicle-tunnel ways (SF city polygon: 22; section 4). |
| OSM bridge listing grouped by name/ref; Phase-2 tunnels; rail tunnels | bridge listing grouped by name/ref not obtained: Overpass returned 429/502, then became unreachable (**UNCONFIRMED**; rerun from the Geofabrik PBF with osmium). Counted from the PBF: Phase-2 highway tunnel ways 196 (PBF recount 2026-10-26); railway tunnel ways (any `railway=*`) 67 in the Phase-2 bbox (PBF recount 2026-10-26) and 165 in the SF bbox (PBF recount 2026-10-26) (SF city polygon 165). |

Caltrans fields: BRIDGE (number), NAME, FAC (facility carried), INTERSEC (feature crossed), YRBLT, LENG, MAINSPANS, APPSPANS, DECKWIDTH, DESIGN_MAIN, RTE, PM, CO, LAT, LON. **It is points only: no lane count, no vertical clearance, no deck elevation.** It is an index of structures, not geometry. Tunnels do not appear in it (a Caltrans tunnel inventory: UNCONFIRMED).

Join rule: a divided pair is often two records with suffix L/R (34 0157L/R, 33 0616L/R, 33 0061L/R). Match OSM ways to Caltrans points by nearest point within ~60 m plus matching `RTE`, not by name.

## 2. How many things

- Phase 1 SF: 772 OSM bridge ways, 122 Caltrans bridges.
- Phase 2: 901 OSM bridge ways, 222 Caltrans bridges.
- Most OSM bridge ways are short (ramps, overpasses, footbridges). Only a few tens need custom stacked-deck treatment (sections 3-4). The rest use the generic recipe in section 6.

## 3. Elevated structures and viaducts (Caltrans layer, length >= 200 m unless noted; queried 2026-10-26)

Columns: bridge number, length m, whole-structure deck width m, year built. Lanes are not in the layer: take them from OSM `lanes` and the lidar.

### 3a. Bay Bridge and approaches (I-80)
| Bridge no. | Name | Len | Width | Year | Notes for modelling |
|---|---|---|---|---|---|
| 34 0003 | SFOBB West Bay | 6281 | 19.1 | 1936 | Two decks, one above the other. Two 704 m suspension spans. Upper deck westbound, lower eastbound, 5 lanes total per Wikipedia (57.5 ft wide traffic section). Layer length includes the truss/viaduct approaches. https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge |
| 34 0126L / 34 0126R | SFOBB approach upper deck (WB) / lower deck (EB) | 970 / 603 | 21.0 / 19.4 | 2008 | New concrete approach from Fremont/First to the anchorage: two stacked decks, ramps pass under. |
| 34 0127S / 34 0128K | Fremont St off-ramp / Harrison St off-ramp | 550 / 218 | 12.0 / 8.2 | 2008 | Curved ramps stacked over local streets. |
| 34 0006 | SFOBB East Span (SAS) | 3512 | 50.2 | 2013 | One wide deck, 10 lanes both directions side by side (not stacked), bike/ped path on the south side. Opened 2 Sept 2013. https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge |
| 34 0173J | YBI WB off-ramp | 251 | 9.1 | 2016 | New YBI ramps |
| 33 0601, 33 0613L, 33 0624S, 33 0623S | Bay Bridge HOV separation, HOV-toll plaza OC, Maritime on-ramp, Maritime off-ramp | 704, 446, 436, 1228 | 8-11 | 1995-98 | Oakland touchdown / toll plaza (18 toll lanes per Wikipedia). |
| 33 0612E | Port of Oakland connector viaduct (I-80/I-880) | 3458 | 16.6 | 1996 | |
| 33 0611R / 0611L / 0611S / 0611K | East Bay Viaduct (I-880 NB, SB, on-ramp, off-ramp) | 2494 / 1941 / 265 / 527 | 16.6 / 10.8 / 8.4 / 10.8 | 1994-98 | |
| 33 0610M | 7th Street seal slab | 1010 | 32.1 | 1997 | Likely a buried/covered slab; treat as cover, UNCONFIRMED. |
| 33 0768 | West Grand Ave viaduct | 1014 | 25.5 | 1997 | |

### 3b. YBI and Treasure Island (Local bridges layer)
34C0078 Treasure Island Rd separation #2 (151 m, 1964); 34C0079 TI Rd sidehill viaduct #3 (75 m, 1964). A full YBI/TI list: UNCONFIRMED.

### 3c. SF freeway viaducts and interchanges
| Bridge no. | Name | Len | Width | Year | Notes |
|---|---|---|---|---|---|
| 34 0077 | Central Viaduct (US-101) | 3065 | 24.4 | 1955 | 103 + 52 spans |
| 34 0177 | Central Viaduct (West) | 434 | 27.0 | 2005 | Central Freeway history: opened 1955 to Mission St, 1959 to Turk; cut back after Loma Prieta; Octavia Blvd project opened 9 Sept 2005; the elevated part now runs over Division/13th and descends at Market St. https://en.wikipedia.org/wiki/Central_Freeway |
| 34 0088 | Bayshore Viaduct (US-101) | 2287 | 24.4 | 1955 | |
| 34 0046 | Southern Freeway Viaduct (I-280) | 6580 | 33.3 | 1965 | 234 spans; double-deck section, NB lower and SB upper (https://en.wikipedia.org/wiki/Interstate_280_(California)). |
| 34 0100 | China Basin Viaduct (I-280) | 3353 | 41.3 | 1971 | North end near King/5th; ramps 34 0123L (on) and 0123R (off), 1998, ~420-440 m. |
| 34 0070, 0070E, 0070H, 0071F, 0131L, 0132R, 0134G, 0135G, 0136G | 280/101 interchange directional ramps | 275-608 | ~11.4 | 1960-66 | Nine directional ramps; 34 0070 is upper S280-S101 over lower N101-N280. Most stacked piece in SF. |
| 34 0033, 0034S, 0114J, 0115K | Alemany Circle UC, Cesar Chavez UC and ramps | 228-325 | 7.9-26.8 | 1950-74 | |
| 34 0157R / 0157L | Presidio Viaduct (US-101) | 426 / 408 | 15.7 / 24.2 | 2015 / 2012 | Part of Presidio Parkway |
| 34 0017, 34 0021, 34 0098, 34 0081 | Kobbe Ave UC, Alemany Blvd OC, 20th St OC, Monterey Blvd on-ramp | 216-301 | 8-15 | 1939-68 | |
| 34C0029 / 0030 / 0032 / 0034 | Market St sidehill viaducts (Twin Peaks) | 184 / 171 / 91 / 113 | 14-26 | 1958 | Local layer |
| 34C0056, 34C0067, 34C0063 | Bryant St sidehill (118 m), Ingerson Ave sidehill (76 m), Lincoln Way separation (73 m) | | | 1953-59, 1931 | Local layer |
| 34C0086, 34C0088 | Transit Center bus ramp viaduct (318 m), bus storage ramp (139 m) | | 11.8 / 8.5 | 2018 | Local layer |
| 34C0076, 34C0025 | Illinois St intermodal bridge (140 m), Channel St/Third St (90 m) | | | 2008, 1932 | Islais Creek, Mission Creek |

Do not model: Embarcadero Freeway (opened 1959, demolition began 27 Feb 1991; https://en.wikipedia.org/wiki/Embarcadero_Freeway), the Cypress Viaduct (collapsed 1989, now Mandela Parkway; https://en.wikipedia.org/wiki/MacArthur_Maze), the old Bay Bridge east span (demolition completed Sept 2018, Wikipedia above), the double-deck Central Freeway north of Mission.

### 3d. Golden Gate and Marin
27 0052 Golden Gate Bridge, 2742 m, 18.9 m, 1937 (existing in code; 6 lanes, https://en.wikipedia.org/wiki/Golden_Gate_Bridge). 27 0010 Richardson Bay bridge, 873 m, 1957 (Phase 3).

### 3e. East Bay: MacArthur Maze, I-880, I-980, I-580, SR-24
| Bridge no. | Name | Len | Width | Year | Notes |
|---|---|---|---|---|---|
| 33 0061R / 0061L | Distribution Structure (MacArthur Maze core) | 1124 / 1218 | 10.0 | 1935 / 1955 | Three levels: third level added 24 Oct 1955. 2007 tanker fire collapsed a 168 ft connector, rebuilt in 26 days. https://en.wikipedia.org/wiki/MacArthur_Maze |
| 33 0303H, 0302H, 0304G, 0305F | Connectors 580-980, 580-24, 980-580, 24-580 | 1009, 1201, 829, 1564 | 10-12 | 1970 | The SR-24/I-980/I-580 interchange, a separate four-level stack finished 1985, ~1 mi east of the Maze (same Wikipedia page). 33 0305F has 58 spans. |
| 33 0344F | S13-E580 connector | 201 | 12.1 | 1965 | |
| 33 0200 | 5th and 6th Street Viaduct (I-880, old) | 1274 | 34.8 | 1953 | |
| 33 0616L / 0616R | 5th and 6th Street Viaduct (I-880 SB/NB, new) | 1138 / 1104 | 21.8 | 1998 | |
| 33 0484G, 0485K, 0483F | N880-E980 connector, 980/260 separation, 980 SB connector | 288, 512, 551 | 8-17 | 1985 | |
| 33 0421R/L, 0440 | 27th St UC, San Pablo UC (I-980) | 314, 201, 293 | 24.7, 51.6 | 1969-73 | |
| 33 0754, 0732R/L | 5th Ave OH, High St separation (I-880) | 727, 525/523 | 47.1, 25.5 | 2013 | |
| 33 0041, 0198, 0100, 0137, 0753 | Fruitvale OH, Madison UC, San Leandro BOH, 16th Ave OC, 23rd Ave OC (I-880) | 207-430 | 12-43 | 1947-2020 | |
| 33 0740 | Hegenberger UP (BART aerial) | 1003 | - | 2014 | Oakland Airport Connector |
| 33 0417R/L, 0419L | College Ave UC, Patton St UC (SR-24) | 411, 421, 257 | 21.0 | 1970 | |
| 33 0285, 0287, 0131, 0280L/R | Broadway-Richmond, MacArthur Blvd, Lakeshore Park, Adeline (I-580) | 255-326 | 10-45 | 1961-62 | |
| 33 0051L/R, 0023, 0661, 0764 | El Cerrito separations (I-80), University Ave OC, Eastshore POC, Gilman POC | 653/643, 419, 215, 336 | | 1939-2023 | Berkeley/Albany stretch |
| 33 0086 | San Leandro Bay (SR-61 bascule) | 294 | 19.9 | 1953 | Movable span |
| 33C0026, 0027, 0147 | High St, Park St, Fruitvale (Miller Sweeney) bridges over the Estuary | 154, 132, 120 | 7.9-19.6 | 1934-74 | Local layer; bascule/lift spans |
| 33C0183, 0028, 0399, 0184, 0148, 0202 | Rail overheads: Powell, Adeline, 40th, Buchanan, 23rd Ave, Hegenberger | 139-342 | 17-26 | 1962-95 | Local layer |

Some "length" values (e.g. 33 0305F) may combine several structures; verify against OSM way chains before hardcoding.

## 4. Tunnels

OSM tunnel ways in the SF bbox (Overpass, 2026-10-26): Presidio Parkway (5 ways, motorway, layer -1, lanes 4); Dwight D. Eisenhower Highway = the YBI tunnel (2 ways, motorway, layer -1, lanes 5); General Douglas MacArthur Tunnel (2 ways, lanes 2); Geary Boulevard underpasses (4 ways, primary, lanes 2); Junipero Serra Freeway underpass (1, motorway, lanes 3); San Jose Avenue (2); Broadway (1 way + 1 tagged `highway=construction`, lanes 2); Stockton Tunnel (tertiary, layer -2, lanes 2); 4 unnamed motorway_link tunnel ways near 37.804,-122.471 (Presidio ramps); Baker-Barry Tunnel and Alexander Ave (Marin, Phase 3). Phase-2 East Bay tunnel ways: UNCONFIRMED (query failed).

| Structure | Length | Lanes / levels | Opened | Bake notes | Source |
|---|---|---|---|---|---|
| **Yerba Buena Island Tunnel (I-80)** | **540 ft (160 m)** (another site says ~546 m / 0.5 mi: treat as wrong) | Two decks, 5 lanes each, upper WB and lower EB. Bore 76 ft wide x 58 ft high overall. | 12 Nov 1936, rebuilt 1961-62 | Chain west to east: 321 ft concrete viaduct, tunnel, 790.8 ft viaduct, 1,169.7 ft curved steel truss viaduct, then the SAS. OSM has two 5-lane ways at layer -1; split by deck. | https://en.wikipedia.org/wiki/Yerba_Buena_Tunnel ; https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge |
| **Presidio Parkway: Battery Tunnels** | 850 ft | 3 lanes each way (Arup) vs 3+2 shoulder NB / 4 SB (TunnelTalk): conflicting, UNCONFIRMED | July 2015 (12 Jul per Presidio Trust) | Cut-and-cover twin bores, park on top. | https://www.arup.com/projects/presidio-parkway ; https://tunneltalk.com/USA-22May2015-San-Francisco-Presidio-Parkway-final-preparations.php ; https://wp.presidio.gov/wp-content/uploads/2023/08/202203-battery-bluff-fact-sheet-nrthrn-waterfront.pdf (figures via search summary; TunnelTalk page itself failed to load, UNCONFIRMED) |
| **Presidio Parkway: Main Post Tunnels** | 1,020 ft | as above | July 2015 | Cut-and-cover twin bores | same |
| **Broadway Tunnel (Robert C. Levy)** | 1,616 ft (493 m) per bore | 2 bores x 2 lanes, narrow outboard sidewalks, ~20 ft clearance (13 ft 6 in at east end) | 21 Dec 1952 | Two parallel bores, layer -1. | https://en.wikipedia.org/wiki/Broadway_Tunnel_(San_Francisco) |
| **Stockton Street Tunnel** | 911 ft (278 m) | 3 lanes, 50 ft wide, 13 ft clearance, max grade 4.29% | 29 Dec 1914 | Single bore, OSM layer -2. | https://en.wikipedia.org/wiki/Stockton_Street_Tunnel |
| **Fort Mason Tunnel (rail)** | length UNCONFIRMED | single track | built 1913, opened 1914, closed 1993 | Disused State Belt Railroad tunnel, NPS-owned; no cars. Visual only. | https://en.wikipedia.org/wiki/Fort_Mason_Tunnel |
| **Posey Tube** | 3,545 ft tunnel, 4,436 ft with approaches (1,352 m) | 1 tube, 2 lanes, one-way to Oakland, 14.67 ft clearance | 27 Oct 1928 | Immersed tube, art deco portals. | https://en.wikipedia.org/wiki/Posey_and_Webster_Street_Tubes |
| **Webster Street Tube** | 3,350 ft underwater, 5,923 ft with approaches (1,805 m) | 1 tube, 2 lanes, 24 ft roadway, one-way to Alameda, ~15 ft clearance | 13 Feb 1963 | Immersed tube. | same |
| **Caldecott Tunnel (SR-24), Phase 3** | bores 1-2: 3,610 ft; bore 3: 3,771 ft; bore 4: 3,389 ft | 4 bores x 2 lanes; bores 1-2 eastbound, 3-4 westbound | 1937, 1964, 2013 | Needs Contra Costa/Alameda lidar at the county line. | https://en.wikipedia.org/wiki/Caldecott_Tunnel |
| MacArthur Tunnel, Geary underpasses, Junipero Serra underpass, San Jose Ave | lengths and openings UNCONFIRMED | per OSM tags above | | Short cut-and-cover | OSM only |

## 5. Modelling facts

1. **Stacked levels:** Bay Bridge west span (2 decks), YBI tunnel (2), Southern Freeway Viaduct (2), MacArthur Maze (3), SR-24/I-980/I-580 (4), 280/101 interchange (several directional ramps). Single wide deck: SAS and Golden Gate.
2. **Tunnels:** lidar shows only the exterior, so the "never below terrain" clamp (MAP_RESOURCES item 7) must be replaced: use OSM `layer`/`level` plus portal-to-portal elevation interpolation, draw a roof above.
3. **Immersed tubes (Posey, Webster):** under water; lidar gives nothing there. Model as a ramp-down and ramp-up with a constant slope between portals; bathymetry (CoNED) only for visuals.
4. **Grade sanity checks:** HDM ramp max 8% (MAP_RESOURCES.md); Stockton Tunnel max 4.29% (above).
5. **Filter stale OSM:** exclude `construction`, `proposed`, `abandoned` ways (Broadway has one `construction` tunnel way).

## 6. How to get deck surfaces (recommendation)

**What the data says.** The 2023 SF lidar `CA_SanFrancisco_1_B23` is classified LAS 1.4, ~44 pts/m² (this is total/first-return pulse density; measured on real points 2026-10-26: 121–154 pts/m² all returns and 31–42 pts/m² ground (class 2) over mixed SF blocks, see lidar-probes.md §1) (corrected 2026-10-26), nominal pulse spacing 0.15 m, collected spring 2023, NVA RMSEz 1.73 cm, 654 tiles of 500 x 500 m (corrected 2026-10-26), and its class list includes **17 = Bridge Decks** (also 1, 2, 7, 9, 18, 20). Record: https://www.fisheries.noaa.gov/inport/item/73386 ; EPT (EPSG:3857, NAVD88 metres): https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SanFrancisco_1_B23/ept.json. The record says nothing about how elevated ramps and stacked decks were classified, and USGS reports state classification beyond the minimum is not independently verified (example class list: https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/metadata/CA_MountainPass_2019_D19/CA_MountainPass_2019_D19_WP_Report.pdf). **Real class-17 coverage over SF decks and over Alameda 2021: UNCONFIRMED** until a PDAL test.

**Method.**
1. Build the structure list: union of OSM motorway/trunk/primary ways with `bridge=*` or `tunnel=*` and Caltrans points within ~60 m.
2. Corridor per OSM way: Caltrans `DECKWIDTH`/2 + 3 m, or `lanes` x 3.66 m + 2 m shoulders.
3. Crop EPT to the corridor (PDAL `readers.ept` `bounds`, `filters.range` `Classification[17:17]`). Fallback if sparse: first returns inside the corridor, split into levels by vertical clusters with a ~3 m gap so stacked decks separate.
4. Sample along the centreline every ~2 m; take median Z of deck points across the width (robust to cars, rails, poles); smooth with a spline limited to grade caps (ramps 8%).
5. Cross-slope per station by plane fit (crown 2%, superelevation to 10%, MAP_RESOURCES.md).
6. Clearance: ground/class-2 returns under the deck; deck thickness inferred from the difference between deck top and underside returns.
7. Each deck is its own surface with a level index. This needs the stacked-deck contract change (item 6 in MAP_RESOURCES.md; physics sign-off).
8. Hand-check the ~10 largest structures (Bay Bridge west and approaches, YBI, SAS, 280/101, Maze, Southern Freeway Viaduct, Central/Bayshore Viaducts, Presidio Parkway) in CloudCompare/QGIS before shipping.

Cross-checks: Caltrans LENG/DECKWIDTH above; HAER LoC `ca1352` for the Bay Bridge (MAP_RESOURCES.md); comma2k19 for I-280.

## 7. Open questions
- Class 17 coverage over stacked decks (test tile near -122.395, 37.781) and the Alameda 2021 class list.
- Presidio Parkway tunnel lengths and lanes from a primary source.
- Fort Mason Tunnel length; MacArthur Tunnel and Geary underpass lengths.
- OSM deck tagging on the Bay Bridge (one way per deck?) and the grouped bridge list: needs a PBF extract.
- East Bay OSM tunnel list; a Caltrans tunnel inventory.

## Fact-check

Independent check, 2026-10-26.

| # | Claim | Verdict | Correction / source |
|---|---|---|---|
| 1 | Caltrans State Highway Bridges: 122 (Phase 1 bbox), 222 (Phase 2), 364 (union); Local Bridges 41 per bbox | **Confirmed** (Local Bridges only for SF bbox) | Re-ran `returnCountOnly` on https://gisdata.dot.ca.gov/arcgis/rest/services/CHhighway/State_Highway_Bridges/MapServer/0: 122 / 222 / 364. Local_Bridges/MapServer/0 SF bbox: 41. Phase-2 Local count (41) and union (93) not re-run. "Partial subset" is an inference, UNCONFIRMED. |
| 2 | OSM: 772 bridge ways (SF), 901 (Phase 2); of 406 SF tunnel ways only ~25 are vehicle tunnels | **Unverifiable** | overpass-api.de and overpass.kumi.systems returned nothing (unreachable) on 2026-10-26. UNCONFIRMED; rerun from a Geofabrik PBF. |
| 3 | B23 lidar: LAS 1.4, class 17 in class list, ~44 pts/m2, NVA RMSEz 1.73 cm; deck coverage unverified | **Mostly confirmed; "44 pts/m2" is not sourced** | https://www.fisheries.noaa.gov/inport/item/73386 confirms LAS 1.4, 654 tiles, 0.15 m nominal pulse spacing, NVA RMSEz 1.73 cm, and "bridge decks" among the classes (the page names classes, not the number 17; 17 is the standard ASPRS code). No density figure appears: 44 is only 1/0.15^2 = 44.4 pulses/m2, a pulse (not point) density derived by arithmetic. Reword as "~44 pulses/m2 (derived from 0.15 m spacing)". |
| 4 | YBI tunnel 540 ft (160 m), 76 x 58 ft, two decks of 5 lanes (upper WB, lower EB), 321 ft and 790.8 ft viaducts, 1,169.7 ft truss | **Confirmed** | https://en.wikipedia.org/wiki/Yerba_Buena_Tunnel: 540 ft, 76 ft x 58 ft overall, ten lanes on two decks, upper WB / lower EB. https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge: 321 ft, 790.8 ft, 1,169.7 ft truss. Note: the Bay Bridge page also gives 5 lanes in a 57.5 ft section, so Section 3a's "5 lanes total" for the west span is better stated as 5 lanes per direction (one per deck). Truss "to the SAS" order is plausible but the order of 321 ft viaduct vs tunnel was not checked in detail. |
| 5 | Broadway 1,616 ft, 2 bores x 2 lanes (1952); Stockton 911 ft, 3 lanes, 4.29% (1914); Posey 3,545 ft (1928), Webster 3,350 ft underwater (1963), 2 lanes one-way; Caldecott 4 bores (3,389-3,771 ft) | **Confirmed** | Broadway (opened 21 Dec 1952), Stockton (opened 29 Dec 1914, max grade 4.29%), Posey/Webster (opened 27 Oct 1928 / 13 Feb 1963; 3,545 ft and 3,350 ft underwater, 2 lanes; Posey one-way to Oakland, Webster one-way to Alameda), Caldecott (bores 3,610 / 3,610 / 3,771 / 3,389 ft, 2 lanes each) all match the cited Wikipedia pages. |

- PBF recount 2026-10-26: OSM counts re-verified against a Geofabrik extract; see probes/osm_recount_vs_notes.json.

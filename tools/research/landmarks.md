## Method and confidence

- Coordinates and QIDs: Wikidata SPARQL (https://query.wikidata.org/sparql, one query per batch, 2026-10-26). Coordinates are Wikidata P625 as returned. They are not surveyed centroids, so snap to the OSM footprint at bake time (bake.py already does this for 11 of the 16 current landmarks).
- Heights/dims marked "(src)" were read from the cited page. Anything else is **UNCONFIRMED** (from memory, or not on the page I fetched).
- Reference column: HABS/HAER are public domain (US government). "Commons" means the Wikimedia Commons category for that name. I did not open the Commons pages, so every per-file licence is **UNCONFIRMED**. Licence rule: only PD/CC0/CC BY files may feed shipped data. CC BY-SA files (common on Commons) are NOT on our allowed list, so use them for eyeballing only.
- Priority: 1 = skyline/route-defining, build by hand; 2 = recognisable, build as kit/simple hero; 3 = flavour, let the generic building pipeline carry it.

## A. Phase 1: San Francisco (30)

| # | Name | Lat, Lon (Wikidata) | QID | Height / footprint (src) | Distinctive geometry | Best redistributable reference | Pri |
|---|---|---|---|---|---|---|---|
| 1 | Golden Gate Bridge | 37.81972, -122.47861 | [Q44440](https://www.wikidata.org/wiki/Q44440) | towers 746 ft/227 m, main span 4,200 ft/1,280 m, length 8,981 ft, width 90 ft/27.4 m, clearance 220 ft/67 m, 6 lanes (src: https://en.wikipedia.org/wiki/Golden_Gate_Bridge) | art-deco tower setbacks, portal struts, 2 cables, vertical suspenders, Warren stiffening truss, sidewalks outside cable planes, Fort Point arch, approach viaducts | HAER CA-31 (photos), LoC drawings `ca3663` (from MAP_RESOURCES.md, not re-verified); lidar for deck profile | 1 |
| 2 | Salesforce Tower | 37.7899, -122.397 | [Q14684154](https://www.wikidata.org/wiki/Q14684154) | 326 m with crown, roof 296 m, 61 floors, opened 2018 (src: https://en.wikipedia.org/wiki/Salesforce_Tower) | rounded-square tapering obelisk, crown last ~30 m | none PD; Pelli Clarke Pelli spec sheets UNCONFIRMED; measure from 2023 lidar | 1 |
| 3 | Transamerica Pyramid | 37.795135, -122.402748 | [Q216865](https://www.wikidata.org/wiki/Q216865) | 260 m, 48 floors, 1972, floor 5 is 21,025 sq ft, top floor 2,025 sq ft (45 ft side), base ~175 ft/53.3 m, wings start floor 29 (src: https://en.wikipedia.org/wiki/Transamerica_Pyramid ; https://sfyimby.com/2021/12/number-3-transamerica-pyramid-in-the-financial-district-san-francisco.html ; https://skyscraperpage.com/b1601) | square pyramid, east wing = elevator shaft, west wing = stairs/smoke tower, hollow spire | lidar + above; HABS UNCONFIRMED | 1 |
| 4 | 181 Fremont | 37.7897, -122.395 | [Q4554120](https://www.wikidata.org/wiki/Q4554120) | UNCONFIRMED (about 245 m) | slender faceted tower; post-2010, so DataSF height is missing | lidar | 2 |
| 5 | Millennium Tower | 37.790278, -122.396111 | [Q1833555](https://www.wikidata.org/wiki/Q1833555) | 196.6 m (Wikidata P2048) | rectangular glass tower, tilted (~ 0.6 m lean UNCONFIRMED) | lidar | 3 |
| 6 | Salesforce Transit Center / Park | 37.789682, -122.396618 | [Q7833806](https://www.wikidata.org/wiki/Q7833806) | UNCONFIRMED (~ 1.6 km long, rooftop park) | perforated white aluminium skin, rooftop park, bus ramp from Fremont | lidar | 2 |
| 7 | Coit Tower | 37.8025, -122.405833 | [Q1107297](https://www.wikidata.org/wiki/Q1107297) | 210 ft/64 m overall, shaft 180 ft/55 m, deck 32 ft below top, 1933 (src: https://en.wikipedia.org/wiki/Coit_Tower) | tapering fluted shaft, rotunda base, open-arched crown, sits on Telegraph Hill (crest ~ 87 m, UNCONFIRMED) | lidar; HABS UNCONFIRMED | 1 |
| 8 | Ferry Building | 37.795556, -122.393611 | [Q1408117](https://www.wikidata.org/wiki/Q1408117) | clock tower 245 ft/75 m, 4 dials 22 ft/6.7 m, Great Nave 660 ft/200 m, 1898 (src: https://en.wikipedia.org/wiki/San_Francisco_Ferry_Building) | long low arcaded hall, central tower with tiered stages and cupola | HABS CA-1910 (photos/data, no drawings found): https://www.loc.gov/item/ca1504 | 1 |
| 9 | San Francisco City Hall | 37.779278, -122.419278 | [Q1093944](https://www.wikidata.org/wiki/Q1093944) | dome 307.5 ft/93.7 m, dome dia 112 ft/34 m, 390 x 273 ft (119 x 83 m), 2 blocks, 1913-16 (src: https://en.wikipedia.org/wiki/San_Francisco_City_Hall) | coupled-column drum, ribbed dome, gilded lantern | HABS CA-1881 (earthquake damage survey): https://www.loc.gov/item/ca0633 UNCONFIRMED which record is which | 1 |
| 10 | Palace of Fine Arts | 37.802778, -122.448333 | [Q966263](https://www.wikidata.org/wiki/Q966263) | rotunda 162 ft/49 m, pergola 1,100 ft/340 m, 1915 (src: https://en.wikipedia.org/wiki/Palace_of_Fine_Arts) | open rotunda on octagon, curved colonnade, lagoon | Commons (licence UNCONFIRMED) | 1 |
| 11 | Alcatraz Island | 37.82672, -122.422833 | [Q131354](https://www.wikidata.org/wiki/Q131354) | island 1,675 x 590 ft (511 x 180 m), 135 ft/41 m high point (src: https://en.wikipedia.org/wiki/Alcatraz_Island) | cell house on crest, lighthouse, water tower (1940), guard tower, warden house ruin | HABS CA-1792-A cell house, one measured drawing: https://www.loc.gov/item/ca1498 | 1 |
| 12 | Sutro Tower | 37.7552, -122.4528 | [Q650097](https://www.wikidata.org/wiki/Q650097) | 297.8 m (977 ft) on 254.2 m ground; legs 45.7 m apart at base, 18.3 m at waist, 30.5 m at antenna (src: https://en.wikipedia.org/wiki/Sutro_Tower) | three-legged truss, red/white, antenna arrays | lidar + dims above | 1 |
| 13 | Oracle Park | 37.778333, -122.389444 | [Q298585](https://www.wikidata.org/wiki/Q298585) | opened 2000, 41,331 seats, LF line 339 ft, CF 391, RC 415, RF line 309, RF wall 24 ft/7.3 m (src: https://en.wikipedia.org/wiki/Oracle_Park) | brick facade, clock tower, McCovey Cove arches, bottle slide (80 ft/24 m), light towers | lidar + OSM footprint | 1 |
| 14 | Chase Center | 37.767833, -122.387389 | [Q15262098](https://www.wikidata.org/wiki/Q15262098) | UNCONFIRMED | oval arena, large LED facade | lidar + OSM | 2 |
| 15 | Bank of America Center (555 California) | UNCONFIRMED (near 37.7919, -122.4034) | UNCONFIRMED | UNCONFIRMED (about 237 m) | dark granite faceted tower | lidar | 3 |
| 16 | Embarcadero Center | 37.7947, -122.398 | [Q3493067](https://www.wikidata.org/wiki/Q3493067) | UNCONFIRMED | 4 towers on podium + bridges | lidar + OSM | 3 |
| 17 | Fort Point | 37.81056, -122.47722 | [Q1438659](https://www.wikidata.org/wiki/Q1438659) | 7 ft thick walls, built 1853-61, cliff cut from 90 ft to 15 ft above sea (src: https://en.wikipedia.org/wiki/Fort_Point,_San_Francisco) | multi-tier brick casemates, parade ground, sits under GG south arch | HABS: not found in my search (try call number prefix `HABS CAL,38-SANFRA`) UNCONFIRMED | 1 |
| 18 | Sutro Baths ruins / Cliff House | 37.78, -122.513611 | [Q3505806](https://www.wikidata.org/wiki/Q3505806) | UNCONFIRMED | concrete pool ruins, cliff-edge | lidar | 3 |
| 19 | Painted Ladies (Postcard Row) | 37.7764, -122.4331 (page coord is generic) | no QID found | row 710-720 Steiner St, 1892-96, nickname "Seven Sisters" (src: https://en.wikipedia.org/wiki/Painted_Ladies) | Queen Anne/Italianate rows with bays, across Alamo Square | Commons UNCONFIRMED | 2 |
| 20 | Lombard Street (crooked block) | 37.801944, -122.418889 | [Q930276](https://www.wikidata.org/wiki/Q930276) | 8 turns, 27% (MAP_RESOURCES.md) | brick hairpins, planter beds | DataSF centerline + lidar | 1 |
| 21 | Chinatown Dragon Gate | 37.790685, -122.405585 | [Q40729318](https://www.wikidata.org/wiki/Q40729318) | UNCONFIRMED | 3-arch green-tile gate, dragons, lions | Commons UNCONFIRMED | 3 |
| 22 | Grace Cathedral | UNCONFIRMED (about 37.7919, -122.4132) | [Q5591026](https://www.wikidata.org/wiki/Q5591026) | UNCONFIRMED | Gothic revival twin towers on Nob Hill | lidar | 3 |
| 23 | Cathedral of St Mary of the Assumption | 37.784201, -122.425297 | [Q4347013](https://www.wikidata.org/wiki/Q4347013) | UNCONFIRMED | hyperbolic-paraboloid shell with cross-shaped skylights | lidar | 2 |
| 24 | Ghirardelli Square | 37.805876, -122.42295 | [Q5556730](https://www.wikidata.org/wiki/Q5556730) | UNCONFIRMED | brick complex, rooftop neon sign | OSM footprint | 3 |
| 25 | Pier 39 | 37.809992, -122.410357 | [Q1856083](https://www.wikidata.org/wiki/Q1856083) | UNCONFIRMED | wooden pier, sea-lion K-dock | OSM | 3 |
| 26 | Legion of Honor | 37.784466, -122.500842 | [Q2468251](https://www.wikidata.org/wiki/Q2468251) | UNCONFIRMED | neoclassic colonnade court | OSM | 3 |
| 27 | de Young Museum | 37.771469, -122.468676 | [Q1470276](https://www.wikidata.org/wiki/Q1470276) | UNCONFIRMED (tower ~ 44 m) | copper-clad twisting tower | OSM + lidar | 3 |
| 28 | California Academy of Sciences | 37.77, -122.466389 | [Q965731](https://www.wikidata.org/wiki/Q965731) | UNCONFIRMED | green living roof with domes | lidar canopy model | 3 |
| 29 | Conservatory of Flowers | 37.772, -122.46 | [Q5163145](https://www.wikidata.org/wiki/Q5163145) | UNCONFIRMED | white Victorian glasshouse with dome | OSM | 3 |
| 30 | Mission San Francisco de Asis | 37.7644, -122.427 | [Q1000321](https://www.wikidata.org/wiki/Q1000321) | UNCONFIRMED | adobe mission | OSM | 3 |

SF extras worth a pass (all UNCONFIRMED heights): Twin Peaks [Q1344297](https://www.wikidata.org/wiki/Q1344297) 37.7516, -122.448; Cow Palace [Q604015](https://www.wikidata.org/wiki/Q604015); Rincon Center [Q1877405](https://www.wikidata.org/wiki/Q1877405); Cupid's Span [Q3007583](https://www.wikidata.org/wiki/Q3007583) 37.7916, -122.39; Fort Mason [Q948933](https://www.wikidata.org/wiki/Q948933); Hyde Street Pier [Q12060640](https://www.wikidata.org/wiki/Q12060640); Wave Organ [Q7975291](https://www.wikidata.org/wiki/Q7975291); Exploratorium [Q206518](https://www.wikidata.org/wiki/Q206518); Presidio [Q1755360](https://www.wikidata.org/wiki/Q1755360).

## B. Phase 2: Bay Bridge, YBI, Treasure Island, Oakland, Emeryville, Berkeley (21)

| # | Name | Lat, Lon | QID | Height / footprint (src) | Distinctive geometry | Reference | Pri |
|---|---|---|---|---|---|---|---|
| 31 | Bay Bridge west span | 37.8180, -122.3467 is the Wikidata point for the whole bridge | [Q771404](https://www.wikidata.org/wiki/Q771404) | 2 main spans 704 m each, towers 160 m, total 3,141 m; deck 5 lanes/17.5 m per deck; clearance below 67 m (src: https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge) | 2 decks, 4 towers, centre anchorage, Rincon Hill touchdown | HAER CA-229 / LoC `ca1352` ~ 400 original drawing copies: https://loc.gov/pictures/item/ca1352 (PD) | 1 |
| 32 | Bay Bridge east span (SAS) | along same axis, east of YBI | same QID | single 385 m tower 160 m, east span total 3,102 m, 10 lanes/78.7 m (src: same page) | self-anchored suspension, single asymmetric tower, skyway, Oakland touchdown | Caltrans/ASCE sheets UNCONFIRMED; lidar | 1 |
| 33 | Yerba Buena Tunnel | 37.809444, -122.365556 | [Q47516798](https://www.wikidata.org/wiki/Q47516798) | 540 ft/160 m long, bore 76 ft wide x 58 ft high outside, 66 x 53 ft inside (src: Bay Bridge page) | double-deck tunnel, portals both sides | HAER (YBI records `ca2554`, `ca2555`) UNCONFIRMED content | 1 |
| 34 | Yerba Buena Island | 37.809928, -122.366082 | [Q768669](https://www.wikidata.org/wiki/Q768669) | UNCONFIRMED | road loops, Coast Guard buildings, Nimitz House (HABS CA-1793-B, UNCONFIRMED) | HABS/HAER on loc.gov | 2 |
| 35 | The Bay Lights | 37.819, -122.349 | [Q7715933](https://www.wikidata.org/wiki/Q7715933) | original 25,000 LEDs switched off 2023-03-05 (src: Bay Bridge page); The Bay Lights 360 relaunched 2026-03-20 with ~48,000 white LEDs on the north cable plane of the west span, nightly dusk to dawn (illuminate.org; see night-lighting-data.md) (corrected 2026-10-26) | LED cable art; decide whether to show (design call) | none needed | 3 |
| 36 | Treasure Island | 37.824167, -122.371111 | [Q778565](https://www.wikidata.org/wiki/Q778565) | UNCONFIRMED | flat artificial island, Hangars 1-3, Building 1 | HABS/HAER on loc.gov UNCONFIRMED | 2 |
| 37 | Oakland City Hall | 37.8053, -122.2725 | [Q932794](https://www.wikidata.org/wiki/Q932794) | 320 ft/98 m, 18 floors, 1910-14 (src: https://en.wikipedia.org/wiki/Oakland_City_Hall) | 3-tier wedding-cake, clock tower | lidar | 1 |
| 38 | Tribune Tower (Oakland) | 37.8031, -122.2705 | [Q7840494](https://www.wikidata.org/wiki/Q7840494) | 305 ft/93 m, 22 floors, clock tower 1923 (src: https://en.wikipedia.org/wiki/Tribune_Tower_(Oakland)) | Venetian-campanile style clock tower | lidar | 2 |
| 39 | Fox Oakland Theatre | 37.808889, -122.269167 | [Q5476853](https://www.wikidata.org/wiki/Q5476853) | UNCONFIRMED | Moorish/Art Deco vertical sign tower | OSM | 2 |
| 40 | Paramount Theatre (Oakland) | 37.81, -122.268 | [Q14683611](https://www.wikidata.org/wiki/Q14683611) | UNCONFIRMED | Art Deco facade, vertical sign | OSM | 3 |
| 41 | Kaiser Center | 37.8088, -122.264 | [Q14682900](https://www.wikidata.org/wiki/Q14682900) | UNCONFIRMED | 28-storey tower, rooftop garden (UNCONFIRMED) | lidar | 2 |
| 42 | Lake Merritt | 37.8039, -122.2591 | [Q3623431](https://www.wikidata.org/wiki/Q3623431) | UNCONFIRMED | tidal lagoon, "necklace of lights" | OSM water + lidar | 1 |
| 43 | Cathedral of Christ the Light | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | vesica piscis timber frame | lidar | 3 |
| 44 | Oakland Coliseum | 37.751667, -122.200556 | [Q1147732](https://www.wikidata.org/wiki/Q1147732) | UNCONFIRMED | twin bowls, Mt Davis stand | lidar + OSM | 3 |
| 45 | Port of Oakland cranes / Middle Harbor | 37.8058, -122.324 | [Q6841447](https://www.wikidata.org/wiki/Q6841447) | UNCONFIRMED | gantry cranes, container stacks | lidar | 2 |
| 46 | USS Hornet (CV-12) | 37.772778, -122.302778 | [Q1141355](https://www.wikidata.org/wiki/Q1141355) | UNCONFIRMED | carrier at Pier 3 Alameda | OSM | 3 |
| 47 | Sather Tower (Campanile) | 37.871944, -122.257778 | [Q357019](https://www.wikidata.org/wiki/Q357019) | 307 ft/94 m, 1914-15, 61 bells (src: https://en.wikipedia.org/wiki/Sather_Tower) | stone tower with clock faces, top lantern | lidar | 1 |
| 48 | California Memorial Stadium | 37.871111, -122.250833 | [Q1026837](https://www.wikidata.org/wiki/Q1026837) | UNCONFIRMED | bowl built on a fault, hillside | lidar | 2 |
| 49 | Lawrence Hall of Science | 37.8794, -122.247 | [Q14683059](https://www.wikidata.org/wiki/Q14683059) | UNCONFIRMED | hilltop concrete, bay vista | lidar | 3 |
| 50 | Berkeley Pier / Marina | 37.86283, -122.3176 | [Q4892079](https://www.wikidata.org/wiki/Q4892079) | UNCONFIRMED | long fishing pier | OSM | 3 |
| 51 | Pixar / Bay Street Emeryville | 37.8353, -122.2922 | [Q4874127](https://www.wikidata.org/wiki/Q4874127) | UNCONFIRMED | Pixar HQ is a campus with a brick main building | OSM | 3 |

(Emeryville Marina [Q39048110](https://www.wikidata.org/wiki/Q39048110) 37.841, -122.314; Hearst Greek Theatre [Q671266](https://www.wikidata.org/wiki/Q671266) 37.8737, -122.2542; Hearst Mining Building [Q5691716](https://www.wikidata.org/wiki/Q5691716) are spare candidates.)

## C. Phase 3: Marin, Alameda, more bridges (9)

| # | Name | Lat, Lon | QID | Height / footprint | Geometry | Reference | Pri |
|---|---|---|---|---|---|---|---|
| 52 | Golden Gate north approach, Fort Baker | 37.8359, -122.477 | [Q1370920](https://www.wikidata.org/wiki/Q1370920) | UNCONFIRMED | Baker-Barry tunnel (HAER, name from search), vista point | HAER on loc.gov | 2 |
| 53 | Point Bonita Lighthouse | 37.815569, -122.529604 | [Q2100738](https://www.wikidata.org/wiki/Q2100738) | 10 m (P2048) | tiny tower reached by suspension footbridge | lidar | 3 |
| 54 | Marin Headlands (Hawk Hill, Battery Spencer) | 37.8278, -122.5061 | [Q488627](https://www.wikidata.org/wiki/Q488627) | UNCONFIRMED | bunkers, ridge roads, the famous GG view | lidar (check coverage; see MAP_RESOURCES.md) | 1 |
| 55 | Fort Cronkhite | 37.8322, -122.535 | [Q19865802](https://www.wikidata.org/wiki/Q19865802) | UNCONFIRMED | WWII barracks rows | OSM | 3 |
| 56 | Sausalito (waterfront, ferry terminal) | 37.857778, -122.490278 | [Q828729](https://www.wikidata.org/wiki/Q828729) | UNCONFIRMED | houseboats, hillside homes | OSM | 2 |
| 57 | Richmond-San Rafael Bridge | 37.93533, -122.44771 | [Q1485003](https://www.wikidata.org/wiki/Q1485003) | 99.1 m (P2048) | double-cantilever truss | Caltrans UNCONFIRMED | 3 |
| 58 | Angel Island | 37.86, -122.43 | [Q531734](https://www.wikidata.org/wiki/Q531734) | UNCONFIRMED | hill island, Camp Reynolds | lidar | 3 |
| 59 | Alameda Naval Air Station | 37.7861, -122.319 | [Q3016749](https://www.wikidata.org/wiki/Q3016749) | UNCONFIRMED | runways, hangars | OSM | 3 |
| 60 | Caldecott Tunnel | 37.8548, -122.2166 | [Q5018994](https://www.wikidata.org/wiki/Q5018994) | bore 4 ~ 1,033 m (MAP_RESOURCES.md) | tunnel portals | Caltrans | 3 |

## D. Constants that disagree with real numbers

Verified disagreements (real numbers sourced):

| File:line | Current | Real | Source |
|---|---|---|---|
| src/world/landmarkdefs.js:19 `transamerica.base: 44` | 44 m | about 53.3 m (175 ft) at the base | https://skyscraperpage.com/b1601 , https://architectuul.com/architecture/transamerica-pyramid UNCONFIRMED. Note the code's top half-width 7.5 m (landmarks.js:277) gives a 15 m top vs 45 ft = 13.7 m. |
| src/world/landmarkdefs.js:23 `cityhall.L: 125, W: 90` | 125 x 90 m | 119 x 83 m (390 x 273 ft). Note: line 151 clamps to `max(.., 90)` x `max(.., 60)`, so OSM can override. | https://en.wikipedia.org/wiki/San_Francisco_City_Hall |
| src/world/landmarkdefs.js:23 `cityhall.domeR: 26` and landmarks.js:410 `SphereGeometry(21)` | dome radius 21-26 m | dome diameter 112 ft = 34 m, so r = 17 m. The exterior drum may be larger than the interior figure; UNCONFIRMED. | same page |
| src/world/landmarks.js:229 `const TH = 150` | Bay Bridge tower height 150 m | 160 m (526 ft) | https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge |
| src/world/landmarks.js:217 `deckY = min(58, 26 + t*0.11)` | upper deck peaks at 58 m | clearance below the west span is 67 m; the upper deck sits a whole deck-structure above it. UNCONFIRMED how far (guess 14+ m), so take the profile from lidar. | same page |
| src/world/landmarks.js:222 `box(21, 8.5, ...)` | deck 21 m wide | 17.5 m roadway per deck (5 lanes); truss overall width UNCONFIRMED | same page |
| src/world/landmarks.js:358 `CircleGeometry(3.2)` | clock dial dia 6.4 m | 22 ft = 6.7 m (r 3.35); trivial | https://en.wikipedia.org/wiki/San_Francisco_Ferry_Building |
| src/world/landmarks.js:540 bottle height 32 | 32 m | 80 ft = 24 m (page says "length"; may be height) UNCONFIRMED | https://en.wikipedia.org/wiki/Oracle_Park |
| src/world/landmarkdefs.js:27 `oraclepark.r: 120` | ring radius 120 m | field depth is 94-126 m (RC 415 ft); a 120 m ring only fits the field, not the stands. Real grandstand is not a circle. | same page |
| tools/bake.py:468 Pier 39 point | 37.8087, -122.4098 | Wikidata puts the pier centre at 37.80999, -122.41036 (~150 m north-west). The entrance sign is probably where bake.py places it, so this may be intentional. | Wikidata Q1856083 |

Checked and consistent (no change): GG towerHeight 227 (746 ft); GG main span ~1280 m; deckTower/deckMid 66/68 vs 67 m clearance (only if world y=0 equals MHW; datum UNCONFIRMED, NAVD88 would shift this); halfW 13.6 vs bridge width 27.4 m; Coit 64 m; Ferry tower 75 m and L 200 m; Fine Arts 49 m; Transamerica 260 m and Salesforce 326/296 m (crown split matches); City Hall domeH 94.

Not verifiable from what I fetched (UNCONFIRMED, needs HABS, OSM footprint or lidar): coit.r 6.2; ferry.W 36 and height 15; cityhall.height 26; finearts.r 21 and R=17 at landmarks.js:368; alcatraz cellL 150, cellW 34, cellH 14, lightH 26; paintedladies w 7.6, d 18, h 11.5; fortpoint L 76, W 50, height 14; Salesforce base 52; Oracle Park height 34 and light poles 62 (landmarks.js:533); dragongate span 20, height 11; ghirardelli 14x14x26; Transamerica wing position/size (landmarks.js:280).

Process notes:
- Existing blurbs in bake.py:449-483 agree with sources (Capitol comparison: dome 93.7 m is taller than the 288 ft Capitol, Capitol height UNCONFIRMED).
- The OSM-footprint override in bake.py:1209-1236 covers `transamerica`, `salesforce`, `coit`, `ferry`, `finearts`, `cityhall`, `oraclepark`, so footprint constants matter mainly for tall-height and fallback paths. Heights stay hard-coded, so prefer lidar max-minus-ground for each hero tower.
- Post-2010 towers (Salesforce, 181 Fremont, Transit Center) have no DataSF height; lidar-derived is required.

## E. Referencing guidance

- HABS/HAER items found (PD): Alcatraz cell house https://www.loc.gov/item/ca1498 ; Ferry Building https://www.loc.gov/item/ca1504 ; City Hall https://www.loc.gov/item/ca0633 ; Bay Bridge https://loc.gov/pictures/item/ca1352 ; YBI records https://loc.gov/pictures/item/ca2554 , https://loc.gov/pictures/item/ca2555 . For several of these I only saw search-result summaries, not the pages.
- No HABS/HAER hit for Coit, Palace of Fine Arts, Fort Point or Sutro Tower in my searches (not proof they do not exist).
- Wikimedia Commons: check each file's licence before use. CC BY-SA files cannot ship as derived data under our rule, so only CC0/PD/CC BY.
- For every tall hero, the 2023 SF lidar (`CA_SanFrancisco_1_B23`, 44 pts/m2; this is total/first-return pulse density; measured on real points 2026-10-26: 121–154 pts/m² all returns and 31–42 pts/m² ground (class 2) over mixed SF blocks, see lidar-probes.md §1) (corrected 2026-10-26) gives roof height and massing directly; the numbers above are cross-checks.

## Fact-check

Independent re-fetch on 2026-10-26. Only the first ~100k characters of the two bridge pages were read by the fetch tool.

| Claim | Verdict | Correction / source |
|---|---|---|
| Golden Gate: towers 746 ft (227 m), main span 1,280 m, 90 ft wide, clearance 220 ft (67 m); code constants match | confirmed | Page gives 746 ft (227 m), 4,200 ft (1,280 m), 90 ft (27.4 m), 220 ft (67 m) clearance. Page says "at high tide"/"above high water", not "mean high water". Code: landmarkdefs.js:10 `towerHeight: 227` matches. https://en.wikipedia.org/wiki/Golden_Gate_Bridge |
| Bay Bridge west span towers 160 m (526 ft), two 704 m main spans; code TH=150 is short | confirmed (with caveat) | Infobox lists "Height (West) 526 ft (160 m)" and two main spans of 2,310 ft (704 m). The page does not label 160 m explicitly as "tower height", so tower = 160 m is inferred from the infobox. Code at landmarks.js:229 is `const TH = 150`, so it is 10 m short if the inference holds. https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge |
| City Hall 390 x 273 ft (119 x 83 m), dome 307.5 ft (93.7 m), dome dia 112 ft; code uses 125x90 and dome radius 21-26 | confirmed (minor) | Page gives 390 ft (120 m, not 119) x 273 ft (83 m); 390 ft converts to 118.9 m, so 119 is the correct conversion and the page rounds to 120. Dome 307.5 ft (93.7 m), diameter 112 ft (34 m). Code: landmarkdefs.js:23 `L:125, W:90, domeR:26`; landmarks.js:410 `SphereGeometry(21`. https://en.wikipedia.org/wiki/San_Francisco_City_Hall |
| Transamerica base ~175 ft (53.3 m), top floor ~45 ft; code base is 44 m | partly confirmed | skyscraperpage.com/b1601 gives base width 53.3 m (sourced to TAPyramid.com) but does NOT list top floor dimensions. The 45 ft top-floor figure is UNCONFIRMED from that source (md cites Wikipedia/sfyimby for it; not re-fetched). Code: landmarkdefs.js:19 `base: 44` confirmed. https://skyscraperpage.com/b1601 |
| Sutro Tower 297.8 m, legs 45.7 m apart at base; Sather Tower 307 ft, Oakland City Hall 320 ft, Tribune Tower 305 ft | confirmed | Sutro: 297.8 m (977 ft), legs 45.7 m (150 ft) at base, 18.3 m at waist, 30.5 m at antenna. Sather 307 ft (94 m). Oakland City Hall 320 ft (98 m). Tribune Tower 305 ft (93 m). https://en.wikipedia.org/wiki/Sutro_Tower , https://en.wikipedia.org/wiki/Sather_Tower , https://en.wikipedia.org/wiki/Oakland_City_Hall , https://en.wikipedia.org/wiki/Tribune_Tower_(Oakland) |

# OSM tag completeness audit: SF, Oakland, Emeryville, Berkeley

Measured 2026-10-26 against the live public Overpass instance (https://overpass-api.de/api/interpreter, API docs https://wiki.openstreetmap.org/wiki/Overpass_API) using `out count;` queries, one request at a time, 5-10 s apart. Overpass was overloaded (502/504s and connect timeouts, partly from concurrent load), so queries were batched several `out count` statements per request and retried. The raw query outputs were not kept; the PBF recount (`probes/osm_recount.json`) supersedes them. OSM data timestamp of the replies was not recorded (UNCONFIRMED); counts are "now" as of the run date.

## Method and caveats

Bboxes (S,W,N,E), all rectangles, so they include water, neighbouring towns and bridge approaches:

| Area | bbox | What spills in |
|---|---|---|
| SF | 37.70,-122.53,37.84,-122.35 | Daly City/Brisbane edge, Treasure Island, Yerba Buena Island, Angel Island, Alcatraz, Marin Headlands corner, Golden Gate Bridge north end only partly |
| Oakland | 37.70,-122.35,37.835,-122.11 | Alameda, Bay Farm Island, Oakland Airport, San Leandro edge, Bay Bridge east span; Treasure Island/YBI lie west of this box (counted in SF) |
| Emeryville | 37.828,-122.32,37.850,-122.275 | Small box; overlaps the Oakland and Berkeley boxes by a few hundred metres, so city totals are not additive |
| Berkeley | 37.848,-122.335,37.91,-122.21 | Albany, part of Richmond south, Berkeley Marina and its pier |

- Buildings are counted with `nwr["building"]` (nodes + ways + relations; ways are 99.4% of them in SF). Percentages are of that total.
- "Roads" = `highway` in motorway, trunk, primary, secondary, tertiary, unclassified, residential, living_street and the `_link` variants (drivable, non-service). Service roads, footways, cycleways, paths and steps are in the separate "all highway ways" table. Percentages for road tags are of the road set, not of all highways. Service roads (parking aisles, alleys) are 13% of SF highway ways and 36% of Oakland's.
- A way is counted once even if long; OSM splits ways at tag changes and junctions, so "% of ways" is not "% of road length". A length-weighted measure was not done (UNCONFIRMED how much it differs).
- Presence is counted, not plausibility. A `height` tag could still be wrong or stale.
- The tag-key regexes (`sidewalk*`, `cycleway*`, `turn:lanes*`, `parking:lane*`) match every suffix variant (`sidewalk:left`, `sidewalk:both`, `turn:lanes:forward` and so on). Tag semantics: https://wiki.openstreetmap.org/wiki/Key:sidewalk, https://wiki.openstreetmap.org/wiki/Key:turn:lanes, https://wiki.openstreetmap.org/wiki/Key:lanes.

## 1. Buildings

Tags: https://wiki.openstreetmap.org/wiki/Key:height, https://wiki.openstreetmap.org/wiki/Key:building:levels, https://wiki.openstreetmap.org/wiki/Key:roof:shape

| Metric | SF | Oakland | Emeryville | Berkeley |
|---|---|---|---|---|
| `building=*` features | 170,024 (PBF recount 2026-10-26) | 179,702 (PBF recount 2026-10-26) | 4,817 | 54,295 (PBF recount 2026-10-26) |
| with `height` | 142,417 (PBF recount 2026-10-26) (83.8%) | 155 (0.1%) | 14 (0.3%) | 35 (0.1%) |
| with `building:levels` | 3,238 (PBF recount 2026-10-26) (1.9%) | 1,486 (0.8%) | 146 (3.0%) | 1,997 (3.7%) |
| with `roof:shape` | 320 (0.2%) | 111 (0.1%) | 7 (0.1%) | 242 (0.4%) |
| with `roof:height` | 40 | 32 | 1 | 1 |
| with `min_height` | 12 | 0 | 0 | 2 |
| with `name` | 3,416 (PBF recount 2026-10-26) (2.0%) | 2,350 (PBF recount 2026-10-26) (1.3%) | 101 (2.1%) | 1,085 (PBF recount 2026-10-26) (2.0%) |
| `building:part` features | 1,686 (PBF recount 2026-10-26) | 561 | 196 | 126 |
| ...with `height` | 978 (PBF recount 2026-10-26) (58.0%) | 235 (41.9%) | 2 (1.0%) | 8 (6.3%) |
| ...with `building:levels` | 665 (39.4%) | 301 (53.7%) | 187 (95.4%) | 94 (74.6%) |

Notes:
- SF footprint coverage is good: 170,024 (PBF recount 2026-10-26) OSM features vs 177,023 DataSF footprints (`ynuv-fyni`, count from tools/MAP_RESOURCES.md), about 96%, though the two are not 1:1 (OSM merges and splits).
- SF `height` at 83.8% is almost certainly the result of a bulk import of the city's lidar-derived heights; the import provenance was not checked (UNCONFIRMED). The values therefore inherit the 2010-era staleness already noted for DataSF in MAP_RESOURCES.md, and I did not test them against the 2023 lidar.
- Oakland, Emeryville and Berkeley have essentially no heights (0.1-0.3%) and only 1-4% levels. Footprints exist (180k, 4.8k, 54k) but carry no vertical information.
- Roof shape is effectively absent everywhere (0.1-0.4%), including SF. `building:part` (used for towers with setbacks) is rare: 1,686 (PBF recount 2026-10-26) in SF.
- Only 12 `min_height` tags in SF, so bridges-over-street/overhang geometry is not described.

## 2. Roads (drivable, non-service)

Tags: https://wiki.openstreetmap.org/wiki/Key:lanes, https://wiki.openstreetmap.org/wiki/Key:width, https://wiki.openstreetmap.org/wiki/Key:maxspeed, https://wiki.openstreetmap.org/wiki/Key:surface, https://wiki.openstreetmap.org/wiki/Key:layer, https://wiki.openstreetmap.org/wiki/Key:incline, https://wiki.openstreetmap.org/wiki/Key:oneway

| Tag (on road set) | SF | Oakland | Emeryville | Berkeley |
|---|---|---|---|---|
| road ways (total) | 15,007 | 14,797 | 855 | 4,487 |
| `lanes` | 8,400 (56.0%) | 7,571 (PBF recount 2026-10-26) (51.2%) | 455 (PBF recount 2026-10-26) (53.6%) | 2,739 (61.0%) |
| `width` | 44 (0.3%) | 4 (0.0%) | 0 | 15 (0.3%) |
| `maxspeed` | 5,781 (38.5%) | 2,779 (18.8%) | 444 (51.9%) | 3,376 (75.2%) |
| `surface` | 8,802 (PBF recount 2026-10-26) (58.7%) | 5,673 (PBF recount 2026-10-26) (38.3%) | 554 (PBF recount 2026-10-26) (64.9%) | 4,009 (89.3%) |
| `sidewalk*` | 9,198 (61.3%) | 8,111 (54.8%) | 531 (62.1%) | 4,070 (90.7%) |
| `cycleway*` | 5,724 (PBF recount 2026-10-26) (38.1%) | 4,369 (PBF recount 2026-10-26) (29.6%) | 381 (PBF recount 2026-10-26) (45.4%) | 2,066 (46.0%) |
| `turn:lanes*` | 2,268 (15.1%) | 3,081 (20.8%) | 227 (26.5%) | 613 (13.7%) |
| `layer` | 374 (2.5%) | 478 (3.2%) | 29 (3.4%) | 71 (1.6%) |
| `incline` | 19 (0.1%) | 3 (0.0%) | 0 | 6 (0.1%) |
| `oneway` (any value) | 7,439 (49.6%) | 6,279 (42.4%) | 465 (54.4%) | 2,036 (45.4%) |
| `oneway=yes` | 6,758 (45.0%) | 5,990 (40.5%) | 445 (52.0%) | 1,512 (33.7%) |
| `lit` | 4,934 (32.9%) | 839 (5.7%) | 57 (6.7%) | 626 (14.0%) |
| `name` | 13,976 (93.1%) | 13,558 (91.6%) | 772 (90.3%) | 4,197 (93.5%) |
| `parking:lane*` (all ways, not only roads) | 1,593 | 996 | 0 | 50 |
| `placement` (all ways) | 100 | 73 | 0 | 0 |

Notes:
- `lanes` is on about half of road ways and `oneway` is explicit on about half; on untagged ways the oneway default is two-way, so a missing tag is usually correct there, but missing `lanes` is real missing data.
- `width` is essentially absent (under 0.5%), so no road width comes from OSM. Carriageway width must come from lidar / DataSF (street centreline `3psu-pn9h`, sidewalk widths `4g86-grxu`, curbs `emxt-b6yg`, all listed in tools/MAP_RESOURCES.md).
- `maxspeed` is patchy in SF (38.5%) and Oakland (18.8%) but good in Berkeley (75%). SF has a full DataSF speed-limit set (`3t7b-gebn`).
- `incline` is near zero: slopes must come from the DEM.
- `sidewalk*` is common (55-91%), but a `sidewalk` tag says "exists on side X", not its width. Separately mapped sidewalks (footway=sidewalk ways) are the likely carrier; 38,848 footway ways in SF, see section 3.
- `lit` is tagged on 33% of SF road ways, but only 6-14% elsewhere, so it cannot decide where lamps go.

## 3. All highway ways, bridges and tunnels

Tags: https://wiki.openstreetmap.org/wiki/Key:bridge, https://wiki.openstreetmap.org/wiki/Key:tunnel

| Metric | SF | Oakland | Emeryville | Berkeley |
|---|---|---|---|---|
| all `highway=*` ways | 68,188 | 47,889 | 2,920 (PBF recount 2026-10-26) | 17,161 (PBF recount 2026-10-26) |
| `highway=service` | 9,015 | 17,048 | 942 (PBF recount 2026-10-26) | 4,531 (PBF recount 2026-10-26) |
| `highway=footway` | 38,848 | 13,413 | 958 | 5,995 |
| `highway=cycleway` | 626 | 589 | 93 | 298 |
| `path` + `steps` | 3,682 | 1,372 | 37 | 1,553 |
| highway ways with `bridge=yes` | 738 | 797 | 45 | 210 |
| highway ways with any `bridge` value other than `no` | 772 | 813 | 46 | 214 |
| highway ways with `tunnel=yes` | 229 | 50 | 7 | 29 |
| highway ways with any `tunnel` value other than `no` | 406 | 152 | 23 | 75 |
| bridge ways that also have `layer` | 707 (91.6% of 772) | 752 (92.5%) | 40 (87.0%) | 171 (79.9%) |
| tunnel ways that also have `layer` | 266 (65.5% of 406) | 47 (30.9%) | 7 (30.4%) | 41 (54.7%) |
| bridge ways with `name` | 234 | 393 | 25 | 83 |
| bridge ways with `bridge:structure` | 13 (PBF recount 2026-10-26) (SF city polygon: 6) | 0 | 0 | 1 |
| non-highway `bridge=*` ways (mostly railway) | 89 (railway 58) | 128 (railway 123) | 11 (railway 10) | 32 (railway 30) |

Notes:
- Bridge and tunnel ways are present in both counties, with layer on about 80-93% of bridge ways. So stacked decks are describable from OSM (`bridge` + `layer`) for most cases, but a quarter to two thirds of tunnel ways lack `layer`.
- Tunnel counts include `tunnel=building_passage` and culverts (406 "any" vs 229 `yes` in SF), so filter on `tunnel=yes` for road tunnels.
- Spot check of the Bay Bridge area (bbox 37.76,-122.38,37.84,-122.30): the bridge decks are mapped as `bridge=yes` with `layer`, and the Alexander Zuckermann Bay Bridge Trail way carries `width=4.72`, `surface=concrete` and `lit=yes`. Some Treasure Island Road ways are `highway=construction` with `bridge=yes` and `construction=tertiary`, so they are not drivable as tagged. Only 4 ways were printed in this check, so completeness of the Bay Bridge decks was not verified (UNCONFIRMED).
- Deck height, thickness and clearance are never tagged (`bridge:structure` appears on 26 ways in SF). Take them from first-return lidar along each bridge way, as MAP_RESOURCES.md already proposes.
- The Oakland box includes the Oakland Airport Connector (see section 6) and Alameda causeways, which contribute to its bridge count.

## 4. Street furniture and kerbs (nodes)

Tags: https://wiki.openstreetmap.org/wiki/Tag:highway=traffic_signals, https://wiki.openstreetmap.org/wiki/Tag:highway=crossing, https://wiki.openstreetmap.org/wiki/Tag:highway=stop, https://wiki.openstreetmap.org/wiki/Tag:highway=street_lamp, https://wiki.openstreetmap.org/wiki/Tag:barrier=kerb, https://wiki.openstreetmap.org/wiki/Key:kerb, https://wiki.openstreetmap.org/wiki/Tag:natural=tree

| Feature (nodes) | SF | Oakland | Emeryville | Berkeley |
|---|---|---|---|---|
| `highway=traffic_signals` | 2,286 | 1,440 | 91 | 320 |
| ...with `traffic_signals:direction` | 460 | 348 | 8 | 60 |
| `highway=crossing` | 19,891 | 13,754 | 676 | 4,642 |
| ...with a `crossing=*` subtype | 18,174 (91.4%) | 12,434 (90.4%) | 602 (89.1%) | 4,485 (96.6%) |
| `highway=stop` | 4,941 | 5,503 | 283 | 2,296 |
| `highway=give_way` | 47 | 421 | 46 | 271 |
| `highway=street_lamp` | 1,801 | 886 | 61 | 91 |
| `barrier=kerb` | 8,860 (PBF recount 2026-10-26) | 3,243 | 331 | 2,131 |
| `kerb=*` (any value) | 11,572 (PBF recount 2026-10-26) | 7,038 (PBF recount 2026-10-26) | 380 (PBF recount 2026-10-26) | 2,879 |
| `barrier=kerb` as a way | 121 | 23 | 55 | 75 |
| `natural=tree` | 10,866 | 1,946 | 185 | 873 |
| ...with `height` | 230 | 10 | 0 | 2 |
| ...with `species` | 446 | 45 | 0 | 124 |
| ...with `genus` | 326 | 43 | 0 | 3 |
| ...with `circumference` | 0 | 7 | 0 | 1 |
| `natural=tree_row` (ways) | 20 | 25 | 0 | 9 |
| `highway=bus_stop` | 3,378 | 2,009 | 102 | 756 |
| `traffic_calming=*` | 889 | 2,666 | 139 | 566 |

Notes:
- Crossings, stop signs and signals are well mapped (the crossing node figure for SF, 19,891, is about 3 per road way). The kerb nodes are access-ramp / lowered-kerb markers at crossings (`kerb=lowered|flush|raised`), not a continuous kerb line; real kerb lines must come from DataSF `emxt-b6yg` (SF) and lidar elsewhere.
- Street lamps: 1,801 in SF, 886 Oakland, 91 Berkeley. OSM lamp coverage is tiny compared to a city of this size (the SF figure is a small fraction of the city's lamp count, whose exact value I did not verify, UNCONFIRMED). The lighting-data agent already covers this topic; I note only that OSM cannot be the lamp source.
- Trees: SF has 10,866 `natural=tree` nodes against 144,522 in the SF street-tree inventory `tkzw-k3nq` (tools/MAP_RESOURCES.md), so OSM holds about 7.5% of them. Oakland has 1,946 against about 42,666 + 38,613 in the two city datasets (about 2-5%). Species is on 4% of SF tree nodes and DBH/height is essentially absent.
- `traffic_calming` is higher in Oakland (2,666) than SF (889) and is available as node/way tags, but the subtype (bump, table, island and so on) was not tallied.

## 5. Transit rails and overhead wire

Tags: https://wiki.openstreetmap.org/wiki/Tag:railway=tram, https://wiki.openstreetmap.org/wiki/Tag:railway=light_rail, https://wiki.openstreetmap.org/wiki/Key:trolley_wire, https://wiki.openstreetmap.org/wiki/Key:electrified

| Ways | SF | Oakland | Emeryville | Berkeley |
|---|---|---|---|---|
| `railway=tram` | 127 | 0 | 0 | 0 |
| `railway=cable_car` | 0 | 0 | 0 | 0 |
| `aerialway=cable_car` | 1 | 0 | 0 | 0 |
| `railway=light_rail` | 456 | 0 | 0 | 0 |
| `railway=subway` | 62 | 182 | 0 | 37 |
| `railway=rail` | 175 | 409 | 62 | 47 |
| `railway=funicular` | 3 | 17 | 0 | 0 |
| `trolley_wire=yes` | 1,806 | 0 | 0 | 0 |
| `trolley_wire=*` (any value) | 1,861 | 1 | 0 | 1 |
| `trolley_wire` on nodes | 0 | 0 | 0 | 0 |
| `electrified=contact_line` | 611 | 0 | 0 | 0 |
| `railway=tram` with `electrified` | 126 of 127 | 0 | 0 | 0 |

Notes:
- `railway=cable_car` returns zero everywhere. How SF's cable cars are mapped (probably as `railway=tram` or `rail` with an operator tag) was not established by the Overpass run. Resolved by the PBF recount 2026-10-26: cable car track is `railway=tram gauge=1067 electrified=no` (78 ways, 15.2 km), grouped in SFMTA `route=tram` relations (Powell/Hyde 1959009/3433158, Powell/Mason 1959010/3433157, California 2852264/2852265).
- `trolley_wire=yes` appears on 1,806 SF ways, so Muni trolleybus overhead wire is mapped as ways in SF, and effectively nowhere else. AC Transit (Oakland/Berkeley) runs diesel buses without overhead wire, so the zero is plausible (assumption, not verified), and Berkeley/Oakland have no trolley_wire to get.
- The 17 Oakland `funicular` ways are the BART Oakland Airport Connector ("H-Line", operator BART, with `bridge`/`tunnel` and `layer` tags), a guideway rather than a funicular; tag spot-check via Overpass.
- Light rail in SF (456 ways) is Muni Metro; ways are segmented per track and per tunnel/bridge state.
- BART is `railway=subway` plus `railway=rail`; the BART viaduct and tunnel state sit in `bridge`/`tunnel` on these ways (the 123 Oakland non-highway `bridge=*` ways are mostly this).

## 6. What to rely on for the bake

Relying on OSM means the tag exists on at least about 80% of features and agrees with a second source. A third column marks what must come from elsewhere.

| Need | OSM verdict | Take instead from |
|---|---|---|
| Road topology, names, oneway, bridge/tunnel flags, layer for stacked decks | RELY. Present and structurally complete: names 90-94%, bridge layers 80-93%, plus connectivity. Use `tunnel=yes` only, and cross-check tunnels (65% layered in SF, 31% in Oakland). | Caltrans bridge layers for cross-check |
| Number of lanes | PARTIAL: 51-61%. Use as a hint; fall back to width/standards. | Lidar paint-free width / DataSF centrelines; Caltrans 12 ft standard (tools/MAP_RESOURCES.md) |
| Turn lanes | NO: 14-27% of road ways. | Optional; traffic AI can ignore |
| Road/carriageway width | NO: under 0.5% have `width`. | Lidar, DataSF sidewalk widths `4g86-grxu` and curbs `emxt-b6yg` (SF); lidar only in East Bay |
| Max speed | PARTIAL: SF 38.5%, Oakland 18.8%, Berkeley 75.2%. | DataSF speed limits `3t7b-gebn` (SF); class default for the East Bay |
| Road surface | PARTIAL: 38-89%. | Fine for gameplay; DataSF PCI `5aye-4rtt` for wear |
| Slope/incline | NO | Lidar DEM |
| Sidewalk existence | RELY with care: 55-91% of road ways (sidewalk tag) plus a large mapped footway layer (38,848 SF footway ways). | Lidar for the real footprint |
| Kerb line | NO: kerb nodes are crossing ramps only. | DataSF curbs `emxt-b6yg`; lidar |
| Traffic signals, stop, crossing nodes | RELY: dense and mapped. | DataSF signals `ybh5-27n2` and stop signs `4542-gpa3` to cross-check SF |
| Street lamps | NO: 1,801 nodes in SF. | Lighting data agent's source |
| Trees | NO for inventory use: about 7.5% of SF's tree inventory. | SF `tkzw-k3nq`, Oakland `svwc-9r23` / `4jcx-enxf`, lidar canopy |
| Building footprints | RELY: ~96% of DataSF count in SF; large sets in Oakland (179,703) and Berkeley (54,297). | DataSF/Overture as a cross-check |
| Building height | SF: usable as a fallback only (83.8%, import-era); East Bay: NO (0.1-0.3%). | 2023 lidar (SF), 2021 lidar (Alameda), DataSF `hgt_*` for SF |
| Building levels | NO: 1-4%. | Derive from height |
| Roof shape | NO: 0.1-0.4%. | Lidar roof segmentation; default gable/flat by footprint |
| Building parts / setbacks | PARTIAL for SF towers: 1,686 (PBF recount 2026-10-26) parts, 58% with height. | Lidar |
| Trolley overhead wire | SF ONLY: 1,806 `trolley_wire=yes` ways. | None elsewhere (see section 5) |
| Rail: Muni tram/light rail, BART | RELY on geometry; cable cars are `railway=tram gauge=1067 electrified=no` (PBF recount 2026-10-26). | Lidar for elevation of elevated guideways |
| Bridge/tunnel deck profile | NO elevation in OSM. | Lidar first returns along the way |

Bottom line: use OSM for footprints and for the road graph (topology, names, bridge/tunnel/layer, crossings, signals, stop signs, oneway, a good chunk of lanes and sidewalks). Everything geometric and vertical (road width, kerbs, slopes, deck profiles, building heights, roof shapes, tree inventory, lamp positions) must come from lidar and the city datasets already listed in tools/MAP_RESOURCES.md. SF is the one city where OSM heights are populated (83.8%), whereas Oakland, Emeryville and Berkeley need the full lidar height pass (Alameda `CA_AlamedaCo_2_2021` (2019 QL1, upgraded) or `CA_AlamedaCo_3_2021` (2021 QL0), one per tile and never both, choice pending a per-tile density map (corrected 2026-10-26); see MAP_RESOURCES.md).

## 7. Open points

- Bridge/tunnel counts are of ways, not of structures; one bridge is many ways.
- Cable car tagging in SF: zero `railway=cable_car`; the track is 78 `railway=tram gauge=1067` ways (77 `electrified=no`, 15.2 km) in SFMTA `route=tram` relations (PBF recount 2026-10-26).
- Provenance and accuracy of SF's 142,417 (PBF recount 2026-10-26) `height` tags unchecked against the 2023 lidar.
- Length-weighted completeness (share of road length with lanes or maxspeed) not measured.
- The Bay Bridge decks were seen only as a 4-way sample; a dedicated pass is needed in Phase 2.
- Street-lamp ground truth for SF was not checked; OSM's 1,801 is only a lower bound.

## Fact-check

Independent re-run on 2026-10-26 (Overpass base timestamp 2026-10-27T00:13Z, https://overpass-api.de/api/interpreter, same bboxes and filters as above). Counts matched exactly unless stated.

1. Building height/levels/roof tags: CONFIRMED. SF 170,039 buildings, 142,420 with height (83.8%); Oakland 179,703 / 155; Berkeley 54,297 / 35; roof:shape SF 320, Oakland 111, Berkeley 242; building:levels SF 3,239, Oakland 1,486, Berkeley 1,997. Source: Overpass `out count` queries; tag docs https://wiki.openstreetmap.org/wiki/Key:height
2. Drivable road tags: CONFIRMED (tiny drift). Oakland 14,797 ways, lanes 7,574, maxspeed 2,779, width 4, incline 3; Berkeley 4,487 / 2,739 / 3,376 / 15 / 6; SF lanes 8,400, maxspeed 5,781, width 44. SF road total is now 15,011 (report says 15,007) and SF incline 19 matches the report table. Source: Overpass; https://wiki.openstreetmap.org/wiki/Key:width
3. Bridges/tunnels: CONFIRMED. Highway bridge ways (bridge not "no") SF 772, Oakland 813; with layer 707 (91.6%) and 752 (92.5%); tunnel ways with layer SF 266/406 = 65.5%, Oakland 47/152 = 30.9%. Zero highway bridge ways carry `ele`. Minor wording: Emeryville tunnel share is 30.4%, so "31-65%" is really "30-65%"; Berkeley bridge share is 79.9%, so "80-93%" is rounded. Source: Overpass; https://wiki.openstreetmap.org/wiki/Key:bridge
4. Street furniture: CONFIRMED on counts. SF crossing 19,891, traffic_signals 2,286, stop 4,941, street_lamp 1,801, natural=tree 10,866, barrier=kerb nodes 8,871. SF street-tree inventory tkzw-k3nq returns count 144,522 (https://data.sf.gov/resource/tkzw-k3nq.json), so 10,866 / 144,522 = 7.5%. UNVERIFIED: that kerb nodes are only crossing ramps rather than kerb lines (semantic claim, not re-tested; barrier=kerb docs https://wiki.openstreetmap.org/wiki/Tag:barrier=kerb).
5. Trolley wire / cable car: CONFIRMED on counts, with a correction. `trolley_wire=yes` ways: SF 1,806, Oakland 0, Emeryville 0, Berkeley 0 (any trolley_wire value: SF 1,861, Oakland 1, Berkeley 1). `railway=cable_car` is 0 in all four boxes. Correction to the open point: SF cable cars ARE mapped, as `route=tram` relations (for example "Muni Powell/Hyde Cable Car", relation 1959009, and Powell/Mason 1959010, operator SFMTA), so they are not absent; which `railway=*` value their ways carry was not established here, so way-level tagging remains UNCONFIRMED. Source: Overpass `out tags` on relations in the SF bbox. Resolved by the PBF recount 2026-10-26: the ways are `railway=tram gauge=1067 electrified=no`.

- PBF recount 2026-10-26: OSM counts re-verified against a Geofabrik extract; see probes/osm_recount_vs_notes.json.

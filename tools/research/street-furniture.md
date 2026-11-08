# Street furniture and prop datasets (SF, Oakland, Berkeley)

Researched 2026-10-26. Row counts were read live from the Socrata APIs on that date. SF's portal now lives at `data.sf.gov` (the old `data.sfgov.org` 301-redirects). UNCONFIRMED = not verified. All DataSF sets below are PDDL (public domain), so they are shippable.

Query pattern used for counts: `https://data.sf.gov/resource/<id>.json?$select=count(*)`. Metadata: `https://data.sf.gov/api/views/<id>.json`. Dataset discovery that works: `https://api.us.socrata.com/api/catalog/v1?search_context=data.sf.gov&domains=data.sf.gov&q=<term>`.

## 1. Ranked by visual impact for a driving game

Rank = how often the player sees it at road level times how much it changes the read of "real SF". Per-area densities are measured from the data, not guessed (method in section 4).

| # | Prop | Best source | Count (live) | Position quality | Ship? |
|---|---|---|---|---|---|
| 1 | Streetlights / lamp posts | NO open SF dataset found; OSM `highway=street_lamp` (1,801 nodes in the SF bbox (PBF recount 2026-10-26); SF city polygon: 1,786); Rec&Park lamp posts only in parks | SF total ~25k-45k (sources conflict, see 3.1) | Unknown | Procedural from OSM plus rule |
| 2 | Traffic signals | DataSF `ybh5-27n2` (already in MAP_RESOURCES) | 1,507 | Intersection points | Yes |
| 3 | Street signs, stop signs | DataSF `m48z-6ji4` 144,333 rows; `4542-gpa3` 11,179 rows (MAP_RESOURCES) | see left | Point | Yes |
| 4 | Street trees | DataSF `tkzw-k3nq` 144,522 (vegetation agent's topic) | see left | Point | Yes |
| 5 | Parking meters | DataSF `8vzz-qzz9` | 38,775 (37,804 on-street, 971 off-street) | Per-space point, blockface id, cap colour | Yes |
| 6 | Utility poles and overhead wires | NO open dataset; OSM `power=pole` (2,769 nodes in the SF bbox (PBF recount 2026-10-26); SF city polygon: 2,589), `power=minor_line` (228 ways (PBF recount 2026-10-26); city polygon: 214) | n/a | n/a | Procedural along streets where lidar shows wire returns |
| 7 | Muni trolley overhead wires | OSM `trolley_wire=yes` on `highway=*` ways | 1,806 ways in the SF bbox (PBF recount 2026-10-26) (SF city polygon: 1,779) | Way geometry | Yes (ODbL) |
| 8 | Bus stops and shelters | DataSF Muni Stops `i28k-bkz6` | 3,260 stops; `shelter=1` on 991; OSM `shelter=yes` 871 nodes in the SF bbox (PBF recount 2026-10-26) (SF city polygon: 867) | Stop point plus side (orientation, position) | Yes |
| 9 | Fire hydrants | No open SF dataset found; OSM `emergency=fire_hydrant` 1,241 nodes in the SF bbox | SFPUC says ~8,500 white + ~1,500 high-pressure = ~10,000 real | OSM is ~12% complete | Procedural at corners, OSM where present |
| 10 | Trash cans | DataSF `5buk-jp7b` plus Rec&Park `e3jj-mbb3` | 1,978 street + 1,377 in parks; OSM `amenity=waste_basket` 1,285 nodes in the SF bbox (PBF recount 2026-10-26) (SF city polygon: 1,278) | Point, can type | Yes |
| 11 | Bench | Rec&Park `e3jj-mbb3` (parks only) | 3,293; OSM `amenity=bench` 3,285 nodes in the SF bbox (PBF recount 2026-10-26) (SF city polygon: 3,231) | Point | Yes (parks); street benches have no dataset |
| 12 | Bike racks | DataSF `hn4j-6fx5` | 6,035 | Address-matched, not exact | Yes |
| 13 | Bay Wheels docks | Lyft GBFS station_information | 648 (all regions); ~395 in SF bbox | Point, capacity | Licence UNCONFIRMED, see 3.6 |
| 14 | Murals and civic art | Civic Art `r7bn-7v9c` 1,038; StreetSmARTS Murals `wg8w-68vc` 70; Rec&Park public art 94 | see left | Address/intersection level | Yes, as landmarks only |
| 15 | Surface-mounted utility cabinets and small cells | `xu5w-5kgd` 1,955; `xtj2-daw9` 1,408 | see left | Point per permit | Optional |
| 16 | Fire stations | DataSF City Facilities `nc68-ngbr` | 48 name matches (SFFD has ~45; dedupe UNCONFIRMED) | Point | Yes |
| 17 | Newspaper racks | No dataset found | n/a | n/a | Skip or procedural |
| 18 | Billboards | No dataset found | n/a | n/a | Skip or procedural |
| 19 | Mailboxes (USPS) | No open dataset; OSM `amenity=post_box` (615 nodes in the SF bbox (PBF recount 2026-10-26); SF city polygon: 612) | n/a | n/a | Procedural, tiny effect |

Highest-value insight: the meters (38.8k), signs (144k), signals, Muni stops, trash cans and trees are all real per-object points with PDDL licences. The items drivers feel most at night (streetlights, utility poles, wires) have NO open per-object SF dataset, so they have to come from lidar plus OSM plus rules. That ties into the lighting data agent's work.

## 2. SF datasets (verified)

Base URL pattern `https://data.sf.gov/d/<id>`.

| Dataset | ID | Rows | Updated | Key fields | Notes |
|---|---|---|---|---|---|
| Parking Meters | [8vzz-qzz9](https://data.sf.gov/d/8vzz-qzz9) | 38,775 | 2026-10-24, weekly | `parking_space_id, post_id, on_offstreet_type, active_meter_flag, cap_color, meter_type, meter_model, smart_meter_flag, street_name, street_num, blockface_id, street_seg_ctrln_id, orientation, latitude, longitude, shape` | `active_meter_flag`: M 26,572; T 4,571; U 5,075; P 2,491; L 66. Docs say filter M or T for working meters. Source: [catalog.data.gov](https://catalog.data.gov/dataset/parking-meters). Joins by `street_seg_ctrln_id` to centerlines for curb offset. |
| Meter Inventory (older or sibling) | [uan2-8hmm](https://docs.datasf.org/uan2-8hmm) | UNCONFIRMED | UNCONFIRMED | blockface, cap colour, collection route | Not needed if `8vzz-qzz9` is used |
| Muni Stops | [i28k-bkz6](https://data.sf.gov/d/i28k-bkz6) | 3,260 | rows 2026-04-11 | `stopid, stopname, onstreet, atstreet, position, orientation, serviceplanningstoptype, shelter, accessibilitymask, latitude, longitude` | `shelter`: 1 on 991, 0 on 1, blank on 2,268 (blank is not proof of no shelter). `position` and `orientation` (NW/FS, SW/NS etc.) say which corner and side of the intersection. Derived from SFMTA GTFS. |
| Trash Can Locations | [5buk-jp7b](https://data.sf.gov/d/5buk-jp7b) | 1,978 | 2026-10-26 | `cantype, cancolor, onstreet, fromstreet, streetcorner, installeddate, removeddate, latitude, longitude` | `cantype`: Renaissance/Metal 1,444; Cement/Concrete 512; Slim Silhouette 18; other 4. These are the real can models, so two meshes cover 99% of cans. Public Works says locations are approximate. Filter `removeddate IS NULL`. |
| Assets Maintained by Rec and Park | [e3jj-mbb3](https://data.sf.gov/d/e3jj-mbb3) | see breakdown | 2026-10-26 | `asset_type, asset_subtype, tma_asset_name, latitude, longitude, facility_id` | Bench 3,293; Lamp Post 1,646; Trash Can 1,377; Table 760; Signage 346; Drinking Fountain 248; Play Structure 233; Bicycle Rack 144; Utility Pole 104; Grill 94; Public Art 94; Fire Hydrant 78; Bollard 25; Flag Pole 24; EV Charger 17; Light Pole 16; Statue 13; Sculpture 9; Toilet 2. Park interiors only, but a great source for Golden Gate Park, Presidio-adjacent and Dolores Park. |
| Bicycle Parking Racks | [hn4j-6fx5](https://data.sf.gov/d/hn4j-6fx5) | 6,035 | 2024-06-17 (quarterly nominal) | `address, location, street, placement, racks, spaces, install_yr, lat, lon` | SFMTA racks only; address-matched so offset by up to a few metres. `placement` values (sidewalk, corral, garage, parklet) not enumerated. |
| Civic Art Collection | [r7bn-7v9c](https://data.sf.gov/d/r7bn-7v9c) | 1,038 | 2024-04-25 (hand-maintained) | `display_title, artist, medium, display_dimensions, facility, location_description, street_address_or_intersection, latitude, longitude` | One artwork can have several rows. Includes many works inside buildings, so filter by `location_description`. Source: [catalog.data.gov](https://catalog.data.gov/dataset/civic-art-collection). Note: `docs.datasf.org/zfw6-95su` is an older id for this set. |
| StreetSmARTS Murals | [wg8w-68vc](https://data.sf.gov/d/wg8w-68vc) | 70 | 2024-04-25 | `street_address, artist, year` | Only 70, from a 2017 manual compile. Real SF has hundreds of murals (e.g. Clarion Alley, Balmy Alley); this is a tiny subset. |
| Surface Mounted Facility Permits | [xu5w-5kgd](https://data.sf.gov/d/xu5w-5kgd) | 1,955 | 2026-10-26 | `permit_number, applicant, status, location, latitude, longitude` | Telecom/utility cabinets on the sidewalk, approved and requested. Mix of statuses, so only use approved. |
| Wireless Service Facility Permits | [xtj2-daw9](https://data.sf.gov/d/xtj2-daw9) | 1,408 | 2026-10-26 | UNCONFIRMED (not fetched) | Small cells on poles. Minor. |
| City Facilities | [nc68-ngbr](https://data.sf.gov/d/nc68-ngbr) | n/a | 2026-10-26 | `common_name, department_name` | 48 rows match fire station or engine; filter view `wt27-4jim`. |
| Bay Area Bike Share Stations (historical) | [7jbp-yzp3](https://data.sf.gov/d/7jbp-yzp3) | 472 | 2024-03-13 | n/a | Old 2013-era Ford GoBike system. Not current; use GBFS instead. |
| Curb Ramps | [ch9w-7kih](https://data.sf.gov/d/ch9w-7kih) | not re-counted | 2026-10-26 | Public Works CRIS | Already in MAP_RESOURCES. |
| Traffic Signals | [ybh5-27n2](https://data.sf.gov/d/ybh5-27n2) | 1,507 | n/a | n/a | Already in MAP_RESOURCES. |
| Street Signs | [m48z-6ji4](https://data.sf.gov/d/m48z-6ji4) | 144,333 | n/a | n/a | Already in MAP_RESOURCES. |
| Stop Signs | [4542-gpa3](https://data.sf.gov/d/4542-gpa3) | 11,179 | n/a | n/a | Already in MAP_RESOURCES. |
| Parklet Permits | [jczu-j2ku](https://data.sf.gov/d/jczu-j2ku) | UNCONFIRMED (a count query returned 15 but that response was summarised oddly) | 2026-10-26 | permits | Parklets are a strong visual in the Mission, Hayes Valley and Castro, but verify the count and geometry before relying on it. Map view `gmae-x4dn`. |

Searches that found nothing in the SF catalog (so no dataset exists under these names): hydrant, bench (street), street light, streetlight (only a 311 case filter, `c53t-rr3f`), pole (besides the Rec&Park asset type), newspaper, billboard, kiosk, advertising sign, bus shelter (only Muni Stops `shelter` flag). Catalog query evidence: `api.us.socrata.com/api/catalog/v1?search_context=data.sf.gov&domains=data.sf.gov&q=<term>`.

SF newsracks: Public Works runs a pedestal newsrack program under a 2002 20-year Clear Channel contract ([sfpublicworks.org](https://sfpublicworks.org/node/22090) via search, count not published). Bike racks, bike corrals and transit shelters are permitted by SFMTA; other furniture by Public Works ([sfbetterstreets.org street furniture overview](https://sfbetterstreets.org/find-project-types/streetscape-elements/street-furniture-overview)).

## 3. Per-topic findings

### 3.1 Streetlights, poles, wires (the night-driving gap)
- No DataSF streetlight dataset exists (see catalog searches above). The only SF streetlight GIS hit is a Port of SF layer for the Embarcadero, described as an older version and removed from the live LGIM, licence blank: [gis.sfport.com Streetlights](https://gis.sfport.com/psrv/rest/services/Streetlights/MapServer/0/iteminfo?f=pjson). Treat as UNCONFIRMED and non-redistributable until licence is clarified.
- Real counts conflict by source. SFPUC testimony (2012) as quoted: ~45,500 lights, ~19,000 PG&E-owned and ~26,500 SFPUC-owned ([CPUC file](https://files.cpuc.ca.gov/PG&E20150130ResponseToA1312012Ruling/2013/05/SB_GT&S_0500385.pdf)). Potrero View says 22,000 of 43,000 are SFPUC ([potreroview.net](https://www.potreroview.net/?p=1625)). A 2017 Chronicle line says 25,500 ([pressreader](https://www.pressreader.com/usa/san-francisco-chronicle-late-edition/20170911/281496456444307)). Use ~25k-45k and say so. (These search-summary numbers were not opened in the primary documents; UNCONFIRMED.)
- Rec&Park alone lists 1,646 lamp posts + 16 light poles + 104 utility poles in parks ([e3jj-mbb3](https://data.sf.gov/d/e3jj-mbb3)). Measured density in the GG Park box (37.76..37.775, -122.50..-122.45, ~7.3 km2): 513 lamp posts, ~70/km2.
- Practical approach: for SF, place lights by rule (one per ~25-35 m per side on residential blocks, closer on arterials) and validate against OSM `highway=street_lamp` plus lidar pole returns (class 1 vertical outliers beside curbs). That is the lighting agent's domain; this note only records that no per-object public dataset exists.
- Poles and wires: PG&E has about 2.3-2.4 million wooden poles system-wide ([NBC Bay Area](https://nbcbayarea.com/investigations/pge-raises-safety-concern-about-half-million-aging-power-poles/2579796)); no SF-only count found. Use lidar (wire and pole returns) rather than a dataset. Lidar project metadata from MAP_RESOURCES applies.

### 3.2 Muni trolleybus overhead (trolley_wire)
- OSM key `trolley_wire` is for `highway=*` ways (not railway), "overhead contact lines for a trolleybus service": [OSM wiki Key:trolley_wire](https://wiki.openstreetmap.org/wiki/Key:trolley_wire). It is only valid on ways and may be split by direction (`trolley_wire:forward/backward`) per the search summary of the same wiki. There is no `railway=trolley_wire`. The query for MAP work is `way["trolley_wire"="yes"]` plus `way["trolleybus"="yes"]` plus `route=trolleybus` relations; count: 1,806 `trolley_wire=yes` ways in the SF bbox (PBF recount 2026-10-26) (SF city polygon: 1,779).
- Network scale: SFMTA told MIT in 2025 that Muni has "271 miles of overhead wires" (all electrified modes, also 74 mi light-rail track, 28 substations) per a search summary of [MIT MMI PDF](https://www.mmi.mit.edu/_files/ugd/29d096_c1ed9d2e0dc2412b874f7971f09e5127.pdf) (I could not open the PDF, over 10 MB; UNCONFIRMED). Wikipedia lists 15 trolleybus routes and 278 vehicles (2023): [Trolleybuses in San Francisco](https://en.wikipedia.org/wiki/Trolleybuses_in_San_Francisco). 2018 route list: 1, 2, 3, 5, 5R, 6, 14, 21, 22, 24, 30, 31, 33, 41, 45, 49 ([SFMTA](https://www.sfmta.com/node/15952), dated).
- Caveat: the 30 Stockton was extended to Crissy Field in 2020 without new wire (battery only), so OSM geometry may not equal real wire. Use lidar to confirm wire presence on each way.
- Visual role: double wires with span poles every ~30-35 m and cross-street span wires at intersections, so the wire grid reads as "SF" in daylight and silhouettes against the night sky. Strong value, moderate cost (a line mesh per way).

### 3.3 Fire hydrants
- [SFPUC Emergency Firefighting Water System fact sheet, 24 Feb 2026](https://www.sfpuc.gov/sites/default/files/documents/Firefighting-Water-System-Fact-Sheet-02.24.2026.pdf) (read directly): about 8,500 smaller white hydrants on the city drinking-water system, "on every block"; about 1,500 larger high-pressure hydrants with blue, black or red tops (blue = Jones Street Tank, black = Twin Peaks, red = Ashbury Tanks); 135-mile high-pressure pipeline; ~200 cisterns.
- No hydrant point dataset on DataSF (catalog query returned only Curb Ramps for "hydrant"). OSM has 1,241 hydrant nodes in the SF bbox 37.70..37.84, -122.53..-122.35 (Overpass `out count`, 2026-10-26T22:27Z, ODbL), so roughly 12% of the real ~10,000. Rec&Park lists 78 in parks.
- Approach: use OSM nodes where they exist; fill the rest procedurally: one white hydrant per block face near a corner (~10,000 / 120 km2 = ~83/km2 citywide), with coloured tops on the AWSS side streets (east side and downtown, thinner in the Sunset and Richmond).
- Oakland and Berkeley: EBMUD hydrants are not published as open data in anything found (UNCONFIRMED); use OSM plus procedural.

### 3.4 Bus stops and shelters
- SF: Muni Stops, shelter flag on 991 of 3,260 (30%); real dense downtown shelters are mostly the Clear Channel/JCDecaux-style units (operator UNCONFIRMED).
- Berkeley: Oaklandside counts 422 AC Transit stops in Berkeley with ~40 shelters ([oaklandside.org](https://oaklandside.org/2024/02/27/guerrilla-bus-benches-berkeley-mingwei-samuel-darrell-owens/)); Next City says 512 stops, 50 shelters ([nextcity.org](https://nextcity.org/features/these-guerilla-bus-benches-are-spurring-berkeley-to-step-up-for-bus-riders)). So ~10% of stops have shelters and benches are rarer, plus guerrilla benches. A bench inventory is not published.
- AC Transit stops: GTFS feed requires a free API key (`api.actransit.org`) and terms at [actransit.org/data-terms-and-conditions](https://www.actransit.org/data-terms-and-conditions/) (not opened; UNCONFIRMED). No shelter dataset found. OSM `highway=bus_stop` and `shelter=yes` are the shippable alternative (ODbL).
- Oakland: no stop or shelter inventory found on the city portal.

### 3.5 BART
- No BART station-entrance dataset found. Caltrans has a 2013 BART station point shapefile (stations, not entrances) labelled public domain: [Berkeley geodata](https://geodata.lib.berkeley.edu/catalog/stanford-sp464ds6332). BART station maps (PDF) show entrances but are not machine-readable.
- Take entrances from OSM `railway=subway_entrance` / `public_transport=stop_position` (ODbL; 71 `railway=subway_entrance` nodes in the SF bbox (PBF recount 2026-10-26); SF city polygon: 69). In SF, Market Street entrances at Embarcadero, Montgomery, Powell and Civic Center are iconic and cheap to hand-place (4 stations x 4-6 entrances).
- BART GTFS (stops only, no entrance geometry): `bart.gov/dev/schedules/google_transit.zip` from MAP_RESOURCES.

### 3.6 Bay Wheels docks (GBFS)
- Feed: `https://gbfs.lyft.com/gbfs/2.3/bay/en/station_information.json` (fetched 2026-10-26, 211 KB). 648 stations total: San Francisco region 365, Oakland 103, San Jose 82, Berkeley 48, Emeryville 15, none-assigned 35. Fields: `station_id, name, short_name, lat, lon, capacity, region_id, address, is_charging, rental_uris`. Regions: `system_regions.json`.
- By bbox: 395 stations in the Phase 1 SF bbox (37.70..37.84, -122.53..-122.35), total capacity 9,078 docks; 167 in the Phase 2 bbox (37.76..37.90, -122.38..-122.17), capacity 3,421. These overlap on the east edge of SF so they are not additive.
- Licence: UNCONFIRMED. The feed itself carries no license field in `system_information.json` (only `system_id` "lyft_bay", name "Lyft Bike", operator "Lyft"). Lyft's [system data page](https://lyftbikes.com/system-data) says trip data is "provided according to the Lyft Bike License Agreement" and says nothing about the real-time GBFS feed; I could not open the agreement. Recommendation: do not ship a derived Bay Wheels station file unless Lyft's terms are checked; OSM `amenity=bicycle_rental` provides the same positions under ODbL. Visual value is moderate (docks are a recognisable colourful kiosk).
- The 2024-03 DataSF set `7jbp-yzp3` (472) is the defunct 2013 system, not usable for current layout.

### 3.7 Public art and murals
- SF: Civic Art Collection 1,038 rows (PDDL), StreetSmARTS Murals 70 rows. Both address-level only, no facade geometry. Per the Arts Commission, the collection has "over 4,000 objects" ([sf.gov](https://www.sf.gov/san-francisco-is-home-to-one-of-the-largest-and-most-diverse-public-art-collections-in-the-country)) of which only publicly sited works are in the dataset.
- Oakland: no public art or mural dataset found. LocalWiki lists 700+ pages of murals ([localwiki.org/oakland/Murals](https://localwiki.org/oakland/Murals)), but it is a wiki, so licence and structure are unverified. City page: [oaklandca.gov public art](https://www.oaklandca.gov/topics/public-art-in-oakland).
- Berkeley: nothing found on the portal; portal has "over 40 datasets" ([berkeleyca.gov](https://berkeleyca.gov/your-government/public-records/open-data-portal)) and says data may be reused without restrictions.
- Use: murals as texture decals on named landmark walls (Clarion Alley, Balmy Alley, Women's Building, Coit Tower interior no), not as a generic scatter. Do not reproduce copyrighted artwork imagery; use generic stylised colour fields at the dataset's location only.

## 4. Oakland and Berkeley datasets found

| Dataset | Portal id | Rows | Licence | Notes |
|---|---|---|---|---|
| City of Oakland Parking Meters | [wnjv-tz7z](https://data.oaklandca.gov/d/wnjv-tz7z) | 4,872 | not stated | Fields `zone, area, pole, pole_type, meter_type, latitude, longitude, dome_colou, street_add`; updated 2024-06-13, description says "Last updated March 4, 2020". Oakland also lists a parking meter inventory page: [oaklandca.gov](https://www.oaklandca.gov/resources/parking-mobility-related-maps-and-data) |
| Oakland Bike Parking | [kd2g-wuf6](https://data.oaklandca.gov/d/kd2g-wuf6) | 2,387 | Public Domain US Gov | Racks, corrals, lockers, BART bike stations; updated 2026-08-04; counts per rack (`qty1loop` etc.) |
| Jack London On-Street Parking Inventory | [q8h9-buxg](https://data.oaklandca.gov/d/q8h9-buxg) | UNCONFIRMED | not stated | Dated 2019 |
| Oakland street trees | in MAP_RESOURCES | | | not my topic |
| Berkeley | `data.cityofberkeley.info` catalog API returned 0 hits for "tree"; no furniture or meter dataset found | | | Berkeley's open-data footprint is small |

Catalog searches on Oakland for "hydrant" and "street light" returned 0 results. No bench, shelter, hydrant, streetlight or art dataset exists on the Oakland portal as far as the search shows.

## 5. Per-km density estimates

Method: counts from the live APIs divided by area. SF land area is taken as ~121 km2 (46.9 mi2; UNCONFIRMED for this run, standard figure). A "box" is a `within_box` query over a lat/lon rectangle; 0.012 deg lat is 1.33 km and 0.015 deg lon is 1.32 km at this latitude. Street length per km2 was not measured (no street-length query run), so densities are per km2, and per-block-face rules are my estimate.

| Item | Citywide (per km2 of SF land) | Dense core measured | Residential measured | Per kilometre of driven street (estimate) |
|---|---|---|---|---|
| On-street parking meters | 37,804 / 121 = ~310 | 3,491 in 1.76 km2 (FiDi/Union Sq/SoMa box) = ~1,980 per km2 | 76 in 1.76 km2 (Outer Sunset box 37.752..37.764, -122.505..-122.490) = ~43 per km2 | Downtown ~16 per 100 m of block face (one every ~6 m, a real parallel-park pitch); zero in most of Sunset and Richmond |
| Trash cans (street) | 1,978 / 121 = ~16 | 85 in the same downtown box = ~48 | not measured | Mostly at corners: ~2-4 per downtown block, ~0.2-0.5 per residential block (UNCONFIRMED) |
| Muni stops | 3,260 / 121 = ~27 | not measured | not measured | A stop every ~250-300 m on bus lines (typical spacing, UNCONFIRMED) |
| Muni stops with shelters | 991 / 121 = ~8 | not measured | not measured | ~1 shelter per 4 stops |
| Park benches (Rec&Park) | 3,293 total, parks only | 863 in a 7.3 km2 Golden Gate Park box (37.76..37.775, -122.50..-122.45) = ~118 per km2 | | Not applicable to roads |
| Park lamp posts | 1,646 total | 513 in the same GG Park box = ~70 per km2 | | Not applicable |
| Fire hydrants (est. real) | ~10,000 / 121 = ~83 | | | ~1 per block face at a corner, ~1 per 100-120 m on grid streets (UNCONFIRMED) |
| Street signs | 144,333 / 121 = ~1,190 | | | ~12 per 100 m on average (dense with poles at corners) |
| Traffic signals | 1,507 / 121 = ~12 | | | Signalised intersection every ~300-400 m on arterials |
| Bike racks (SFMTA) | 6,035 / 121 = ~50 | | | Cluster on commercial streets |
| Bay Wheels docks | ~395 stations in SF bbox, ~3.3 per km2 | | | ~one station per 400 m in the core |
| Newsracks, billboards, mailboxes | no data | | | Procedural: newsrack clusters at downtown corners, USPS box ~1 per 500 m (UNCONFIRMED) |

Oakland: 4,872 meters over ~145 km2 city land (UNCONFIRMED area) is about 34 per km2 citywide, concentrated downtown and in the Jack London district.

## 6. Recommendations for the bake

1. Ship as per-object instanced data (small, point-based): meters (38.8k), signals, signs, Muni stops with shelter flag, trash cans, bike racks, benches (parks), hydrants (OSM plus procedural), fire stations. Budget: each is ~8-12 bytes per point after tile-local quantisation, so even 144k signs is ~1.5 MB raw.
2. Instancing: use `InstancedMesh` per tile per prop type (BatchedMesh is not needed). Meters, hydrants, cans, bollards and bike racks each need one shared low-poly mesh (50-200 triangles). Only render meters inside ~150 m (they are 1 m tall and invisible beyond that).
3. Priority order for visual payoff at least cost: (a) streetlights and poles with lit heads (lighting agent), (b) trolley wires and span poles on the ~15 trolley routes, (c) traffic signals and signs, (d) trash can, hydrant and meter instances, (e) Muni shelters, (f) bike racks, docks, benches, (g) murals and art at named sites.
4. Meters are drawn on the curb at `orientation` (side of street). Join to the centerline using `street_seg_ctrln_id` and offset ~0.5 m from the curb into the sidewalk.
5. Where datasets are weak (streetlights, hydrants, newsracks, mailboxes, billboards), derive from OSM plus lidar and mark placement as "procedural, plausible not surveyed" in the README, so it does not claim 1:1 for these.

## 7. Licences summary

- DataSF (data.sf.gov): PDDL, verified in each `api/views/<id>.json` for 8vzz-qzz9, i28k-bkz6, 5buk-jp7b, hn4j-6fx5, e3jj-mbb3, r7bn-7v9c, wg8w-68vc, xu5w-5kgd.
- Oakland Parking Meters: licence not stated in the metadata I read (UNCONFIRMED); Oakland Bike Parking is public domain US Gov.
- OSM extracts (hydrants, trolley_wire, lamps, post boxes, BART entrances): ODbL, so attribution plus share-alike on the derived database.
- Lyft GBFS station_information: UNCONFIRMED (see 3.6).
- AC Transit GTFS: terms page not opened; API key needed; UNCONFIRMED.
- SFPUC fact sheet figures: facts only, nothing is bundled.

## 8. Not verified in this run

- Overpass API (`overpass-api.de`, kumi, private.coffee, mail.ru) was rate-limited or timing out for every query after the first hydrant count, so OSM counts for street lamps, benches, waste baskets, bus shelters, post boxes, trolley_wire, subway entrances and utility poles were UNCONFIRMED in this run and have since been counted from the Geofabrik PBF (PBF recount 2026-10-26; see the table above). Original note: re-run with `out count` and 8-10 s gaps later, or use the Geofabrik NorCal PBF plus osmium (MAP_RESOURCES section 3).
- SF land area (~121 km2) and street length per km2.
- Lyft licence text; AC Transit terms; Oakland meter licence.
- Parklet Permits row count.
- Whether Berkeley/Oakland publish streetlights or hydrants on ArcGIS hubs (only portal search done).

## Fact-check

Independent check run 2026-10-26. Verdicts: confirmed / wrong / unverifiable.

1. **SF Parking Meters (8vzz-qzz9)**: PARTLY CONFIRMED.
   - Confirmed live: 38,775 rows; `on_offstreet_type` is coded `ON` 37,804 and `OFF` 971; licence PDDL; publishing frequency "Weekly"; the fields cap_color, blockface_id and street_seg_ctrln_id exist ([API](https://data.sf.gov/resource/8vzz-qzz9.json?$select=count(*)), [views](https://data.sf.gov/api/views/8vzz-qzz9.json)).
   - Outer Sunset box 37.752..37.764, -122.505..-122.490: 76 on-street meters, so ~43 per km2 over 1.76 km2 is confirmed.
   - Downtown figure of ~1,980 per km2 (3,491 meters): UNCONFIRMED. The box is not specified. A same-size box at 37.785..37.797, -122.41..-122.395 returned 4,941, so the number depends on the box. Record the exact box coordinates.
2. **Hydrants**: PARTLY CONFIRMED.
   - The SFPUC fact sheet (02.24.2026) text confirms "approximately 8,500" smaller white hydrants on the drinking-water system. The ~1,500 high-pressure figure appears in the 01.27.2026 sheet per search ([SFPUC](https://www.sfpuc.gov/sites/default/files/documents/Firefighting-Water-System-Fact-Sheet-01.27.2026.pdf)); I could not extract that sentence from the 02.24 PDF text.
   - No hydrant dataset on DataSF: catalog search for "hydrant" returned only Curb Ramps ([catalog](https://api.us.socrata.com/api/catalog/v1?search_context=data.sf.gov&domains=data.sf.gov&q=hydrant)). Confirmed.
   - OSM 1,241 nodes (~12%): UNCONFIRMED. Overpass timed out in this run. The ~12% is arithmetic against ~10,000.
3. **Streetlights and poles**: MOSTLY CONFIRMED.
   - Catalog search for "streetlight" returns only a 311 case filter and the Curb Ramps dataset ([catalog](https://api.us.socrata.com/api/catalog/v1?search_context=data.sf.gov&domains=data.sf.gov&q=streetlight)), so no per-object dataset was found.
   - Potrero View (June 2016) says about 43,000 streetlights, ~22,000 SFPUC ([source](https://www.potreroview.net/?p=1625)). The 25k lower bound (Chronicle 2017) was not checked here, so "sources conflict" is only partly verified. Absence of a utility-pole dataset is not proven by one search.
4. **Muni Stops and Trash Cans**: CONFIRMED.
   - i28k-bkz6: 3,260 rows; shelter=1 on 991, 0 on 1, blank on 2,268; PDDL.
   - 5buk-jp7b: 1,978 rows; PDDL; cantype Renaissance/Metal 1,444 plus Cement/Concrete 512 = 1,956 (98.9%), so "essentially two models" holds. Orientation and position fields were not re-checked here.
5. **trolley_wire and Bay Wheels**: CONFIRMED.
   - OSM wiki: trolley_wire is a way-only key in the highways group and requires highway=* ([wiki](https://wiki.openstreetmap.org/wiki/Key:trolley_wire)).
   - GBFS station_information has 648 stations, 395 in bbox 37.70..37.84, -122.53..-122.35; system_information.json has no license field (fields: system_id, language, name, operator, url, purchase_url, timezone) ([feed](https://gbfs.lyft.com/gbfs/2.3/bay/en/station_information.json)). Redistribution rights remain unconfirmed, as the doc says.

- PBF recount 2026-10-26: OSM counts re-verified against a Geofabrik extract; see probes/osm_recount_vs_notes.json.

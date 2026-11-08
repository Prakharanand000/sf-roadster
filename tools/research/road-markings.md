# Road surface and marking truth data (procedural marking generator)

Researched 2026-10-26. Every number carries a source. UNCONFIRMED = not verified in a primary text. "DEFAULT" = our own generator choice, not a legal value.

Units: ft and in as printed in the manuals; the generator should convert to metres (1 ft = 0.3048 m, 1 in = 0.0254 m).

## 0. Headline findings

- Caltrans published the **California MUTCD 2026 Edition** (the FHWA 2023 / 11th Edition "as amended for use in California"); the Part 3 page headers are dated January 18, 2026. The 2014 Rev 9 manual stays in use "through January 18, 2026" per https://dot.ca.gov/programs/safety-programs/camutcd/camutcd-2014. Use the 2026 numbers. The old 2014/federal 2009 numbers differ in places (see section 1).
- Chapters read directly from the Caltrans PDFs: 3A (lines, colours, Figures 3A-101 to 3A-114 CA), 3H (coloured pavement), 3D, 9E (bike markings). Chapter 3B (crosswalk, stop line, arrows, words) is a 23 MB PDF and was **not** downloaded (over the ~20 MB limit); its numbers below come from the federal 2009 MUTCD plus SF's own Better Streets Plan, marked accordingly.
  - 3A: https://dot.ca.gov/-/media/dot-media/programs/safety-programs/documents/ca-mutcd/2026/2026-camutcd-2026-3a-a11y.pdf
  - 3H: https://dot.ca.gov/-/media/dot-media/programs/safety-programs/documents/ca-mutcd/2026/2026-camutcd-2026-3h-a11y.pdf
  - 9E: https://dot.ca.gov/-/media/dot-media/programs/safety-programs/documents/ca-mutcd/2026/2026-camutcd-2026-9e-a11y.pdf
- **Red curbs and most SF curb regulation are NOT in any open dataset.** The SFMTA `colorcurb` layer holds only about 17.5k assets and 13,298 of them are "Driveway Red Zone"; there is no layer of street-corner/hydrant red curb. The generator must derive those from rules (section 4).
- **Red transit lanes**: DataSF `tzh6-6j82` has a `redlane` flag per segment, so painted-red lanes can be placed from data.
- **Green bike lanes**: the bikeway network layer has a `SURFACE_TR` field with "GREEN PAINT" on about 424 of about 5,500 segments (counts below), so green is placed from data; bike boxes and conflict zones come from the point-features layer.
- OSM in our own cache carries lane-level tags (turn:lanes, bus:lanes, cycleway:*) but **no** surface:colour tag for green or red pavement. Colour must come from SFMTA data.

## 1. Longitudinal lines (California MUTCD 2026, Ch. 3A)

Source for every row unless stated: CA MUTCD 2026 Ch. 3A (URL in section 0), Sections 3A.03, 3A.04 and Figures 3A-101(CA) to 3A-102(CA).

| Item | Value | Notes |
|---|---|---|
| Colours allowed for markings | yellow, white, red, blue, green, purple | 3A.03 para 01. Black only as contrast under/beside lines. |
| Yellow | separates opposing traffic, left edge of divided/one-way roadways, two-way left-turn lanes | 3A.03 para 03 |
| White | separates same-direction traffic, right edge | 3A.03 para 04 |
| Blue | supplements white for disabled parking spaces | 3A.03 para 06 |
| Purple | ETC-account-only toll lanes (not relevant to SF streets) | 3A.03 para 07 |
| Normal line width | 4 to 6 in | 3A.04 para 02A |
| Wide line | at least 2x normal | 3A.04 para 02B |
| State highway lane/edge/centre lines | **6 in** | 3A.04 para 02a (use for freeways, I-80, US-101, I-280, SR-1, Bay Bridge) |
| Local agency roads (SF streets) | min 4 in, may be 6 in | 3A.04 para 02b/02c. DEFAULT 4 in on SF local streets, 6 in on arterials. |
| Double line | two parallel lines with a "discernible space"; gap should not exceed 2x one line width | 3A.04 para 02C and 03 |
| Double yellow gap in Caltrans figures | 3 in drawn on Details 21, 27 | Figure 3A-104(CA) and 3A-105(CA); the figure text extraction is ambiguous on which dimension is which, UNCONFIRMED. DEFAULT 4 in gap on 4 in lines. |
| Black contrast line (paint) | 3 in black between 4 in yellow lines; **required** on State highways, optional on local roads | 3A.03 para 02a/02b. Useful visual detail on light concrete. |
| Broken line, guidance | 10 ft line / 30 ft gap, or similar ratio | 3A.04 para 06 (same ratio in federal 2009 3A.06) |
| Dotted lane line | 3 ft line / 9 ft gap | 3A.04 para 07 |
| Dotted extension through intersection/taper/ramp | 2 ft line / 2 to 6 ft gap | 3A.04 para 07 |

### 1.1 Caltrans Standard Plan patterns (what is actually painted)

From Figures 3A-101(CA), 3A-102(CA) (CA MUTCD 2026 Ch. 3A). Pattern repeats listed as line + gap.

| Detail | Use | Line + gap | Cycle |
|---|---|---|---|
| 1, 8 | Centre / lane line, speed 40 mph or less (typical local street) | **7 ft + 17 ft** | 24 ft (figure shows 48 ft of drawing) |
| 5, 11 | Centre / lane line, speed 45 mph or more | **12 ft + 36 ft** | 48 ft (figure label 60 ft) |
| 2, 9 | as 1 / 8 with raised pavement markers | 7 ft + 17 ft, markers at 8.5 ft / 7 ft offsets | 24 ft |
| 6, 12 | as 5 / 11 with markers | 18 ft + 12 ft + 18 ft pattern in 48 ft | 48 ft |
| 25 | Left edge line (State highways) | double solid 2 in-spaced figure | continuous |
| 27C | Right-edge line extension through intersections | 3 ft + 12 ft | 15 ft |

Rule for the generator: speed <= 40 mph -> 7/17 ft; >= 45 mph -> 12/36 ft. The federal 10/30 ft is guidance only; California does not paint 10/30. (UNCONFIRMED: which detail number applies to a given SF street; there is no data. Derive from the speed-limit layer, `3t7b-gebn`.)

Lane-line retroreflectivity thresholds are 50 mcd/m2/lx at 35 mph or more (3A.05), irrelevant for rendering except that all lines are retroreflective, which matters for the night shader (they should glow strongly in headlights, weakly under street lights).

## 2. Transverse markings, crosswalks, words, arrows

Source: federal MUTCD 2009 Ch. 3B, https://mutcd.fhwa.dot.gov/htm/2009r1r2/part3/part3b.htm (California adopts this text with amendments; the 2026 CA 3B PDF at https://dot.ca.gov/-/media/dot-media/programs/safety-programs/documents/ca-mutcd/2026/2026-camutcd-2026-3b-a11y.pdf is 23 MB and was not read. Treat the numbers as federal, UNCONFIRMED for CA 2026 wording.)

| Item | Value | Source / confidence |
|---|---|---|
| Stop line width | 12 to 24 in | federal 2009 3B.16; SF Better Streets Plan agrees (https://sfbetterstreets.org/find-project-types/pedestrian-safety-and-traffic-calming/crosswalks/). DEFAULT 18 in. |
| Stop line setback from crosswalk | at least 4 ft before the nearest crosswalk line | federal 2009 3B.16 |
| Advance stop line | 4 to 50 ft ahead of a crosswalk | SF Better Streets Plan (link above) |
| Yield line | triangles, base 12 to 24 in, height 1.5 x base, gaps 3 to 12 in | federal 2009 3B.16 |
| Crosswalk, transverse ("standard") | two parallel lines, each 6 to 24 in wide, at least 6 ft apart | federal 2009 3B.18. **SF standard: two 12 in white thermoplastic lines, crosswalk width at least 10 ft and at least as wide as the adjacent sidewalk** (Better Streets Plan link above). |
| Crosswalk, continental / ladder bars | bars 12 to 24 in wide, gaps 12 to 60 in, gap at most 2.5 x bar width, bars parallel to traffic direction | federal 2009 3B.18 (also quoted for the 11th edition by secondary sources) |
| SFMTA policy | convert all crosswalks to continental; High Injury Network target was 2024; crosswalks near schools are yellow | https://www.sfmta.com/continental-crosswalks (bar dimensions not published there) |
| Word marking letter height | 6 ft or more (guidance) | federal 2009 3B.20 |
| Spacing between repeated word/arrow messages | at least 4 x character height on low-speed roads, at most 10 x | federal 2009 3B.20 |
| Message length | at most 3 lines; no wider than one lane | federal 2009 3B.20 |
| Turn-lane arrows | at least 2 per turn lane | federal 2009 3B.20 |
| Caltrans arrow / word / crosswalk drawings | Standard Plans A24A (arrows), A24B (arrows + symbols), A24C (symbols, numerals), A24D and A24E (words), A24F (crosswalks) | sheet names only: https://dot.ca.gov/programs/design/2025-ccs-standard-plans-and-standard-specifications/individual-standard-plans-in-dgn-format-2025-standards. The files are DGN and the PDF set is 120 MB, so the dimensions were not read: UNCONFIRMED. |
| KEEP CLEAR | white word marking, used inside intersections and in front of driveways/fire stations. No dimensions found. DEFAULT: 6 ft letters, white, centred in lane. | UNCONFIRMED (3B text not read) |

Standing generator rules (DEFAULT, from the above):
- At a signalised/stop-controlled intersection arm: stop bar 18 in wide across approach lanes, 4 ft back from the near crosswalk edge.
- Crosswalk type: continental where the DataSF continental layer says so (section 5, `g9zy-srvv`), otherwise transverse two-line 12 in lines, 10 ft clear width. Yellow variants near schools (school list: `MTA.saferoutes_schools`, SFMTA ArcGIS layer 15 of DataSF/master).

## 3. Coloured pavement (CA MUTCD 2026 Ch. 3H and FHWA interim approvals)

Source: CA MUTCD 2026 Ch. 3H (URL in section 0), Sections 3H.06 and 3H.07; chromaticity from FHWA IA-14 and IA-22.

| Treatment | Rule | Source |
|---|---|---|
| **Green** pavement for bicycle facilities | Allowed in bike lanes, bike-lane extensions through intersections, conflict/weave zones, two-stage turn boxes, bicycle boxes, bicycle-detector symbol background. Never replaces required lines or symbols. When it fills dotted extension lines it matches the dotted pattern (fill only between dash pairs). May cover the whole lane or just parts. Inside bike boxes it must fill the full box. | 3H.06 paras 02 to 08, 9E.12 para 13 |
| Green colour spec | Daytime chromaticity corners (x,y): (0.230,0.754), (0.266,0.500), (0.367,0.500), (0.444,0.555); luminance factor Y 7 to 35. Night corners (0.230,0.754), (0.336,0.540), (0.450,0.500), (0.479,0.520). Retroreflective allowed, not required. | FHWA IA-14, https://mutcd.fhwa.dot.gov/resources/interim_approval/ia14 |
| **Red** pavement for transit | Full lane width (para 04); may be whole or part of the lane; **broken pattern where general traffic may enter** (e.g. before a turn); full-time or part-time lanes. Does not replace required markings. | 3H.07 paras 04 to 07 |
| Red colour spec | Daytime corners (x,y): (0.420,0.330), (0.450,0.380), (0.560,0.370), (0.540,0.320). No night spec. | FHWA IA-22, https://mutcd.fhwa.dot.gov/resources/interim_approval/ia22/index.htm |
| SFMTA red lane material | thermoplastic, installed by SFMTA crews; roughly 10 miles of red lane installed 2013 to 2016 as an FHWA experiment; more than 43 miles of dedicated transit lanes in SF | https://www.sfmta.com/en/node/20769 |
| Khaki / "painted safety zones" | khaki paint with white plastic delineator posts | https://www.sfmta.com/node/25501 (SFMTA does not give dimensions) |

DEFAULT sRGB for the generator (our reading of the chromaticity boxes; tune by eye): green ~ #1E8E4F daytime, red ~ #B5332E daytime (thermoplastic is dull; brighten slightly under headlights), khaki ~ #B9A66D, bike-lane green is darker and less saturated when worn.

## 4. Bike lane geometry (CA MUTCD 2026 Ch. 9E)

Source: 9E PDF (URL in section 0).

| Item | Value | Section |
|---|---|---|
| Bike lane marking | longitudinal line + bike symbol or BIKE LANE word; symbol 72 in tall per Figure 9E-1 (figure labels 72 in and 44 in / 64 in elements) | 9E.01, Fig 9E-1 |
| Stripe beside parking | 4 to 6 in white (local roads), 6 in (State highways) | 9E.01 para 03h |
| Bike lane to curb with parking | bike-lane space min 5 ft (figure 9E-4/9E-5 callouts "5 ft Minimum"; 4 ft where no parking next to curb/gutter) | Figures in 9E |
| Dotted line approaching turn lane | 50 to 200 ft of dotted white line (2 ft line, 6 ft space around bus stops) | 9E.02, figures |
| Bike lane marking stops short of intersection | solid stripe ends 50 to 200 ft before the intersection | 9E.02 |
| Bike through lane beside a right-turn lane | min 4 ft wide; 6 ft where posted speed above 40 mph | 9E.02 |
| Buffer-separated lane | buffer min 18 in; chevrons or diagonals if buffer is 2 to 3 ft; diagonals required if more than 3 ft; chevron/diagonal lines 4 to 6 in at 45 degrees on 10 to 40 ft intervals | 9E.06 paras 09 to 14b |
| Separated bikeway posts | placed in the centre of a 3 ft buffer (2 ft min), at least 1 ft from the bike-lane line | 9E.06/9E.07 |
| Shared lane marking (sharrow) | centre at least 13 ft from curb face with parking and effective lane width at least 14 ft; otherwise per figure; spacing 50 to 250 ft | 9E.09 |
| Bicycle box | at least 10 ft deep; must contain at least one bike symbol; fully green if coloured | 9E.12 |
| Shared-use path dashed centre | 3 ft line / 9 ft gap | 9E.13 |
| Bike detector marking | see Fig 9E-16: 42 in tall with 6 in lines | 9E.15 |

SFMTA's own facility classes are Class I to IV (FACILITY_T field below). The older SF Bicycle Plan goal for lanes on fast or busy streets is 6 to 8 ft (https://www.sfgov.org/sfc/bac/bicycle-plan-part-5, dated planning document, not a standard).

## 5. Curb colours (California Vehicle Code 21458)

Source: statute text summarised at https://california.public.law/codes/vehicle_code_section_21458 ; CA MUTCD 3A.03 para 01a says curb marking colour conforms to CVC 21458.

| Curb colour | Meaning | SF dataset presence |
|---|---|---|
| Red | no stopping, standing or parking (a bus may stop if signed as bus zone) | Only **driveway** red zones are inventoried (13,298 in the SFMTA `colorcurb` layer). Corner/hydrant/bus-zone red: not found as data. |
| Yellow | loading/unloading of passengers or freight; time per local ordinance | "Yellow Zone/Commercial Loading" 132, "Commercial Loading Zone" 596, "6-Wheel Commercial Loading Zone" 88 |
| White | passenger loading, mail deposit; time per ordinance | "White Zone/Passenger Loading" 2,041; also School Bus 155, Shuttle Bus 48, Tour Bus 35 loading zones |
| Green | time-limited parking | "Green Zone/Short Term Parking" 296, "Green Meter" 120 |
| Blue | disabled persons and veterans only | "Blue Zone/Disabled Parking" 686 |

Counts (ZONE_TYPE) from the live query of https://services.sfmta.com/arcgis/rest/services/DataSF/master/MapServer/49 on 2026-10-26. Others: Taxi Zone 69, Dual-use 10, General Loading 1, two blank. The layer is a **multipoint with a FEET length attribute**, "all assets maintained by the Color Curb Program as of August 25, 2021", so it is a static 2021 snapshot (no line geometry): place a curb stripe of `FEET` length along the nearest block face, centred on the point, UNCONFIRMED how the point relates to the zone (centre vs start).

Rules for red curb with no data (DEFAULT, to be validated):
- Driveway red: from data. SFMTA says a driveway red zone is a clearance tip of about 2 ft either side of a driveway (https://www.kqed.org/news/12028846/the-numbers-behind-san-franciscos-illegally-painted-curb-problem, summarised; exact length UNCONFIRMED).
- Corners: parking is banned within 20 ft of a crosswalk by California Vehicle Code 22500(a). Not fetched (leginfo returned 403): UNCONFIRMED; SF's Better Streets Plan quotes at least 10 ft "daylighting" for SF (https://sf.streetsblog.org/2011/05/16/sfmta-daylights-crosswalks-to-improve-pedestrian-visibility, secondary). Do not paint corner red by default; paint red only where data says so or at hydrants if a hydrant dataset is added.

## 6. Dataset table

All SFMTA ArcGIS layers are under https://services.sfmta.com/arcgis/rest/services/ . The `DataSF/master` MapServer is a single service with the layers below, so one base URL gives everything (query with `/query?where=1=1&outFields=*&f=geojson`, paged; max record counts per service apply).

Licence for everything published on data.sf.gov is PDDL 1.0 (confirmed for `tzh6-6j82` and `ygmz-vaxd` on catalog.data.gov; for the other DataSF sets this is the portal default and matches MAP_RESOURCES.md). The SFMTA ArcGIS layers show no separate licence text, only a contact (layer 49 copyright text: "contact Evan Knopf"); treat them as the same data as the DataSF mirrors where a mirror exists, otherwise licence UNCONFIRMED.

### 6.1 San Francisco

| Topic | Dataset | ID / layer | Geometry | Key fields | Licence | Use |
|---|---|---|---|---|---|---|
| Bike network (lines) | MTA Bike Network Linear Features | data.sf.gov `ygmz-vaxd`; ArcGIS `DataSF/master` layer 37 `MTA.bikewaynetwork` (also `Bicycle/bicycle` layer 0) | polyline | CNN, STREETNAME, FROM_ST, TO_ST, **FACILITY_T** (CLASS I 373, II 1,804, III 2,628, IV 676, null 3), **SURFACE_TR** (GREEN PAINT 404, GREEN-BACKED SHARROWS 112, both 17, KHAKI PAINT 1, SAFE-HIT POSTS, CONCRETE), BARRIER, SHARROW, BUFFERED, RAISED, CONTRAFLOW, GREENWAVE, DIRECT/DIR, INSTALL_YR/MO, INROW | PDDL | bike lane lines, buffer, green fill, sharrows, separators |
| Bike network (points) | SFMTA Bikeway Network Point Features | `k6qg-djmi`; layer 34 | point | CNN, CORNER, STREET1/2, DESCRIPT, COUNT | PDDL | bike boxes, turn boxes, detector markings (DESCRIPT values not enumerated: UNCONFIRMED) |
| Transit-only lanes | Transit Only Lanes | `tzh6-6j82` (catalog.data.gov/dataset/transit-only-lanes); layer 10 `MTA.transitonlylanes` | line | ST_NAME, FROM_ST, TO_ST, **REDLANE**, TAXI, HOURS/HRS_BEGIN/HRS_END, DAYTYPE_WD/WE, STATUS (incl. "suspended"), DIRECTION, LAYOUT (e.g. centre/curb), MUNI_ROUTE, BUSORTRAIN, CORRIDOR, MTAB_DATE; updated 2024-01-18 | PDDL | red fill (full lane width, broken at turn entries), BUS ONLY legend, hours signs |
| Continental crosswalks | Continental Crosswalks | `g9zy-srvv`; layer 53 | point (intersection) | CNN, STREETNAME, CROSS_STRE, YR_INSTALL (0 = before 2015), CONTINENTA (YES/UNDETERMINED), LAST_REPAI, LATITUDE, LONGITUDE | PDDL | marks which intersections use continental bars. Not per-leg: apply to all legs (UNCONFIRMED whether partial). Covers post-2015 installs plus the High Injury Network only. |
| Painted safety zones | Painted Safety Zones | `vtn2-q8ky`; layer 16 (and `Pedestrian/pedestrian` layer 1) | point | CNN, UNITS, INSTALL_DA, STATUS (I implemented, L legislated), INSTALL_YR/MO | PDDL | khaki corner bulb-outs; dimensions not published, DEFAULT ~6 ft deep (SFMTA only says 6 ft is the safe turning distance) |
| Colour curb assets | Color Curb (SFMTA ArcGIS only) | layer 49 `MTA.colorcurb` (**no data.sf.gov ID found**) | multipoint | ASSET_NAME, ZONE_TYPE, FEET, SUBJECT_LO, ZONE_SPECS (free text hours/limits) | not stated | yellow/white/green/blue/driveway-red stripes; 2021 snapshot |
| Blue (accessible) | Accessible parking | layer 22 `MTA.colorcurb_blue_accessible`; `Parking/parking` layer 1 | point | ASSET_ID, STATUS_CODE, ADDRESS, STSIDE | not stated | blue zones with side of street |
| Other parking regs | Parking regulations (except non-metered color curb) | data.sf.gov `hi6h-neyh`; `Parking/parking` layers 9, 10 | line | REGULATION, DAYS, HOURS, HRLIMIT | PDDL (portal default) | signage, not paint |
| Meters | Meters / metered blockfaces | layers 19, 25; `Parking/parking` 11, 12 | point/line | POST_ID, CAP_COLOR, BLOCKFACE_ID | PDDL (portal default) | meter caps; yellow/blue/green cap colours |
| Curbs and islands | Curbs and Islands | `emxt-b6yg` | polygon/line | see MAP_RESOURCES.md | PDDL | medians, islands, true curb line; layer 12 `MTA.curbs` in DataSF/master is probably the same: UNCONFIRMED |
| Sidewalk widths | Sidewalk Widths | `4g86-grxu`; layer 18 | line | width | PDDL | pedestrian space for crosswalk length |
| Traffic calming | Traffic calming (lines + points) | layers 51, 52; also `Traffic/traffic` 8, 17, 20 | line/point | TC_MEASURE, UNITS, INSTALL_YR, CNN | PDDL (portal default) | speed humps/tables/bulb-outs: TC_MEASURE values not enumerated (UNCONFIRMED) |
| Slow Streets | Slow streets lines + points | layers 44, 48 | line/point | STREETNAME, STATUS, PHASE, BARRIER | PDDL | closure barriers |
| Speed limits | Speed Limits | `3t7b-gebn`; layer 2 | line | SPEEDLIMIT, SCHOOLZONE, SCHOOLZONE_LIMIT | PDDL | selects 7/17 vs 12/36 ft dashes; school-zone markings |
| Stop signs / signals | Stop Signs, Signals | `4542-gpa3`, `ybh5-27n2`; layers 0, 1 | point | DIRECTION, ST_FACING, CNN | PDDL | decides where stop bars go |
| Signs | Street Signs | `m48z-6ji4` | point | 144k signs | PDDL | stop-bar/crosswalk presence hints |
| Green Wave | Green wave streets/signals | layers 35, 38 | point/line | CNN, STREET | PDDL (portal default) | no paint, ignore |
| Crossing guard / schools | crossingguard_*, saferoutes_schools | layers 13, 14, 15 | point | school names | not stated | yellow crosswalks near schools |
| Muni stops / routes | Muni stops, simple routes, patterns | layers 8, 9, 43; `Transit/transit` 0 to 3 | point/line | STOPNAME, ROUTE_NAME, DIRECTION | not stated | bus-zone red curb and BUS STOP legends |
| Pavement quality | Pavement Condition Index | `5aye-4rtt` | line | PCI | PDDL | wear: fade markings, cracks |
| Metadata | SFMTA ArcGIS `metadata_dictionary` | services.sfmta.com/arcgis/rest/services/metadata_dictionary | | | | field definitions |

Notes
- The Socrata catalog API (api.us.socrata.com) returned zero results for `data.sfgov.org` and `data.sf.gov` queries on 2026-10-26, so IDs above came from catalog.data.gov pages and direct SFMTA service listings. Re-check any ID before coding against it. The portal domain moved from data.sfgov.org to data.sf.gov (301 redirect seen).
- **Muni rail and cable car are not separate dataset rows**: DataSF/master has `Muni_simpleroutes` (routes, not tracks). Take tracks from OSM (below).

### 6.2 Rail and cable car (OSM, cached in tools/cache)

From `tools/cache/osm_misc.json` and `osm_roads.json` (northern SF extract, counted 2026-10-26):

| Feature | OSM tags | Count / values | Gauge |
|---|---|---|---|
| Muni Metro and Central Subway | railway=light_rail | 456 ways in the SF bbox (PBF recount 2026-10-26) (SF city polygon: 454 ways, 120.7 km); the old ~117 came from a partial cache | 1435 mm (4 ft 8.5 in), electrified contact_line (600 V DC per https://en.wikipedia.org/wiki/Muni_Metro) |
| Muni F/E and other streetcar | railway=tram | 127 ways in the SF bbox (PBF recount 2026-10-26) (SF city polygon: 127 ways, 35.0 km); the old ~36 came from a partial cache. Muni streetcars are `railway=tram` `gauge=1435` `electrified=contact_line` (49 ways, 19.7 km) | 1435 mm |
| Cable car track | railway=tram with gauge=1067 and electrified=no (78 ways with gauge=1067 (PBF recount 2026-10-26), 77 of them `electrified=no`, 15.2 km; there are no `railway=cable_car` ways; SFMTA `route=tram` relations: Powell/Hyde 1959009/3433158, Powell/Mason 1959010/3433157, California 2852264/2852265); Hyde Street and Taylor Street carry embedded_rails=tram on the road way | | **1067 mm (3 ft 6 in)**, https://en.wikipedia.org/wiki/San_Francisco_cable_car_system |
| Cable car lines | Powell-Mason (1.6 mi), Powell-Hyde (2.1 mi), California St (1.4 mi) | | cable 1.25 in diameter, 9.5 mph |

**Cable car slot width: UNCONFIRMED.** Not found in any fetched source; Wikipedia only describes a slit between the rails, and streetcar.org says the California Street slot is about 3 in off-centre (https://www.streetcar.org/uncovering-cal-cables-past/). Do not hard-code a width. DEFAULT: a thin dark strip ~1 in wide centred between the rails, purely visual.

### 6.3 Oakland and Berkeley

| City | Dataset | Access | Fields | Licence | Status |
|---|---|---|---|---|---|
| Oakland | Existing Bikeways in Oakland (City of Oakland DOT, Bicycle & Pedestrian Program; updated 2024-09-24, 773 line features) | https://services.arcgis.com/9tC74aDHuml0x5Yz/ArcGIS/rest/services/Existing_Bikeways/FeatureServer/0 | ROADWAY, BEGINNING, ENDING, EXISTINGCL, PROPOSEDCL, Class, PRIORITYPR, VISION, ONEWAY_DIV, CENTERLINE | not stated in layer | Class codes (free text): 1, 2, 2B, 3, 3A, 3B, 4 and combinations like 2.3A, 4.2B. Class 2B appears to be "buffered", UNCONFIRMED. No SURFACE_TR-like green flag. |
| Oakland | OpenOakland 2014 bikeways copy | https://data.openoakland.org/node/56 | | "Other (Public Domain)" | outdated (2014) |
| Berkeley | Bike Boulevards (2008, shapefile on UC library mirror) | https://geodata.lib.berkeley.edu/catalog/berkeley-s76h3m | | not verified | outdated; no current Berkeley bikeway dataset found on the city portal. Use OSM `cycleway=*` there. |
| Oakland/Berkeley colour curb, transit lanes, crosswalk types | not found | | | | UNCONFIRMED: assume none; derive from OSM (`crossing:markings`, `bus:lanes`) and lidar intensity if worthwhile |

### 6.4 OSM tag coverage in our SF cache (osm_roads.json, 11,004 ways)

Useful as fallback and for lane counts:

| Tag | Count |
|---|---|
| lanes=1/2/3/4/5/6 | 501 / 1,898 / 1,310 / 646 / 133 / 24 |
| cycleway:right=lane / track / shared_lane | 389 / 207 / 283 |
| cycleway=lane / track / shared_lane | 182 / 131 / 207 |
| cycleway:*:lane=pictogram / exclusive / advisory | about 280 / about 200 / 11 |
| cycleway:buffer=yes | 20 (+9 with :both) |
| lanes:bus=1 | 104 |
| bus:lanes (sample patterns "yes|yes|designated" etc.) | about 60 |
| turn:lanes | hundreds of patterns; full tag list in cache |
| lane_markings=no / yes | 460 / 63 |
| crossing:markings=ladder | 2 only (crossing nodes mostly absent from the cache) |
| surface:colour / cycleway:*:surface:colour | **0** |

Overpass live counts for the full Phase 1 bbox were attempted and failed (HTTP 429/502 "at capacity"); not retried, to stay polite. Counts above are for the cached northern-SF extract only.

## 7. Placement algorithm (spec for the procedural generator)

Inputs per road segment: centreline (OSM or DataSF CNN), lane count (OSM `lanes`, `lanes:forward/backward`), one-way flag, speed limit (`3t7b-gebn`), road class, `bus:lanes`/`turn:lanes`, bike class (SFMTA layer), transit-only flags, intersection nodes with stop/signal controls (`4542-gpa3`, `ybh5-27n2`).

1. **Centre line**: two-way, >= 2 lanes total: double solid yellow, two 4 in lines separated by 4 in (DEFAULT; Caltrans draws about 3 in). Use 6 in lines on State highways. Where a centre two-way left-turn lane exists (OSM turn:lanes `left` in the middle), use yellow solid + yellow broken inside (not covered in data read; UNCONFIRMED figure).
2. **Lane lines**: between same-direction lanes, white broken. Speed <= 40 mph: 7 ft line + 17 ft gap. Speed >= 45 mph: 12 ft + 36 ft. Start each dash pattern at the stop line and run in phase along the segment; stop the pattern 50 to 200 ft before the intersection when a turn pocket exists, replacing it with solid or dotted (3 ft + 9 ft) lines for the pocket.
3. **Edge lines**: only outside parking: solid white (right) and, on one-ways/divided roads, solid yellow (left). SF side streets with parked cars normally have no edge line; add one only on arterials with a bike lane (the bike lane stripe is the edge line).
4. **Bike lanes** (from `ygmz-vaxd`): Class II: 4 to 6 in white line, bike symbol after each major intersection and at intervals (spacing DEFAULT 150 to 250 ft), lane width 5 ft with parking, 4 ft without (9E figures). `BUFFERED`: add 2 to 3 ft buffer with chevrons at 10 to 40 ft interval (45 degrees). `SURFACE_TR` containing GREEN: green fill of the lane and, with the dotted extension, through intersections. `FACILITY_T=CLASS IV`: separated, with posts (3 ft buffer, posts centred, DEFAULT post spacing 5 to 20 ft: UNCONFIRMED) or raised curb (`RAISED`). Sharrows (`SHARROW`): symbol at least 13 ft from curb (parking present) or 4 ft, spacing 50 to 250 ft.
5. **Transit lanes** (from `tzh6-6j82`, `REDLANE` flag): full lane width in red (thermoplastic), broken (dashed) pattern at right-turn entry, white BUS ONLY or BUS legend (legend size and exact wording UNCONFIRMED), solid white lane line on the side towards general traffic. Skip segments with `STATUS=suspended` or flag them off. Rail-embedded lanes (Muni on Market, Judah): rails take precedence.
6. **Stop bars**: at the near side of an intersection arm that has a stop sign or signal: 18 in wide, spanning the approach lanes (not the opposing lane), 4 ft before the near crosswalk edge.
7. **Crosswalks**: one per leg that has a marked crossing. Continental bars (bar width 12 to 24 in, gap 12 to 60 in but at most 2.5 x bar width; DEFAULT 24 in bars, 24 in gaps; crosswalk width at least 10 ft per Better Streets Plan) where `g9zy-srvv` marks the intersection; else two 12 in transverse lines. Yellow where within a school zone. Note SF still has many un-upgraded transverse crosswalks (the continental layer is incomplete).
8. **Curb paint**: from the `colorcurb` layer (section 5): stripe length = FEET, colour by ZONE_TYPE. Add red at bus stops from the Muni stops layer (DEFAULT 80 ft; UNCONFIRMED, real bus-stop lengths vary).
9. **Pedestrian refuge / painted safety zones**: khaki area at corner points in `vtn2-q8ky`, 6 ft deep (DEFAULT), with white delineator posts.
10. **Rail**: draw two rails at 1435 mm (Muni) or 1067 mm (cable car) gauge, flush paving; cable car gets the thin slot strip.
11. **Wear and night**: fade markings with the Pavement Condition Index; markings are retroreflective (50 mcd/m2/lx minimum on roads at 35 mph or more, 3A.05); crosswalk bars and stop lines too. Bike-lane green and transit red may be retroreflective but are not required to be (IA-14, IA-22).

## 8. Open questions

1. Chapter 3B of CA MUTCD 2026 (23 MB PDF) was skipped for size; crosswalk, stop-line, arrow, KEEP CLEAR and word sizes come from federal 2009. Please allow a download of that one file (about 23 MB) or accept the federal numbers.
2. Caltrans Standard Plan sheets A24A to A24F (arrow, word, crosswalk dimensions) exist only as DGN or inside a 120 MB PDF. Exact arrow lengths unconfirmed.
3. Data.sf.gov dataset ID for `colorcurb` (if any), and the meaning of its multipoint geometry relative to the zone: unconfirmed.
4. Cable car slot width, double-yellow gap figure (Caltrans draws 3 in, UNCONFIRMED), turn-pocket and two-way left-turn lane details.
5. How Oakland encodes its class codes (2B, 3A...), Oakland licence, and any Berkeley bikeway dataset newer than 2008.
6. Overpass counts for the full Phase 1 and Phase 2 boxes; rerun later (public server was at capacity).
7. Red curb for corners and hydrants: no dataset; need a hydrant source (DataSF/SFPUC?) or accept rule-based generation.

## Fact-check

Independent check on 2026-10-26. Verdicts: confirmed / wrong / unverifiable.

1. **Broken-line patterns and widths (CA MUTCD 2026 Ch. 3A): confirmed.** Figures 3A-101/102(CA) show 7 ft line + 17 ft gap "FOR SPEEDS 40 mph OR LESS" and 12 ft + 36 ft "FOR SPEEDS 45 mph OR MORE". 3A.04 para 02a: state-highway lane/edge/centre lines 6 in; 02b/02c: local roads minimum 4 in, may be 6 in; para 06 gives the federal-style 10 ft line / 30 ft gap "or similar ratio" as guidance. Source: https://dot.ca.gov/-/media/dot-media/programs/safety-programs/documents/ca-mutcd/2026/2026-camutcd-2026-3a-a11y.pdf (text extracted locally). Nuance: the "California does not paint 10/30" wording in section 1.1 is an inference; the CA figures simply show 7/17 and 12/36.
2. **Coloured pavement (Ch. 3H): confirmed, with one wording correction.** 3H.06 para 02-04: green limited to bike lanes, extensions, turn/bike boxes, detector backgrounds; must match the dotted-line pattern; must not replace required markings. 3H.07 para 04: red "shall be installed for the full width of the lane"; para 07: broken pattern where general traffic may enter is an Option ("may"), not a requirement. The claim's "must ... broken where general traffic may enter" overstates this; say "may be broken". Para 03 also says red is only for lanes general traffic may not occupy. The "supplement, not replace" rule is explicit for green (3H.06 para 03D) and not stated in 3H.07. Source: https://dot.ca.gov/-/media/dot-media/programs/safety-programs/documents/ca-mutcd/2026/2026-camutcd-2026-3h-a11y.pdf . IA-14/IA-22 colour specs were not re-checked.
3. **SFMTA bike network / transit-only layers: confirmed.** Layer 37 `MTA.bikewaynetwork` (polyline) has FACILITY_T and SURFACE_TR; SURFACE_TR = "GREEN PAINT" on exactly 404 segments (plus about 21 more rows with GREEN PAINT combined with other values, e.g. 17 with GREEN-BACKED SHARROWS; layer total 5,484 features). `tzh6-6j82` has a `redlane` column (cached values "red lane" and "Non-red", with nulls); both datasets are PDDL 1.0 on catalog.data.gov. Sources: https://services.sfmta.com/arcgis/rest/services/DataSF/master/MapServer/37 ; https://data.sf.gov/api/views/tzh6-6j82/columns.json ; https://catalog.data.gov/dataset/transit-only-lanes ; https://catalog.data.gov/dataset/mta-bike-network-linear-features . Note: only 25 cached "red lane" values, so red coverage by data is thin.
4. **Colorcurb layer: confirmed, except the "no dataset" part.** Layer 49 is esriGeometryMultipoint with FEET, described as "All assets maintained by the Color Curb Program as of August 25, 2021"; live count 17,577 features and 13,298 "Driveway Red Zone". Source: https://services.sfmta.com/arcgis/rest/services/DataSF/master/MapServer/49 . "No dataset covers corner or hydrant red curbs" is **unverifiable** (absence claim); a web search found no such open dataset, only hearing results and 311 tickets (https://www.sfmta.com/node/29622).
5. **Crosswalk standards: confirmed.** SF Better Streets: two 12 in retro-reflective thermoplastic stripes, minimum 10 ft wide (https://sfbetterstreets.org/find-project-types/pedestrian-safety-and-traffic-calming/crosswalks/). Federal 2009 3B.18: bars 12 to 24 in wide, gaps 12 to 60 in, gap not over 2.5x bar width, all "should" guidance (https://mutcd.fhwa.dot.gov/htm/2009r1r2/part3/part3b.htm). `g9zy-srvv` Continental Crosswalks lists intersections with at least one continental crosswalk, installs after 2015 plus High Injury Network, PDDL (https://catalog.data.gov/dataset/continental-crosswalks). sfmta.com/continental-crosswalks gives policy and yellow-near-schools but no bar dimensions, as the file says. Caveat: data is per intersection, not per leg.

- PBF recount 2026-10-26: OSM counts re-verified against a Geofabrik extract; see probes/osm_recount_vs_notes.json.

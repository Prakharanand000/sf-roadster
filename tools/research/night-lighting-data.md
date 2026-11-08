# Night lighting: real-world data

Source: research agent, 2026-10-26. "Verified" means fetched or queried directly; anything else is marked UNCONFIRMED.

## Streetlights

| Item | Finding |
|---|---|
| SF ownership | ~43–45.5k lights: SFPUC ~22–26.5k, PG&E the rest (2013 CPUC filing; Potrero View) |
| SF point dataset | **None found** on data.sf.gov (Socrata catalog search). SFPUC may hold an internal GIS layer (UNCONFIRMED). |
| Oakland | ~36,000 lights and 671 signalised intersections (2011 Public Works). No point dataset found. |
| Berkeley | No dataset found |
| Caltrans freeway lighting | No dataset found |
| OSM `highway=street_lamp` (Overpass 2026-10-26; recounted from the Geofabrik PBF) | SF 1,801 nodes (PBF recount 2026-10-26) (SF city polygon 1,786; ~4% of the ~44k real lights, not ~3%); Oakland bbox 886 (PBF recount 2026-10-26) (city polygon 568); Berkeley 91 (PBF recount 2026-10-26) (city polygon 74). The earlier SF, Oakland and Berkeley figures (1,445–1,451, 956, 105) came from a partial query. |

**Conclusion:** no open streetlight inventory exists. Generate lamps along road centrelines at a
typical spacing (~30–40 m; UNCONFIRMED, should be checked against NAIP or lidar pole detection)
and use the OSM lamps as seeds and corrections.

Possible upgrade: detect poles in the lidar point clouds (tall thin non-ground clusters beside
roads). Not researched yet.

## Light colour

**Streetlights:**
- **SF (SFPUC):** ~18,500 fixtures converted to LED, finishing in 2018. SFPUC says 3000K "warm white" (another source says neutral white). PG&E-owned lights: colour UNCONFIRMED.
- **Oakland:** ~30,000 HPS cobraheads became GE Evolve LEDs around 2013. Colour temperature UNCONFIRMED, likely 4000K.
- **Berkeley:** 4000K LEDs from 2014; the 2019 Tanko/Leotek retrofit uses 3000K. So it is a mix.

**Golden Gate Bridge:**
- Roadway: HPS/LPS in amber-lensed shoeboxes with a yellow-amber look (PNNL-21894, 2012, osti.gov/biblio/1060680). A later LED retrofit is UNCONFIRMED.
- Tower floodlights: UNCONFIRMED.

**Bay Bridge:**
- Roadway lighting: not researched.
- **The Bay Lights 360** (verified via illuminate.org):
  - Relaunched 2026-03-20. ~48,000 white LEDs (originally 25,000), built by Musco, nightly dusk to dawn.
  - They run along the northern cable plane of the west span (SF to YBI), 1.8 mi.
  - The SF-facing strand is on now. An inward, East Bay-facing strand is pending.
  - White-only choreographed sequences.

## Landmark lighting

| Landmark | Look |
|---|---|
| Salesforce Tower crown | "Day for Night" (Jim Campbell), white LED display. Starts at dusk with a sunset-colour sequence and runs to ~2 a.m. (2018; current hours UNCONFIRMED). |
| SF City Hall | 220+ LED fixtures. Soft white nightly from sunset, with themed colours for occasions (schedule on sf.gov). |
| Lake Merritt Necklace of Lights | 4,000+ bulbs on 126 lampposts, warm/white, dusk to dawn |
| Coit Tower, Transamerica, Ferry Building, Palace of Fine Arts, Fox, Paramount, Castro, Fisherman's Wharf, Chinatown neon, Sather Tower | UNCONFIRMED, needs a targeted pass |

## Night reference imagery (NASA, generally public domain)
- **Black Marble VNP46A2:** 500 m, daily. Useful as a regional brightness prior only.
- **ISS night photos** (look up on eol.jsc.nasa.gov):
  - ISS037-E-2604 (2013-09-25): SF, Oakland, San Jose; also at science.nasa.gov/earth/earth-observatory/san-francisco-region-at-night-82198
  - ISS030-E-015724 (2011-12-25)
  - ISS073E0285002 (2025-07-04)

## Window occupancy drivers
- **DataSF Land Use 2023:** `fdfd-xptc`.
- **Land Use 2016:** `us3s-fp9q`. Fields: RESUNITS, BLDGSQFT, and office/retail/industrial square footage per parcel.
- **Oakland / Alameda County land-use codes:** not researched.
- **Office after-hours occupancy:** only proprietary data exists (Kastle), so use modelled schedules instead.

## Traffic signals
- **DataSF Traffic Signals `ybh5-27n2`** (verified): 1,507 rows, PDDL, quarterly. Fields include CNN, STREET1-4, TYPE, PED_SIGNAL, BEACON_FLA and a point shape. API: https://data.sf.gov/resource/ybh5-27n2.json
- **Oakland / Berkeley signals:** not found.

## Working colour assumptions
- SF street LEDs 3000K; Berkeley a 3000K/4000K mix; Oakland 4000K (UNCONFIRMED).
- Golden Gate roadway amber sodium; Bay Lights white.
- Leftover HPS (~2000K) only where the data confirms it.

## Fact-check

- PBF recount 2026-10-26: OSM counts re-verified against a Geofabrik extract; see probes/osm_recount_vs_notes.json.

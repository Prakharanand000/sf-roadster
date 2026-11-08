# Road surface from lidar: method and first measurements

Measured 2026-10-26 on real SF B23 points (`CA_SanFrancisco_1_B23`, read from USGS EPT). Closes the
first half of MAP_RESOURCES §11 gap 1. Script: `tools/probes/road_surface.py`. Raw results and
plots: `tools/research/probes/road_*.json` and `road_*.png`.

## Answer

**Yes for straight and gently curved streets, and the numbers match the published ones.** OSM gives
where the road goes; lidar ground points give its height, crown, gutters and curbs. Parked cars did
not leave holes at this point density. Hairpins (Lombard's crooked block) need a 2D method instead.

## Method (as implemented)

1. **Centreline**: OSM ways with the street's name and a drivable `highway` value, from the Geofabrik
   extract. Shortest path along them between the nodes shared with the two cross streets.
2. **Points**: every EPT point within 16 m of the centreline, withheld points dropped, reprojected to
   SFT1 metres. Each point gets a station (distance along the centreline) and a signed offset (left
   when travelling from the first cross street to the second).
3. **Long profile**: median height of ground (class 2) points with |offset| ≤ 2.5 m, per 1 m station.
4. **Cross-section**: ground height minus the profile at that station, in 0.2 m offset bins, computed
   **per 10 m window** (one block-wide median smears the curb when the centreline is off-centre).
   - Gutter = lowest point of the 3-bin smoothed section 2.5–13 m out on each side.
   - A gutter on the edge of that range is counted as "at cap" and left out, because its value is
     censored rather than measured.
   - Curb rise = median height 0.6–1.4 m outward of the gutter minus the gutter; counted when ≥ 8 cm.
   - The block is flagged invalid when the centreline turns more than 60° within 20 m (hairpins fold
     the station/offset projection).
5. **Baseline**: the Terrarium z14 DEM the game bakes from today, sampled at the same stations.

The script was reviewed by a code-checking agent. Grades, drops and the Terrarium comparison passed.
Its two curb findings (the gutter search capping at Judah, and a ~1 cm high bias from taking a raw
minimum) are fixed in the numbers below.

## Results

| Block | Length (m) | Ground pts/m² in corridor | Mean grade | Steepest 62.9 m window | Published | Crown to gutter, L / R (m) | Gutter to gutter (m) | Curb found (10 m windows, L / R) | Curb rise, median L / R (m) | OSM centreline offset (m) | Terrarium − lidar on centreline (m) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Filbert, Hyde → Leavenworth | 146.9 | 43.8 | 15.6% | **30.4%** | 31.5% | 0.12 / 0.13 | 11.1 | 10/14, 11/14 | 0.11 / 0.11 | −0.25 | mean −0.29, max 0.53 |
| 22nd, Church → Vicksburg | 96.7 | 39.7 | 25.3% | **31.5%** | 31.5% | 0.20 / 0.02 | 11.7 | 6/9, 3/9 | 0.13 / 0.12 | 0.5 | mean −0.34, max 0.53 |
| Lombard crooked block, Hyde → Leavenworth | 197.5 (along curves) | 29.2 | 16.7% | 18.6% | none published | invalid (124° turn in 20 m) | invalid | invalid | invalid | n/a | mean 0.09, max 0.67 |
| Kirkham, 30th → 31st Ave (flat Sunset) | 94.8 | 68.7 | 2.1% | 2.8% | — | 0.20 / 0.20 | 14.4 | 7/9, 7/9 | 0.13 / 0.11 | 0.1 | mean −0.13, max 0.20 |
| Judah, 30th → 31st Ave (streetcar) | 94.8 | 69.9 | 3.2% | 4.1% | — | 0.09 / 0.09 | 17.2 | 8/9, 7/9 | 0.14 / 0.12 | 0.3 | mean −0.08, max 0.15 |

- "Published" is the 206.25 ft (62.9 m) half-block grade from `validation.md` §1.
- "OSM centreline offset" is the midpoint of the two measured gutters relative to the OSM line.
- Ground density is averaged over the 32 m corridor, so it includes building footprints that have no
  ground returns.

## What this shows

1. **Grades match the published figures.**
   - 22nd St measures 31.51% against the published 31.5%.
   - Filbert measures 30.4% against 31.5%, inside the 28.5–34.5% band in `validation.md`.
   - Filbert's whole block averages only 15.6% because the upper half is nearly flat. The famous
     figure is the lower half-block, as `validation.md` §1 already suspected.
2. **Lombard passes all three `validation.md` checks**: polyline 197.5 m (gate 160–200), drop
   32.8 m (28–40), mean grade 16.7% (15–23%). OSM tags the way `incline=-16%`.
3. **The cross-section is real road geometry**, consistent from window to window on straight blocks:
   - The crown sits 8–20 cm above the gutter: Kirkham 20 cm each side, Filbert 12–13 cm, and Judah
     8 cm with a flat trackbed of about ±5 m.
   - Curbs rise 11–14 cm above the gutter (block medians). That is under the 15 cm HDM standard,
     which is plausible where repaving has raised the road; this is not checked.
   - Judah shows a 15 cm raised strip about 2 m wide in a few windows. These are probably the
     streetcar boarding islands at 31st Ave (UNCONFIRMED).
4. **Parked cars are not a blocker at this density.**
   - No 1 m station in the centre band lacked ground returns.
   - A gutter was found inside the search range in 78–100% of 10 m windows on the straight blocks.
5. **OSM centrelines sit within 0.5 m of the measured gutter midline** on these blocks. That supports
   D3 (OSM topology, lidar geometry).
6. **Today's terrain already gets centreline height within 0.15–0.67 m** on all five blocks.
   - The lidar's added value on roads is the cross-section (crown, gutters, curbs, islands) and
     detail under 10 m.
   - Away from roads the gap is larger: over the Nob Hill tile the Terrarium−lidar RMS is 1.35 m
     with a 11 m maximum (`lidar-probes.md`).
7. **Where the method failed:**
   - Lombard's hairpins make station/offset meaningless; the script now flags such blocks
     automatically. Use 2D curb breaklines from a 0.25–0.5 m ground raster there, or hand-author it
     as a landmark.
   - 22nd is asymmetric (20 cm vs 2 cm of crown fall, curbs in only 3–6 of 9 windows); not investigated.

## Consequences for the bake

- **Ribbon height**: the 1 m lidar profile along the OSM centreline.
- **Ribbon width and curb lines**: per-window gutter offsets, smoothed. Where fewer than half the
  windows find a curb, fall back to DataSF curbs (`emxt-b6yg`) in SF, then OSM `width`/`lanes`, then
  HDM defaults.
- **Cross slope**: the measured crown profile. Store it as gutter depth below crown per side, not a
  fixed 2%.
- **Curb height**: the measured rise per block, default 0.12 m.

## Not done yet

- East Bay blocks (Alameda `_2`/`_3`, lower ground density, see `lidar-probes.md`).
- Junction blending, superelevation on curves and ramps, speed humps and tables, driveway curb cuts.
- Checking detected curb lines against DataSF Curbs and Islands (`emxt-b6yg`).
- 2D curb extraction for hairpins and plazas.

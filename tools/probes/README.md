# Real-data probes

One-off measurements on real USGS lidar and OSM data, used to check the estimates in
`tools/research/`. Results are written to `tools/research/probes/` and summarised in
`tools/research/lidar-probes.md` and `tools/research/road-surface-method.md`. None of this
is needed to run the game.

## Setup (Windows)

1. Command-line tools (PDAL, osmium) from conda-forge:
   ```
   mamba env create -f tools/environment.yml
   ```
2. A python.org Python venv for the analysis side:
   ```
   py -3.13 -m venv %USERPROFILE%\Downloads\sf-roadster-bakecache\venv
   %USERPROFILE%\Downloads\sf-roadster-bakecache\venv\Scripts\python -m pip install numpy scipy matplotlib pillow pyproj "laspy[lazrs]"
   ```
   Smart App Control blocks parts of conda-forge's Python, so the probes call PDAL and osmium as
   programs and do the rest in this venv. On machines without that policy the `bake` env's own
   Python works too.

`SF_BAKE_ENV` and `SF_BAKE_CACHE` override the env and cache paths (see `common.py`). Lidar is
read from the public USGS EPT bucket and cached as LAZ under the cache folder; nothing large goes
in the repo.

## Scripts

| Script | Measures |
|---|---|
| `common.py` | Shared helpers: EPT fetch through PDAL, LAZ load, SFT1 reprojection |
| `road_surface.py` | One street block: lidar profile and grade, crown, gutters, curbs, vs today's Terrarium terrain |
| `tile_benchmark.py` | One 512 m SFT1 tile: fetch time, DTM/DSM, height-grid bytes |
| `class_histogram.py` | Lidar classes and densities per sample box |
| `deck_crops.py` | Bridge-deck class 17 on stacked structures |
| `osm_recount.py` | OSM tag coverage and feature counts per city from the Geofabrik extract |

Example (from the repo root, with the OSM street lines exported by osmium):
```
python tools/probes/road_surface.py streets.geojson "Filbert Street" "Hyde Street" "Leavenworth Street" filbert tools/research/probes
```

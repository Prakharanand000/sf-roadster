"""Geo helpers for the v2 world (tools/research/v2-build-plan.md).

Drop-in for geo.py: the same names, so the v1 bake functions run unchanged on the v2 area when
`bake_v2.py` installs this module as `geo` before importing `bake`. What differs:
- projection: local transverse Mercator on NAD83(2011) at Union Square (CONTRACTS patch item 1),
  x = easting, z = -northing; replaces the equirectangular constants, which squash the map;
- datum: heights are NAVD88 minus Y0 (mean sea level at NOAA 9414290), so sea water is y = 0;
- area: SF to Berkeley/Oakland, on a grid aligned to the 512 m tiles;
- caches: outside the repo (SF_BAKE_CACHE/v2), since OSM and DEM inputs are large.
"""
import json
import math
import os

import numpy as np
from pyproj import Transformer

# Same helpers as v1 for everything that is not projection-specific. Only pure geometry may come
# from geo.py: a geo.py function that projects (geom_xy, element_polygons) would use the v1
# projection through its own module globals. bake_v2.py checks this at startup.
from geo import assemble_rings, dp_simplify, poly_area, simplify_ring  # noqa: F401
PURE_FROM_GEO = ('assemble_rings', 'dp_simplify', 'poly_area', 'simplify_ring')

LAT0, LON0 = 37.7880, -122.4075
# Equirectangular metres per degree at LAT0: only for rough distances in lat/lon space (district()),
# never for positions.
KX = 111320.0 * math.cos(math.radians(LAT0))
KZ = 110540.0

TM = ("+proj=tmerc +lat_0=37.7880 +lon_0=-122.4075 +k_0=1 +x_0=0 +y_0=0 "
      "+ellps=GRS80 +units=m +no_defs")
Y0 = 0.969          # m: MSL above NAVD88 at NOAA 9414290 (epoch 1983-2001); y = NAVD88 - Y0
TILE = 512.0        # m: L0 tile size, i = floor(x / TILE), j = floor(z / TILE)

_fwd = Transformer.from_crs("EPSG:4326", TM, always_xy=True)
_inv = Transformer.from_crs(TM, "EPSG:4326", always_xy=True)


def proj(lat, lon):
    e, n = _fwd.transform(lon, lat)
    return (float(e), float(-n))


def proj_arr(lat, lon):
    e, n = _fwd.transform(np.asarray(lon, dtype=np.float64), np.asarray(lat, dtype=np.float64))
    return np.asarray(e), -np.asarray(n)


def unproj(x, z):
    lon, lat = _inv.transform(x, -np.asarray(z) if not np.isscalar(z) else -z)
    if np.isscalar(lat):
        return (float(lat), float(lon))
    return (np.asarray(lat), np.asarray(lon))


# play area (lat/lon): SF to the Daly City line, the Bay Bridge, YBI/TI, Oakland, Emeryville, Berkeley
AREA = dict(s=37.700, n=37.905, w=-122.520, e=-122.200)

# heightfield grid (8 m) with a 1 km margin, aligned so tile edges fall on grid lines
CELL = 8.0


def _area_xz():
    xs, zs = [], []
    for la in (AREA['s'], AREA['n']):
        for lo in (AREA['w'], AREA['e']):
            x, z = proj(la, lo)
            xs.append(x); zs.append(z)
    return min(xs), max(xs), min(zs), max(zs)


_x0, _x1, _z0, _z1 = _area_xz()
GX0 = math.floor((_x0 - 1000.0) / TILE) * TILE
GZ0 = math.floor((_z0 - 1000.0) / TILE) * TILE
NX = int(math.ceil((_x1 + 1000.0 - GX0) / TILE) * TILE / CELL) + 1
NZ = int(math.ceil((_z1 + 1000.0 - GZ0) / TILE) * TILE / CELL) + 1
# landcover raster (4 m pixels, pixel (i,j) covers [GX0+4i, GX0+4i+4))
LC_RES = 4.0
LCX, LCZ = int((NX - 1) * CELL / LC_RES), int((NZ - 1) * CELL / LC_RES)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BAKE_CACHE = os.environ.get("SF_BAKE_CACHE", os.path.expanduser(r"~\Downloads\sf-roadster-bakecache"))
CACHE = os.path.join(BAKE_CACHE, "v2")       # osm_*.json and dem/ for the v2 area
OUT = os.path.join(ROOT, "data", "v2")       # baked v2 world


def world_bounds():
    return dict(minX=round(_x0), maxX=round(_x1), minZ=round(_z0), maxZ=round(_z1))


def load_osm(name):
    with open(os.path.join(CACHE, 'osm_%s.json' % name), encoding='utf8') as f:
        return json.load(f)['elements']


def geom_xy(geom):
    """Overpass geometry list -> Nx2 float array of world x,z."""
    lat = np.array([g['lat'] for g in geom if g is not None])
    lon = np.array([g['lon'] for g in geom if g is not None])
    x, z = proj_arr(lat, lon)
    return np.stack([x, z], axis=1)


def element_polygons(e):
    """Outer rings (Nx2 world arrays, closed) of a way/relation area element (geo.py's, on geo2's geom_xy)."""
    if e['type'] == 'way':
        g = e.get('geometry')
        if not g or len(g) < 4:
            return []
        p = geom_xy(g)
        if np.hypot(*(p[0] - p[-1])) > 1.0:
            return []
        return [p]
    if e['type'] == 'relation':
        outs = [geom_xy(m['geometry']) for m in e.get('members', [])
                if m.get('type') == 'way' and m.get('role') in ('outer', '') and m.get('geometry')]
        return assemble_rings(outs)
    return []

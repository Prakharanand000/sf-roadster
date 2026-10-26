"""Shared geo helpers for the SF Roadster Rush bake (see CONTRACTS.md for the projection)."""
import json, math, os
import numpy as np

LAT0, LON0 = 37.7880, -122.4075
KX = 111320.0 * math.cos(math.radians(LAT0))
KZ = 110540.0

# play area (lat/lon) and derived world bounds
AREA = dict(s=37.765, n=37.832, w=-122.490, e=-122.372)

# heightfield grid (8 m), slightly larger than the play area
CELL = 8.0
GX0, GZ0 = -7480.0, -5080.0
NX, NZ = 1351, 981            # samples -> covers 10800 x 7840 m
# landcover raster (4 m pixels, pixel (i,j) covers [GX0+4i, GX0+4i+4))
LC_RES = 4.0
LCX, LCZ = 2700, 1960

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, 'cache')


def proj(lat, lon):
    return ((lon - LON0) * KX, -(lat - LAT0) * KZ)


def proj_arr(lat, lon):
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    return (lon - LON0) * KX, -(lat - LAT0) * KZ


def unproj(x, z):
    return (LAT0 - z / KZ, LON0 + x / KX)


def world_bounds():
    x0, z1 = proj(AREA['s'], AREA['w'])
    x1, z0 = proj(AREA['n'], AREA['e'])
    return dict(minX=round(x0), maxX=round(x1), minZ=round(z0), maxZ=round(z1))


def load_osm(name):
    with open(os.path.join(CACHE, 'osm_%s.json' % name), encoding='utf8') as f:
        return json.load(f)['elements']


def geom_xy(geom):
    """Overpass geometry list -> Nx2 float array of world x,z."""
    lat = np.array([g['lat'] for g in geom if g is not None])
    lon = np.array([g['lon'] for g in geom if g is not None])
    x, z = proj_arr(lat, lon)
    return np.stack([x, z], axis=1)


def assemble_rings(member_geoms):
    """Join open way pieces (lists of (x,z)) into closed rings by matching endpoints."""
    pieces = [list(map(tuple, g)) for g in member_geoms if len(g) >= 2]
    rings = []
    key = lambda p: (round(p[0], 2), round(p[1], 2))
    while pieces:
        cur = pieces.pop()
        changed = True
        while key(cur[0]) != key(cur[-1]) and changed:
            changed = False
            for i, p in enumerate(pieces):
                if key(p[0]) == key(cur[-1]):
                    cur = cur + p[1:]; pieces.pop(i); changed = True; break
                if key(p[-1]) == key(cur[-1]):
                    cur = cur + p[::-1][1:]; pieces.pop(i); changed = True; break
                if key(p[-1]) == key(cur[0]):
                    cur = p + cur[1:]; pieces.pop(i); changed = True; break
                if key(p[0]) == key(cur[0]):
                    cur = p[::-1] + cur[1:]; pieces.pop(i); changed = True; break
        if len(cur) >= 4:
            rings.append(np.array(cur))
    return rings


def element_polygons(e):
    """Outer rings (Nx2 world arrays, closed) of a way/relation area element."""
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


def poly_area(p):
    x, z = p[:, 0], p[:, 1]
    return 0.5 * float(np.sum(x[:-1] * z[1:] - x[1:] * z[:-1]) + x[-1] * z[0] - x[0] * z[-1])


def dp_simplify(pts, tol):
    """Douglas-Peucker on an open polyline (Nx2)."""
    n = len(pts)
    if n < 3:
        return pts
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        A, B = pts[a], pts[b]
        d = B - A
        L = math.hypot(d[0], d[1])
        seg = pts[a + 1:b] - A
        if L < 1e-9:
            dist = np.hypot(seg[:, 0], seg[:, 1])
        else:
            dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L
        i = int(np.argmax(dist))
        if dist[i] > tol:
            m = a + 1 + i
            keep[m] = True
            stack.append((a, m)); stack.append((m, b))
    return pts[keep]


def simplify_ring(ring, tol):
    """ring: closed Nx2 (first==last). Returns open ring (no duplicate) simplified."""
    r = ring[:-1] if np.hypot(*(ring[0] - ring[-1])) < 0.01 else ring
    if len(r) <= 4:
        return r
    # split at the vertex farthest from vertex 0 so DP handles closed rings
    d = np.hypot(r[:, 0] - r[0, 0], r[:, 1] - r[0, 1])
    k = int(np.argmax(d))
    a = dp_simplify(np.vstack([r[:k + 1]]), tol)
    b = dp_simplify(np.vstack([r[k:], r[:1]]), tol)
    out = np.vstack([a[:-1], b[:-1]])
    # remove near-duplicate consecutive points
    keep = [0]
    for i in range(1, len(out)):
        if np.hypot(*(out[i] - out[keep[-1]])) > 0.3:
            keep.append(i)
    out = out[keep]
    if len(out) >= 2 and np.hypot(*(out[0] - out[-1])) < 0.3:
        out = out[:-1]
    return out

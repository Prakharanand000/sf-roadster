"""v2 world bake: the v1 pipeline (tools/bake.py) on the larger v2 area, written as tiles + net.

    python tools/osm_from_pbf.py     # OSM inputs (once)
    python tools/bake_v2.py          # -> data/v2/net.json, net.bin.wasm, tiles/*.bin.wasm

Plan and decisions: tools/research/v2-build-plan.md. This module installs geo2 as `geo` before
importing bake, so every v1 function runs with the v2 projection (transverse Mercator), datum
(sea at y = 0) and grid. Only what does not scale to a 30 km grid, or is specific to the v1 area,
is replaced here:
- the DEM sampler (Terrarium tiles for the v2 area; heights NAVD88 - Y0);
- the sea mask seeds (East Bay waters added);
- landcover and heightfield lake handling (masks cropped to each lake's box instead of full-size);
- the router's "main component" (SF and the East Bay are separate road networks until the Bay
  Bridge is added) and unhinted intersections (kept inside the v1 area, where the six tracks are);
- tree budgets (scaled to the area) and no building cap (the world streams by tile).
The landmark block of bake.main is reproduced here unchanged apart from these hooks.

Output: one global `net` (roads, graph, junctions, tracks, landmarks, lakes, structures, coarse
16 m terrain, 8 m landcover, skyline) plus one file per 512 m tile with any land (8 m heights,
4 m landcover, buildings, trees). Tile coordinates are tile-local, so nothing overflows.
"""
import hashlib
import json
import math
import pickle
import os
import re
import sys
import time
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import geo2  # noqa: E402
sys.modules['geo'] = geo2          # bake does `from geo import *`
import bake as v1                  # noqa: E402
import baybridge_v2 as bb          # noqa: E402
from geo2 import (AREA, CACHE, CELL, GX0, GZ0, LC_RES, LCX, LCZ, NX, NZ, OUT, TILE, TM, Y0,  # noqa: E402
                  geom_xy, load_osm, poly_area, proj, simplify_ring, unproj, world_bounds)

log = v1.log


def _check_geo_leaks():
    """Every function bake got from `geo` must be geo2's, or pure geometry from geo.py: anything
    else would still project with the v1 constants (it looks names up in geo.py's globals)."""
    bad = [n for n, f in vars(v1).items()
           if callable(f) and getattr(f, '__globals__', {}).get('__name__') == 'geo' and n not in geo2.PURE_FROM_GEO]
    assert not bad, 'v1 projection leaks into the v2 bake through geo.py: %s' % bad


_check_geo_leaks()
WATER, URBAN, PARK, WOOD, SAND, LAKE, PIER = v1.WATER, v1.URBAN, v1.PARK, v1.WOOD, v1.SAND, v1.LAKE, v1.PIER
V1_AREA = dict(s=37.765, n=37.832, w=-122.490, e=-122.372)   # where the six tracks live


# ---------------------------------------------------------------------------------------- DEM
DEM_Z = 14
DEM_DIR = os.path.join(CACHE, 'dem')


def _tile_xy(lat, lon, z=DEM_Z):
    n = 2 ** z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


def fetch_dem():
    """Terrarium z14 tiles covering the whole v2 grid (cached)."""
    os.makedirs(DEM_DIR, exist_ok=True)
    corners = [unproj(x, z) for x in (GX0, GX0 + (NX - 1) * CELL) for z in (GZ0, GZ0 + (NZ - 1) * CELL)]
    lats = [c[0] for c in corners]; lons = [c[1] for c in corners]
    x0, y0 = _tile_xy(max(lats) + 0.005, min(lons) - 0.005)
    x1, y1 = _tile_xy(min(lats) - 0.005, max(lons) + 0.005)
    todo = [(tx, ty) for ty in range(int(y0), int(y1) + 1) for tx in range(int(x0), int(x1) + 1)]
    got = 0
    for tx, ty in todo:
        p = os.path.join(DEM_DIR, f'{DEM_Z}_{tx}_{ty}.png')
        if os.path.exists(p) and os.path.getsize(p) > 0:
            continue
        url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{DEM_Z}/{tx}/{ty}.png'
        req = urllib.request.Request(url, headers={'User-Agent': 'SFRoadsterRush/1.0 (personal game build)'})
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
        with open(p, 'wb') as f:
            f.write(body)
        got += 1
    log(f'DEM tiles: {len(todo)} needed, {got} downloaded')


def load_dem_sampler():
    """Bilinear Terrarium heights at world (x, z), on the v2 projection and datum."""
    files = [f for f in os.listdir(DEM_DIR) if f.endswith('.png')]
    xs = sorted({int(f.split('_')[1]) for f in files}); ys = sorted({int(f.split('_')[2][:-4]) for f in files})
    tx0, ty0 = xs[0], ys[0]
    mos = np.zeros(((ys[-1] - ty0 + 1) * 256, (xs[-1] - tx0 + 1) * 256), dtype=np.float32)
    for f in files:
        _, tx, ty = f[:-4].split('_'); tx = int(tx); ty = int(ty)
        im = np.asarray(Image.open(os.path.join(DEM_DIR, f)).convert('RGB')).astype(np.float64)
        mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = \
            im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
    n = 2 ** DEM_Z

    def sample(x, z):
        shape = np.shape(x)
        lat, lon = unproj(np.ravel(x), np.ravel(z))
        px = ((np.asarray(lon) + 180) / 360 * n - tx0) * 256 - 0.5
        py = ((1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n - ty0) * 256 - 0.5
        v = ndimage.map_coordinates(mos, [py, px], order=1, mode='nearest')
        return (v - Y0).reshape(shape)
    return sample


# -------------------------------------------------------------- lidar ground (USGS 1 m DEM)
FEATHER = 48.0      # m: where no lidar project covers land, blend into Terrarium over this distance


def lidar_ground_sampler(terr, sea):
    """Heights at world (x, z): USGS's 1 m bare-earth DEM (tools/dem1m_v2.py, as 4 m means) on
    land, Terrarium over the sea (bathymetry) and on land no lidar project covers, blended over
    FEATHER. Sea points within a pixel of the shore get the shore's land height; the heightfield
    clamps every sea node below -0.8 m anyway. Returns (sampler, stats); Terrarium alone when the
    mosaic has not been built."""
    import dem1m_v2
    M = dem1m_v2.load_mosaic()
    if M is None:
        log('no 1 m DEM mosaic (run tools/dem1m_v2.py): Terrarium everywhere')
        return terr, None
    have = np.isfinite(M)
    gap = ~have & ~sea          # land without lidar; the coast is not a gap (land and sea are apart)
    if gap.any():
        wf = np.clip(ndimage.distance_transform_edt(~gap) * LC_RES / FEATHER, 0, 1)
        wf = (wf * wf * (3 - 2 * wf)).astype(np.float32)      # blend toward lidar, 0 in gaps
    else:
        wf = np.ones(gap.shape, np.float32)
    wl = np.where(have & ~sea, 1, 0).astype(np.float32)       # which pixels a land height may use
    Mw = np.where(have & ~sea, M - Y0, 0).astype(np.float32)
    del M, gap

    def sample(x, z):
        shape = np.shape(x)
        x = np.ravel(x); z = np.ravel(z)
        fx = (x - GX0) / LC_RES - 0.5
        fz = (z - GZ0) / LC_RES - 0.5
        num = ndimage.map_coordinates(Mw, [fz, fx], order=1, mode='nearest')
        den = ndimage.map_coordinates(wl, [fz, fx], order=1, mode='nearest')
        b = ndimage.map_coordinates(wf, [fz, fx], order=1, mode='nearest')
        t = terr(x, z)
        with np.errstate(invalid='ignore', divide='ignore'):
            lid = num / den             # mean of the land lidar pixels around the point
        return np.where(den > 1e-3, b * lid + (1 - b) * t, t).reshape(shape)

    land = ~sea
    st = dict(land_with_lidar=round(float((have & land).sum() / max(land.sum(), 1)), 4))
    # every 16 m, for the comparison only
    SX, SZ = np.meshgrid(GX0 + (np.arange(0, LCX, 4) + 0.5) * LC_RES, GZ0 + (np.arange(0, LCZ, 4) + 0.5) * LC_RES)
    m = (have & land)[::4, ::4]
    d = sample(SX[m], SZ[m]) - terr(SX[m], SZ[m])
    assert d.size, 'the 1 m DEM mosaic covers no land of this grid'
    st['lidar_minus_terrarium_m'] = dict(mean=round(float(d.mean()), 3), rms=round(float(np.sqrt((d ** 2).mean())), 3),
                                         p95_abs=round(float(np.percentile(np.abs(d), 95)), 3))
    log('lidar ground: %.1f%% of land from the 1 m DEM; lidar - Terrarium on land: %s'
        % (100 * st['land_with_lidar'], st['lidar_minus_terrarium_m']))
    return sample, st


# ---------------------------------------------------------------------------------- sea mask
SEA_SEEDS = [(37.815, -122.400), (37.805, -122.488), (37.823, -122.440), (37.800, -122.376), (37.790, -122.380),
             # v2: Pacific off Ocean Beach, the Bay east of YBI, south Bay, Oakland outer harbour, the Estuary
             # (both at their DEM minimum: -17.7 / -16.6 m), Emeryville and Berkeley flats, off Hunters Point
             (37.750, -122.530), (37.810, -122.340), (37.760, -122.360), (37.8075, -122.3400), (37.7913, -122.2900),
             (37.850, -122.320), (37.880, -122.330), (37.720, -122.360)]
# places that must come out as land / sea (the bake stops otherwise): a seed on land floods a whole
# coast-bounded landmass, which happened once with two East Bay seeds
LAND_CHECKS = [('Berkeley, Shattuck & Center', 37.8716, -122.2727), ('Oakland City Hall', 37.8044, -122.2712),
               ('Emeryville', 37.8313, -122.2852), ('Alameda', 37.7652, -122.2416), ('Twin Peaks', 37.7544, -122.4477),
               ('Union Square', 37.7880, -122.4075), ('Treasure Island', 37.8236, -122.3706), ('Sausalito', 37.8591, -122.4853)]
SEA_CHECKS = [('Bay off the Ferry Building', 37.7980, -122.3850), ('Oakland Estuary', 37.7913, -122.2900),
              ('Pacific off Ocean Beach', 37.7600, -122.5150), ('Bay off Berkeley', 37.8650, -122.3300)]


def check_sea(sea):
    bad = []
    for name, la, lo, want in [(n, a, o, False) for n, a, o in LAND_CHECKS] + [(n, a, o, True) for n, a, o in SEA_CHECKS]:
        x, z = proj(la, lo)
        i, j = int((x - GX0) / LC_RES), int((z - GZ0) / LC_RES)
        if bool(sea[j, i]) != want:
            bad.append('%s should be %s' % (name, 'sea' if want else 'land'))
    assert not bad, 'sea mask: ' + '; '.join(bad)


def build_sea_mask(dem_lc):
    coast = load_osm('coast')
    img = Image.new('L', (LCX, LCZ), 0)
    dr = ImageDraw.Draw(img)
    for e in coast:
        if e['type'] != 'way' or not e.get('geometry'):
            continue
        dr.line(v1.to_px(geom_xy(e['geometry'])), fill=1, width=1)
    barrier = np.asarray(img) > 0
    lab, nlab = ndimage.label(~barrier)
    water_labels = set()
    for la, lo in SEA_SEEDS:
        x, z = proj(la, lo)
        i, j = int((x - GX0) / LC_RES), int((z - GZ0) / LC_RES)
        assert 0 <= i < LCX and 0 <= j < LCZ and dem_lc[j, i] < -1.0, \
            'sea seed %.4f,%.4f is not under water (DEM %.1f m)' % (la, lo, dem_lc[j, i] if 0 <= i < LCX and 0 <= j < LCZ else float('nan'))
        if lab[j, i] > 0:
            water_labels.add(int(lab[j, i]))
    idx = np.arange(1, nlab + 1)
    means = ndimage.mean(dem_lc, lab, idx)
    sizes = ndimage.sum(np.ones_like(dem_lc), lab, idx)
    for k, m, s in zip(idx, means, sizes):
        if m < -2.0 and s > 200:
            water_labels.add(int(k))
    sea = np.isin(lab, list(water_labels))
    nb = ndimage.uniform_filter(sea.astype(np.float32), 3)
    sea = sea | (barrier & (nb > 0.6))
    log('sea mask: %.1f%% water, %d components, %d water comps' % (sea.mean() * 100, nlab, len(water_labels)))
    check_sea(sea)
    return sea


# ---------------------------------------------------------------------- landcover (v1 + boxed lakes)
def _poly_mask(ring):
    """Rasterise a ring into a mask cropped to its own box: (mask, i0, j0)."""
    px = np.array(v1.to_px(ring))
    i0 = max(0, int(math.floor(px[:, 0].min())) - 1); i1 = min(LCX, int(math.ceil(px[:, 0].max())) + 2)
    j0 = max(0, int(math.floor(px[:, 1].min())) - 1); j1 = min(LCZ, int(math.ceil(px[:, 1].max())) + 2)
    if i1 <= i0 or j1 <= j0:
        return np.zeros((0, 0), bool), i0, j0
    m = Image.new('L', (i1 - i0, j1 - j0), 0)
    ImageDraw.Draw(m).polygon([(a - i0, b - j0) for a, b in px], fill=1)
    return np.asarray(m) > 0, i0, j0


def build_landcover(sea):
    """bake.build_landcover with lake masks cropped to each lake's box."""
    els = load_osm('landuse')
    polys = {c: [] for c in range(11)}
    lakes, piers, seen = [], [], set()
    for e in els:
        k = (e['type'], e['id'])
        if k in seen:
            continue
        seen.add(k)
        t = e.get('tags', {})
        c = v1.classify_landuse(t)
        if c is None:
            continue
        if c == PIER and e['type'] == 'way' and e.get('geometry'):
            p = geom_xy(e['geometry'])
            if np.hypot(*(p[0] - p[-1])) > 1.0:
                piers.append(('line', p, float(t.get('width', 10) if str(t.get('width', '10')).replace('.', '').isdigit() else 10)))
                continue
        for ring in v1.element_polygons(e):
            a = abs(poly_area(ring))
            if a < 30:
                continue
            polys[c].append((a, ring, t))
            if c == LAKE:
                lakes.append((ring, t))
            if c == PIER:
                piers.append(('poly', ring, 0))
    img = Image.new('L', (LCX, LCZ), URBAN)
    dr = ImageDraw.Draw(img)
    for c in [PARK, v1.PAVED, v1.SCRUB, v1.PITCH, WOOD, v1.ROCK, SAND]:
        for a, ring, t in sorted(polys[c], key=lambda r: -r[0]):
            if c == PARK and t.get('leisure') == 'nature_reserve':
                continue
            dr.polygon(v1.to_px(ring), fill=c)
    lc = np.array(img)
    lc[sea] = WATER
    img2 = Image.fromarray(lc)
    dr = ImageDraw.Draw(img2)
    for kind, p, w in piers:
        if kind == 'poly':
            dr.polygon(v1.to_px(p), fill=PIER)
        else:
            dr.line(v1.to_px(p), fill=PIER, width=max(1, int(w / LC_RES)))
    lc = np.array(img2)
    lake_out = []
    for ring, t in lakes:
        if abs(poly_area(ring)) < 300:
            continue
        cx, cz = ring[:, 0].mean(), ring[:, 1].mean()
        i, j = int((cx - GX0) / LC_RES), int((cz - GZ0) / LC_RES)
        if not (0 <= i < LCX and 0 <= j < LCZ) or sea[j, i]:
            continue
        mm, i0, j0 = _poly_mask(ring)
        if mm.sum() < 10 or (sea[j0:j0 + mm.shape[0], i0:i0 + mm.shape[1]] & mm).mean() > 0.001:
            continue
        sub = lc[j0:j0 + mm.shape[0], i0:i0 + mm.shape[1]]
        sub[mm] = LAKE
        lake_out.append(dict(ring=ring, mask=mm, i0=i0, j0=j0, name=t.get('name', '')))
    log('landcover: ' + ', '.join('%s=%.1f%%' % (n, (lc == c).mean() * 100) for c, n in enumerate(
        ['water', 'urban', 'park', 'wood', 'sand', 'lake', 'pier', 'pitch', 'scrub', 'rock', 'paved'])),
        'lakes', len(lake_out), 'piers', len(piers))
    return lc, lake_out


# ---------------------------------------------------------------- heightfield (v1 + boxed lakes)
def build_heightfield(dem_sample, sea_lc, lc, lakes, roads):
    """bake.build_heightfield; only the lake carving uses the cropped masks."""
    GXs, GZs = v1.grid_xz()
    dem = dem_sample(GXs, GZs).astype(np.float64)
    log('dem range %.1f..%.1f' % (dem.min(), dem.max()))
    ii = np.clip(((GXs - GX0) / LC_RES).astype(int), 0, LCX - 1)
    jj = np.clip(((GZs - GZ0) / LC_RES).astype(int), 0, LCZ - 1)
    sea = sea_lc[jj, ii]
    cls = lc[jj, ii]
    land = ~sea
    sm = ndimage.gaussian_filter(dem, 0.8)
    h = np.where(land, sm, dem)
    d_land = ndimage.distance_transform_edt(sea) * CELL
    d_sea = ndimage.distance_transform_edt(land) * CELL
    sand = cls == SAND
    hw_ = np.minimum(h, -0.8 - np.minimum(d_land, 200) * 0.06)
    h = np.where(sea, hw_, h)
    land_min = np.where(sand, 0.35 + np.minimum(d_sea, 60) * 0.03, 1.4 + np.minimum(d_sea, 40) * 0.02)
    h = np.where(land, np.maximum(h, land_min), h)
    pier = cls == PIER
    h = np.where(pier, np.maximum(2.6, np.where(land, h, 2.6)), h)
    h[pier & sea] = 2.6
    del d_land, d_sea, GXs, GZs, dem, sm

    hs = ndimage.gaussian_filter(h, 0.8)
    CHs = np.zeros((LCZ, LCX), np.float32); CHc = np.zeros((LCZ, LCX), np.float32)
    rimg = Image.new('I', (LCX, LCZ), 0)
    dr = ImageDraw.Draw(rimg)
    order = sorted(range(len(roads)), key=lambda k: roads[k]['w'])
    for k in order:
        r = roads[k]
        if r['flags'] & v1.F_GGB:
            continue
        dr.line(v1.to_px(r['p']), fill=k + 1, width=1)
        if r['flags'] & bb.F_BAYB:     # on a deck: the ground under it keeps its shape
            continue
        q, L = v1.resample(r['p'], 2.0)
        hh = v1.bilinear(hs, q[:, 0], q[:, 1])
        if len(hh) > 3:
            hh = ndimage.gaussian_filter1d(hh, sigma=5.0, mode='nearest')
        pi = np.clip(((q[:, 0] - GX0) / LC_RES).astype(int), 0, LCX - 1)
        pj = np.clip(((q[:, 1] - GZ0) / LC_RES).astype(int), 0, LCZ - 1)
        np.add.at(CHs, (pj, pi), hh)
        np.add.at(CHc, (pj, pi), 1)
    R = np.asarray(rimg)
    has = CHc > 0
    CH = np.where(has, CHs / np.maximum(CHc, 1), 0).astype(np.float32)
    del CHs, CHc
    dist, (ni, nj) = ndimage.distance_transform_edt(~has, return_indices=True)
    del has
    dR, (ri_, rj_) = ndimage.distance_transform_edt(R == 0, return_indices=True)
    del dR
    rid = R[ri_, rj_] - 1
    del ri_, rj_
    gd = dist[jj, ii] * LC_RES
    del dist
    pjx, pix = ni[jj, ii], nj[jj, ii]
    del ni, nj
    gr = rid[pjx, pix]
    del rid
    halfw = np.array([r['w'] * 0.5 for r in roads] + [0])[gr]
    hc = CH[pjx, pix].astype(np.float64)
    wgt = np.clip(1 - (gd - (halfw + 3.0)) / 9.0, 0, 1)
    wgt = wgt * wgt * (3 - 2 * wgt)
    wgt[sea & ~pier] = 0
    core = (wgt > 0.99).astype(float)
    num_ = ndimage.gaussian_filter(hc * core, 0.9)
    den_ = ndimage.gaussian_filter(core, 0.9)
    hc = np.where(den_ > 0.2, num_ / np.maximum(den_, 1e-6), hc)
    h = h + (hc - h) * wgt
    lake_defs = []
    for L in lakes:
        # grid samples whose 4 m landcover pixel is in this lake's (cropped) mask
        m = L['mask']; i0, j0 = L['i0'], L['j0']
        gi0 = max(0, int((i0 * LC_RES) // CELL) - 1); gi1 = min(NX, int(((i0 + m.shape[1]) * LC_RES) // CELL) + 2)
        gj0 = max(0, int((j0 * LC_RES) // CELL) - 1); gj1 = min(NZ, int(((j0 + m.shape[0]) * LC_RES) // CELL) + 2)
        si, sj = ii[gj0:gj1, gi0:gi1] - i0, jj[gj0:gj1, gi0:gi1] - j0
        ok = (si >= 0) & (si < m.shape[1]) & (sj >= 0) & (sj < m.shape[0])
        mm = np.zeros(si.shape, bool)
        mm[ok] = m[sj[ok], si[ok]]
        ring = L['ring']
        vals = v1.bilinear(h, ring[:, 0], ring[:, 1])
        level = float(np.percentile(vals, 20)) - 0.3
        if mm.any():
            sub = h[gj0:gj1, gi0:gi1]
            dil = ndimage.binary_dilation(mm, iterations=1)
            sub[:] = np.where(mm, np.minimum(sub, level - 1.5), sub)
            sub[:] = np.where(dil & ~mm, np.minimum(sub, level + 0.4), sub)
        lake_defs.append(dict(level=level, ring=ring, name=L['name']))
    log('heightfield range %.1f..%.1f, %d lakes' % (h.min(), h.max(), len(lake_defs)))
    return h, lake_defs, R


# ------------------------------------------------------------------------------- router hooks
def patch_router(router, roads):
    """SF and the East Bay are separate networks (no Bay Bridge yet): every large component is
    routable, and unhinted intersections stay inside the v1 area where the six tracks are."""
    vpos, edges = router.vpos, router.edges
    par = list(range(len(vpos)))

    def f(a):
        while par[a] != a:
            par[a] = par[par[a]]; a = par[a]
        return a
    for a, b, *_ in edges:
        par[f(a)] = f(b)
    roots = np.array([f(i) for i in range(len(vpos))])
    ids, cnt = np.unique(roots, return_counts=True)
    big = set(ids[cnt >= 2000].tolist())
    router.main = np.isin(roots, list(big))
    log('router: %d components >= 2000 nodes, %d routable nodes' % (len(big), int(router.main.sum())))
    xa, za = proj(V1_AREA['n'], V1_AREA['w']); xb, zb = proj(V1_AREA['s'], V1_AREA['e'])
    inside = (vpos[:, 0] >= xa) & (vpos[:, 0] <= xb) & (vpos[:, 1] >= za) & (vpos[:, 1] <= zb)
    # v1's track paths (data/world.json), in v2 metres: where an unhinted waypoint names two streets
    # that meet at several nodes (divided roads), take the node v1's track went through. v1 itself
    # took whichever node its set iteration gave first, which depends on vertex numbering, so a
    # bigger road graph otherwise picks another carriageway and adds a U-turn detour.
    v1pts = []
    with open(os.path.join(os.path.dirname(OUT), 'world.json'), encoding='utf8') as f:
        for t in json.load(f).get('tracks', []):
            for x, z in t['path']:
                v1pts.append(proj(*v1_unproj(x, z)))
    v1tree = cKDTree(np.array(v1pts))

    def intersection(a, b, hint=None):
        if hint is not None:
            return router_intersection(router, a, b, hint)
        cands = router_intersection(router, a, b, None, every=True)
        cands = [k for k in cands if inside[k]]
        if not cands:
            raise RuntimeError('no intersection %s / %s in the v1 area' % (a, b))
        d, _ = v1tree.query(vpos[cands])
        return cands[int(np.argmin(d))]
    router.intersection = intersection


def router_intersection(router, a, b, hint, every=False):
    """bake.Router.intersection; every=True returns all routable common nodes (sorted by id)."""
    na, nb = set(), set()
    for (u, v, L, ri, i0, i1) in router.edges:
        n = router.roads[ri]['name']
        if n == a:
            na.update((u, v))
        if n == b:
            nb.update((u, v))
    common = sorted(k for k in (na & nb) if router.main[k])
    if every:
        return common
    if not common:
        raise RuntimeError('no intersection %s / %s' % (a, b))
    if hint is not None:
        hx, hz = proj(*hint)
        common.sort(key=lambda k: (router.vpos[k][0] - hx) ** 2 + (router.vpos[k][1] - hz) ** 2)
    return common[0]


def v1_unproj(x, z):
    """v1 world metres (tools/geo.py, equirectangular at LAT0) -> (lat, lon)."""
    kx = 111320.0 * math.cos(math.radians(37.7880))
    return 37.7880 - z / 110540.0, -122.4075 + x / kx


# ------------------------------------------------------------------------------ landmarks (as v1)
def place_landmarks(roads, router, H, sea):
    """bake.main's landmark block, unchanged except for module references."""
    misc = load_osm('misc')
    raw_b = [e for e in load_osm('bld_0_0') if e.get('tags', {}).get('name')]
    named = v1.find_named_footprints(raw_b, misc)
    lms, lm_excl = [], []
    for (lid, name, la, lo, excl, blurb, rx) in v1.LANDMARKS:
        x, z = proj(la, lo)
        rot, L, W = 0.0, 0.0, 0.0
        fp = None
        if rx:
            cands = []
            for n, lst in named.items():
                if re.search(rx, n):
                    for ring, t in lst:
                        cx, cz = ring[:, 0].mean(), ring[:, 1].mean()
                        d = math.hypot(cx - x, cz - z)
                        if d < 600:
                            cands.append((abs(poly_area(ring)) if t.get('building') else abs(poly_area(ring)) * 0.5, d, ring, t))
            if cands:
                cands.sort(key=lambda c: -c[0])
                ring = cands[0][2]
                cx, cz, rot, L, W = v1.min_area_rect(simplify_ring(ring, 0.5))
                fp = ring
                if lid not in ('alcatraz', 'pier39', 'ghirardelli', 'oraclepark'):
                    x, z = cx, cz
        if lid in ('paintedladies', 'dragongate'):
            x, z, rot = v1.street_aligned(lid, roads, router)
        g = float(v1.bilinear(H, [x], [z])[0])
        lm = dict(id=lid, name=name, x=round(float(x), 1), z=round(float(z), 1), ground=round(g, 2),
                  rot=round(float(rot), 4), L=round(float(L), 1), W=round(float(W), 1), blurb=blurb)
        if lid == 'baybridge':
            lm.update(v1.bay_bridge_geometry())
        if lid == 'oraclepark':
            hp = router.vpos[router.intersection('King Street', '3rd Street')]
            d = np.array([x, z]) - hp
            lm['rot'] = round(math.atan2(d[1], d[0]), 4)
            lm['L'], lm['W'] = 200.0, 200.0
        if lid in ('ferry', 'cityhall', 'alcatraz', 'fortpoint'):
            c, s_ = math.cos(rot), math.sin(rot)
            vx, vz = -s_, c

            def wet(px_, pz_):
                i, j = int((px_ - GX0) / LC_RES), int((pz_ - GZ0) / LC_RES)
                return 0 <= i < LCX and 0 <= j < LCZ and bool(sea[j, i])
            lm['front'] = -1 if wet(x + vx * 70, z + vz * 70) and not wet(x - vx * 70, z - vz * 70) else 1
        lms.append(lm)
        if lid in ('ferry', 'finearts', 'cityhall', 'oraclepark', 'transamerica', 'salesforce', 'coit') and fp is not None:
            lm_excl.append((x, z, 0, fp))
        if excl:
            lm_excl.append((x, z, excl, None))
        if lid == 'paintedladies':
            lm_excl.append((x, z, 0, v1.painted_ladies_box(x, z, rot)))
        if lid == 'alcatraz':
            lm_excl.append((x, z, 260, None))
        if lid == 'ghirardelli':
            lm_excl.append((x, z, 16, None))
        if lid == 'dragongate':
            lm_excl.append((x, z, 12, None))
        if lid == 'fortpoint':
            lm_excl.append((x, z, 45, None))
    return lms, lm_excl


# ------------------------------------------------------------------------------------- output
def tile_range():
    i0, j0 = int(GX0 // TILE), int(GZ0 // TILE)
    ni, nj = int(round((NX - 1) * CELL / TILE)), int(round((NZ - 1) * CELL / TILE))
    return i0, j0, ni, nj


class Blob:
    """Typed arrays in one buffer, 8-byte aligned, with an index like world.json's."""
    def __init__(self):
        self.parts, self.index, self.off = [], {}, 0

    def add(self, name, arr):
        arr = np.ascontiguousarray(arr)
        pad = (-self.off) % 8
        if pad:
            self.parts.append(b'\0' * pad); self.off += pad
        self.index[name] = dict(offset=self.off, length=int(arr.size), type=str(arr.dtype))
        b = arr.tobytes()
        self.parts.append(b); self.off += len(b)

    def bytes(self):
        return b''.join(self.parts)


def q32(v, origin):
    """world metres -> int16 1/32 m relative to `origin` (+-1024 m)."""
    a = np.round((np.asarray(v, dtype=np.float64) - origin) * 32)
    assert np.abs(a).max() < 32767, 'tile-local coordinate overflow'
    return a.astype(np.int16)


def write_tiles(H, lc, blds, trees, stats):
    """One file per 512 m tile with any land or buildings: 8 m heights (65x65, shared borders),
    4 m landcover (128x128), buildings whose centroid is in the tile, trees in the tile."""
    i0, j0, ni, nj = tile_range()
    k = int(TILE / CELL)
    kl = int(TILE / LC_RES)
    tdir = os.path.join(OUT, 'tiles')
    os.makedirs(tdir, exist_ok=True)
    for f in os.listdir(tdir):
        os.remove(os.path.join(tdir, f))
    bx = np.array([b['cx'] for b in blds]); bz = np.array([b['cz'] for b in blds])
    bti = np.floor(bx / TILE).astype(int); btj = np.floor(bz / TILE).astype(int)
    tr = np.array(trees) if trees else np.zeros((0, 4))
    tti = np.floor(tr[:, 0] / TILE).astype(int); ttj = np.floor(tr[:, 1] / TILE).astype(int)
    bidx, tidx = {}, {}
    for n, key in enumerate(zip(bti, btj)):
        bidx.setdefault(key, []).append(n)
    for n, key in enumerate(zip(tti, ttj)):
        tidx.setdefault(key, []).append(n)
    manifest = []
    total = 0
    for tj in range(nj):
        for ti in range(ni):
            gi, gj = i0 + ti, j0 + tj
            lcp = lc[tj * kl:(tj + 1) * kl, ti * kl:(ti + 1) * kl]
            bl = bidx.get((gi, gj), [])
            if (lcp == WATER).all() and not bl:
                continue
            ox, oz = gi * TILE, gj * TILE
            B = Blob()
            B.add('h8', np.round(H[tj * k:(tj + 1) * k + 1, ti * k:(ti + 1) * k + 1] * 10).clip(-32000, 32000).astype(np.int16))
            B.add('lc', lcp.astype(np.uint8))
            if bl:
                xs = np.vstack([blds[n]['p'] for n in bl])
                B.add('bld_xz', np.stack([q32(xs[:, 0], ox), q32(xs[:, 1], oz)], axis=1).ravel())
                B.add('bld_count', np.array([len(blds[n]['p']) for n in bl], np.uint8))
                B.add('bld_gmin', np.round(np.array([blds[n]['gmin'] for n in bl]) * 10).astype(np.int16))
                B.add('bld_gmax', np.round(np.array([blds[n]['gmax'] for n in bl]) * 10).astype(np.int16))
                B.add('bld_top', np.round(np.array([blds[n]['top'] for n in bl]) * 10).astype(np.int16))
                B.add('bld_style', np.array([blds[n]['style'] for n in bl], np.uint8))
                B.add('bld_wall', np.array([blds[n]['wall'] for n in bl], np.uint8).ravel())
                B.add('bld_roof', np.array([blds[n]['roof'] for n in bl], np.uint8).ravel())
                B.add('bld_src', np.array([blds[n]['src'] for n in bl], np.uint8))
            tl = tidx.get((gi, gj), [])
            if tl:
                t = tr[tl]
                B.add('tree_xz', np.stack([q32(t[:, 0], ox), q32(t[:, 1], oz)], axis=1).ravel())
                B.add('tree_type', t[:, 2].astype(np.uint8))
                B.add('tree_scale', np.round(t[:, 3] * 100).astype(np.uint8))
            head = json.dumps(dict(v=1, i=gi, j=gj, x0=ox, z0=oz, arrays=B.index)).encode()
            hpad = (-(4 + len(head))) % 8
            data = len(head).to_bytes(4, 'little') + head + b' ' * hpad + B.bytes()
            with open(os.path.join(tdir, f'{gi}_{gj}.bin.wasm'), 'wb') as f:
                f.write(data)
            total += len(data)
            manifest.append([gi, gj, len(data), len(bl), len(tl)])
    stats['tiles'] = dict(count=len(manifest), bytes=total, grid=[i0, j0, ni, nj])
    log('tiles: %d written, %.1f MB' % (len(manifest), total / 1e6))
    return manifest


def write_net(H, lc, roads, vid, vpos, edges, arms, blds, tracks, lms, lake_defs, ggb, manifest, stats, bridge):
    """The always-loaded part: roads, graph, junctions, tracks, landmarks, lakes, coarse terrain."""
    B = Blob()
    H16 = H[::2, ::2]
    B.add('height16', np.round(H16 * 10).clip(-32000, 32000).astype(np.int16))
    lc8 = lc[::2, ::2]
    B.add('landcover8_rle', v1.rle(lc8.astype(np.uint8)))
    node_is_v = set(vid.keys())
    names, name_idx = [''], {'': 0}
    rstart, rcount, rwidth, rtype, rflags, rlanes, rname, rcoords = [], [], [], [], [], [], [], []
    off = 0
    for r in roads:
        keep = np.array([n in node_is_v for n in r['nodes']])
        keep[0] = keep[-1] = True
        p = v1.dp_keep(r['p'], keep, 0.35)
        rstart.append(off); rcount.append(len(p)); off += len(p)
        rcoords.append(p)
        rwidth.append(int(round(r['w'] * 10)))
        rtype.append(v1.RT[r['type']]); rflags.append(r['flags']); rlanes.append(min(r['lanes'], 255))
        if r['name'] not in name_idx:
            name_idx[r['name']] = len(names); names.append(r['name'])
        rname.append(name_idx[r['name']])
    B.add('road_xz', np.vstack(rcoords).astype(np.float32).ravel())
    B.add('road_start', np.array(rstart, np.uint32))
    B.add('road_count', np.array(rcount, np.uint16))
    B.add('road_width', np.array(rwidth, np.uint16))
    B.add('road_type', np.array(rtype, np.uint8))
    B.add('road_flags', np.array(rflags, np.uint8))
    B.add('road_lanes', np.array(rlanes, np.uint8))
    B.add('road_name', np.array(rname, np.uint16))
    B.add('graph_xz', vpos.astype(np.float32).ravel())
    B.add('graph_edges', np.array([(a, b) for a, b, L, ri, i0, i1 in edges], np.uint32).ravel())
    B.add('graph_len', np.array([L for a, b, L, ri, i0, i1 in edges], np.float32))
    B.add('graph_road', np.array([ri for a, b, L, ri, i0, i1 in edges], np.uint32))
    jx, jr = [], []
    vhw = np.zeros(len(vpos))
    for a, b, L, ri, i0, i1 in edges:
        hw = roads[ri]['w'] * 0.5
        vhw[a] = max(vhw[a], hw); vhw[b] = max(vhw[b], hw)
    for v, n in arms.items():
        if n >= 3:
            jx.append(vpos[v]); jr.append(vhw[v])
    B.add('junction_xz', np.array(jx, np.float32).ravel())
    B.add('junction_r', np.round(np.array(jr) * 4).astype(np.uint8))
    # skyline: tall buildings, drawn far beyond the loaded tiles
    sky = [b for b in blds if b['h'] >= 30]
    B.add('sky_xz', np.vstack([b['p'] for b in sky]).astype(np.float32).ravel() if sky else np.zeros(0, np.float32))
    B.add('sky_count', np.array([len(b['p']) for b in sky], np.uint8))
    B.add('sky_gmin', np.round(np.array([b['gmin'] for b in sky]) * 10).astype(np.int16))
    B.add('sky_top', np.round(np.array([b['top'] for b in sky]) * 10).astype(np.int16))
    B.add('sky_style', np.array([b['style'] for b in sky], np.uint8))
    B.add('sky_wall', np.array([b['wall'] for b in sky], np.uint8).ravel())
    B.add('sky_roof', np.array([b['roof'] for b in sky], np.uint8).ravel())
    # the tile each skyline building is stored in (write_tiles: by centroid), so the runtime hides
    # exactly the skyline copies whose tile has its own buildings on screen
    B.add('sky_tile', np.array([[math.floor(b['cx'] / TILE), math.floor(b['cz'] / TILE)] for b in sky], np.int16).ravel())
    B.add('tiles', np.array(manifest, np.int32).ravel())
    # decks (kind 0: a bridge road at its deck height; kind 1: a tunnel roof) and bridge solids
    dxzh, dhlr, dstart, dcount, dhw, dkind, droad, dflags = [], [], [], [], [], [], [], []
    for k in bridge['bidx']:
        r = roads[k]
        dstart.append(len(dxzh)); dcount.append(len(r['p'])); dhw.append(r['w'] * 0.5); dkind.append(0); droad.append(k)
        dflags.append(1 if r.get('on_roof') else 0)   # 1: on the ground (a hill over a tunnel), no structure
        dxzh.extend([float(x), float(z), float(bridge['h'][n])] for (x, z), n in zip(r['p'], r['nodes']))
        dhlr.extend([float(v) for v in bridge['edges'][(k, i)]] for i in range(len(r['nodes'])))
    for p, hh, half, hl, hr in bridge['roofs']:
        dstart.append(len(dxzh)); dcount.append(len(p)); dhw.append(half); dkind.append(1); droad.append(-1); dflags.append(1)
        dxzh.extend([float(x), float(z), float(y)] for (x, z), y in zip(p, hh))
        dhlr.extend([float(a), float(b)] for a, b in zip(hl, hr))
    B.add('deck_xzh', np.array(dxzh, np.float32).ravel())
    B.add('deck_hlr', np.array(dhlr, np.float32).ravel())
    B.add('deck_start', np.array(dstart, np.uint32))
    B.add('deck_count', np.array(dcount, np.uint32))
    B.add('deck_hw', np.round(np.array(dhw) * 10).astype(np.uint16))
    B.add('deck_kind', np.array(dkind, np.uint8))
    B.add('deck_flags', np.array(dflags, np.uint8))
    B.add('deck_road', np.array(droad, np.int32))
    sol = bridge['solids']
    B.add('solid_xz', np.array([q for q, _, _, _ in sol], np.float32).ravel() if sol else np.zeros(0, np.float32))
    B.add('solid_base', np.array([b0 for _, b0, _, _ in sol], np.float32))
    B.add('solid_top', np.array([t0 for _, _, t0, _ in sol], np.float32))
    B.add('solid_hc', np.array([c for _, _, _, c in sol], np.float32).ravel() if sol else np.zeros(0, np.float32))
    with open(os.path.join(OUT, 'net.bin.wasm'), 'wb') as f:
        f.write(B.bytes())
    tracks_out = [dict(id=tk['td']['id'], name=tk['td']['name'], area=tk['td']['area'], description=tk['td']['description'],
                       laps=tk['td']['laps'], loop=tk['td']['loop'], difficulty=tk['td']['difficulty'],
                       path=[[round(float(x), 1), round(float(z), 1)] for x, z in tk['path']]) for tk in tracks]
    lakes_out = [dict(name=l['name'], level=round(l['level'], 2),
                      ring=[[round(float(x), 1), round(float(z), 1)] for x, z in simplify_ring(l['ring'], 1.0)])
                 for l in lake_defs]
    i0, j0, ni, nj = tile_range()
    index = dict(
        version=2,
        attribution='(c) OpenStreetMap contributors (ODbL); ground, building and bridge heights: USGS 3DEP lidar and 1 m DEM (public domain); bay floor and gaps: Mapzen Terrarium / AWS Terrain Tiles',
        projection=TM, datum=dict(vertical='NAVD88', y0_navd88=Y0),
        bounds=world_bounds(),
        grid=dict(x0=GX0, z0=GZ0, cell=CELL * 2, nx=H16.shape[1], nz=H16.shape[0]),
        landcover=dict(x0=GX0, z0=GZ0, res=LC_RES * 2, nx=lc8.shape[1], nz=lc8.shape[0],
                       classes=['water', 'urban', 'park', 'wood', 'sand', 'lake', 'pier', 'pitch', 'scrub', 'rock', 'paved']),
        tiles=dict(size=TILE, cell=CELL, lcRes=LC_RES, i0=i0, j0=j0, ni=ni, nj=nj, count=len(manifest)),
        road_types=v1.RTYPES,
        road_flags=dict(oneway=v1.F_ONEWAY, bridge=v1.F_BRIDGE, cablecar=v1.F_CABLE, ggbridge=v1.F_GGB,
                        median=v1.F_MEDIAN, lombard=v1.F_LOMBARD, sidewalk=v1.F_SIDEWALK, baybridge=bb.F_BAYB),
        styles=['glass', 'office', 'brick', 'victorian', 'stucco', 'deco', 'warehouse', 'modern'],
        names=names, arrays=B.index,
        counts=dict(buildings=len(blds), skyline=len(sky), roads=len(roads), trees=stats.get('trees', 0),
                    graphNodes=len(vpos), graphEdges=len(edges), junctions=len(jx), tiles=len(manifest)),
        ggbridge=dict(axis=[round(float(v), 6) for v in ggb['axis']],
                      centre=[round(float(v), 2) for v in ggb['centre']], halfSpan=round(ggb['half'], 1),
                      south=[round(float(v), 2) for v in ggb['south']], north=[round(float(v), 2) for v in ggb['north']],
                      southTower=[round(float(v), 2) for v in ggb['st']], northTower=[round(float(v), 2) for v in ggb['nt']],
                      tmin=round(float(ggb['tmin']), 1), tmax=round(float(ggb['tmax']), 1),
                      groundSouth=round(ggb['gS'], 2), groundNorth=round(ggb['gN'], 2), slices=ggb['slices']),
        landmarks=lms, lakes=lakes_out, tracks=tracks_out, stats=stats,
    )
    with open(os.path.join(OUT, 'net.json'), 'w', encoding='utf8') as f:
        json.dump(index, f, separators=(',', ':'), ensure_ascii=False)
    log('net: %.1f MB bin, %.2f MB json' % (B.off / 1e6, os.path.getsize(os.path.join(OUT, 'net.json')) / 1e6))


def apply_lidar_heights(blds, towers=(), decks=()):
    """Guessed heights (src 0) -> lidar roof minus ground (src 2) from tools/lidar_heights_v2.py,
    matched by footprint centroid. The roof goes where it was measured, and the style is picked
    again by bake.finish_buildings' height rules (a 60 m building drawn as a Victorian house
    because its guess was 9 m would look wrong)."""
    path = os.path.join(CACHE, 'lidar_heights.json')
    if not os.path.exists(path):
        log('no lidar building heights (%s): guessed heights stay' % path)
        return
    with open(path) as f:
        L = np.array(json.load(f)['buildings'], np.float64)
    if not len(L):
        return
    tree = cKDTree(L[:, :2])
    tw = np.array(towers, np.float64).reshape(-1, 2)
    # under a bridge deck the lidar roof is the deck: keep the guess there (points every 2 m along
    # every deck road, with their half widths)
    dp, dw = [], []
    for r in decks:
        for a, b2 in zip(r['p'][:-1], r['p'][1:]):
            k = max(1, int(np.hypot(*(b2 - a)) / 2))
            for t in np.linspace(0, 1, k + 1):
                dp.append(a + (b2 - a) * t); dw.append(r['w'] * 0.5)
    dtree = cKDTree(np.array(dp)) if dp else None
    dw = np.array(dw)

    def under_deck(b):
        if dtree is None:
            return False
        for q in np.vstack([b['p'], b['p'].mean(axis=0)[None]]):
            for j in dtree.query_ball_point(q, 30.0):
                if np.hypot(*(dp[j] - q)) < dw[j] + 6.0:
                    return True
        return False
    n = skipped = 0
    for b in blds:
        if b['src'] != 0:   # (finish_buildings has just set 0 or 1; 2 is set here)
            continue
        c = b['p'].mean(axis=0)
        d, j = tree.query(c)
        if d > 0.3:
            continue
        # a footprint at a bridge tower measures the tower; a small one far taller than a house is
        # a tree over it or a crane: keep the guess
        if (len(tw) and np.hypot(*(tw - c).T).min() < 120) or (b['area'] < 150 and L[j, 2] > 30) or under_deck(b):
            skipped += 1
            continue
        b['h'] = float(L[j, 2])
        b['top'] = b['gmin'] + b['h']
        b['src'] = 2
        restyle(b)
        n += 1
    log('building heights from lidar: %d (of %d measured; %d implausible kept their guess)' % (n, len(L), skipped))


PLAIN = 8                    # past bake.py's eight facade styles: walls without windows (buildings.js)
PLAIN_WALL = (196, 194, 188)  # light concrete


def plain_structures(blds):
    """Towers and bridge supports mapped as buildings (the Bay Bridge's SAS tower, the Campanile,
    bridge piers) are not offices: no windows. A pylon's height is from the water, not the bay floor."""
    n = 0
    for b in blds:
        t = b['tags']
        if not ('bridge:support' in t or t.get('building') in ('bridge', 'anchorage') or t.get('man_made') == 'tower'):
            continue
        b['style'] = PLAIN
        b['wall'] = v1.parse_colour(t.get('building:colour') or t.get('colour')) or PLAIN_WALL
        if b['src'] == 1 and b['gmin'] < 0:
            b['top'] = max(b['top'], b['h'])
        n += 1
    log('towers and bridge supports drawn plain: %d' % n)


def restyle(b):
    """bake.finish_buildings' style and wall colour choice, for a building whose height changed."""
    t = b['tags']
    h, dist, a = b['h'], b['dist'], b['area']
    bt = t.get('building', 'yes')
    mat = t.get('building:material', '')
    r = v1.rng.random()
    if mat == 'brick':
        st = v1.BRICK
    elif mat in ('glass',):
        st = v1.GLASS
    elif h >= 70:
        st = v1.GLASS if r < 0.5 else v1.OFFICE if r < 0.8 else v1.DECO
    elif h >= 26:
        st = v1.OFFICE if r < 0.3 else v1.BRICK if r < 0.48 else v1.DECO if r < 0.62 else v1.MODERN if r < 0.88 else v1.GLASS
    elif bt in ('industrial', 'warehouse') or (dist == 'soma' and a > 700 and r < 0.6):
        st = v1.WARE
    elif dist == 'marina' and a < 600:
        st = v1.STUCCO if r < 0.75 else v1.VICT
    elif dist == 'res' and a < 420 and h < 16:
        st = v1.VICT if r < 0.62 else v1.STUCCO
    elif dist in ('fidi', 'downtown', 'soma'):
        st = v1.BRICK if r < 0.35 else v1.OFFICE if r < 0.6 else v1.DECO if r < 0.75 else v1.MODERN
    else:
        st = v1.STUCCO if r < 0.35 else v1.BRICK if r < 0.55 else v1.MODERN if r < 0.75 else v1.VICT if r < 0.9 else v1.OFFICE
    if st != b['style']:
        b['style'] = st
        col = v1.parse_colour(t.get('building:colour')) or v1.rng.choice(v1.PAL[st])
        jit = v1.rng.uniform(0.92, 1.06)
        b['wall'] = tuple(int(min(255, c * jit)) for c in col)


def cached_load_buildings(H, lm_excl):
    """bake.load_buildings (footprints from OSM, ~7 min for the v2 area), cached on disk. Its output
    depends only on the OSM buildings file, the projection and the landmark exclusions (not on H)."""
    src = os.path.join(CACHE, 'osm_bld_0_0.json')
    import inspect
    key = hashlib.sha1(repr((os.path.getsize(src), os.path.getmtime(src),
                             open(geo2.__file__, 'rb').read(), inspect.getsource(v1.load_buildings), [(round(float(a), 2), round(float(b), 2), r, None if q is None else np.round(np.asarray(q), 2).tolist())
                                                                for a, b, r, q in lm_excl])).encode()).hexdigest()[:16]
    path = os.path.join(CACHE, 'work', 'buildings_%s.pkl' % key)
    if os.path.exists(path):
        with open(path, 'rb') as f:
            blds = pickle.load(f)
        log('buildings from cache %s: %d' % (os.path.basename(path), len(blds)))
        return blds
    blds = v1.load_buildings(H, lm_excl)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        pickle.dump(blds, f, protocol=pickle.HIGHEST_PROTOCOL)
    return blds


# the seventh track (v2 only): over the Bay Bridge to Oakland
BAY_BRIDGE_RUN = dict(
    id='bay-bridge-run', name='Bay Bridge Run', area='Bay Bridge and Yerba Buena Island',
    description='From the Embarcadero under the bridge, up onto the Bay Bridge, through the Yerba Buena '
                'Island tunnel and down the east span to Oakland.',
    laps=1, loop=False, difficulty=2,
    wps=[('The Embarcadero', 'Harrison Street', (37.7895, -122.3880), None),
         ('West Grand Avenue', 'Maritime Street', (37.8128, -122.2984), 'Dwight D. Eisenhower Highway')])


# ------------------------------------------------------------------------------------------ main
def main():
    stats = {}
    os.makedirs(OUT, exist_ok=True)
    fetch_dem()
    terr_sample = load_dem_sampler()
    LX, LZ = v1.lc_xz()
    dem_lc = terr_sample(LX, LZ)              # land / sea from Terrarium, as before the lidar ground
    del LX, LZ
    sea = build_sea_mask(dem_lc)
    del dem_lc
    dem_sample, stats['lidar_ground'] = lidar_ground_sampler(terr_sample, sea)
    v1.load_dem_sampler = lambda: dem_sample   # anything in bake that samples the DEM uses this one
    lc, lakes = build_landcover(sea)
    roads = v1.load_roads(sea)
    # the Bay Bridge (baybridge_v2.py): crossing roads back in, stacked decks side by side
    profile = bb.load_profile()
    bidx = bb.add_bridge_roads(roads, profile)
    bb.shift_stacked(roads, bidx, profile)
    H, lake_defs, roadR = build_heightfield(dem_sample, sea, lc, lakes, roads)
    # the lidar ground the game draws: the tile patches where they exist, else the pilot
    pg = bb.lidar_ground(H) or bb.pilot_ground(H)
    stats['deck_ground'] = pg.kind if pg is not None else 'terrain'   # tests hold decks to this ground
    if pg is not None:   # overpasses over the lidar ground (they join the decks)
        for box in pg.boxes:
            bidx = bidx + bb.add_overpasses(roads, bidx, box)
    deck_h, deck_pinned, _ = bb.deck_heights(roads, bidx, H, profile, ground=pg)
    H_pre = H.copy()                  # the ground before the tunnel cut (buildings, roads on the hill)
    roofs = bb.carve(roads, bidx, H, deck_h)
    bidx = bidx + bb.add_roof_roads(roads, bidx, roofs, H_pre, deck_h)
    ggb = v1.gg_bridge_geometry(roads, H)
    vid, vpos, edges, arms = v1.build_graph(roads)
    router = v1.Router(roads, vpos, edges)
    patch_router(router, roads)
    lms, lm_excl = place_landmarks(roads, router, H, sea)
    for lm in lms:
        if lm['id'] == 'baybridge' and 'span' in lm:
            prof = bb.west_span_profile(roads, bidx, deck_h, lm['span'])
            if prof:
                lm['deck'] = prof
                lm['deckHalf'] = round(bb.west_span_half_width(roads, bidx, lm['span']), 1)

    blds = cached_load_buildings(H, lm_excl)
    blds = v1.finish_buildings(blds, H_pre, cap=10 ** 9)   # buildings over a tunnel stand on the hill
    for b in blds:   # where the height came from: 1 OSM height / levels, 0 bake's random pick
        t = b['tags']
        b['src'] = 1 if ((v1.num(t.get('height')) or 0) >= 2 or v1.num(t.get('building:levels'))) else 0
    towers = [ggb['st'], ggb['nt']] + [t for lm in lms if lm['id'] == 'baybridge' for t in lm.get('towers', [])]
    decks = [r for r in roads if r['flags'] & (v1.F_GGB | bb.F_BAYB)]
    apply_lidar_heights(blds, towers, decks)
    plain_structures(blds)
    # buildings over ground cut for a deck (the YBI portal cuts) would float over the cut: drop them
    cut = (H_pre - H) > 1.0
    if cut.any():
        def over_cut(b):
            ij = np.round((b['p'] - [GX0, GZ0]) / CELL).astype(int)
            ii, jj = np.clip(ij[:, 0], 0, NX - 1), np.clip(ij[:, 1], 0, NZ - 1)
            c = np.round((b['p'].mean(axis=0) - [GX0, GZ0]) / CELL).astype(int)
            return bool(cut[jj, ii].any() or cut[min(max(c[1], 0), NZ - 1), min(max(c[0], 0), NX - 1)])
        before = len(blds)
        blds = [b for b in blds if not over_cut(b)]
        log('buildings over cuts for decks dropped: %d' % (before - len(blds)))
    # drop footprints that sit on top of a street centreline (as bake.main)
    bimg_ = Image.new('I', (LCX, LCZ), 0)
    d_ = ImageDraw.Draw(bimg_)
    for k_, b in enumerate(blds):
        d_.polygon(v1.to_px(b['p']), fill=k_ + 1)
    Bid = np.asarray(bimg_)
    major = np.array([0] + [0 if r['type'] == 'service' else 1 for r in roads])[roadR]
    hit = Bid[(roadR > 0) & (major > 0) & (Bid > 0)] - 1
    cnt = np.bincount(hit, minlength=len(blds))
    bad = set(np.flatnonzero(cnt >= 3).tolist())
    log('buildings covering street centrelines dropped: %d' % len(bad))
    blds = [b for i, b in enumerate(blds) if i not in bad]
    del Bid, bimg_, major

    v1.TRACK_DEFS.append(BAY_BRIDGE_RUN)
    tracks = v1.build_tracks(router, roads, ggb)
    bsolids = bb.solids(roads, bidx, deck_h, H_pre)

    bimg = Image.new('L', (LCX, LCZ), 0)
    dr = ImageDraw.Draw(bimg)
    for b in blds:
        dr.polygon(v1.to_px(b['p']), fill=1)
    bmask = ndimage.binary_dilation(np.asarray(bimg) > 0, iterations=1)
    tosm = [proj(e['lat'], e['lon']) for e in load_osm('trees') if e['type'] == 'node']
    palms = v1.embarcadero_palms(roads)
    # tree budgets: v1's absolute counts, scaled from the v1 raster (2700 x 1960 px) to this one
    scale = (LCX * LCZ) / (2700 * 1960)
    trees = scatter_trees_scaled(lc, bmask, roadR, roads, tosm, palms, scale)
    # none in a tunnel cut (they would stand on its floor, inside the roof)
    if roofs:
        cut = []
        for p, _, rad, _, _ in roofs:
            for i in range(len(p) - 1):
                for t in np.linspace(0, 1, 6):
                    cut.append(p[i] + (p[i + 1] - p[i]) * t)
        ct = cKDTree(np.array(cut))
        rmax = max(rad for _, _, rad, _, _ in roofs)
        d, _ = ct.query(np.array([[t[0], t[1]] for t in trees]))
        before = len(trees)
        trees = [t for t, dd in zip(trees, d) if dd > rmax + 2.0]
        log('trees in tunnel cuts dropped: %d' % (before - len(trees)))
    stats['trees'] = len(trees)
    del bmask

    manifest = write_tiles(H, lc, blds, trees, stats)
    pg2 = bb.lidar_ground(H_pre) or bb.pilot_ground(H_pre)
    ground = (lambda x, z: np.where(np.isfinite(pg2(x, z)), pg2(x, z), v1.bilinear(H_pre, x, z))) if pg2 is not None else (lambda x, z: v1.bilinear(H_pre, x, z))
    bridge = dict(bidx=bidx, h=deck_h, roofs=roofs, solids=bsolids, edges=bb.deck_edges(roads, bidx, deck_h, ground))
    write_net(H, lc, roads, vid, vpos, edges, arms, blds, tracks, lms, lake_defs, ggb, manifest, stats, bridge)
    log('done')


def scatter_trees_scaled(lc, bmask, roadR, roads, trees_osm, palms, scale):
    """bake.scatter_trees with its budgets multiplied by `scale` (same density over a bigger area)."""
    out = []
    dist = ndimage.distance_transform_edt(roadR == 0) * LC_RES
    halfw = np.array([0] + [r['w'] * 0.5 for r in roads])
    hwr = ndimage.maximum_filter(halfw[roadR], size=7)
    clear = dist > (hwr + 2.0)
    del dist, hwr
    ok = clear & ~bmask & np.isin(lc, [URBAN, PARK, WOOD, v1.SCRUB, v1.PITCH, v1.ROCK])
    rng, nprand = v1.rng, np.random

    def okat(x, z):
        i, j = int((x - GX0) / LC_RES), int((z - GZ0) / LC_RES)
        return 0 <= i < LCX and 0 <= j < LCZ and ok[j, i]

    for (x, z) in palms:
        out.append((x, z, 2, rng.uniform(0.9, 1.15)))
    n_osm = 0
    rng.shuffle(trees_osm)
    for (x, z) in trees_osm:
        if n_osm >= int(6500 * scale):
            break
        if okat(x, z):
            out.append((x, z, 0 if rng.random() < 0.85 else 1, rng.uniform(0.7, 1.15))); n_osm += 1
    noise = ndimage.gaussian_filter(nprand.rand(LCZ // 8 + 1, LCX // 8 + 1), 2.0)
    noise = (noise - noise.min()) / (noise.max() - noise.min() + 1e-9)
    budget = {WOOD: int(10500 * scale), PARK: int(5200 * scale), v1.SCRUB: int(700 * scale)}
    spacing = {WOOD: 9.0, PARK: 13.0, v1.SCRUB: 18.0}
    for cls in (WOOD, PARK, v1.SCRUB):
        s = spacing[cls]
        xs = np.arange(GX0 + s / 2, GX0 + LCX * LC_RES, s)
        zs = np.arange(GZ0 + s / 2, GZ0 + LCZ * LC_RES, s)
        X, Z = np.meshgrid(xs, zs)
        X = X + nprand.uniform(-s * 0.45, s * 0.45, X.shape)
        Z = Z + nprand.uniform(-s * 0.45, s * 0.45, Z.shape)
        I = np.clip(((X - GX0) / LC_RES).astype(int), 0, LCX - 1)
        J = np.clip(((Z - GZ0) / LC_RES).astype(int), 0, LCZ - 1)
        m = (lc[J, I] == cls) & ok[J, I]
        nz = noise[J // 8, I // 8]
        prob = nz if cls != WOOD else 0.35 + 0.65 * nz
        m &= nprand.rand(*X.shape) < prob
        X, Z = X[m], Z[m]
        for k in nprand.permutation(len(X))[:budget[cls]]:
            r = rng.random()
            if cls == WOOD:
                ty = 1 if r < 0.45 else 3 if r < 0.75 else 0
            elif cls == v1.SCRUB:
                ty = 1 if r < 0.5 else 0
            else:
                ty = 0 if r < 0.7 else 1 if r < 0.85 else 3
            out.append((float(X[k]), float(Z[k]), ty, rng.uniform(0.75, 1.3)))
    log('trees: %d (palms %d, osm %d)' % (len(out), len(palms), n_osm))
    return out


if __name__ == '__main__':
    main()

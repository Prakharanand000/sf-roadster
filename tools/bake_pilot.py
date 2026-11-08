"""Pilot bake: lidar ground + measured road ribbons over Nob Hill + FiDi.

MAP_RESOURCES.md §9, Phase 0 step 5. Writes an optional overlay (data/pilot.json +
data/pilot.bin.wasm) that src/world/pilot.js layers over today's world. Without those two files
the game is unchanged.

Same coordinates and heights as tools/bake.py (CONTRACTS.md projection; heights in NAVD88 metres,
like today's Terrarium terrain), so there is no contract change. The SFT1 projection and datum
swap (§9 step 3) comes later and will re-bake this.

What it bakes:
- a 2 m ground grid from USGS 3DEP lidar (CA_SanFrancisco_1_B23, ground class only), holes under
  buildings filled, far holes (water) taken from today's terrain;
- one ribbon per road (today's OSM centrelines, clipped to the pilot box), a cross-section every
  <= 2 m with 7 knots: sidewalk edge, curb top, gutter, crown, gutter, curb top, sidewalk edge.
  Gutter offsets are measured per station; crown depth and curb rise per road side (medians of
  the measured 10 m windows); the crown line height per station. Method and its limits:
  tools/research/road-surface-method.md.
- Inside junctions the ribbon follows the lidar grid (no crown, no curbs), ramping back to the
  measured section over 4 m, which also gives curb ramps at corners.

Run with the analysis venv (tools/probes/README.md); PDAL comes from the conda `bake` env:
    python tools/bake_pilot.py
"""
import gzip
import hashlib
import json
import math
import os
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from pyproj import Transformer
from scipy.interpolate import griddata
from scipy.ndimage import distance_transform_edt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "probes"))
from common import CACHE, bounds_3857_from_ll, fetch_ept, load_points  # noqa: E402

LAT0, LON0 = 37.7880, -122.4075
KX = 111320.0 * math.cos(math.radians(LAT0))
KZ = 110540.0

PROJECT = "CA_SanFrancisco_1_B23"
BBOX = (-920.0, -1480.0, 1480.0, 200.0)   # x0, z0, x1, z1 in game metres, on today's 8 m grid
FEATHER = 24.0      # m; the overlay blends into today's terrain over this band (runtime)
CELL = 2.0          # ground grid spacing
FINE = 0.25         # lidar ground raster used for measuring
CHUNK, MARGIN = 256.0, 6.0
STEP = 2.0          # max ribbon station spacing
BEVEL = 0.25        # curb face width
WALK = 3.0          # sidewalk width modelled beyond the curb
SHOULDER = 0.6      # edge band on roads without a curb
DEFAULT_RISE = 0.13
SEARCH = (2.0, 12.0)  # gutter search range from the centreline
BURN = 0.01         # ground grid sits this far below the ribbon it is under
# Nodes without ground are filled by linear interpolation over a Delaunay triangulation of the nodes
# with ground. On the bare 2 m lattice every square's corners are cocircular, so which diagonal
# Qhull picks depends on the whole point set, and the same block filled inside a different box
# comes out different (up to metres inside large building blocks). FILL_JITTER moves each node by
# a fixed 1/1000 cell keyed to its position in the world, so the triangulation is generic and every
# filled node depends only on the ground around it (tile-by-tile bakes reproduce one big bake).
# Off for v1 so today's pilot re-bakes as it was; the v2 lidar tiles turn it on.
FILL_JITTER = False
# WATER_EXTRA(shape) -> bool grid nodes that are water besides the sea (lakes; the v2 lidar tiles):
# lidar over them counts as no ground (its few returns there are off the water surface, or a drained
# bed, and would pave over the 8 m ground's carved bed), and far from the shore they take today's
# terrain, as the sea does. None: the sea only (v1).
WATER_EXTRA = None
# FILL_ANCHOR (m): water nodes (and ANCHOR_EXTRA's) farther than this from any ground return take
# today's terrain *before* the fill, as data points. With jitter alone the fill is local inside the
# triangulation, but at its hull (the sea, the edge of the lidar's coverage) which nodes it reaches
# depends on the whole box. Anchored, the sea and what lies beyond coverage are data, and the fill
# only spans the shore band and holes on land. Over water nothing changes beyond FILL_ANCHOR (the
# blend below gives today's terrain from 24 m); the shore band slopes to it instead of spanning the
# hull. Land holes (buildings, under decks) keep the plain fill. None: off (v1 and the old pilot).
FILL_ANCHOR = None
# ANCHOR_EXTRA(shape) -> bool grid nodes where FILL_ANCHOR applies besides water (the v2 lidar
# tiles: outside the covered tiles, where there is no lidar at all).
ANCHOR_EXTRA = None
LEVEL_GAP = 2.5     # ribbons overlapping further apart than this are on different levels (an
                    # overpass clears >= 4 m; smaller gaps are steep streets binned to 2 m nodes)

OUT_JSON = os.path.join(ROOT, "data", "pilot.json")
OUT_BIN = os.path.join(ROOT, "data", "pilot.bin.wasm")
PCACHE = os.path.join(CACHE, "pilot")

DT = {"int16": "<i2", "uint16": "<u2", "int32": "<i4", "uint32": "<u4", "uint8": "u1",
      "float32": "<f4", "int8": "i1"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def unproj(x, z):
    return LAT0 - np.asarray(z) / KZ, LON0 + np.asarray(x) / KX


def proj(lat, lon):
    return (np.asarray(lon) - LON0) * KX, -(np.asarray(lat) - LAT0) * KZ


# ---------------------------------------------------------------- today's world

def load_world():
    with open(os.path.join(ROOT, "data", "world.json"), encoding="utf8") as f:
        idx = json.load(f)
    with open(os.path.join(ROOT, "data", "world.bin.wasm"), "rb") as f:
        buf = f.read()

    def arr(name):
        a = idx["arrays"][name]
        return np.frombuffer(buf, dtype=DT[a["type"]], count=a["length"], offset=a["offset"])

    g = idx["grid"]
    W = {"index": idx, "grid": g,
         "H": (arr("height").astype(np.float32) * 0.1).reshape(g["nz"], g["nx"])}
    rxz = arr("road_xz").astype(np.float64).reshape(-1, 2) * 0.25
    start, count = arr("road_start"), arr("road_count")
    width, rtype, flags = arr("road_width") * 0.1, arr("road_type"), arr("road_flags")
    F = idx["road_flags"]
    W["roads"] = [{"i": i, "pts": rxz[start[i]:start[i] + count[i]], "width": float(width[i]),
                   "type": idx["road_types"][rtype[i]], "bridge": bool(flags[i] & F["bridge"]),
                   "sidewalk": bool(flags[i] & F["sidewalk"])}
                  for i in range(len(start))]
    W["roads_hash"] = fnv1a16(arr("road_xz"))
    W["jxz"] = arr("junction_xz").astype(np.float64).reshape(-1, 2) * 0.25
    W["jr"] = arr("junction_r").astype(np.float64) * 0.25
    bxz = arr("bld_xz").astype(np.float64).reshape(-1, 2) * 0.25
    bs, bn = arr("bld_start"), arr("bld_count")
    W["buildings"] = [bxz[bs[k]:bs[k] + bn[k]] for k in range(len(bs))]
    return W


def fnv1a16(a):
    """32-bit FNV-1a over int16 values (as uint16); pilot.js worldFingerprint computes the same."""
    h = 0x811C9DC5
    for v in a.astype(np.uint16).tolist():
        h = ((h ^ v) * 0x01000193) & 0xFFFFFFFF
    return h


def tri_interp(Hg, x0, z0, cell, x, z):
    """Height on a grid with the same triangle split as worlddata.js heightAt / terrain.js."""
    nz, nx = Hg.shape
    fx = np.clip((np.asarray(x) - x0) / cell, 0, nx - 1.0001)
    fz = np.clip((np.asarray(z) - z0) / cell, 0, nz - 1.0001)
    ix, iz = fx.astype(np.int64), fz.astype(np.int64)
    tx, tz = fx - ix, fz - iz
    h00, h10 = Hg[iz, ix], Hg[iz, ix + 1]
    h01, h11 = Hg[iz + 1, ix], Hg[iz + 1, ix + 1]
    return np.where(tx + tz <= 1,
                    h00 + (h10 - h00) * tx + (h01 - h00) * tz,
                    h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz))


def old_height(W, x, z):
    g = W["grid"]
    return tri_interp(W["H"], g["x0"], g["z0"], g["cell"], x, z)


# ---------------------------------------------------------------- lidar ground raster

def ground_raster(stats):
    """Mean height of non-withheld ground (class 2) returns per 0.25 m cell over the box."""
    x0, z0, x1, z1 = BBOX
    nxf, nzf = int(round((x1 - x0) / FINE)), int(round((z1 - z0) / FINE))
    key = hashlib.sha1(json.dumps([PROJECT, BBOX, FINE]).encode()).hexdigest()[:10]
    path = os.path.join(PCACHE, f"ground025_{key}.npy")
    meta_path = path.replace(".npy", ".json")
    if os.path.exists(path) and os.path.exists(meta_path):
        log("lidar raster from cache", path)
        with open(meta_path) as f:
            stats["lidar"] = json.load(f)
        stats["lidar"]["cached"] = True
        return np.load(path)

    chunks = []
    for cz in np.arange(z0, z1, CHUNK):
        for cx in np.arange(x0, x1, CHUNK):
            core = (cx, cz, min(cx + CHUNK, x1), min(cz + CHUNK, z1))
            lat_a, lon_a = unproj(core[0] - MARGIN, core[3] + MARGIN)
            lat_b, lon_b = unproj(core[2] + MARGIN, core[1] - MARGIN)
            chunks.append((core, bounds_3857_from_ll(lat_a, lon_a, lat_b, lon_b)))
    log(f"fetching {len(chunks)} lidar chunks of {CHUNK:.0f} m from {PROJECT}")
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=4) as ex:
        fetched = list(ex.map(lambda c: fetch_ept(PROJECT, c[1]), chunks))
    fetch_s = time.perf_counter() - t0
    laz_bytes = sum(st["laz_bytes"] for _, st in fetched)
    log(f"fetched {laz_bytes / 1e6:.0f} MB LAZ in {fetch_s:.0f} s")

    to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    acc = np.zeros((nzf, nxf), np.float64)
    cnt = np.zeros((nzf, nxf), np.uint32)
    n_all = n_ground = 0
    t0 = time.perf_counter()
    for (core, _), (laz, _) in zip(chunks, fetched):
        P = load_points(laz, reproject=False)
        n_all += P["Z"].size
        m = (P["Classification"] == 2) & ~P["Withheld"]
        lon, lat = to_ll.transform(P["X"][m], P["Y"][m])
        gx, gz = proj(lat, lon)
        zz = P["Z"][m]
        keep = (gx >= core[0]) & (gx < core[2]) & (gz >= core[1]) & (gz < core[3])
        gx, gz, zz = gx[keep], gz[keep], zz[keep]
        n_ground += zz.size
        ix0, iz0 = int(round((core[0] - x0) / FINE)), int(round((core[1] - z0) / FINE))
        cw, ch = int(round((core[2] - core[0]) / FINE)), int(round((core[3] - core[1]) / FINE))
        lx = np.clip(((gx - core[0]) / FINE).astype(np.int64), 0, cw - 1)
        lz = np.clip(((gz - core[1]) / FINE).astype(np.int64), 0, ch - 1)
        flat = lz * cw + lx
        acc[iz0:iz0 + ch, ix0:ix0 + cw] += np.bincount(flat, weights=zz, minlength=cw * ch).reshape(ch, cw)
        cnt[iz0:iz0 + ch, ix0:ix0 + cw] += np.bincount(flat, minlength=cw * ch).reshape(ch, cw).astype(np.uint32)
    with np.errstate(invalid="ignore", divide="ignore"):
        r = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan).astype(np.float32)
    stats["lidar"] = {"project": PROJECT, "chunks": len(chunks), "laz_mb": round(laz_bytes / 1e6, 1),
                      "fetch_s": round(fetch_s, 1), "load_s": round(time.perf_counter() - t0, 1),
                      "points": int(n_all), "ground_points": int(n_ground),
                      "ground_cells_frac": round(float((cnt > 0).mean()), 3)}
    os.makedirs(PCACHE, exist_ok=True)
    np.save(path, r)
    with open(meta_path, "w") as f:
        json.dump(stats["lidar"], f)
    return r


def mask_buildings(W, r025, stats):
    """Drop 'ground' returns inside building footprints: rooftop parks, podiums and terraces are
    classified as ground in this survey (e.g. the Transit Center's roof park). Ground under a
    building is then interpolated from the streets around it."""
    from PIL import Image, ImageDraw
    x0, z0 = BBOX[0], BBOX[1]
    nzf, nxf = r025.shape
    img = Image.new("1", (nxf, nzf), 0)
    dr = ImageDraw.Draw(img)
    n = 0
    for poly in W["buildings"]:
        if poly[:, 0].max() < x0 or poly[:, 0].min() > BBOX[2] or poly[:, 1].max() < z0 or poly[:, 1].min() > BBOX[3]:
            continue
        dr.polygon([((x - x0) / FINE, (z - z0) / FINE) for x, z in poly], fill=1)
        n += 1
    # shrink footprints by 1 m: OSM outlines often overlap the sidewalk or curb by a metre or so
    from scipy.ndimage import binary_erosion
    m = binary_erosion(np.asarray(img, dtype=bool), iterations=int(round(1.0 / FINE)))
    before = int(np.isfinite(r025).sum())
    r = r025.copy()
    r[m] = np.nan
    stats["lidar"]["buildings_masked"] = n
    stats["lidar"]["ground_cells_in_footprints_dropped_frac"] = round(1 - int(np.isfinite(r).sum()) / max(before, 1), 3)
    return r


def dtm_grid(W, r025, stats):
    """2 m ground grid at nodes (x0 + 2i, z0 + 2j): mean of the 0.25 m cells within +-1 m. Nodes
    without ground are filled (FILL_JITTER, FILL_ANCHOR, WATER_EXTRA, ANCHOR_EXTRA above), and over
    water far from ground blended to today's terrain."""
    x0, z0, x1, z1 = BBOX
    nx, nz = int(round((x1 - x0) / CELL)) + 1, int(round((z1 - z0) / CELL)) + 1
    k = int(round(CELL / FINE))
    pad = k // 2
    P = np.full((nz * k, nx * k), np.nan, np.float32)
    P[pad:pad + r025.shape[0], pad:pad + r025.shape[1]] = r025
    blocks = P.reshape(nz, k, nx, k)
    valid_cells = np.sum(~np.isnan(blocks), axis=(1, 3))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        G = np.nanmean(blocks, axis=(1, 3))
    del P, blocks
    valid = valid_cells >= 6
    lake = WATER_EXTRA((nz, nx)) if WATER_EXTRA is not None else None
    if lake is not None:
        valid &= ~lake
    G[~valid] = np.nan
    stats["grid"] = {"nx": nx, "nz": nz, "cell": CELL, "nodes": int(nx * nz),
                     "nodes_without_ground_frac": round(float(1 - valid.mean()), 3)}

    t0 = time.perf_counter()
    dist = distance_transform_edt(~valid) * CELL
    X = x0 + np.arange(nx) * CELL
    Z = z0 + np.arange(nz) * CELL
    XX, ZZ = np.meshgrid(X, Z)
    old = old_height(W, XX, ZZ).astype(np.float32)
    water = old < 1.0
    if lake is not None:
        water = water | lake
    known = valid
    if FILL_ANCHOR is not None:
        far = ~valid & (dist > FILL_ANCHOR) & (water if ANCHOR_EXTRA is None else water | ANCHOR_EXTRA(G.shape))
        G[far] = old[far]
        known = valid | far
        stats["grid"]["anchor_nodes_frac"] = round(float(far.mean()), 3)
    jj, ii = np.nonzero(known)
    hj, hi = np.nonzero(~known)
    pts = np.c_[ii, jj].astype(np.float64)
    if FILL_JITTER:
        gi = np.rint((x0 + ii * CELL) / CELL).astype(np.int64)
        gj = np.rint((z0 + jj * CELL) / CELL).astype(np.int64)
        hsh = (gi * 73856093) ^ (gj * 19349663)
        pts += np.c_[(hsh & 1023) / 1023.0 - 0.5, ((hsh >> 10) & 1023) / 1023.0 - 0.5] * 1e-3
    filled = griddata(pts, G[known], np.c_[hi, hj].astype(np.float64), method="linear")
    G[hj, hi] = filled
    # far from any ground return over water or piers (today's terrain below 1 m): use today's
    # terrain, blended over 16-24 m. Elsewhere (block interiors under buildings) keep the fill.
    a = np.clip((dist - 16.0) / 8.0, 0, 1) * water
    a[np.isnan(G)] = 1.0
    G = np.where(np.isnan(G), old, G * (1 - a) + old * a).astype(np.float32)
    stats["grid"]["fill_s"] = round(time.perf_counter() - t0, 1)
    stats["grid"]["nodes_from_old_terrain_frac"] = round(float((a >= 1).mean()), 3)
    d = (G - old)[a < 1]
    if d.size:
        stats["grid"]["lidar_minus_old_terrain_m"] = {
            "mean": round(float(np.mean(d)), 2), "rms": round(float(np.sqrt(np.mean(d * d))), 2),
            "p95_abs": round(float(np.percentile(np.abs(d), 95)), 2)}
    return G


# ---------------------------------------------------------------- roads

def clip_runs(pts):
    """Clip a polyline to BBOX; return the inside pieces as polylines."""
    x0, z0, x1, z1 = BBOX
    runs, cur = [], None
    for p, q in zip(pts[:-1], pts[1:]):
        d = q - p
        t0, t1 = 0.0, 1.0
        ok = True
        for pv, qv in ((-d[0], p[0] - x0), (d[0], x1 - p[0]), (-d[1], p[1] - z0), (d[1], z1 - p[1])):
            if pv == 0:
                if qv < 0:
                    ok = False
                    break
            else:
                t = qv / pv
                if pv < 0:
                    t0 = max(t0, t)
                else:
                    t1 = min(t1, t)
        if not ok or t0 >= t1:
            cur = None
            continue
        a, b = p + t0 * d, p + t1 * d
        if cur is not None and t0 == 0.0:
            cur.append(b)
        else:
            cur = [a, b]
            runs.append(cur)
        if t1 < 1.0:
            cur = None
    return [np.array(r) for r in runs if len(r) >= 2 and np.sum(np.hypot(*np.diff(np.array(r), axis=0).T)) > 1.0]


def densify(poly):
    out, s = [poly[0]], [0.0]
    for p, q in zip(poly[:-1], poly[1:]):
        L = float(np.hypot(*(q - p)))
        n = max(1, int(math.ceil(L / STEP)))
        for k in range(1, n + 1):
            out.append(p + (q - p) * k / n)
            s.append(s[-1] + L / n)
    xy = np.array(out)
    t = np.gradient(xy, axis=0)
    t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    return xy, np.array(s), t, np.c_[-t[:, 1], t[:, 0]]


ALONG = np.arange(-5.0, 5.01, 0.5)
LAT = np.arange(-16.0, 16.01, 0.2)


def measure(r025, xy, t, n):
    """Per station: crown-line height, and per side gutter offset, curb rise, crown depth."""
    x0, z0 = BBOX[0], BBOX[1]
    nzf, nxf = r025.shape
    N = len(xy)
    out = {k: np.full(N, np.nan) for k in ("c", "gA", "riseA", "crownA", "gB", "riseB", "crownB")}
    band = np.abs(LAT) <= 2.5
    near = np.abs(ALONG) <= 1.0
    for b0 in range(0, N, 96):
        sl = slice(b0, min(N, b0 + 96))
        c, tt, nn = xy[sl], t[sl], n[sl]
        px = c[:, None, None, 0] + ALONG[None, :, None] * tt[:, None, None, 0] + LAT[None, None, :] * nn[:, None, None, 0]
        pz = c[:, None, None, 1] + ALONG[None, :, None] * tt[:, None, None, 1] + LAT[None, None, :] * nn[:, None, None, 1]
        ix = np.floor((px - x0) / FINE).astype(np.int64)
        iz = np.floor((pz - z0) / FINE).astype(np.int64)
        ok = (ix >= 0) & (ix < nxf) & (iz >= 0) & (iz < nzf)
        Z = np.full(px.shape, np.nan, np.float32)
        Z[ok] = r025[iz[ok], ix[ok]]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            rowc = np.nanmedian(Z[:, :, band], axis=2)
            out["c"][sl] = np.nanmedian(rowc[:, near], axis=1)
            det = Z - rowc[:, :, None]
            sec = np.nanmedian(det, axis=1)
            sec[np.sum(~np.isnan(det), axis=1) < 3] = np.nan
            pad = np.pad(sec, ((0, 0), (1, 1)), constant_values=np.nan)
            smooth = np.nanmean(np.stack([pad[:, :-2], pad[:, 1:-1], pad[:, 2:]]), axis=0)
        for side, sgn in (("A", 1), ("B", -1)):
            rng = np.nonzero((sgn * LAT >= SEARCH[0]) & (sgn * LAT <= SEARCH[1]))[0]
            vals = np.where(np.isnan(smooth[:, rng]), np.inf, smooth[:, rng])
            k = np.argmin(vals, axis=1)
            found = np.isfinite(vals[np.arange(len(k)), k]) & (k > 0) & (k < len(rng) - 1)
            kg = rng[k]
            g = np.abs(LAT[kg])
            gz = smooth[np.arange(len(k)), kg]
            outward = sgn * (LAT[None, :] - LAT[kg][:, None])
            topm = (outward >= 0.6) & (outward <= 1.4)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                top = np.nanmedian(np.where(topm, sec, np.nan), axis=1)
            rise = top - gz
            good = found & np.isfinite(rise) & (rise >= 0.06) & (rise <= 0.35) & (-gz > -0.05) & (-gz < 0.40)
            out["g" + side][sl] = np.where(good, g, np.nan)
            out["rise" + side][sl] = np.where(good, rise, np.nan)
            out["crown" + side][sl] = np.where(good, -gz, np.nan)
    return out


def rolling_nanmedian(v, w):
    h = w // 2
    p = np.pad(v, h, constant_values=np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(np.lib.stride_tricks.sliding_window_view(p, w), axis=1)


def fill_along(s, v, default):
    ok = np.isfinite(v)
    if not ok.any():
        return np.full_like(v, default)
    return np.interp(s, s[ok], v[ok])


def smoothstep(u):
    u = np.clip(u, 0, 1)
    return u * u * (3 - 2 * u)


def build_ribbons(W, r025, Gdtm, stats):
    x0, z0, x1, z1 = BBOX
    jq = {(int(round(x * 4)), int(round(z * 4))): k for k, (x, z) in enumerate(W["jxz"])}
    runs = []
    for r in W["roads"]:
        if r["bridge"] or len(r["pts"]) < 2:
            continue
        p = r["pts"]
        if p[:, 0].max() < x0 or p[:, 0].min() > x1 or p[:, 1].max() < z0 or p[:, 1].min() > z1:
            continue
        jn = sorted({jq[q] for q in ((int(round(x * 4)), int(round(z * 4))) for x, z in p) if q in jq})
        for poly in clip_runs(p):
            xy, s, t, n = densify(poly)
            runs.append({"road": r, "xy": xy, "s": s, "t": t, "n": n, "junctions": jn})
    log(f"{len(runs)} ribbon runs, {sum(len(u['xy']) for u in runs)} stations")

    # 1) measure every station, masking stations whose window reaches into a junction
    t0 = time.perf_counter()
    for u in runs:
        u["m"] = measure(r025, u["xy"], u["t"], u["n"])
        if u["junctions"]:
            J = W["jxz"][u["junctions"]]
            d = np.min(np.hypot(u["xy"][:, None, 0] - J[None, :, 0], u["xy"][:, None, 1] - J[None, :, 1])
                       - W["jr"][u["junctions"]][None, :], axis=1)
            for k in ("gA", "riseA", "crownA", "gB", "riseB", "crownB"):
                u["m"][k][d < 8.0] = np.nan
    stats["ribbons"] = {"measure_s": round(time.perf_counter() - t0, 1)}

    # 2) per road side: curb rise and crown depth (medians of valid windows)
    by_road = {}
    for u in runs:
        by_road.setdefault(u["road"]["i"], []).append(u)
    side_info = {}
    for ri, us in by_road.items():
        road = us[0]["road"]
        hw = max(2.0, road["width"] / 2)
        info = {}
        for side in "AB":
            g = np.concatenate([u["m"]["g" + side] for u in us])
            rise = np.concatenate([u["m"]["rise" + side] for u in us])
            crown = np.concatenate([u["m"]["crown" + side] for u in us])
            nv = int(np.isfinite(rise).sum())
            if nv >= 3:
                rv = float(np.clip(np.nanmedian(rise), 0.06, 0.25))
                info[side] = {"curb": True, "measured": True, "rise": rv, "n": nv,
                              "g": float(np.nanmedian(g)),
                              "crown": float(np.clip(np.nanmedian(crown), 0.0, 0.30))}
            else:
                info[side] = {"curb": road["sidewalk"], "measured": False,
                              "rise": DEFAULT_RISE if road["sidewalk"] else 0.0, "n": nv,
                              "g": hw, "crown": 0.02 * hw}
        side_info[ri] = info

    # 3) per station gutter offsets and crown line
    for u in runs:
        info = side_info[u["road"]["i"]]
        for side in "AB":
            g = rolling_nanmedian(u["m"]["g" + side], 5)
            u["g" + side] = np.clip(fill_along(u["s"], g, info[side]["g"]), SEARCH[0], SEARCH[1])
            # curb height per station: the measured windows around it (10 m), else the road side's
            if info[side]["measured"]:
                rr = rolling_nanmedian(u["m"]["rise" + side], 5)
                u["rise" + side] = np.clip(fill_along(u["s"], rr, info[side]["rise"]), 0.06, 0.25)
            else:
                u["rise" + side] = np.full(len(u["xy"]), info[side]["rise"])
        c = rolling_nanmedian(u["m"]["c"], 3)
        if np.isfinite(c).any():
            u["c"] = fill_along(u["s"], c, 0.0)
        else:
            u["c"] = tri_interp(Gdtm, x0, z0, CELL, u["xy"][:, 0], u["xy"][:, 1])

    # gate (tile-format-proposal.md §2.7): modelled curb height vs each measured 10 m window
    parts = [u["m"]["rise" + side] - u["rise" + side] for u in runs for side in "AB"
             if side_info[u["road"]["i"]][side]["measured"]]
    dev = np.concatenate(parts) if parts else np.zeros(0)
    dev = dev[np.isfinite(dev)]
    stats["ribbons"]["curb_windows"] = int(dev.size)
    stats["ribbons"]["curb_windows_within_2cm_frac"] = round(float(np.mean(np.abs(dev) <= 0.02)), 3) if dev.size else None
    stats["ribbons"]["curb_window_dev_m_p50_p90_abs"] = [round(float(np.percentile(np.abs(dev), q)), 3) for q in (50, 90)] if dev.size else None

    # 4) junction size from the measured widths of the roads meeting there (runs passing within
    # 30 m of it); ramp weight per station
    r_eff = {}
    for u in runs:
        for j in u["junctions"]:
            J = W["jxz"][j]
            dj = np.hypot(u["xy"][:, 0] - J[0], u["xy"][:, 1] - J[1])
            k = int(np.argmin(dj))
            r_eff.setdefault(j, W["jr"][j])
            if dj[k] < 30.0:
                r_eff[j] = max(r_eff[j], max(u["gA"][k], u["gB"][k]) + BEVEL + 0.5)
    for u in runs:
        if u["junctions"]:
            J = W["jxz"][u["junctions"]]
            R = np.array([r_eff[j] for j in u["junctions"]])
            d = np.hypot(u["xy"][:, None, 0] - J[None, :, 0], u["xy"][:, None, 1] - J[None, :, 1]) - R[None, :]
            u["jd"] = d.min(axis=1)
        else:
            u["jd"] = np.full(len(u["xy"]), 1e3)
        u["w"] = smoothstep(u["jd"] / 4.0)

    # 5) knots: offsets [-W_B, -C_B, -g_B, 0, g_A, C_A, W_A] along n, and their heights
    for u in runs:
        info = side_info[u["road"]["i"]]
        N = len(u["xy"])
        off = np.zeros((N, 7))
        hp = np.zeros((N, 7))
        hp[:, 3] = u["c"]
        for side, sgn, (kg, kc, kw) in (("A", 1, (4, 5, 6)), ("B", -1, (2, 1, 0))):
            si = info[side]
            g = u["g" + side]
            # curb and sidewalk taper to nothing into junctions (w -> 0), so one street's
            # sidewalk never crosses another's roadway; the taper doubles as a corner curb ramp
            C = g + np.maximum(0.01, (BEVEL if si["curb"] else 0.05) * u["w"])
            Wd = C + np.maximum(0.01, (WALK if si["curb"] else SHOULDER) * u["w"])
            off[:, kg], off[:, kc], off[:, kw] = sgn * g, sgn * C, sgn * Wd
            crown = si["crown"] if si["measured"] else 0.02 * g
            gutter = u["c"] - crown
            hp[:, kg] = gutter
            hp[:, kc] = gutter + u["rise" + side]
            hp[:, kw] = gutter + u["rise" + side]
        kx = u["xy"][:, None, 0] + off * u["n"][:, None, 0]
        kz = u["xy"][:, None, 1] + off * u["n"][:, None, 1]
        gk = tri_interp(Gdtm, x0, z0, CELL, kx, kz)
        w = u["w"][:, None]
        u["off"], u["kx"], u["kz"] = off, kx, kz
        u["h"] = w * hp + (1 - w) * gk
    return runs, side_info, r_eff


LATS = np.arange(-16.0, 16.01, 0.5)


def ribbon_samples(u, roadway_only=False):
    """Points on a run's ribbon surface every station and half-station, every 0.5 m across plus
    the knots. Returns px, pz, h and the station index (into the run) of each point."""
    off, h, xy, n = u["off"], u["h"], u["xy"], u["n"]
    N = len(xy)
    mo = np.vstack([off, (off[:-1] + off[1:]) / 2])
    mh = np.vstack([h, (h[:-1] + h[1:]) / 2])
    mxy = np.vstack([xy, (xy[:-1] + xy[1:]) / 2])
    mn = np.vstack([n, (n[:-1] + n[1:]) / 2])
    sidx = np.r_[np.arange(N), np.arange(N - 1)]
    out = ([], [], [], [])
    for k in range(len(mo)):
        lo, hi = (mo[k, 2], mo[k, 4]) if roadway_only else (mo[k, 0], mo[k, 6])
        dd = np.r_[mo[k][(mo[k] >= lo) & (mo[k] <= hi)], LATS[(LATS >= lo) & (LATS <= hi)]]
        hh = np.interp(dd, mo[k], mh[k])
        out[0].append(mxy[k, 0] + dd * mn[k, 0])
        out[1].append(mxy[k, 1] + dd * mn[k, 1])
        out[2].append(hh)
        out[3].append(np.full(dd.size, sidx[k]))
    return tuple(np.concatenate(a) for a in out)


def node_index(px, pz, shape):
    nz, nx = shape
    ii = np.rint((px - BBOX[0]) / CELL).astype(np.int64)
    jj = np.rint((pz - BBOX[1]) / CELL).astype(np.int64)
    ok = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < nz)
    return ii, jj, ok


def split_run(u, keep):
    """Sub-runs of consecutive kept stations (at least 2)."""
    out, i, N = [], 0, len(keep)
    per_station = [k for k, v in u.items() if isinstance(v, np.ndarray) and v.shape[:1] == (N,)]
    while i < N:
        if not keep[i]:
            i += 1
            continue
        j = i
        while j < N and keep[j]:
            j += 1
        if j - i >= 2:
            v = dict(u)
            for k in per_station:
                v[k] = u[k][i:j]
            v["s"] = u["s"][i:j] - u["s"][i]
            tt = np.gradient(v["xy"], axis=0)
            tt /= np.maximum(np.hypot(tt[:, 0], tt[:, 1]), 1e-9)[:, None]
            v["t"], v["n"] = tt, np.c_[-tt[:, 1], tt[:, 0]]
            out.append(v)
        i = j
    return out


def resolve_levels(runs, shape, stats):
    """Where two ribbons overlap more than LEVEL_GAP apart (a street crossing over another, a
    ramp over a lane), keep the upper one and drop the lower one's stations there. heightAt is
    single-valued; stacked roads become structures in Phase 1 (MAP_RESOURCES.md §9)."""
    # per node: the highest sample (h1, from run r1) and the highest from any other run (h2), so a
    # station is only compared with OTHER roads (a steep street's own samples differ by > LEVEL_GAP)
    nodes, hs, rs = [], [], []
    for r, u in enumerate(runs):
        px, pz, h, _ = ribbon_samples(u)
        ii, jj, ok = node_index(px, pz, shape)
        nodes.append(jj[ok] * shape[1] + ii[ok]); hs.append(h[ok]); rs.append(np.full(ok.sum(), r))
    nodes, hs, rs = np.concatenate(nodes), np.concatenate(hs), np.concatenate(rs)
    order = np.lexsort((-hs, nodes))
    nodes, hs, rs = nodes[order], hs[order], rs[order]
    first = np.r_[True, nodes[1:] != nodes[:-1]]
    gid = np.cumsum(first) - 1
    ukeys = nodes[first]
    h1, r1 = hs[first], rs[first]
    other = rs != r1[gid]
    h2 = np.full(ukeys.size, -np.inf)
    on = nodes[other]
    if on.size:
        f2 = np.r_[True, on[1:] != on[:-1]]
        h2[np.searchsorted(ukeys, on[f2])] = hs[other][f2]
    out, dropped, total = [], 0, 0
    for r, u in enumerate(runs):
        px, pz, h, si = ribbon_samples(u, roadway_only=True)
        ii, jj, ok = node_index(px, pz, shape)
        k = np.searchsorted(ukeys, jj[ok] * shape[1] + ii[ok])
        top_other = np.where(r1[k] == r, h2[k], h1[k])
        under = np.zeros(len(u["xy"]), bool)
        low = top_other - h[ok] > LEVEL_GAP
        under[si[ok][low]] = True
        total += len(under)
        dropped += int(under.sum())
        out.extend(split_run(u, ~under) if under.any() else [u])
    stats["ribbons"]["stations_dropped_under_upper_level"] = dropped
    stats["ribbons"]["stations_dropped_frac"] = round(dropped / max(total, 1), 4)
    return out


def ribbon_at_nodes(runs, shape):
    """Ribbon height at every grid node a ribbon covers, evaluated exactly as pilot.js ribbonAt
    does: locate the node between two stations' cut lines, interpolate knot offsets and heights
    along, piecewise-linear across; where ribbons overlap, the highest wins."""
    nz, nx = shape
    top = np.full(shape, -np.inf)
    for u in runs:
        xy, n, off, h = u["xy"], u["n"], u["off"], u["h"]
        for i in range(len(xy) - 1):
            j = i + 1
            cx = np.r_[xy[i, 0] + n[i, 0] * off[i, [0, 6]], xy[j, 0] + n[j, 0] * off[j, [0, 6]]]
            cz = np.r_[xy[i, 1] + n[i, 1] * off[i, [0, 6]], xy[j, 1] + n[j, 1] * off[j, [0, 6]]]
            i0 = max(0, int(np.ceil((cx.min() - BBOX[0]) / CELL)))
            i1 = min(nx - 1, int(np.floor((cx.max() - BBOX[0]) / CELL)))
            j0 = max(0, int(np.ceil((cz.min() - BBOX[1]) / CELL)))
            j1 = min(nz - 1, int(np.floor((cz.max() - BBOX[1]) / CELL)))
            if i1 < i0 or j1 < j0:
                continue
            JJ, II = np.mgrid[j0:j1 + 1, i0:i1 + 1]
            px, pz = BBOX[0] + II.ravel() * CELL, BBOX[1] + JJ.ravel() * CELL
            ai = (px - xy[i, 0]) * n[i, 1] - (pz - xy[i, 1]) * n[i, 0]
            aj = (px - xy[j, 0]) * n[j, 1] - (pz - xy[j, 1]) * n[j, 0]
            ok = (ai >= -0.02) & (aj <= 0.02) & (ai - aj > 1e-6)
            if not ok.any():
                continue
            px, pz, ai, aj = px[ok], pz[ok], ai[ok], aj[ok]
            t = np.clip(ai / (ai - aj), 0, 1)
            ccx = xy[i, 0] + (xy[j, 0] - xy[i, 0]) * t
            ccz = xy[i, 1] + (xy[j, 1] - xy[i, 1]) * t
            nnx = n[i, 0] + (n[j, 0] - n[i, 0]) * t
            nnz = n[i, 1] + (n[j, 1] - n[i, 1]) * t
            nl = np.maximum(np.hypot(nnx, nnz), 1e-9)
            d = ((px - ccx) * nnx + (pz - ccz) * nnz) / nl
            o = off[i][None, :] + (off[j] - off[i])[None, :] * t[:, None]
            hh = h[i][None, :] + (h[j] - h[i])[None, :] * t[:, None]
            inside = (d >= o[:, 0]) & (d <= o[:, 6])
            if not inside.any():
                continue
            d, o, hh = d[inside], o[inside], hh[inside]
            band = np.clip(np.sum(d[:, None] > o[:, 1:], axis=1), 0, 5)
            r = np.arange(len(d))
            oa, ob, ha, hb = o[r, band], o[r, band + 1], hh[r, band], hh[r, band + 1]
            val = ha + (hb - ha) * np.where(ob > oa, (d - oa) / np.maximum(ob - oa, 1e-9), 0)
            ii = np.rint((px[inside] - BBOX[0]) / CELL).astype(np.int64)
            jj = np.rint((pz[inside] - BBOX[1]) / CELL).astype(np.int64)
            np.maximum.at(top, (jj, ii), val)
    return top


def burn(runs, Gdtm, stats):
    """Ground grid under the ribbons = the ribbon surface there (minus BURN), so where physics
    leaves a ribbon onto the grid (sidewalk edges, junction corners, run ends) there is no step.
    The terrain mesh is kept from showing through ribbons by a depth offset (pilot.js), not by
    lowering the ground."""
    top = ribbon_at_nodes(runs, Gdtm.shape)
    inside = np.isfinite(top)
    G = Gdtm.copy()
    G[inside] = (top[inside] - BURN).astype(np.float32)
    stats["grid"]["nodes_under_ribbons_frac"] = round(float(inside.mean()), 3)
    # ribbon outer edge = grid there, so physics has no step where the ribbon ends
    for u in runs:
        for k in (0, 6):
            u["h"][:, k] = tri_interp(G, BBOX[0], BBOX[1], CELL, u["kx"][:, k], u["kz"][:, k])
    return G


# ---------------------------------------------------------------- output

class Bin:
    def __init__(self):
        self.parts, self.arrays, self.off = [], {}, 0

    def add(self, name, a, typ):
        a = np.ascontiguousarray(a, dtype=DT[typ])
        pad = (-self.off) % 4
        if pad:
            self.parts.append(b"\0" * pad)
            self.off += pad
        b = a.tobytes()
        self.arrays[name] = {"offset": self.off, "length": int(a.size), "type": typ}
        self.parts.append(b)
        self.off += len(b)
        return b


def write(W, G, runs, side_info, stats):
    x0, z0, x1, z1 = BBOX
    hmin = float(min(G.min(), min(u["h"].min() for u in runs)))
    hbase = math.floor(hmin) - 1.0
    hmax = float(max(G.max(), max(u["h"].max() for u in runs)))
    assert hmax - hbase < 655.0, "heights exceed the uint16 cm range"
    B = Bin()
    sec = {}
    sec["grid"] = B.add("grid", np.rint((G - hbase) * 100), "uint16")
    xy = np.vstack([u["xy"] for u in runs])
    off = np.vstack([u["off"] for u in runs])
    h = np.vstack([u["h"] for u in runs])
    jd = np.concatenate([u["jd"] for u in runs])
    sec["st_xz"] = B.add("st_xz", xy.astype(np.float32).ravel(), "float32")
    sec["st_off"] = B.add("st_off", np.rint(off * 100).ravel(), "int16")
    sec["st_h"] = B.add("st_h", np.rint((h - hbase) * 100).ravel(), "uint16")
    sec["st_jd"] = B.add("st_jd", np.rint(np.clip(jd, -300, 3000) * 10), "int16")
    starts = np.cumsum([0] + [len(u["xy"]) for u in runs[:-1]])
    flags = []
    for u in runs:
        si = side_info[u["road"]["i"]]
        flags.append((si["A"]["curb"] << 0) | (si["B"]["curb"] << 1) | (si["A"]["measured"] << 2) | (si["B"]["measured"] << 3))
    sec["run_start"] = B.add("run_start", starts, "uint32")
    sec["run_count"] = B.add("run_count", [len(u["xy"]) for u in runs], "uint32")
    sec["run_road"] = B.add("run_road", [u["road"]["i"] for u in runs], "uint32")
    sec["run_flags"] = B.add("run_flags", flags, "uint8")
    data = b"".join(B.parts)
    area_km2 = (x1 - x0) * (z1 - z0) / 1e6
    sizes = {k: {"raw": len(v), "gzip": len(gzip.compress(v, 9))} for k, v in sec.items()}
    stats["size"] = {"area_km2": round(area_km2, 3), "bin_raw": len(data),
                     "bin_gzip": len(gzip.compress(data, 9)), "sections": sizes,
                     "gzip_per_km2": round(len(gzip.compress(data, 9)) / area_km2)}
    index = {
        "version": 1,
        "attribution": "Ground and roads: USGS 3DEP lidar CA_SanFrancisco_1_B23 (public domain); "
                       "road centrelines (c) OpenStreetMap contributors (ODbL)",
        "bbox": {"x0": x0, "z0": z0, "x1": x1, "z1": z1}, "feather": FEATHER,
        "grid": {"x0": x0, "z0": z0, "cell": CELL, "nx": int(G.shape[1]), "nz": int(G.shape[0]), "hBase": hbase},
        "knots": 7, "bevel": BEVEL,
        "world": {"roads": len(W["roads"]), "buildings": len(W["buildings"]), "roadsHash": W["roads_hash"]},
        "counts": {"stations": int(len(xy)), "runs": len(runs)},
        "arrays": B.arrays, "stats": stats,
    }
    with open(OUT_BIN, "wb") as f:
        f.write(data)
    with open(OUT_JSON, "w", encoding="utf8") as f:
        json.dump(index, f, indent=1)
    log(f"wrote {OUT_BIN} ({len(data) / 1e6:.2f} MB raw, {stats['size']['bin_gzip'] / 1e6:.2f} MB gzip)")


def summarise(runs, side_info, r_eff, stats):
    roads = list(side_info.values())
    sides = [s for r in roads for s in r.values()]
    meas = [s for s in sides if s["measured"]]
    km = sum(u["s"][-1] for u in runs) / 1000
    stats["ribbons"].update({
        "runs": len(runs), "roads": len(roads), "km": round(km, 1),
        "stations": int(sum(len(u["xy"]) for u in runs)),
        "road_sides": len(sides), "sides_curb_measured": len(meas),
        "sides_curb_default": sum(1 for s in sides if s["curb"] and not s["measured"]),
        "sides_no_curb": sum(1 for s in sides if not s["curb"]),
        "curb_rise_m_p10_p50_p90": [round(float(np.percentile([s["rise"] for s in meas], q)), 3) for q in (10, 50, 90)] if meas else None,
        "crown_m_p10_p50_p90": [round(float(np.percentile([s["crown"] for s in meas], q)), 3) for q in (10, 50, 90)] if meas else None,
        "gutter_to_gutter_m_p10_p50_p90": [round(float(np.percentile(
            np.concatenate([u["gA"] + u["gB"] for u in runs]), q)), 1) for q in (10, 50, 90)],
        "junctions": len(r_eff),
        "junction_radius_m_p50_p90": [round(float(np.percentile(list(r_eff.values()), q)), 1) for q in (50, 90)],
    })


def main():
    t0 = time.perf_counter()
    stats = {"bbox": BBOX}
    W = load_world()
    r025 = mask_buildings(W, ground_raster(stats), stats)
    G0 = dtm_grid(W, r025, stats)
    log("grid", stats["grid"])
    runs, side_info, r_eff = build_ribbons(W, r025, G0, stats)
    runs = resolve_levels(runs, G0.shape, stats)
    log("ribbons", stats["ribbons"])
    G = burn(runs, G0, stats)
    summarise(runs, side_info, r_eff, stats)
    stats["bake_s"] = round(time.perf_counter() - t0, 1)
    write(W, G, runs, side_info, stats)
    log(json.dumps({k: v for k, v in stats.items() if k != "size"}, indent=1))
    log("size", json.dumps(stats["size"]))


if __name__ == "__main__":
    main()

"""Shared pieces of the lidar tile bakes (tools/bake_lidar_tiles.py, tools/spike_lidar_tiles.py).

Pass 1 (per tile, resumable): the tile's 0.25 m lidar ground raster as int16 cm in
CACHE/lidar_tiles/r025/<i>_<j>.npz, cut from the v2 pilot's cached raster when the tile lies inside
its box, else fetched from EPT (the LAZ deleted afterwards). Pass 2 helpers: an island's raster from
its tiles, station normals as pilot.js computes them, the per-tile road fingerprint, the pilot file
reader and writer. Proven by the spike (research/lidar-tiles-spike.md).
"""
import gzip
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "probes"))
import numpy as np  # noqa: E402

import bake_pilot_v2 as V  # noqa: E402   (installs nothing; callers set the overrides, as V.main() does)
import geo2  # noqa: E402

P = V.P
TS = 512.0
PILOT_BOX = tuple(V.V2_BBOX)   # the v2 pilot's box, before any bake moves V.V2_BBOX
R025 = os.path.join(P.CACHE, "lidar_tiles", "r025")
LIDAR_DIR = os.path.join(P.CACHE, "lidar")
SEG_MARGIN = 1.0      # m: a segment goes into every tile its quad + this margin meets
HASH_PAD = 32.0       # m: roads within this of a tile are in its fingerprint


def setup_v2():
    """bake_pilot on the v2 projection, datum and world (what bake_pilot_v2.main sets), fill jitter on."""
    P.proj = lambda lat, lon: geo2.proj_arr(lat, lon)
    P.unproj = lambda x, z: geo2.unproj(np.asarray(x, float), np.asarray(z, float))
    P.load_world = V.load_world_v2
    P.FILL_JITTER = True
    P.FILL_ANCHOR = 24.0


def island_box(tiles):
    i0 = min(i for i, _ in tiles); i1 = max(i for i, _ in tiles)
    j0 = min(j for _, j in tiles); j1 = max(j for _, j in tiles)
    assert len(tiles) == (i1 - i0 + 1) * (j1 - j0 + 1), "an island must be a full rectangle of tiles"
    return (i0 * TS, j0 * TS, (i1 + 1) * TS, (j1 + 1) * TS)


def save_r025(i, j, r):
    """0.25 m ground raster (NAVD88 - Y0, NaN = no ground return) -> int16 cm above an integer base."""
    os.makedirs(R025, exist_ok=True)
    ok = np.isfinite(r)
    base = math.floor(float(np.nanmin(r))) if ok.any() else 0.0
    q = np.full(r.shape, -32768, np.int16)
    v = np.rint((r[ok] - base) * 100)
    assert not v.size or v.max() < 32767, "tile relief over 327 m"   # no ground at all: all no-data"
    q[ok] = v.astype(np.int16)
    path = os.path.join(R025, "%d_%d.npz" % (i, j))
    tmp = path + ".tmp.npz"
    np.savez_compressed(tmp, q=q, base=np.float64(base))
    os.replace(tmp, path)
    return path


def load_r025(i, j):
    d = np.load(os.path.join(R025, "%d_%d.npz" % (i, j)))
    q = d["q"]
    r = np.where(q == -32768, np.nan, q.astype(np.float32) * np.float32(0.01) + np.float32(d["base"]))
    return r.astype(np.float32)


def tile_laz_paths(box):
    """The LAZ files bake_pilot.ground_raster fetches for `box` (its chunks, as fetch_ept names them):
    deleting exactly these keeps parallel fetches of other tiles intact."""
    x0, z0, x1, z1 = box
    out = []
    for cz in np.arange(z0, z1, P.CHUNK):
        for cx in np.arange(x0, x1, P.CHUNK):
            core = (cx, cz, min(cx + P.CHUNK, x1), min(cz + P.CHUNK, z1))
            lat_a, lon_a = P.unproj(core[0] - P.MARGIN, core[3] + P.MARGIN)
            lat_b, lon_b = P.unproj(core[2] + P.MARGIN, core[1] - P.MARGIN)
            bounds = P.bounds_3857_from_ll(lat_a, lon_a, lat_b, lon_b)
            key = P.hashlib.sha1(f"{P.PROJECT}|{bounds}".encode()).hexdigest()[:12]
            out.append(os.path.join(LIDAR_DIR, P.PROJECT, key + ".laz"))
    return out


def pass1_fetch(i, j):
    """EPT fetch of one tile -> 0.25 m raster (int16 npz) -> the LAZ and the float raster deleted.
    Safe to run for different tiles in parallel processes."""
    box = (i * TS, j * TS, (i + 1) * TS, (j + 1) * TS)
    done = os.path.join(R025, "%d_%d.npz" % (i, j))
    if os.path.exists(done):                # resumable: a tile with a raster is done
        return dict(tile=[i, j], cached=True, raster_int16_npz_mb=round(os.path.getsize(done) / 1e6, 2))
    os.makedirs(os.path.join(LIDAR_DIR, P.PROJECT), exist_ok=True)
    mine = tile_laz_paths(box)
    P.BBOX = box
    stats = {}
    t0 = time.perf_counter()
    try:
        r = P.ground_raster(stats)          # bake_pilot's chunked fetch; heights NAVD88 (v1 convention)
    except Exception:
        # a failed read can leave a partial LAZ that fetch_ept would take as cached next time
        for f in mine:
            if os.path.exists(f):
                os.remove(f)
        raise
    s_raster = time.perf_counter() - t0
    r = (r - geo2.Y0).astype(np.float32)
    new_laz = [f for f in mine if os.path.exists(f)]
    laz_bytes = sum(os.path.getsize(f) for f in new_laz)
    for f in new_laz:
        os.remove(f)
    # this process's PDAL pipeline specs (common.run_pdal names them by process and thread)
    for f in os.listdir(LIDAR_DIR):
        if f.startswith("_pipeline_%d_" % os.getpid()):
            os.remove(os.path.join(LIDAR_DIR, f))
    # bake_pilot caches its float raster; the tile's int16 npz replaces it
    key = P.hashlib.sha1(json.dumps([P.PROJECT, box, P.FINE]).encode()).hexdigest()[:10]
    fl = os.path.join(P.PCACHE, "ground025_%s.npy" % key)
    float_bytes = os.path.getsize(fl) if os.path.exists(fl) else 0
    for f in (fl, fl.replace(".npy", ".json")):
        if os.path.exists(f):
            os.remove(f)
    path = save_r025(i, j, r)
    lid = stats.get("lidar", {})
    return dict(tile=[i, j], laz_files=len(new_laz), laz_mb=round(laz_bytes / 1e6, 1), laz_deleted=True,
                fetch_s=lid.get("fetch_s"), raster_s=round(s_raster, 1), points=lid.get("points"),
                ground_points=lid.get("ground_points"), ground_cells_frac=lid.get("ground_cells_frac"),
                raster_float_mb=round(float_bytes / 1e6, 1), raster_int16_npz_mb=round(os.path.getsize(path) / 1e6, 2))


def pass1_from_pilot(tiles):
    """Island A: its tiles' rasters cut from the v2 pilot's cached raster (no fetch)."""
    stats = {}
    keep, V.V2_BBOX = V.V2_BBOX, PILOT_BOX  # ground_raster_v2 finds its cache by this box
    try:
        full = V.ground_raster_v2(stats)    # over the old pilot box, NAVD88 - Y0
    finally:
        V.V2_BBOX = keep
    bx0, bz0 = PILOT_BOX[0], PILOT_BOX[1]
    out = []
    for i, j in tiles:
        c0, r0 = (i * TS - bx0) / P.FINE, (j * TS - bz0) / P.FINE
        assert c0 == int(c0) and r0 == int(r0) and c0 >= 0 and r0 >= 0
        n = int(TS / P.FINE)
        sub = full[int(r0):int(r0) + n, int(c0):int(c0) + n]
        assert sub.shape == (n, n), "tile %d,%d is not inside the old pilot box" % (i, j)
        path = save_r025(i, j, sub)
        out.append(dict(tile=[i, j], source="v2 pilot raster (cached)", raster_int16_npz_mb=round(os.path.getsize(path) / 1e6, 2)))
    return out


def island_raster(tiles, box):
    n = int(TS / P.FINE)
    x0, z0, x1, z1 = box
    r = np.full((int((z1 - z0) / P.FINE), int((x1 - x0) / P.FINE)), np.nan, np.float32)
    for i, j in tiles:
        c, rr = int((i * TS - x0) / P.FINE), int((j * TS - z0) / P.FINE)
        r[rr:rr + n, c:c + n] = load_r025(i, j)
    return r


def read_pilot(path_json, path_bin):
    with open(path_json, encoding="utf8") as f:
        idx = json.load(f)
    with open(path_bin, "rb") as f:
        buf = f.read()
    A = {k: np.frombuffer(buf, dtype=P.DT[a["type"]], count=a["length"], offset=a["offset"]) for k, a in idx["arrays"].items()}
    return idx, A


def station_normals(xz, start, count):
    """pilot.js decodePilot's normals: central difference inside a run, one-sided at its ends."""
    n = np.zeros((len(xz), 2), np.float32)
    x = xz.astype(np.float64)
    for s, c in zip(start.tolist(), count.tolist()):
        e = s + c
        for i in range(s, e):
            a, b = max(s, i - 1), min(e - 1, i + 1)
            tx, tz = x[b, 0] - x[a, 0], x[b, 1] - x[a, 1]
            l = math.hypot(tx, tz) or 1.0
            n[i] = (-tz / l, tx / l)
    return n


def write_pilot(path_json, path_bin, idx, arrays):
    B = P.Bin()
    for name, (a, typ) in arrays.items():
        B.add(name, a, typ)
    data = b"".join(B.parts)
    idx = dict(idx, arrays=B.arrays)
    with open(path_bin, "wb") as f:
        f.write(data)
    with open(path_json, "w", encoding="utf8") as f:
        json.dump(idx, f, indent=1)
    return len(data), len(gzip.compress(data, 9))


def net_roads():
    with open(os.path.join(V.V2, "net.json"), encoding="utf8") as f:
        idx = json.load(f)
    with open(os.path.join(V.V2, "net.bin.wasm"), "rb") as f:
        buf = f.read()
    a = lambda n: np.frombuffer(buf, dtype=P.DT[idx["arrays"][n]["type"]], count=idx["arrays"][n]["length"], offset=idx["arrays"][n]["offset"])
    xz = a("road_xz").reshape(-1, 2)
    st, ct = a("road_start").astype(np.int64), a("road_count").astype(np.int64)
    lo = np.array([xz[s:s + c].min(axis=0) for s, c in zip(st, ct)])
    hi = np.array([xz[s:s + c].max(axis=0) for s, c in zip(st, ct)])
    return xz, st, ct, lo, hi


def tile_hash(roads, i, j):
    """FNV-1a (32 bit) over uint16 words: per road meeting the tile +- HASH_PAD, in index order, its
    index (2 words, low first) then its float32 coordinates read as uint16 (lidar2.js tileHash)."""
    xz, st, ct, lo, hi = roads
    x0, z0, x1, z1 = i * TS - HASH_PAD, j * TS - HASH_PAD, (i + 1) * TS + HASH_PAD, (j + 1) * TS + HASH_PAD
    sel = np.flatnonzero((hi[:, 0] >= x0) & (lo[:, 0] <= x1) & (hi[:, 1] >= z0) & (lo[:, 1] <= z1))
    words = []
    for r in sel.tolist():
        words.append(np.array([r & 0xFFFF, r >> 16], np.uint16))
        words.append(np.frombuffer(xz[st[r]:st[r] + ct[r]].tobytes(), np.uint16))
    w = np.concatenate(words) if words else np.zeros(0, np.uint16)
    h = 0x811C9DC5
    for v in w.tolist():
        h = ((h ^ v) * 0x01000193) & 0xFFFFFFFF
    return h, int(len(sel))

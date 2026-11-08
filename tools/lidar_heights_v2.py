"""Building heights from lidar for the v2 world (M5): every building whose height the bake had to
guess (no OSM height or levels: bld_src 0 in the tiles) gets roof minus ground from USGS 3DEP.

Per 512 m tile with such buildings: one EPT read at RES (EPSG:3857 units, ~1 point per m^2), then per
footprint the 90th percentile of the non-ground returns inside it (Alameda's surveys do not classify
buildings, so class 1 counts; trees over small roofs can lift a few), minus the building's ground
(its gmin in the tile, the v2 terrain). SF B23 covers SF, YBI and TI; Alameda _2/_3 the East Bay;
Marin and San Mateo have no survey here and keep their guessed heights.

Writes CACHE/v2/lidar_heights.json: {"buildings": [[cx, cz, h], ...]} with cx, cz the footprint
centroid (mean of its tile vertices); tools/bake_v2.py matches them within 0.3 m.

    python tools/lidar_heights_v2.py
"""
import hashlib
import json
import os
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "probes"))
import numpy as np  # noqa: E402
from matplotlib.path import Path  # noqa: E402

import common as C  # noqa: E402
from geo2 import CACHE as V2CACHE, OUT, Y0  # noqa: E402

RES = 4.0
SF, A2, A3 = "CA_SanFrancisco_1_B23", "CA_AlamedaCo_2_2021", "CA_AlamedaCo_3_2021"
NOT_ROOF = (2, 7, 9, 17, 18, 20)   # ground, noise, water, bridge deck, high noise, ignored ground
MIN_PTS = 6
WORKERS = 6
_lock = threading.Lock()


def tile_buildings(path):
    """(x0, z0, [(xz Nx2, gmin, gmax), ...]) of the buildings without an OSM height."""
    d = open(path, "rb").read()
    hl = struct.unpack("<I", d[:4])[0]
    head = json.loads(d[4:4 + hl])
    base = 4 + hl + (-(4 + hl)) % 8
    A = head["arrays"]
    if "bld_src" not in A:
        return head["x0"], head["z0"], []

    def ta(name):
        a = A[name]
        return np.frombuffer(d, dtype=a["type"], count=a["length"], offset=base + a["offset"])
    cnt = ta("bld_count").astype(int)
    xz = ta("bld_xz").astype(np.float64).reshape(-1, 2) / 32 + [head["x0"], head["z0"]]
    gmin, gmax, src = ta("bld_gmin") * 0.1, ta("bld_gmax") * 0.1, ta("bld_src")
    st = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    # 0: still guessed; 2: measured by an earlier run (re-measured, so this file always has them all)
    out = [(xz[s:s + n], float(gmin[k]), float(gmax[k])) for k, (s, n) in enumerate(zip(st, cnt)) if src[k] in (0, 2)]
    return head["x0"], head["z0"], out


def fetch(project, x0, z0, x1, z1):
    """Cached reduced-resolution EPT read of a box (v2 metres) -> LAZ path or None."""
    b = C.bounds_3857_from_sft1(x0, -z1, x1, -z0)
    key = hashlib.sha1(f"{project}|{b}|{RES}".encode()).hexdigest()[:12]
    out = os.path.join(C.CACHE, "lidar", project + "_r%g" % RES, key + ".laz")
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        C.run_pdal([{"type": "readers.ept", "filename": C.EPT_URL.format(project), "bounds": b, "resolution": RES, "threads": 4},
                    {"type": "writers.las", "filename": out.replace(os.sep, "/"), "compression": True, "minor_version": 4, "dataformat_id": 6}])
    return out


def measure(job):
    path, = job
    x0, z0, blds = tile_buildings(path)
    if not blds:
        return [], None, 0
    order = (SF, A2, A3) if x0 < 4600 else (A2, A3, SF)
    pts = None
    for project in order:
        try:
            laz = fetch(project, x0 - 40, z0 - 40, x0 + 552, z0 + 552)
        except RuntimeError:
            continue
        P = C.load_points(laz)
        keep = ~np.isin(P["Classification"], NOT_ROOF) & ~P["Withheld"]
        if keep.sum() > 500:
            pts = (P["X"][keep], -P["Y"][keep], P["Z"][keep] - Y0, project)
            break
    if pts is None:
        return [], None, len(blds)
    X, Z, Hh, project = pts
    out = []
    order_x = np.argsort(X)
    Xs, Zs, Hs = X[order_x], Z[order_x], Hh[order_x]
    for xz, gmin, gmax in blds:
        lo, hi = np.searchsorted(Xs, xz[:, 0].min()), np.searchsorted(Xs, xz[:, 0].max())
        if hi - lo < MIN_PTS:
            continue
        zz = Zs[lo:hi]
        m = (zz >= xz[:, 1].min()) & (zz <= xz[:, 1].max())
        if m.sum() < MIN_PTS:
            continue
        inside = Path(xz).contains_points(np.c_[Xs[lo:hi][m], zz[m]])
        if inside.sum() < MIN_PTS:
            continue
        roof = float(np.percentile(Hs[lo:hi][m][inside], 90))
        h = roof - gmin
        if 2.5 <= h <= 330:
            c = xz.mean(axis=0)
            out.append([round(float(c[0]), 2), round(float(c[1]), 2), round(h, 2)])
    return out, project, len(blds)


def main():
    tdir = os.path.join(OUT, "tiles")
    jobs = [(os.path.join(tdir, f),) for f in sorted(os.listdir(tdir))]
    t0 = time.perf_counter()
    res, tried, per = [], 0, {}
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for k, (out, project, n) in enumerate(ex.map(measure, jobs)):
            res.extend(out)
            tried += n
            if project:
                per[project] = per.get(project, 0) + len(out)
            if k % 100 == 0:
                print("%d/%d tiles, %d heights of %d guessed buildings, %.0f s" % (k, len(jobs), len(res), tried, time.perf_counter() - t0), flush=True)
    path = os.path.join(V2CACHE, "lidar_heights.json")
    with open(path, "w") as f:
        json.dump({"res": RES, "buildings": res, "by_project": per, "guessed": tried}, f)
    print("wrote %s: %d of %d guessed buildings measured %s in %.0f s" % (path, len(res), tried, per, time.perf_counter() - t0))


if __name__ == "__main__":
    main()

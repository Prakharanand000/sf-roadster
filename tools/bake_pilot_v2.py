"""The lidar pilot (Nob Hill + FiDi: measured ground and road ribbons) for the v2 world (M5).

Runs tools/bake_pilot.py unchanged apart from what is v1-specific, the way bake_v2.py runs bake.py:
- projection and datum: the v2 transverse Mercator (tools/geo2.py), heights NAVD88 - Y0;
- box: v1's pilot box in v2 metres, shrunk inside v1's lidar chunks and snapped to the 8 m grid;
- world: roads, junctions, buildings and terrain from data/v2 (net + tiles) instead of world.json;
- lidar: the v1 run's chunks (same EPSG:3857 boxes), so the cached LAZ files are reused, with each
  chunk's points kept inside its v1 core (no double counting) and binned on the v2 grid.
Writes data/v2/pilot.json + pilot.bin.wasm (pilot.js reads them; src/world/v2/city2.js loads them).

    python tools/bake_pilot_v2.py
"""
import json
import math
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "probes"))
import numpy as np  # noqa: E402
from pyproj import Transformer  # noqa: E402

import geo2  # noqa: E402
import bake_pilot as P  # noqa: E402
from common import bounds_3857_from_ll, fetch_ept, load_points  # noqa: E402

V2 = os.path.join(P.ROOT, "data", "v2")
V1_BBOX = P.BBOX
V1_PROJ, V1_UNPROJ = P.proj, P.unproj
DT = P.DT


def _v2_box():
    """v1's box corners in v2 metres -> the largest axis-aligned box inside, less 8 m, on the 8 m grid."""
    x0, z0, x1, z1 = V1_BBOX
    lat, lon = V1_UNPROJ(np.array([x0, x1, x0, x1]), np.array([z0, z0, z1, z1]))
    X, Z = geo2.proj_arr(lat, lon)
    ix0, ix1 = max(X[0], X[2]), min(X[1], X[3])
    iz0, iz1 = max(Z[0], Z[1]), min(Z[2], Z[3])
    snap = lambda v, f: float(f(v / 8.0) * 8.0)
    return (snap(ix0 + 8, math.ceil), snap(iz0 + 8, math.ceil), snap(ix1 - 8, math.floor), snap(iz1 - 8, math.floor))


V2_BBOX = _v2_box()


def load_world_v2():
    with open(os.path.join(V2, "net.json"), encoding="utf8") as f:
        idx = json.load(f)
    with open(os.path.join(V2, "net.bin.wasm"), "rb") as f:
        buf = f.read()

    def arr(name):
        a = idx["arrays"][name]
        return np.frombuffer(buf, dtype=DT[a["type"]], count=a["length"], offset=a["offset"])

    rxz32 = arr("road_xz")
    rxz = rxz32.astype(np.float64).reshape(-1, 2)
    start, count = arr("road_start"), arr("road_count")
    width, rtype, flags = arr("road_width") * 0.1, arr("road_type"), arr("road_flags")
    F = idx["road_flags"]
    W = {"index": idx}
    W["roads"] = [{"i": i, "pts": rxz[start[i]:start[i] + count[i]], "width": float(width[i]),
                   "type": idx["road_types"][rtype[i]], "bridge": bool(flags[i] & F["bridge"]),
                   "sidewalk": bool(flags[i] & F["sidewalk"])}
                  for i in range(len(start))]
    # fingerprint: FNV-1a over the float32 road coordinates read as uint16 (src/world/v2/city2.js
    # computes the same, so a pilot from another bake of the net is refused)
    W["roads_hash"] = P.fnv1a16(np.frombuffer(rxz32.tobytes(), np.uint16))
    W["jxz"] = arr("junction_xz").astype(np.float64).reshape(-1, 2)
    W["jr"] = arr("junction_r").astype(np.float64) * 0.25
    # terrain and buildings of the tiles around the box (8 m grid, shared tile borders)
    T = idx["tiles"]
    TS, cell = T["size"], T["cell"]
    k = int(TS / cell)
    x0, z0, x1, z1 = V2_BBOX
    ti0, ti1 = int(math.floor((x0 - 64) / TS)), int(math.floor((x1 + 64) / TS))
    tj0, tj1 = int(math.floor((z0 - 64) / TS)), int(math.floor((z1 + 64) / TS))
    nx, nz = (ti1 - ti0 + 1) * k + 1, (tj1 - tj0 + 1) * k + 1
    H = np.full((nz, nx), np.nan, np.float32)
    blds = []
    for tj in range(tj0, tj1 + 1):
        for ti in range(ti0, ti1 + 1):
            fn = os.path.join(V2, "tiles", "%d_%d.bin.wasm" % (ti, tj))
            if not os.path.exists(fn):
                continue
            d = open(fn, "rb").read()
            hl = struct.unpack("<I", d[:4])[0]
            head = json.loads(d[4:4 + hl])
            base = 4 + hl + (-(4 + hl)) % 8
            A = head["arrays"]

            def ta(name):
                a = A[name]
                return np.frombuffer(d, dtype=DT[a["type"]], count=a["length"], offset=base + a["offset"])
            oi, oj = (ti - ti0) * k, (tj - tj0) * k
            H[oj:oj + k + 1, oi:oi + k + 1] = ta("h8").reshape(k + 1, k + 1) * 0.1
            if "bld_xz" in A:
                c = ta("bld_count").astype(int)
                p = ta("bld_xz").astype(np.float64).reshape(-1, 2) / 32 + [head["x0"], head["z0"]]
                s = np.concatenate([[0], np.cumsum(c)[:-1]])
                blds.extend(p[a:a + n] for a, n in zip(s, c))
    if np.isnan(H).any():   # all-water tiles: the net's 16 m terrain
        g = idx["grid"]
        H16 = (arr("height16").astype(np.float32) * 0.1).reshape(g["nz"], g["nx"])
        jj, ii = np.nonzero(np.isnan(H))
        X = ti0 * TS + ii * cell
        Z = tj0 * TS + jj * cell
        H[jj, ii] = P.tri_interp(H16, g["x0"], g["z0"], g["cell"], X, Z)
    W["grid"] = {"x0": ti0 * TS, "z0": tj0 * TS, "cell": cell, "nx": nx, "nz": nz}
    W["H"] = H
    W["buildings"] = blds
    P.log("v2 world: %d roads, %d buildings near the box, terrain %dx%d" % (len(W["roads"]), len(blds), nx, nz))
    return W


def ground_raster_v2(stats):
    """bake_pilot.ground_raster over the v2 box, from the v1 run's lidar chunks (cached LAZ)."""
    x0, z0, x1, z1 = V2_BBOX
    FINE = P.FINE
    nxf, nzf = int(round((x1 - x0) / FINE)), int(round((z1 - z0) / FINE))
    key = P.hashlib.sha1(json.dumps(["v2", P.PROJECT, V2_BBOX, FINE, geo2.Y0]).encode()).hexdigest()[:10]
    path = os.path.join(P.PCACHE, f"ground025_v2_{key}.npy")
    meta_path = path.replace(".npy", ".json")
    if os.path.exists(path) and os.path.exists(meta_path):
        P.log("lidar raster from cache", path)
        with open(meta_path) as f:
            stats["lidar"] = json.load(f)
        stats["lidar"]["cached"] = True
        return np.load(path)
    vx0, vz0, vx1, vz1 = V1_BBOX
    chunks = []
    for cz in np.arange(vz0, vz1, P.CHUNK):
        for cx in np.arange(vx0, vx1, P.CHUNK):
            core = (cx, cz, min(cx + P.CHUNK, vx1), min(cz + P.CHUNK, vz1))
            lat_a, lon_a = V1_UNPROJ(core[0] - P.MARGIN, core[3] + P.MARGIN)
            lat_b, lon_b = V1_UNPROJ(core[2] + P.MARGIN, core[1] - P.MARGIN)
            chunks.append((core, bounds_3857_from_ll(lat_a, lon_a, lat_b, lon_b)))
    P.log(f"reading {len(chunks)} lidar chunks of the v1 run (cached LAZ)")
    t0 = time.perf_counter()
    fetched = [fetch_ept(P.PROJECT, c[1]) for c in chunks]
    new = sum(1 for _, st in fetched if not st["cached"])
    to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    acc = np.zeros((nzf, nxf), np.float64)
    cnt = np.zeros((nzf, nxf), np.uint32)
    n_all = n_ground = 0
    for (core, _), (laz, _) in zip(chunks, fetched):
        Pts = load_points(laz, reproject=False)
        n_all += Pts["Z"].size
        m = (Pts["Classification"] == 2) & ~Pts["Withheld"]
        lon, lat = to_ll.transform(Pts["X"][m], Pts["Y"][m])
        ux, uz = V1_PROJ(lat, lon)
        keep = (ux >= core[0]) & (ux < core[2]) & (uz >= core[1]) & (uz < core[3])   # each point once
        gx, gz = geo2.proj_arr(lat[keep], lon[keep])
        zz = Pts["Z"][m][keep] - geo2.Y0
        inb = (gx >= x0) & (gx < x1) & (gz >= z0) & (gz < z1)
        gx, gz, zz = gx[inb], gz[inb], zz[inb]
        n_ground += zz.size
        flat = (np.floor((gz - z0) / FINE).astype(np.int64) * nxf + np.floor((gx - x0) / FINE).astype(np.int64))
        acc += np.bincount(flat, weights=zz, minlength=nxf * nzf).reshape(nzf, nxf)
        cnt += np.bincount(flat, minlength=nxf * nzf).reshape(nzf, nxf).astype(np.uint32)
    with np.errstate(invalid="ignore", divide="ignore"):
        r = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan).astype(np.float32)
    stats["lidar"] = {"project": P.PROJECT, "chunks": len(chunks), "chunks_downloaded": new,
                      "load_s": round(time.perf_counter() - t0, 1), "points": int(n_all), "ground_points": int(n_ground),
                      "ground_cells_frac": round(float((cnt > 0).mean()), 3), "datum": "NAVD88 - %.3f" % geo2.Y0}
    os.makedirs(P.PCACHE, exist_ok=True)
    np.save(path, r)
    with open(meta_path, "w") as f:
        json.dump(stats["lidar"], f)
    return r


def main():
    P.BBOX = V2_BBOX
    P.proj = lambda lat, lon: geo2.proj_arr(lat, lon)
    P.unproj = lambda x, z: geo2.unproj(np.asarray(x, float), np.asarray(z, float))
    P.load_world = load_world_v2
    P.ground_raster = ground_raster_v2
    P.OUT_JSON = os.path.join(V2, "pilot.json")
    P.OUT_BIN = os.path.join(V2, "pilot.bin.wasm")
    P.log("v2 pilot box", V2_BBOX, "(v1 box", V1_BBOX, ")")
    P.main()


if __name__ == "__main__":
    main()

"""Which v2 tiles get lidar patches (tools/bake_lidar_tiles.py): every tile with land that the SF lidar
(CA_SanFrancisco_1_B23, the project pass 1 fetches) covers whole.

    python tools/lidar_coverage.py        # -> CACHE/lidar_tiles/coverage.json

A tile is in when:
- it has land (at least LAND_MIN of its 4 m landcover is not sea);
- USGS's 1 m DEM from the same lidar (CA_SanFrancisco_B23, tools/dem1m_v2.py) covers at least
  COVER_MIN of that land. Tiles on the edge of the survey would otherwise be filled across the gap;
- it is clear of the tunnel roofs (Yerba Buena Island). A tunnel is a cut in the 8 m ground with the
  hill kept as a roof (baybridge_v2.py), which a lidar patch, the hill as it is, would cover over.
"""
import json
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "probes"))
import numpy as np  # noqa: E402

import common as C  # noqa: E402
import dem1m_v2 as D  # noqa: E402
from geo2 import CACHE, GX0, GZ0, LC_RES, LCX, LCZ, OUT, TM  # noqa: E402

PROJECT_DEM = "CA_SanFrancisco_B23"
LAND_MIN = 0.03
COVER_MIN = 0.98
ROOF_PAD = 50.0           # m around a tunnel roof's half width
WATER = 0                 # bake.py landcover classes: WATER, URBAN, ... (sea)
OUT_JSON = os.path.join(C.CACHE, "lidar_tiles", "coverage.json")   # beside the pass 1 rasters
MASK = os.path.join(D.DEM1M_DIR, "mosaic4_sf.f32")


def sf_mask():
    """4 m pixels (the landcover grid) where the SF survey's 1 m DEM has data."""
    src = sorted(os.path.join(D.DEM1M_DIR, PROJECT_DEM, f) for f in os.listdir(os.path.join(D.DEM1M_DIR, PROJECT_DEM)) if f.endswith(".tif"))
    if not os.path.exists(MASK):
        cmd = [D.GDALWARP, "-overwrite", "-t_srs", TM, "-te", repr(GX0), repr(-(GZ0 + LCZ * LC_RES)), repr(GX0 + LCX * LC_RES), repr(-GZ0),
               "-tr", repr(LC_RES), repr(LC_RES), "-r", "average", "-ot", "Float32", "-dstnodata", repr(D.NODATA), "-of", "ENVI"] + src + [MASK]
        r = subprocess.run(cmd, env=C._tool_env(), capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError("gdalwarp failed: " + r.stderr[-2000:])
    a = np.fromfile(MASK, dtype="<f4")
    assert a.size == LCX * LCZ
    return (a > D.NODATA + 1).reshape(LCZ, LCX)


def read_tile_lc(i, j):
    with open(os.path.join(OUT, "tiles", "%d_%d.bin.wasm" % (i, j)), "rb") as f:
        d = f.read()
    hl = struct.unpack("<I", d[:4])[0]
    head = json.loads(d[4:4 + hl])
    base = 4 + hl + (-(4 + hl)) % 8
    a = head["arrays"]["lc"]
    lc = np.frombuffer(d, dtype=np.uint8, count=a["length"], offset=base + a["offset"])
    n = int(round(np.sqrt(lc.size)))
    return lc.reshape(n, n)


def net_roofs():
    """Tunnel roofs from the net: [(polyline Nx2, half width)]."""
    with open(os.path.join(OUT, "net.json"), encoding="utf8") as f:
        idx = json.load(f)
    with open(os.path.join(OUT, "net.bin.wasm"), "rb") as f:
        buf = f.read()
    DT = {"uint8": "u1", "uint16": "<u2", "uint32": "<u4", "int32": "<i4", "float32": "<f4"}
    a = lambda n: np.frombuffer(buf, dtype=DT[idx["arrays"][n]["type"]], count=idx["arrays"][n]["length"], offset=idx["arrays"][n]["offset"])
    xzh = a("deck_xzh").reshape(-1, 3)
    out = []
    for s, c, hw, k in zip(a("deck_start"), a("deck_count"), a("deck_hw"), a("deck_kind")):
        if k == 1:
            # densified to every 2 m, so a vertex-to-tile distance stands for the segments'
            p = xzh[s:s + c, :2].astype(np.float64)
            pts = [p[0]]
            for q0, q1 in zip(p[:-1], p[1:]):
                n = max(1, int(np.ceil(np.hypot(*(q1 - q0)) / 2.0)))
                pts.extend(q0 + (q1 - q0) * (k2 / n) for k2 in range(1, n + 1))
            out.append((np.array(pts), hw / 10.0))
    return idx, out


def main():
    idx, roofs = net_roofs()
    T = idx["tiles"]
    TS = float(T["size"])
    man = idx["manifest"] if "manifest" in idx else None
    tiles = sorted({(int(f.split("_")[0]), int(f.split("_")[1].split(".")[0])) for f in os.listdir(os.path.join(OUT, "tiles")) if f.endswith(".bin.wasm")})
    valid = sf_mask()
    per = int(TS / LC_RES)
    cover, near_roof, partial = [], [], []
    for i, j in tiles:
        lc = read_tile_lc(i, j)
        land = lc != WATER
        if land.mean() < LAND_MIN:
            continue
        r0, c0 = int((j * TS - GZ0) / LC_RES), int((i * TS - GX0) / LC_RES)
        v = valid[r0:r0 + per, c0:c0 + per]
        if v.shape != land.shape:
            continue
        frac = float(v[land].mean())
        if frac < COVER_MIN:
            if frac > 0.02:
                partial.append([i, j, round(frac, 3)])
            continue
        x0, z0 = i * TS, j * TS
        hit = False
        for p, hw in roofs:
            px = np.clip(p[:, 0], x0, x0 + TS); pz = np.clip(p[:, 1], z0, z0 + TS)
            if np.min(np.hypot(p[:, 0] - px, p[:, 1] - pz)) <= hw + ROOF_PAD:
                hit = True
                break
        if hit:
            near_roof.append([i, j])
            continue
        cover.append([i, j, round(float(land.mean()), 3)])
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf8") as f:
        json.dump({"project": "CA_SanFrancisco_1_B23", "land_min": LAND_MIN, "cover_min": COVER_MIN,
                   "tiles": cover, "excluded_tunnel": near_roof, "excluded_partial": partial}, f, indent=1)
    print("coverage: %d tiles (%.1f km2 of land); left out: %d near the tunnel, %d partly surveyed"
          % (len(cover), sum(t[2] for t in cover) * TS * TS / 1e6, len(near_roof), len(partial)))


if __name__ == "__main__":
    main()

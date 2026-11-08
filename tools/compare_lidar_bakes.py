"""Two bakes of the lidar tile patches, compared file by file (tools/bake_lidar_tiles.py --out):

    python tools/compare_lidar_bakes.py DIR_A DIR_B

Prints, per tile that differs, what differs: the height base, grid nodes (count, max cm, where),
station and run arrays. Same coverage baked with two block sizes must print nothing: lidar_pass2.py
decides every tile and station in one block, whatever the block size.
"""
import json, os, struct, sys
import numpy as np

A, B = sys.argv[1], sys.argv[2]
DT = {"uint16": "<u2", "int16": "<i2", "uint32": "<u4", "uint8": "u1", "float32": "<f4"}


def read(path):
    d = open(path, "rb").read()
    hl = struct.unpack("<I", d[:4])[0]
    head = json.loads(d[4:4 + hl])
    base = 4 + hl + (-(4 + hl)) % 8
    arr = {k: np.frombuffer(d, dtype=DT[a["type"]], count=a["length"], offset=base + a["offset"]) for k, a in head["arrays"].items()}
    return head, arr


for f in sorted(os.listdir(A)):
    if not f.endswith(".bin.wasm"):
        continue
    ha, a = read(os.path.join(A, f))
    hb, b = read(os.path.join(B, f))
    out = []
    if ha["grid"]["hBase"] != hb["grid"]["hBase"]:
        out.append("hBase %s vs %s" % (ha["grid"]["hBase"], hb["grid"]["hBase"]))
    ga, gb = a["grid"].astype(int).reshape(257, 257), b["grid"].astype(int).reshape(257, 257)
    dg = np.abs(ga - gb)
    if dg.any():
        jj, ii = np.nonzero(dg)
        out.append("grid: %d nodes differ, max %d cm, rows %d..%d cols %d..%d" % (dg.astype(bool).sum(), dg.max(), jj.min(), jj.max(), ii.min(), ii.max()))
    if ha["counts"] != hb["counts"]:
        out.append("counts %s vs %s" % (ha["counts"], hb["counts"]))
    else:
        for k in ("st_xz", "st_off", "st_h", "st_jd", "st_n", "run_start", "run_count", "run_road", "run_flags", "run_s0"):
            if not np.array_equal(a[k], b[k]):
                dd = np.abs(a[k].astype(np.float64) - b[k].astype(np.float64))
                out.append("%s: %d differ, max %.4g" % (k, int((dd > 0).sum()), dd.max()))
    if out:
        print(f, "|", "; ".join(out))

"""Lidar tile patches for the v2 world (research/lidar-tiles-plan.md): the lidar pilot's 2 m ground and
measured road ribbons as one file per 512 m tile, for every tile the SF lidar covers.

    python tools/lidar_coverage.py                 # which tiles -> CACHE/lidar_tiles/coverage.json
    python tools/bake_lidar_tiles.py pass1 [N]     # their 0.25 m lidar rasters, N tiles at a time
    python tools/bake_lidar_tiles.py [--block B] [--box=i0,j0,i1,j1 --out DIR]
        # pass 2 in blocks of B x B tiles (tools/lidar_pass2.py), the tile files and index.json, then
        # tools/lidar_bground.mjs (buildings' lidar ground). --box bakes only the coverage inside the
        # tile box, into --out (not data/v2/lidar; lidar_bground is skipped). A block's raster is
        # (B + 2)^2 tiles at 0.25 m, about 420 MB at B = 3 and a few times that at peak: keep B <= 3.

- pass 1, per tile and resumable (lidar_tiles.py): the tile's 0.25 m lidar ground raster, fetched
  from EPT (the LAZ deleted afterwards);
- pass 2, in blocks (lidar_pass2.py): tools/bake_pilot.py's grid and ribbons with stations placed
  along whole roads, per road statistics over whole roads, and each tile and station decided by one
  block, so the result does not depend on the block size;
- cut, per tile:
  - its 257 x 257 grid nodes (edge nodes shared with its neighbours; one height base for all files);
  - every ribbon segment whose quad (+1 m) meets the tile, as sub-runs of the runs, with the
    stations' normals (st_n) and each sub-run's distance from its run's start (run_s0, so lane
    markings keep their phase across a tile edge);
  - the tile's road fingerprint (lidar_tiles.tile_hash).
A patch file is laid out like a v2 tile: uint32 header length, JSON header, padding to 8 bytes, then
the arrays (header offsets count from there). src/world/v2/lidar2.js reads it.
Re-run after every tools/bake_v2.py: patches are fingerprinted to the net's roads, and the 8 m ground
they blend into at the edge of coverage comes from it.
"""
import argparse
import json
import math
import os
import re
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402

import lidar_pass2 as Q  # noqa: E402
import lidar_tiles as L  # noqa: E402
from lidar_tiles import P, TS, V  # noqa: E402

OUT = os.path.join(V.V2, "lidar")
COVERAGE = os.path.join(P.CACHE, "lidar_tiles", "coverage.json")   # tools/lidar_coverage.py
PASS1_LOG = os.path.join(P.CACHE, "lidar_tiles", "pass1.jsonl")
ATTRIBUTION = ("Ground and roads: USGS 3DEP lidar CA_SanFrancisco_1_B23 (public domain); "
               "road centrelines (c) OpenStreetMap contributors (ODbL)")


def pack(head, arrays):
    """A patch file: uint32 header length, JSON header, zero padding to 8 bytes, the arrays."""
    B = P.Bin()
    for name, (a, typ) in arrays.items():
        B.add(name, a, typ)
    data = b"".join(B.parts)
    hj = json.dumps(dict(head, arrays=B.arrays), separators=(",", ":")).encode("utf8")
    pad = (-(4 + len(hj))) % 8
    return struct.pack("<I", len(hj)) + hj + b"\0" * pad + data


def write_patches(runs, Gb, cover, out, roads):
    """The tile files from pass 2's runs and grids. Returns ({tile: hash, bytes, roads}, height base)."""
    os.makedirs(out, exist_ok=True)
    K = 7
    # one height base for every file, so a node or station in two files decodes the same in both
    hmin = min(min(float(g.min()) for g in Gb.values()), min(float(u["h"].min()) for u in runs))
    hmax = max(max(float(g.max()) for g in Gb.values()), max(float(u["h"].max()) for u in runs))
    hbase = math.floor(hmin) - 1.0
    assert hmax - hbase < 655.0, "heights exceed the uint16 cm range"
    xz = np.vstack([u["xy"] for u in runs]).astype(np.float32)
    count = np.array([len(u["xy"]) for u in runs], np.int64)
    start = np.concatenate([[0], np.cumsum(count)[:-1]]).astype(np.int64)
    q_off = np.rint(np.vstack([u["off"] for u in runs]) * 100).astype(np.int16)
    q_h = np.rint((np.vstack([u["h"] for u in runs]) - hbase) * 100).astype(np.uint16)
    q_jd = np.rint(np.clip(np.concatenate([u["jd"] for u in runs]), -300, 3000) * 10).astype(np.int16)
    road = np.array([u["road"]["i"] for u in runs], np.uint32)
    flags = np.array([int(u["info"]["A"]["curb"]) | int(u["info"]["B"]["curb"]) << 1 |
                      int(u["info"]["A"]["measured"]) << 2 | int(u["info"]["B"]["measured"]) << 3 for u in runs], np.uint8)
    nrm = L.station_normals(xz, start, count)
    along = np.zeros(len(xz))
    for s, c in zip(start.tolist(), count.tolist()):
        if c > 1:
            along[s + 1:s + c] = np.cumsum(np.hypot(*(np.diff(xz[s:s + c].astype(np.float64), axis=0).T)))
    # segment boxes as the runtime builds them (decoded offsets), + SEG_MARGIN
    offd = q_off.astype(np.float64) * 0.01
    seg_i = np.concatenate([np.arange(s, s + c - 1) for s, c in zip(start, count)])
    corners = []
    for q in (0, K - 1):
        for st in (seg_i, seg_i + 1):
            corners.append(xz[st].astype(np.float64) + nrm[st].astype(np.float64) * offd[st, q][:, None])
    C = np.stack(corners)
    smin, smax = C.min(axis=0) - L.SEG_MARGIN, C.max(axis=0) + L.SEG_MARGIN
    run_of_seg = np.repeat(np.arange(len(runs)), np.maximum(count - 1, 0))
    res = {}
    for i, j in sorted(cover):
        tx0, tz0 = i * TS, j * TS
        inside = (smax[:, 0] >= tx0) & (smin[:, 0] <= tx0 + TS) & (smax[:, 1] >= tz0) & (smin[:, 1] <= tz0 + TS)
        sub, k, sel = [], 0, np.flatnonzero(inside)
        while k < len(sel):
            a = b = sel[k]
            while k + 1 < len(sel) and sel[k + 1] == b + 1 and run_of_seg[sel[k + 1]] == run_of_seg[a]:
                k += 1
                b = sel[k]
            sub.append((int(run_of_seg[a]), int(seg_i[a]), int(seg_i[b]) + 1))
            k += 1
        lens = [e - s + 1 for _, s, e in sub]
        stn = np.concatenate([np.arange(s, e + 1) for _, s, e in sub]) if sub else np.zeros(0, np.int64)
        Gt = np.rint((Gb[(i, j)].astype(np.float64) - hbase) * 100)
        assert Gt.min() >= 0 and Gt.max() < 65535
        th, nroads = L.tile_hash(roads, i, j)
        head = {"version": 2, "tile": [i, j],
                "bbox": {"x0": tx0, "z0": tz0, "x1": tx0 + TS, "z1": tz0 + TS}, "feather": P.FEATHER,
                "grid": {"x0": tx0, "z0": tz0, "cell": P.CELL, "nx": Q.NT + 1, "nz": Q.NT + 1, "hBase": hbase},
                "knots": K, "bevel": P.BEVEL,
                "counts": {"stations": int(len(stn)), "runs": len(sub)}, "tileHash": th, "tileHashRoads": nroads}
        arrays = {
            "grid": (Gt.astype(np.uint16).ravel(), "uint16"),
            "st_xz": (xz[stn].ravel(), "float32"),
            "st_off": (q_off[stn].ravel(), "int16"),
            "st_h": (q_h[stn].ravel(), "uint16"),
            "st_jd": (q_jd[stn], "int16"),
            "st_n": (nrm[stn].ravel(), "float32"),
            "run_start": (np.concatenate([[0], np.cumsum(lens)[:-1]]).astype(np.uint32) if lens else np.zeros(0, np.uint32), "uint32"),
            "run_count": (np.array(lens, np.uint32), "uint32"),
            "run_road": (road[[r for r, _, _ in sub]], "uint32"),
            "run_flags": (flags[[r for r, _, _ in sub]], "uint8"),
            "run_s0": (along[[s for _, s, _ in sub]].astype(np.float32) if sub else np.zeros(0, np.float32), "float32"),
        }
        data = pack(head, arrays)
        with open(os.path.join(out, "%d_%d.bin.wasm" % (i, j)), "wb") as f:
            f.write(data)
        res[(i, j)] = dict(hash=th, bytes=len(data), roads=sorted(set(road[[r for r, _, _ in sub]].tolist())))
    return res, hbase


def load_cover(box=None):
    with open(COVERAGE, encoding="utf8") as f:
        tiles = [(i, j) for i, j, _ in json.load(f)["tiles"]]
    if box:
        i0, j0, i1, j1 = box
        tiles = [(i, j) for i, j in tiles if i0 <= i <= i1 and j0 <= j <= j1]
    missing = [t for t in tiles if not os.path.exists(os.path.join(L.R025, "%d_%d.npz" % t))]
    if missing:
        raise SystemExit("%d of %d tiles have no raster yet (run: python tools/bake_lidar_tiles.py pass1): %s"
                         % (len(missing), len(tiles), missing[:8]))
    return tiles


def overpass_boxes(cover):
    """Boxes in which OSM bridges become decks pinned to the lidar ground (baybridge_v2.lidar_ground,
    bake_v2.py): every covered tile, as runs of tiles along each row. The patches draw no
    bridge-flagged road (lidar_pass2.build_runs), and their 2 m ground under one is the cut or street
    it crosses (Beale St under Harrison St, the I-280 cut): draped over it, the bridge would dip into
    it. As a deck it spans between its ends, pinned to the ground there. Elevated freeways stay near
    the ground, as on the 8 m ground, until their decks are measured (tools/probes/bridge_profile.py
    measures the Bay Bridge's)."""
    boxes = []
    for j in sorted({j for _, j in cover}):
        row = sorted(i for i, jj in cover if jj == j)
        a = row[0]
        for p, q in zip(row, row[1:] + [None]):
            if q != p + 1:
                boxes.append([a * TS, j * TS, (p + 1) * TS, (j + 1) * TS])
                a = q
    return boxes


def main(block=3, box=None, out=OUT):
    L.setup_v2()
    t0 = time.perf_counter()
    cover = load_cover(box)
    with open(os.path.join(V.V2, "net.json"), encoding="utf8") as f:
        lakes = json.load(f)["lakes"]
    stats = {"block": block, "tiles": len(cover)}
    runs, Gb, W = Q.bake(set(cover), block, lakes, stats)
    res, hbase = write_patches(runs, Gb, cover, out, L.net_roads())
    # patch files of tiles no longer covered
    for f in os.listdir(out):
        m = re.fullmatch(r"(-?\d+)_(-?\d+)\.bin\.wasm", f)
        if m and (int(m.group(1)), int(m.group(2))) not in res:
            os.remove(os.path.join(out, f))
    stats["bytes"] = sum(r["bytes"] for r in res.values())
    stats["bake_s"] = round(time.perf_counter() - t0, 1)
    index = {"version": 2, "tile": TS, "feather": P.FEATHER, "hBase": hbase,
             "cover": [[i, j, r["hash"]] for (i, j), r in sorted(res.items())],
             "coveredRoads": sorted({k for r in res.values() for k in r["roads"]}),
             "world": {"roads": len(W["roads"]), "buildings": len(W["buildings"]), "roadsHash": W["roads_hash"]},
             "attribution": ATTRIBUTION, "overpassBoxes": overpass_boxes(cover), "stats": stats}
    with open(os.path.join(out, "index.json"), "w", encoding="utf8") as f:
        json.dump(index, f, indent=1)
    P.log("wrote %d patches (%.1f MB) to %s: %s, pits %s" % (len(res), stats["bytes"] / 1e6, out, json.dumps(stats["ribbons"]), json.dumps(stats["pits"])))
    if os.path.abspath(out) == os.path.abspath(OUT):
        r = subprocess.run(["node", os.path.join(HERE, "lidar_bground.mjs")], cwd=P.ROOT, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.returncode:
            raise RuntimeError("lidar_bground.mjs failed: " + r.stderr[-3000:])


def _pass1_one(t, tries=3):
    """pass1_fetch with retries (S3 reads fail now and then under load); a tile that fails every
    time is reported and left for the next run."""
    for k in range(tries):
        try:
            res = L.pass1_fetch(*t)
            if k:
                res["tries"] = k + 1
            return res
        except Exception as e:
            err = "%s: %s" % (type(e).__name__, str(e)[-600:])
            if k + 1 < tries:
                time.sleep(15 * 3 ** k)
    return dict(tile=list(t), error=err, tries=tries)


def pass1_all(workers=1):
    """Pass 1 for every tile of coverage.json, `workers` tiles at a time (resumable: tiles with a
    raster are skipped; each worker deletes only its own tile's LAZ)."""
    from multiprocessing import Pool
    with open(COVERAGE, encoding="utf8") as f:
        tiles = [(i, j) for i, j, _ in json.load(f)["tiles"]]
    todo = [t for t in tiles if not os.path.exists(os.path.join(L.R025, "%d_%d.npz" % t))]
    P.log("pass 1: %d of %d tiles to fetch, %d at a time" % (len(todo), len(tiles), workers))
    t0, done, failed = time.perf_counter(), 0, 0
    with Pool(workers, initializer=L.setup_v2) as pool, open(PASS1_LOG, "a", encoding="utf8") as log_f:
        for res in pool.imap_unordered(_pass1_one, todo):
            done += 1
            failed += "error" in res
            print(json.dumps(res), file=log_f)
            log_f.flush()
            el = time.perf_counter() - t0
            P.log("pass 1: %d/%d (%d failed), %.0f s per tile, %.0f min to go" % (
                done, len(todo), failed, el / done, el / done * (len(todo) - done) / 60))
    return failed


if __name__ == "__main__":
    if sys.argv[1:2] == ["pass1"]:
        sys.exit(1 if pass1_all(int(sys.argv[2]) if len(sys.argv) > 2 else 1) else 0)
    ap = argparse.ArgumentParser()
    ap.add_argument("--block", type=int, default=3)
    ap.add_argument("--box", type=lambda s: [int(v) for v in s.split(",")], default=None)
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    if a.box and os.path.abspath(a.out) == os.path.abspath(OUT):
        ap.error("--box bakes part of the coverage: give it an --out folder (data/v2/lidar holds every tile)")
    main(a.block, a.box, a.out)

"""Spike for tools/research/lidar-tiles-plan.md: one lidar patch per 512 m tile, cut from one bake.

    python tools/spike_lidar_tiles.py          # then: node tools/test_lidar_spike.mjs

Each island is a rectangle of tiles, baked by tools/bake_pilot.py unchanged as one pilot box (pass 2),
then cut into one patch per tile:
- A: 2 x 2 tiles inside the old pilot box (Nob Hill, Chinatown, Union Square). Its 0.25 m lidar raster
  is a slice of the v2 pilot's cached raster (the same points, binned on the same grid).
- B: the Painted Ladies tile, outside the old box. Pass 1 runs for real: EPT fetch of the tile, the
  0.25 m ground raster kept as int16 cm, the LAZ deleted.
- C (reference, not cut): the 3 x 2 tiles around A inside the old box, baked whole the same way.
Every bake fills nodes without ground with bake_pilot.FILL_JITTER on, so a fill is local.
Writes data/v2/lidar_spike/: island_<id>.json/.bin.wasm (the reference: one box, as today's pilot,
plus stored station normals) and <i>_<j>.json/.bin.wasm per tile (the same format, cut), and
spike.json with sizes and timings.

A patch keeps:
- its tile's 257 x 257 grid nodes, sharing edge nodes with its neighbours (raw uint16 values and the
  island's hBase, so a shared node decodes identically in both files);
- every ribbon segment whose quad (+1 m) meets the tile, as sub-runs of the island's runs, with
  the stations' normals stored (`st_n`): at a cut, the normal still comes from the neighbours the
  island run had;
- `cover`: the island's tiles, for the blend into the 8 m ground at the outer edge of coverage;
- `tileHash`: FNV-1a over the net roads that meet the tile +-32 m (index, then float32 coordinates as
  uint16), so a re-baked net refuses only the patches whose roads changed.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "probes"))
import numpy as np  # noqa: E402

import bake_pilot_v2 as V  # noqa: E402   (installs nothing; V.main() does the overrides we repeat below)
import geo2  # noqa: E402

from lidar_tiles import (P, SEG_MARGIN, TS, island_box, island_raster, net_roads, pass1_fetch, pass1_from_pilot,  # noqa: E402
                         read_pilot, station_normals, tile_hash, write_pilot)

OUT = os.path.join(V.V2, "lidar_spike")
ISLANDS = {"A": [(-1, -2), (0, -2), (-1, -1), (0, -1)], "B": [(-5, 2)]}
# the largest box of whole tiles inside the old pilot box, baked whole: island A's interior must come
# out as it does there (not cut; a reference only)
REFERENCE = {"C": [(i, j) for j in (-2, -1) for i in (-1, 0, 1)]}


# ------------------------------------------------------------------------------------- pass 1


# ------------------------------------------------------------------------------------- pass 2
def bake_island(name, tiles):
    box = island_box(tiles)
    raster = island_raster(tiles, box)
    P.BBOX = box
    V.V2_BBOX = box                           # load_world_v2 reads the tiles around this box
    P.OUT_JSON = os.path.join(OUT, "island_%s.json" % name)
    P.OUT_BIN = os.path.join(OUT, "island_%s.bin.wasm" % name)

    def gr(stats):
        stats["lidar"] = {"project": P.PROJECT, "source": "lidar_tiles/r025 (int16 cm)", "datum": "NAVD88 - %.3f" % geo2.Y0,
                          "ground_cells_frac": round(float(np.isfinite(raster).mean()), 3)}
        return raster
    P.ground_raster = gr
    t0 = time.perf_counter()
    P.main()
    return box, round(time.perf_counter() - t0, 1)


# ---------------------------------------------------------------------------------------- cut


def cut_island(name, tiles, roads):
    pj, pb = os.path.join(OUT, "island_%s.json" % name), os.path.join(OUT, "island_%s.bin.wasm" % name)
    idx, A = read_pilot(pj, pb)
    K = idx["knots"]
    g = idx["grid"]
    G = A["grid"].reshape(g["nz"], g["nx"])
    xz = A["st_xz"].reshape(-1, 2)
    off = A["st_off"].reshape(-1, K).astype(np.float64) * 0.01
    start, count = A["run_start"].astype(np.int64), A["run_count"].astype(np.int64)
    nrm = station_normals(xz, start, count)
    cover = [list(t) for t in tiles]
    # the reference: the island as one box, with the same stored normals
    base_arrays = {k: (A[k], idx["arrays"][k]["type"]) for k in idx["arrays"]}
    write_pilot(pj, pb, dict(idx, cover=cover), dict(base_arrays, st_n=(nrm.ravel(), "float32")))
    # segment boxes (stations i -> i + 1 inside a run), as pilot.js, plus SEG_MARGIN
    seg_i = np.concatenate([np.arange(s, s + c - 1) for s, c in zip(start, count)]) if len(start) else np.zeros(0, int)
    corners = []
    for q in (0, K - 1):
        for st in (seg_i, seg_i + 1):
            corners.append(xz[st].astype(np.float64) + nrm[st].astype(np.float64) * off[st, q][:, None])
    C = np.stack(corners)                                  # (4, nseg, 2)
    smin, smax = C.min(axis=0) - SEG_MARGIN, C.max(axis=0) + SEG_MARGIN
    run_of_seg = np.repeat(np.arange(len(start)), np.maximum(count - 1, 0))
    out = []
    for i, j in tiles:
        tx0, tz0 = i * TS, j * TS
        inside = (smax[:, 0] >= tx0) & (smin[:, 0] <= tx0 + TS) & (smax[:, 1] >= tz0) & (smin[:, 1] <= tz0 + TS)
        # maximal consecutive included segments of one run -> a sub-run of stations [a, b + 1]
        sub = []
        k = 0
        sel = np.flatnonzero(inside)
        while k < len(sel):
            a = sel[k]
            b = a
            while k + 1 < len(sel) and sel[k + 1] == b + 1 and run_of_seg[sel[k + 1]] == run_of_seg[a]:
                k += 1
                b = sel[k]
            sub.append((run_of_seg[a], int(seg_i[a]), int(seg_i[b]) + 1))
            k += 1
        stn = np.concatenate([np.arange(s, e + 1) for _, s, e in sub]) if sub else np.zeros(0, np.int64)
        gi0, gj0 = int((tx0 - g["x0"]) / g["cell"]), int((tz0 - g["z0"]) / g["cell"])
        n = int(TS / g["cell"])
        Gt = G[gj0:gj0 + n + 1, gi0:gi0 + n + 1]
        assert Gt.shape == (n + 1, n + 1)
        lens = [e - s + 1 for _, s, e in sub]
        th, nroads = tile_hash(roads, i, j)
        pidx = dict(idx, bbox={"x0": tx0, "z0": tz0, "x1": tx0 + TS, "z1": tz0 + TS},
                    grid=dict(g, x0=tx0, z0=tz0, nx=n + 1, nz=n + 1),
                    counts={"stations": int(len(stn)), "runs": len(sub)},
                    tile=[i, j], cover=cover, island=name, tileHash=th, tileHashRoads=nroads, stats={"island": name})
        arrays = {
            "grid": (Gt.ravel(), "uint16"),
            "st_xz": (xz[stn].ravel(), "float32"),
            "st_off": (A["st_off"].reshape(-1, K)[stn].ravel(), "int16"),
            "st_h": (A["st_h"].reshape(-1, K)[stn].ravel(), "uint16"),
            "st_jd": (A["st_jd"][stn], "int16"),
            "st_n": (nrm[stn].ravel(), "float32"),
            "run_start": (np.concatenate([[0], np.cumsum(lens)[:-1]]).astype(np.uint32) if lens else np.zeros(0, np.uint32), "uint32"),
            "run_count": (np.array(lens, np.uint32), "uint32"),
            "run_road": (A["run_road"][[r for r, _, _ in sub]], "uint32"),
            "run_flags": (A["run_flags"][[r for r, _, _ in sub]], "uint8"),
        }
        raw, gz = write_pilot(os.path.join(OUT, "%d_%d.json" % (i, j)), os.path.join(OUT, "%d_%d.bin.wasm" % (i, j)), pidx, arrays)
        out.append(dict(tile=[i, j], stations=int(len(stn)), runs=len(sub), segments=int(inside.sum()),
                        bin_raw=raw, bin_gzip=gz, tile_hash_roads=nroads))
    return dict(island=name, stations=int(len(xz)), segments=int(len(seg_i)), tiles=out,
                stations_in_patches=sum(t["stations"] for t in out),
                segments_in_patches=sum(t["segments"] for t in out))


def main():
    os.makedirs(OUT, exist_ok=True)
    P.proj = lambda lat, lon: geo2.proj_arr(lat, lon)
    P.unproj = lambda x, z: geo2.unproj(np.asarray(x, float), np.asarray(z, float))
    P.load_world = V.load_world_v2
    P.FILL_JITTER = True
    report = {"islands": {}, "references": {}, "pass1": []}
    t0 = time.perf_counter()
    report["pass1"] += pass1_from_pilot(REFERENCE["C"])         # A's tiles are among C's
    report["pass1"].append(pass1_fetch(*ISLANDS["B"][0]))
    P.log("pass 1", json.dumps(report["pass1"]))
    roads = net_roads()
    for name, tiles in ISLANDS.items():
        box, s = bake_island(name, tiles)
        cut = cut_island(name, tiles, roads)
        cut.update(box=list(box), bake_s=s)
        with open(os.path.join(OUT, "island_%s.json" % name), encoding="utf8") as f:
            cut["island_stats"] = json.load(f)["stats"]
        report["islands"][name] = cut
        P.log("island", name, json.dumps({k: v for k, v in cut.items() if k != "island_stats"}))
    for name, tiles in REFERENCE.items():
        box, s = bake_island(name, tiles)
        report["references"][name] = dict(box=list(box), tiles=[list(t) for t in tiles], bake_s=s)
    report["total_s"] = round(time.perf_counter() - t0, 1)
    with open(os.path.join(OUT, "spike.json"), "w", encoding="utf8") as f:
        json.dump(report, f, indent=1)
    P.log("wrote", os.path.join(OUT, "spike.json"))


if __name__ == "__main__":
    main()

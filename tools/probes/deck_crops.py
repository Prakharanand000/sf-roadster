"""Task 2: class-17 (bridge deck) crops: Bay Bridge SF approach, I-280 viaduct, MacArthur Maze.

Per structure: class histogram, Z ranges (class 17 vs others), a top-down 0.5 m raster
coloured by the class of the highest non-withheld point per cell, and a 6 m-wide
cross-section slab perpendicular to the structure (X = across, Y = Z).
Usage: python deck_crops.py [all | bay_bridge | i280 | maze]
Optional tools/research/probes/deck_config.json overrides slab centre/axis per structure
(keys bay_bridge / i280 / maze, each {centre:[x,y], u:[ux,uy], half_across:m}).
"""
import json
import math
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import common as C

OUTDIR = os.path.join(HERE, "..", "research", "probes")
OSM = os.path.join(C.CACHE, "osm", "bay_p12.osm.pbf")
WORK = os.path.join(C.CACHE, "osm", "probe_i280")
SF, A2, A3 = "CA_SanFrancisco_1_B23", "CA_AlamedaCo_2_2021", "CA_AlamedaCo_3_2021"
STACK_DIST = 4.0
SLAB_W = 6.0

COLORS = {1: "#9e9e9e", 2: "#8d6e63", 3: "#a5d6a7", 4: "#43a047", 5: "#1b5e20", 6: "#ffb300",
          7: "#e91e63", 9: "#1e88e5", 17: "#e53935", 18: "#ff9800"}
NAMES = {1: "1 unclassified", 2: "2 ground", 7: "7 low noise", 9: "9 water", 17: "17 bridge deck",
         18: "18 high noise"}
OTHER = "#000000"


def osmium(*args):
    r = subprocess.run([C.OSMIUM, *args], env=C._tool_env(), capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("osmium failed: " + r.stderr[-1500:])


def find_i280_stack():
    os.makedirs(WORK, exist_ok=True)
    mw, i280, gj = (os.path.join(WORK, n) for n in ("mw.osm.pbf", "i280.osm.pbf", "i280.geojson"))
    osmium("tags-filter", OSM, "w/highway=motorway", "-o", mw, "--overwrite")
    osmium("tags-filter", mw, "w/ref=I 280", "w/ref=I-280", "-o", i280, "--overwrite")
    osmium("export", i280, "-f", "geojson", "--add-unique-id=type_id", "-o", gj, "--overwrite")
    ways = []
    for f in json.load(open(gj))["features"]:
        if f["geometry"]["type"] != "LineString":
            continue
        p = f["properties"]
        xy = np.array([C.ll_to_sft1(lat, lon) for lon, lat in f["geometry"]["coordinates"]])
        ways.append({"id": str(f.get("id")), "layer": p.get("layer"), "name": p.get("name"), "xy": xy})

    def densify(xy, step=2.0):
        out = []
        for a, b in zip(xy[:-1], xy[1:]):
            n = max(1, int(np.hypot(*(b - a)) / step))
            out.append(a + (b - a) * (np.arange(n)[:, None] / n))
        out.append(xy[-1:])
        return np.vstack(out)

    def dist_to_poly(pts, poly):
        best = np.full(len(pts), np.inf)
        for a, b in zip(poly[:-1], poly[1:]):
            ab = b - a
            t = np.clip(((pts - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
            best = np.minimum(best, np.hypot(*(pts - (a + t[:, None] * ab)).T))
        return best

    cands = []
    for i, a in enumerate(ways):
        for j, b in enumerate(ways):
            if i == j or a["layer"] == b["layer"] or a["layer"] is None or b["layer"] is None:
                continue
            pa = densify(a["xy"])
            idx = np.flatnonzero(dist_to_poly(pa, b["xy"]) < STACK_DIST)
            if idx.size == 0:
                continue
            for run in np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1):
                if run.size < 2:
                    continue
                seg = pa[run]
                length = float(np.hypot(*np.diff(seg, axis=0).T).sum())
                cands.append({"a": a["id"], "a_layer": a["layer"], "b": b["id"], "b_layer": b["layer"],
                              "length_m": round(length, 1), "pts": seg})
    cands.sort(key=lambda c: -c["length_m"])
    return cands, ways


def load_box(project, x0, y0, x1, y1):
    pts, st = C.read_ept(project, C.bounds_3857_from_sft1(x0, y0, x1, y1))
    m = (pts["X"] >= x0) & (pts["X"] <= x1) & (pts["Y"] >= y0) & (pts["Y"] <= y1)
    return C.subset(pts, m), st


def zstats(z):
    if z.size == 0:
        return None
    return {"n": int(z.size), "min": round(float(z.min()), 2), "p1": round(float(np.percentile(z, 1)), 2),
            "median": round(float(np.median(z)), 2), "p99": round(float(np.percentile(z, 99)), 2),
            "max": round(float(z.max()), 2)}


def legend(ax, classes):
    h = [Line2D([0], [0], marker="s", ls="", color=COLORS.get(c, OTHER), label=NAMES.get(c, str(c)))
         for c in sorted(classes)]
    ax.legend(handles=h, loc="upper right", fontsize=8, framealpha=0.9)


def topdown(pts, box, title, path, slab=None):
    x0, y0, x1, y1 = box
    nw = ~pts["Withheld"]
    X, Y, Z, K = pts["X"][nw], pts["Y"][nw], pts["Z"][nw], pts["Classification"][nw]
    nx, ny = int(math.ceil((x1 - x0) / 0.5)), int(math.ceil((y1 - y0) / 0.5))
    ix = np.clip(((X - x0) / 0.5).astype(int), 0, nx - 1)
    iy = np.clip(((Y - y0) / 0.5).astype(int), 0, ny - 1)
    flat = iy * nx + ix
    order = np.lexsort((Z, flat))  # per cell ascending Z; last = highest
    fs, ks = flat[order], K[order]
    last = np.r_[fs[1:] != fs[:-1], True]
    grid = np.full(nx * ny, 255, np.uint8)
    grid[fs[last]] = ks[last]
    grid = grid.reshape(ny, nx)
    img = np.full((ny, nx, 3), 255, np.uint8)
    present = [int(c) for c in np.unique(grid) if c != 255]
    for c in present:
        h = COLORS.get(c, OTHER).lstrip("#")
        img[grid == c] = [int(h[i:i + 2], 16) for i in (0, 2, 4)]
    fig, ax = plt.subplots(figsize=(11, 11 * ny / nx + 0.8), dpi=110)
    ax.imshow(img[::-1], extent=(0, x1 - x0, 0, y1 - y0), interpolation="nearest")
    if slab:
        c, u, v, hw = slab["centre"], slab["u"], slab["v"], slab["half_across"]
        cc = np.array([c[0] - x0, c[1] - y0])
        quad = np.array([cc - v * hw - u * SLAB_W / 2, cc + v * hw - u * SLAB_W / 2,
                         cc + v * hw + u * SLAB_W / 2, cc - v * hw + u * SLAB_W / 2,
                         cc - v * hw - u * SLAB_W / 2])
        ax.plot(quad[:, 0], quad[:, 1], "c-", lw=1.5)
    ax.set_title(title + "  (cell = class of highest non-withheld point, 0.5 m; cyan = section slab)",
                 fontsize=9)
    ax.set_xlabel("east from box SW corner (m, SFT1)")
    ax.set_ylabel("north (m)")
    legend(ax, present)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return {"present_classes_in_raster": present, "cells": [nx, ny]}


def section(pts, slab, title, path):
    c, u, v, hw = slab["centre"], slab["u"], slab["v"], slab["half_across"]
    d = np.c_[pts["X"] - c[0], pts["Y"] - c[1]]
    along, across = d @ u, d @ v
    m = (np.abs(along) <= SLAB_W / 2) & (np.abs(across) <= hw) & ~pts["Withheld"]
    a, z, k = across[m], pts["Z"][m], pts["Classification"][m]
    fig, ax = plt.subplots(figsize=(12, 6), dpi=110)
    present = [int(q) for q in np.unique(k)]
    for q in sorted(present, key=lambda q: q == 17):  # draw 17 last
        s = k == q
        ax.scatter(a[s], z[s], s=2, c=COLORS.get(q, OTHER), linewidths=0)
    ax.set_title(title + f"  ({SLAB_W:.0f} m slab, n={int(m.sum())})", fontsize=10)
    ax.set_xlabel("distance across structure (m)")
    ax.set_ylabel("Z NAVD88 (m)")
    ax.grid(alpha=.3)
    legend(ax, present)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    bins = []
    for b0 in np.arange(-hw, hw, 4.0):
        s = (a >= b0) & (a < b0 + 4.0)
        if s.sum() < 5:
            continue
        zz, kk = z[s], k[s]
        o = np.argsort(zz)
        zz, kk = zz[o], kk[o]
        cuts = np.flatnonzero(np.diff(zz) > 1.5) + 1
        cl = []
        for zs, ks in zip(np.split(zz, cuts), np.split(kk, cuts)):
            if zs.size >= 5:
                cl.append({"z": [round(float(zs.min()), 1), round(float(zs.max()), 1)], "n": int(zs.size),
                           "classes": {int(q): int((ks == q).sum()) for q in np.unique(ks)}})
        bins.append({"across_m": [float(b0), float(b0 + 4)], "z_clusters": cl})
    return {"slab_points": int(m.sum()), "slab_classes": C.class_histogram({"Classification": k}),
            "slab_z_clusters_by_4m_across_bin": bins}


def analyse(key, project, title, box, axis, half_across, out):
    x0, y0, x1, y1 = box
    pts, st = load_box(project, x0, y0, x1, y1)
    nw = ~pts["Withheld"]
    k = pts["Classification"]
    rec = {"structure": title, "project": project, "n_points": int(pts["Z"].size),
           "class_counts": C.class_histogram(pts), "withheld": int((~nw).sum()),
           "z_class17_nonwithheld": zstats(pts["Z"][nw & (k == 17)]),
           "z_other_nonwithheld": zstats(pts["Z"][nw & (k != 17)]),
           "z_by_class_nonwithheld": {int(c): zstats(pts["Z"][nw & (k == c)]) for c in np.unique(k)},
           "box_sft1": [round(float(v), 1) for v in box]}
    if axis is None:
        s = nw & (k == 17)
        xy = np.c_[pts["X"][s], pts["Y"][s]]
        w, V = np.linalg.eigh(np.cov(xy.T))
        u = V[:, 1]
        centre = xy.mean(0)
        rec["axis_from"] = "PCA of class-17 xy"
    else:
        centre, u = axis
        u = np.asarray(u, float)
        u = u / np.hypot(*u)
        rec["axis_from"] = "supplied"
    v = np.array([-u[1], u[0]])
    rec["slab_centre_sft1"] = [round(float(centre[0]), 1), round(float(centre[1]), 1)]
    rec["slab_axis_u"] = [round(float(u[0]), 4), round(float(u[1]), 4)]
    rec["axis_bearing_deg_from_north"] = round(float(np.degrees(np.arctan2(u[0], u[1])) % 180), 1)
    slab = {"centre": np.asarray(centre), "u": u, "v": v, "half_across": half_across}
    rec["raster"] = topdown(pts, box, title, os.path.join(OUTDIR, f"deck_{key}_topdown.png"), slab)
    rec["section"] = section(pts, slab, title, os.path.join(OUTDIR, f"deck_{key}_section.png"))
    rec["pngs"] = [f"deck_{key}_topdown.png", f"deck_{key}_section.png"]
    out[key] = rec
    print(key, rec["n_points"], rec["class_counts"], "z17", rec["z_class17_nonwithheld"])
    return rec


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    jpath = os.path.join(OUTDIR, "deck_crops.json")
    out = json.load(open(jpath)) if os.path.exists(jpath) else {}
    cfg_path = os.path.join(OUTDIR, "deck_config.json")
    cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
    which = sys.argv[1] if len(sys.argv) > 1 else "all"

    def ax_of(key):
        c = cfg.get(key)
        return ((c["centre"], c["u"]), c["half_across"]) if c else (None, 40)

    if which in ("all", "bay_bridge"):
        a = C.ll_to_sft1(37.7840, -122.3960)
        b = C.ll_to_sft1(37.7900, -122.3860)
        box = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
        axis, hw = ax_of("bay_bridge")
        analyse("bay_bridge", SF, "Bay Bridge SF approach (B23)", box, axis, hw, out)

    if which in ("all", "i280"):
        cands, ways = find_i280_stack()
        srch = {"ways_considered": len(ways),
                "top_candidates": [{k: v for k, v in c.items() if k != "pts"} for c in cands[:8]]}
        print(json.dumps(srch, indent=1))
        out["i280_stack_search"] = srch
        if cands:
            best = cands[0]
            seg = best["pts"]
            mid = len(seg) // 2
            c0 = seg[mid]
            lo, hi = max(0, mid - 75), min(len(seg) - 1, mid + 75)  # 2 m spacing -> ~300 m
            u = (seg[hi] - seg[lo]) / np.hypot(*(seg[hi] - seg[lo]))
            ends = seg[[lo, hi]]
            pad = 40.0
            box = (ends[:, 0].min() - pad, ends[:, 1].min() - pad, ends[:, 0].max() + pad, ends[:, 1].max() + pad)
            llc = C.sft1_to_ll(*c0)
            srch["chosen"] = {"a_way": best["a"], "b_way": best["b"],
                              "layers": [best["a_layer"], best["b_layer"]], "stack_length_m": best["length_m"],
                              "crop_length_m": round(float(np.hypot(*(ends[1] - ends[0]))), 1),
                              "centre_latlon": [round(llc[0], 6), round(llc[1], 6)],
                              "crop_ends_latlon": [[round(v, 6) for v in C.sft1_to_ll(*e)] for e in ends]}
            axis, hw = ax_of("i280")
            analyse("i280", SF, "I-280 stacked viaduct (B23)", box, axis or (c0, u), hw, out)
            if "i280_ne" in cfg:  # second slab where the lower deck also carries class 17
                axis2, hw2 = ax_of("i280_ne")
                analyse("i280_ne", SF, "I-280 stacked viaduct, NE slab (B23)", box, axis2, hw2, out)

    if which in ("all", "maze"):
        cx, cy = C.ll_to_sft1(37.8270, -122.2950)
        box = (cx - 150, cy - 150, cx + 150, cy + 150)
        axis, hw = ax_of("maze")
        analyse("maze", A2, "MacArthur Maze (Alameda 2019 QL1)", box, axis, hw, out)

    with open(jpath, "w") as f:
        json.dump(out, f, indent=1)


main()

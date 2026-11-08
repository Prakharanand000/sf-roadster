"""One-tile bake benchmark: Nob Hill SFT1 L0 tile (tile-format-proposal.md 2.1-2.3, 2.10).

Run:  <venv>\\Scripts\\python.exe tools/probes/tile_benchmark.py
Writes tools/research/probes/tile_benchmark.json and three PNGs.
Measures fetch, DTM (2 m physics grid and 0.5 m), DSM (0.5 m), encode size,
sanity vs Terrarium z14, and projects to Phases 1+2.
"""
import gzip
import json
import math
import os
import sys
import time

import numpy as np
from scipy.interpolate import griddata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "tools", "research", "probes")
DEM = os.path.join(ROOT, "tools", "cache", "dem")
os.makedirs(OUT, exist_ok=True)

PROJECT = "CA_SanFrancisco_1_B23"
LAT, LON = 37.7930, -122.4140
TS = 512.0
MARGIN = 4.0          # metres of points kept beyond the tile edge (apron 2 m + cell/radius)
NOISE = (7, 18)

R = {}                # results
T = {}                # stage wall-clock seconds


def tick():
    return time.perf_counter()


# ---------------------------------------------------------------- tile
ex, ny = common.ll_to_sft1(LAT, LON)
x_e, z_e = ex, -ny
I, J = math.floor(x_e / TS), math.floor(z_e / TS)
X0, X1 = I * TS, (I + 1) * TS            # easting range
Z0, Z1 = J * TS, (J + 1) * TS            # z = -northing range
Y0, Y1 = -Z1, -Z0                        # northing range
cx, cy = (X0 + X1) / 2, (Y0 + Y1) / 2
clat, clon = common.sft1_to_ll(cx, cy)
R["tile"] = {"i": I, "j": J, "x_range": [X0, X1], "z_range": [Z0, Z1],
             "easting_range": [X0, X1], "northing_range": [Y0, Y1],
             "centre_lat_lon": [clat, clon], "query_point_sft1": [ex, ny], "project": PROJECT}
print("tile", I, J, "E", X0, X1, "N", Y0, Y1, "centre", clat, clon)

# ---------------------------------------------------------------- 1. fetch (4 quadrants)
bx = [X0 - MARGIN, (X0 + X1) / 2, X1 + MARGIN]
by = [Y0 - MARGIN, (Y0 + Y1) / 2, Y1 + MARGIN]
parts = []
fetch_s = load_s = 0.0
laz_bytes = 0
raw_points = 0
cached_all = True
ground_x, ground_y, ground_z = [], [], []
cls_hist = {}
withheld_n = 0
kept_n = 0
dsm_hits = []   # (flat idx, z) chunks for DSM

DSM_RES = 0.5
ND = int(TS / DSM_RES)
dsm = np.full((ND, ND), -np.inf, dtype=np.float32)

t_all = tick()
t_agg = 0.0
for qy in range(2):
    for qx in range(2):
        qb = (bx[qx], by[qy], bx[qx + 1], by[qy + 1])
        bounds = common.bounds_3857_from_sft1(*qb)
        pts, st = common.read_ept(PROJECT, bounds)
        cached_all &= st["cached"]
        fetch_s += st.get("fetch_s", 0.0)
        load_s += st["load_s"]
        laz_bytes += st["laz_bytes"]
        raw_points += st["points"]
        t0 = tick()
        x, y, z = pts["X"], pts["Y"], pts["Z"]
        lox, hix = qb[0], qb[2]
        loy, hiy = qb[1], qb[3]
        m = (x >= lox) & (x < hix) & (y >= loy) & (y < hiy)   # de-duplicate quadrant overlap
        for k in pts:
            pts[k] = pts[k][m]
        x, y, z = pts["X"], pts["Y"], pts["Z"]
        c, w = pts["Classification"], pts["Withheld"]
        kept_n += int(z.size)
        withheld_n += int(w.sum())
        for k, n in common.class_histogram(pts).items():
            cls_hist[k] = cls_hist.get(k, 0) + n
        g = (c == 2) & ~w
        ground_x.append(x[g].astype(np.float64)); ground_y.append(y[g].astype(np.float64))
        ground_z.append(z[g].astype(np.float32))
        # DSM: max z, non-withheld, not noise, inside the tile proper
        s = ~w & ~np.isin(c, NOISE) & (x >= X0) & (x < X1) & (y >= Y0) & (y < Y1)
        ci = np.floor((x[s] - X0) / DSM_RES).astype(np.int64)
        ri = np.floor((Y1 - y[s]) / DSM_RES).astype(np.int64)   # row 0 = north
        flat = ri * ND + ci
        zz = z[s].astype(np.float32)
        o = np.argsort(zz, kind="stable")
        tmp = np.full(ND * ND, -np.inf, dtype=np.float32)
        tmp[flat[o]] = zz[o]          # ascending z, last write wins = max
        np.maximum(dsm.reshape(-1), tmp, out=dsm.reshape(-1))
        del pts, x, y, z, c, w, m, s, flat, zz, o, tmp
        t_agg += tick() - t0
        print("quadrant", qx, qy, "done", st.get("fetch_s"), st["points"])

R["fetch"] = {
    "points_loaded_incl_quadrant_overlap": raw_points,
    "points_in_tile_plus_4m_margin": kept_n,
    "laz_bytes_total": laz_bytes, "laz_mb": round(laz_bytes / 1e6, 2),
    "fetch_s": round(fetch_s, 2), "load_s": round(load_s, 2),
    "fetch_was_cached": cached_all, "quadrants": 4,
    "class_histogram": {str(k): v for k, v in sorted(cls_hist.items())},
    "withheld_count": withheld_n,
    "ground_points_class2_not_withheld": int(sum(a.size for a in ground_x)),
}
T["fetch_s"] = fetch_s
T["load_s"] = load_s
T["split_dsm_accumulate_s"] = t_agg
if cached_all:
    print("NOTE: all quadrants came from cache; fetch_s is not a download time")

gx = np.concatenate(ground_x); gy = np.concatenate(ground_y); gz = np.concatenate(ground_z)
del ground_x, ground_y, ground_z


# ---------------------------------------------------------------- 2. DTM
def cell_median_grid(px, py, pz, ox, oy, step, n, row_axis_y_up=False):
    """Median ground z in step-sized cells centred on samples; returns (n, n) grid, NaN where empty.

    Sample (r, c) is at easting ox + c*step, northing oy + r*step (r=0 south).
    A point is in the cell whose centre is nearest (round)."""
    ci = np.floor((px - ox) / step + 0.5).astype(np.int64)
    ri = np.floor((py - oy) / step + 0.5).astype(np.int64)
    ok = (ci >= 0) & (ci < n) & (ri >= 0) & (ri < n)
    flat = ri[ok] * n + ci[ok]
    z = pz[ok]
    o = np.lexsort((z, flat))
    flat, z = flat[o], z[o]
    uniq, start, cnt = np.unique(flat, return_index=True, return_counts=True)
    med = z[start + (cnt - 1) // 2]
    g = np.full(n * n, np.nan, dtype=np.float32)
    g[uniq] = med
    return g.reshape(n, n), cnt


def fill(g):
    """Linear griddata into holes, nearest for whatever the hull misses."""
    holes = np.isnan(g)
    if not holes.any():
        return g.copy()
    rr, cc = np.nonzero(~holes)
    hr, hc = np.nonzero(holes)
    out = g.copy()
    v = griddata((rr, cc), g[~holes], (hr, hc), method="linear")
    still = np.isnan(v)
    if still.any():
        v[still] = griddata((rr, cc), g[~holes], (hr[still], hc[still]), method="nearest")
    out[hr, hc] = v
    return out


t0 = tick()
N2 = 259
# samples: easting X0-2 .. X1+2 step 2 ; northing Y0-2 .. Y1+2 step 2 (r=0 south)
raw2, cnt2 = cell_median_grid(gx, gy, gz, X0 - 2.0, Y0 - 2.0, 2.0, N2)
hole2 = float(np.isnan(raw2).mean())
t_med2 = tick() - t0
t0 = tick()
dtm2_s = fill(raw2)            # rows south->north
t_fill2 = tick() - t0
T["dtm_2m_median_s"] = t_med2
T["dtm_2m_fill_s"] = t_fill2

t0 = tick()
N05 = ND
raw05, cnt05 = cell_median_grid(gx, gy, gz, X0 + 0.25, Y0 + 0.25, 0.5, N05)
hole05 = float(np.isnan(raw05).mean())
T["dtm_0p5m_median_s"] = tick() - t0

R["dtm"] = {
    "method": "median z of non-withheld class-2 points in a step-sized cell centred on each sample",
    "grid_2m": {"samples": N2, "step_m": 2.0, "hole_fraction_before_fill": round(hole2, 5),
                "points_per_cell_median": float(np.median(cnt2)),
                "fill_s": round(t_fill2, 2), "median_s": round(t_med2, 2)},
    "grid_0p5m": {"samples": N05, "step_m": 0.5, "hole_fraction": round(hole05, 5),
                  "points_per_cell_median": float(np.median(cnt05)),
                  "median_s": round(T["dtm_0p5m_median_s"], 2)},
}

# ---------------------------------------------------------------- 3. DSM
t0 = tick()
dsm_hole = float(np.isinf(dsm).mean())
dsm_f = dsm.copy()
dsm_f[np.isinf(dsm_f)] = np.nan
T["dsm_finalise_s"] = tick() - t0
R["dsm"] = {"res_m": 0.5, "shape": [ND, ND], "empty_cell_fraction": round(dsm_hole, 5),
            "zmin": float(np.nanmin(dsm_f)), "zmax": float(np.nanmax(dsm_f)),
            "build_s_incl_in_split_dsm_accumulate": round(t_agg, 2)}

# ---------------------------------------------------------------- 4. encode
t0 = tick()
h = dtm2_s[::-1]               # rows north->south (z increasing), like the tile's z axis
hbase = np.float32(h.min())
q = np.rint((h.astype(np.float64) - float(hbase)) * 100.0)
q_clipped = int((q > 65535).sum())
q = np.clip(q, 0, 65535).astype("<u2")
raw_bytes = q.tobytes()
gz_plain = gzip.compress(raw_bytes, 9)

qi = q.astype(np.int32)
d_row = np.diff(qi, axis=1, prepend=0)                      # row-wise delta
d_row_u = np.where(d_row >= 0, d_row << 1, ((-d_row) << 1) - 1)
assert d_row_u.max() < 65536, "row-delta residual overflows uint16"
d_row_u = d_row_u.astype("<u2")
gz_row = gzip.compress(d_row_u.tobytes(), 9)

# planar predictor (spec 2.4): pred = left + up - upleft, zigzag residual
pad = np.pad(qi, ((1, 0), (1, 0)))
pred = pad[1:, :-1] + pad[:-1, 1:] - pad[:-1, :-1]
res = qi - pred
res_u = np.where(res >= 0, res << 1, ((-res) << 1) - 1)
assert res_u.max() < 65536, "planar residual overflows uint16"
res_u = res_u.astype("<u2")
gz_plan = gzip.compress(res_u.tobytes(), 9)
T["encode_s"] = tick() - t0
est_hgt_raw = round(510_000 * 0.512 * 0.512)  # proposal §2.4 gives 510 KB per km²; a tile is 0.262 km²
est_q_tile = 70_000
R["encode"] = {
    "hBase_m": float(hbase), "q_clipped_samples": q_clipped,
    "raw_uint16_bytes": len(raw_bytes),
    "gzip9_plain_bytes": len(gz_plain),
    "gzip9_row_delta_zigzag_bytes": len(gz_row),
    "gzip9_planar_predictor_zigzag_bytes": len(gz_plan),
    "proposal_estimate": {"HGT_raw_bytes": est_hgt_raw, "q_tile_gz_bytes_all_sections": est_q_tile,
                          "q_gz_per_km2_bytes": [250_000, 300_000]},
    "note": "HGT section alone measured; proposal's ~70 KB/tile covers all q sections (HGT, RIB, SOL, LC...).",
    "encode_s": round(T["encode_s"], 3),
}

# ---------------------------------------------------------------- 5. sanity
gy_, gx_ = np.gradient(dtm2_s.astype(np.float64), 2.0)
slope = 100.0 * np.hypot(gx_, gy_)
R["sanity"] = {"slope_pct_max": float(slope.max()), "slope_pct_p95": float(np.percentile(slope, 95)),
               "slope_pct_p99": float(np.percentile(slope, 99)),
               "height_min_m": float(dtm2_s.min()), "height_max_m": float(dtm2_s.max()),
               "height_navd88_note": "lidar Z is NAVD88 m; Terrarium is not NAVD88"}

# Terrarium
from PIL import Image  # noqa: E402

t0 = tick()
xs = X0 - 2.0 + 2.0 * np.arange(N2)
ys = Y0 - 2.0 + 2.0 * np.arange(N2)
XX, YY = np.meshgrid(xs, ys)
lon_, lat_ = common._sft1_to_ll.transform(XX, YY)
n = 2 ** 14
px = (lon_ + 180) / 360 * n
py = (1 - np.arcsinh(np.tan(np.radians(lat_))) / math.pi) / 2 * n
tx0, tx1 = int(px.min()), int(px.max())
ty0, ty1 = int(py.min()), int(py.max())
terr_ok = True
mos = np.full(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.nan, dtype=np.float64)
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        p = os.path.join(DEM, "14_%d_%d.png" % (tx, ty))
        if not os.path.exists(p):
            terr_ok = False
            continue
        a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
        mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = \
            a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
fx = (px - tx0 * 1.0) * 256 - 0.5
fy = (py - ty0 * 1.0) * 256 - 0.5
x0i, y0i = np.floor(fx).astype(int), np.floor(fy).astype(int)
ax, ay = fx - x0i, fy - y0i
x0i = np.clip(x0i, 0, mos.shape[1] - 2); y0i = np.clip(y0i, 0, mos.shape[0] - 2)
terr = (mos[y0i, x0i] * (1 - ax) * (1 - ay) + mos[y0i, x0i + 1] * ax * (1 - ay)
        + mos[y0i + 1, x0i] * (1 - ax) * ay + mos[y0i + 1, x0i + 1] * ax * ay)
diff = dtm2_s - terr
valid = np.isfinite(diff)
d = diff[valid]
T["terrarium_s"] = tick() - t0
R["terrarium"] = {
    "covers_tile": bool(terr_ok and valid.all()), "tiles_used": [[tx0, tx1], [ty0, ty1]],
    "valid_fraction": float(valid.mean()),
    "mean_diff_m": float(d.mean()), "std_diff_m": float(d.std()),
    "rms_diff_m": float(np.sqrt((d ** 2).mean())),
    "max_abs_diff_m": float(np.abs(d).max()),
    "p95_abs_diff_m": float(np.percentile(np.abs(d), 95)),
    "rms_after_removing_mean_m": float(d.std()),
    "diff_definition": "lidar DTM (NAVD88) minus Terrarium bilinear at the 259x259 sample positions",
    "terrarium_min_max_m": [float(np.nanmin(terr)), float(np.nanmax(terr))],
}

# ---------------------------------------------------------------- 6. PNGs
import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def hillshade(z, cell, az=315.0, alt=45.0):
    zz = np.where(np.isfinite(z), z, np.nanmean(z))
    gy, gx = np.gradient(zz.astype(np.float64), cell)   # rows go south->north OR north->south; caller orients
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(gy, -gx)
    a, al = np.radians(360 - az + 90), np.radians(alt)
    hs = np.sin(al) * np.cos(slope) + np.cos(al) * np.sin(slope) * np.cos(a - aspect)
    return np.clip(hs, 0, 1)


def save(img, path, title, cmap="gray", **kw):
    fig, ax = plt.subplots(figsize=(8, 8), dpi=130)
    im = ax.imshow(img, cmap=cmap, interpolation="nearest", **kw)
    ax.set_title(title, fontsize=9)
    ax.set_xticks([]); ax.set_yticks([])
    if cmap != "gray":
        fig.colorbar(im, ax=ax, shrink=0.7)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


t0 = tick()
# north-up: dtm2_s rows are south->north, so flip; with rows north->south gradient row sign is down = -north
hs1 = hillshade(dtm2_s[::-1], 2.0)
save(hs1, os.path.join(OUT, "tile_dtm2m_hillshade.png"),
     "SFT1 L0 tile %d,%d 2 m DTM hillshade (north up, 259x259)" % (I, J))
hs2 = hillshade(dsm_f, 0.5)
save(hs2, os.path.join(OUT, "tile_dsm0p5m_hillshade.png"),
     "SFT1 L0 tile %d,%d 0.5 m DSM hillshade (north up, 1024x1024)" % (I, J))
vm = float(np.percentile(np.abs(d), 98))
save(diff[::-1], os.path.join(OUT, "tile_dtm_minus_terrarium.png"),
     "DTM minus Terrarium z14 (m), mean %.2f RMS %.2f" % (d.mean(), np.sqrt((d ** 2).mean())),
     cmap="RdBu_r", vmin=-vm, vmax=vm)
T["png_s"] = tick() - t0

# ---------------------------------------------------------------- 7. projection
tile_s = fetch_s + load_s + t_agg + t_med2 + t_fill2 + T["dtm_0p5m_median_s"] + T["encode_s"]
NTILES = 1300
R["stage_seconds"] = {k: round(v, 2) for k, v in T.items()}
R["projection"] = {
    "tile_count": NTILES,
    "tile_count_source": "tile-format-proposal.md 2.10: q and r for ~1,300 land tiles (~330 km2 / 0.262 km2 = ~1,260)",
    "per_tile_fetch_load_bake_s": round(tile_s, 1),
    "fetch_only_s_per_tile": round(fetch_s, 1),
    "fetch_was_cached_so_download_time_unreliable": cached_all,
    "single_thread_total_hours": round(tile_s * NTILES / 3600, 2),
    "laz_total_gb": round(laz_bytes * NTILES / 1e9, 2),
    "hgt_gz_best_total_mb": round(min(len(gz_plain), len(gz_row), len(gz_plan)) * NTILES / 1e6, 1),
    "hgt_gz_plain_total_mb": round(len(gz_plain) * NTILES / 1e6, 1),
    "proposal_q_total_mb_at_70kb": round(est_q_tile * NTILES / 1e6, 1),
    "caveats": "Nob Hill is dense urban; water-edge and park tiles have fewer points; open-water slots are skipped.",
    "parallelises": "tiles are independent (fetch, PDAL EPT read, median/fill, encode); fetch is network bound, "
                    "DTM/DSM/encode CPU bound per tile; quadrant fetches within a tile also parallel. "
                    "Serial: manifest write, seam checks across neighbours (shared border row must match).",
}
R["total_script_wall_s"] = round(tick() - t_all, 1)

with open(os.path.join(OUT, "tile_benchmark.json"), "w") as f:
    json.dump(R, f, indent=2)
print(json.dumps(R, indent=2))

"""Does the USGS 1 m DEM agree with the raw lidar ground? Run after tools/dem1m_v2.py.

Compares, over the lidar pilot box (Nob Hill + FiDi), the DEM against the pilot's own raster of
ground-class returns (0.25 m, NAVD88 - Y0, cached by tools/bake_pilot_v2.py):
- heights: the 4 m mosaic against the raster's 4 m block means (the bias says whether the datums
  agree; the spread is what the mosaic smooths away);
- position: the 1 m DEM warped for the box against the raster's 1 m block means, shifted by up to
  3 m, to see whether the two are offset horizontally (NAD83 vs WGS84 handling).
Writes tools/research/dem1m-check.json.
"""
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
sys.path.insert(0, HERE)
import common as C  # noqa: E402
import dem1m_v2 as D  # noqa: E402
from geo2 import GX0, GZ0, TM, Y0  # noqa: E402

BOX = (-912.0, -1472.0, 1472.0, 192.0)          # bake_pilot_v2.V2_BBOX
FINE = 0.25


def block_mean(r, k, min_frac=0.5):
    nz, nx = r.shape[0] // k, r.shape[1] // k
    b = r[:nz * k, :nx * k].reshape(nz, k, nx, k)
    ok = np.isfinite(b)
    s = np.where(ok, b, 0).sum(axis=(1, 3))
    n = ok.sum(axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(n >= min_frac * k * k, s / np.maximum(n, 1), np.nan)


def stats(d):
    d = d[np.isfinite(d)]
    med = float(np.median(d))
    return dict(n=int(d.size), median=round(med, 3), mad=round(float(np.median(np.abs(d - med))), 3),
                p5=round(float(np.percentile(d, 5)), 3), p95=round(float(np.percentile(d, 95)), 3),
                within_15cm=round(float((np.abs(d) < 0.15).mean()), 3), within_50cm=round(float((np.abs(d) < 0.5).mean()), 3))


def main():
    pc = os.path.join(C.CACHE, "pilot")
    raster = [f for f in os.listdir(pc) if f.startswith("ground025_v2_") and f.endswith(".npy")]
    assert len(raster) == 1, raster
    r = np.load(os.path.join(pc, raster[0]))                          # (z, x), NAVD88 - Y0
    x0, z0, x1, z1 = BOX
    assert r.shape == (int((z1 - z0) / FINE), int((x1 - x0) / FINE)), r.shape
    out = {}

    # heights: 4 m mosaic vs 4 m block means
    M = D.load_mosaic() - Y0
    i0, j0 = int((x0 - GX0) / 4), int((z0 - GZ0) / 4)
    assert (x0 - GX0) % 4 == 0 and (z0 - GZ0) % 4 == 0
    m4 = M[j0:j0 + r.shape[0] // 16, i0:i0 + r.shape[1] // 16]
    out["mosaic4_minus_lidar4"] = stats(m4 - block_mean(r, 16))

    # position: 1 m DEM for the box vs 1 m block means, shifted
    src = [os.path.join(D.DEM1M_DIR, "CA_SanFrancisco_B23", f) for f in os.listdir(os.path.join(D.DEM1M_DIR, "CA_SanFrancisco_B23")) if f.endswith(".tif")]
    tif1 = os.path.join(D.DEM1M_DIR, "pilotbox_1m.f32")
    cmd = [D.GDALWARP, "-overwrite", "-t_srs", TM, "-te", repr(x0), repr(-z1), repr(x1), repr(-z0), "-tr", "1", "1",
           "-r", "bilinear", "-ot", "Float32", "-dstnodata", repr(D.NODATA), "-of", "ENVI"] + src + [tif1]
    p = subprocess.run(cmd, env=C._tool_env(), capture_output=True, text=True)
    assert p.returncode == 0, p.stderr[-2000:]
    d1 = np.fromfile(tif1, dtype="<f4").reshape(int(z1 - z0), int(x1 - x0))
    d1 = np.where(d1 > D.NODATA + 1, d1 - Y0, np.nan)
    l1 = block_mean(r, 4)
    # steep cells carry the position signal; flat ones only add noise
    gz, gx = np.gradient(l1)
    steep = np.hypot(gx, gz) > 0.15
    S = 12                                     # +-3 m in 0.25 m steps of the fine raster
    steep[:S // 4 + 1, :] = steep[-(S // 4 + 1):, :] = False
    steep[:, :S // 4 + 1] = steep[:, -(S // 4 + 1):] = False
    jj, ii = np.nonzero(steep)
    ok = np.isfinite(r)
    # integral images: the mean of fine cells [4i + di, 4i + di + 4) x [4j + dj, 4j + dj + 4) for any shift
    IV = np.zeros((r.shape[0] + 1, r.shape[1] + 1)); IV[1:, 1:] = np.where(ok, r, 0).cumsum(0).cumsum(1)
    IN = np.zeros_like(IV); IN[1:, 1:] = ok.cumsum(0).cumsum(1)
    target = d1[jj, ii]
    best, grid = None, []
    for dj in range(-S, S + 1):
        for di in range(-S, S + 1):
            a0, a1 = 4 * jj + dj, 4 * jj + dj + 4
            b0, b1 = 4 * ii + di, 4 * ii + di + 4
            s = IV[a1, b1] - IV[a0, b1] - IV[a1, b0] + IV[a0, b0]
            n = IN[a1, b1] - IN[a0, b1] - IN[a1, b0] + IN[a0, b0]
            with np.errstate(invalid="ignore", divide="ignore"):
                dd = target - np.where(n >= 8, s / np.maximum(n, 1), np.nan)
            v = dd[np.isfinite(dd)]
            v = v - np.median(v)
            e = float(np.sqrt(np.mean(np.clip(v, -2, 2) ** 2)))
            grid.append((di * FINE, dj * FINE, e))
            if best is None or e < best[2]:
                best = (di * FINE, dj * FINE, e)
    e0 = [g[2] for g in grid if g[0] == 0 and g[1] == 0][0]
    out["dem1m_minus_lidar1"] = stats(d1 - l1)
    out["position"] = dict(steep_cells=int(steep.sum()), rms_at_zero=round(e0, 3),
                           best_shift_x_m=best[0], best_shift_z_m=best[1], rms_at_best=round(best[2], 3),
                           note="best shift: lidar raster sampled at x + dx, z + dz matches the DEM best")
    with open(os.path.join(TOOLS, "research", "dem1m-check.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()

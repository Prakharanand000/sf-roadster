"""USGS 3DEP 1 m bare-earth DEM for the v2 area, warped to one 4 m mosaic on the v2 landcover grid.

    python tools/dem1m_v2.py      # -> CACHE/v2/dem1m/mosaic4.f32 + mosaic4.json (~3.8 GB download once)

The 1 m DEMs are USGS's bare-earth product made from the same lidar the pilot reads
(CA_SanFrancisco_B23 for SF, YBI and TI; CA_AlamedaCounty_2021_B21 for the East Bay), with older
projects filling what those miss. Heights are NAVD88 metres; bake_v2 subtracts Y0. Public domain.

The mosaic's pixel (i, j) is the landcover raster's pixel (i, j): x in [GX0 + 4i, GX0 + 4i + 4),
z in [GZ0 + 4j, GZ0 + 4j + 4) (z = -northing), the mean of the 1 m cells inside it. NaN where no
project has data. gdalwarp and its PROJ data come from the conda bake env (as PDAL in
probes/common.py); this script only needs numpy and pyproj.
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "probes"))
import common as C  # noqa: E402
from geo2 import CACHE, GX0, GZ0, LC_RES, LCX, LCZ, TM, unproj  # noqa: E402

GDALWARP = os.path.join(C.BAKE_ENV, "Library", "bin", "gdalwarp.exe")
DEM1M_DIR = os.path.join(CACHE, "dem1m")
MOSAIC = os.path.join(DEM1M_DIR, "mosaic4.f32")
MOSAIC_META = os.path.join(DEM1M_DIR, "mosaic4.json")
NODATA = -9999.0
TNM_API = "https://tnmaccess.nationalmap.gov/api/v1/products"
DATASET = "Digital Elevation Model (DEM) 1 meter"
# best first: the lidar the pilot and the building heights use, then older collections for gaps
PRIORITY = ["CA_SanFrancisco_B23", "CA_AlamedaCounty_2021_B21", "CA_CaliforniaGaps_B23",
            "CA_NoCal_Wildfires_B5b_QL1_2018", "CA_NoCAL_Wildfires_B5b_2018",
            "CA_NoCAL_3DEP_Supp_Funding_2018_D18"]


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def project_of(url):
    """.../Elevation/1m/Projects/<project>/TIFF/<file>.tif -> <project>"""
    parts = urllib.parse.urlparse(url).path.split("/")
    return parts[parts.index("Projects") + 1] if "Projects" in parts[:-1] else None


def area_bbox():
    """lon/lat box of the whole landcover grid (corners unprojected), padded 0.005 deg."""
    xs = (GX0, GX0 + LCX * LC_RES)
    zs = (GZ0, GZ0 + LCZ * LC_RES)
    lls = [unproj(x, z) for x in xs for z in zs]
    lats = [a for a, _ in lls]; lons = [b for _, b in lls]
    return min(lons) - 0.005, min(lats) - 0.005, max(lons) + 0.005, max(lats) + 0.005


def list_tiles():
    w, s, e, n = area_bbox()
    q = urllib.parse.urlencode({"datasets": DATASET, "bbox": "%.5f,%.5f,%.5f,%.5f" % (w, s, e, n),
                                "outputFormat": "JSON", "max": 500})
    req = urllib.request.Request(TNM_API + "?" + q, headers={"User-Agent": "SFRoadsterRush/1.0 (personal game build)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    items = d["items"]
    # one page holds everything when total <= max (total also counts items the API drops for having
    # no download URL; `filteredOut` says how many, as text)
    assert int(d.get("total") or 0) <= 500, "TNM listing is paged: %s items" % d.get("total")
    if d.get("filteredOut"):
        log("TNM: %s" % d["filteredOut"])
    tiles, skipped = [], []
    for it in items:
        p = project_of(it["downloadURL"])
        if p in PRIORITY:
            tiles.append(dict(project=p, url=it["downloadURL"], bytes=int(it["sizeInBytes"])))
        else:
            skipped.append(p)
    if skipped:
        log("projects not in PRIORITY, skipped: %s" % sorted(set(skipped)))
    return tiles


def download(t):
    """A file is only renamed into place once complete, so one that exists is whole. The listing's
    sizeInBytes can be stale (a tile re-published since), so completeness is the server's
    Content-Length."""
    out = os.path.join(DEM1M_DIR, t["project"], os.path.basename(urllib.parse.urlparse(t["url"]).path))
    if os.path.exists(out):
        return out, False
    os.makedirs(os.path.dirname(out), exist_ok=True)
    req = urllib.request.Request(t["url"], headers={"User-Agent": "SFRoadsterRush/1.0 (personal game build)"})
    tmp = out + ".part"
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        want = int(r.headers.get("Content-Length") or -1)       # -1: not sent (chunked)
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    got = os.path.getsize(tmp)
    if want >= 0 and got != want:
        raise RuntimeError("%s: %d bytes, the server sent Content-Length %d" % (out, got, want))
    if got != t["bytes"]:
        log("  %s: %d bytes, the listing says %d (re-published since)" % (os.path.basename(out), got, t["bytes"]))
    os.replace(tmp, out)
    return out, True


def warp(paths):
    """gdalwarp writes inputs in order, later valid pixels over earlier: lowest priority first."""
    w_n = -GZ0                                   # top edge (northing)
    s_n = -(GZ0 + LCZ * LC_RES)
    cmd = [GDALWARP, "-overwrite", "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-wm", "2048",
           "-t_srs", TM, "-te", repr(GX0), repr(s_n), repr(GX0 + LCX * LC_RES), repr(w_n),
           "-tr", repr(LC_RES), repr(LC_RES), "-r", "average", "-ot", "Float32",
           "-dstnodata", repr(NODATA), "-of", "ENVI"] + paths + [MOSAIC]
    t0 = time.perf_counter()
    r = subprocess.run(cmd, env=C._tool_env(), capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("gdalwarp failed: " + r.stderr[-3000:])
    return time.perf_counter() - t0


def load_mosaic():
    """(LCZ, LCX) float32 NAVD88 heights, NaN where no 1 m DEM; None if not built."""
    if not os.path.exists(MOSAIC_META):
        return None
    with open(MOSAIC_META) as f:
        meta = json.load(f)
    if (meta["gx0"], meta["gz0"], meta["nx"], meta["nz"], meta["res"]) != (GX0, GZ0, LCX, LCZ, LC_RES):
        raise RuntimeError("dem1m mosaic was built for another grid: re-run tools/dem1m_v2.py")
    a = np.fromfile(MOSAIC, dtype="<f4")
    assert a.size == LCX * LCZ, (a.size, LCX, LCZ)
    a = a.reshape(LCZ, LCX)
    a[a <= NODATA + 1] = np.nan
    return a


def main():
    os.makedirs(DEM1M_DIR, exist_ok=True)
    tiles = list_tiles()
    tiles.sort(key=lambda t: (-PRIORITY.index(t["project"]), t["url"]))   # lowest priority first
    log("%d tiles, %.2f GB: %s" % (len(tiles), sum(t["bytes"] for t in tiles) / 1e9,
                                  {p: sum(1 for t in tiles if t["project"] == p) for p in PRIORITY}))
    paths, got = [], 0
    for k, t in enumerate(tiles):
        p, new = download(t)
        paths.append(p)
        got += new
        log("  %d/%d %s%s" % (k + 1, len(tiles), os.path.basename(p), "" if new else " (cached)"))
    log("downloaded %d, cached %d" % (got, len(tiles) - got))
    s = warp(paths)
    a = np.fromfile(MOSAIC, dtype="<f4")
    assert a.size == LCX * LCZ, "gdalwarp wrote %d pixels, expected %d x %d" % (a.size, LCX, LCZ)
    valid = a > NODATA + 1
    meta = dict(gx0=GX0, gz0=GZ0, nx=LCX, nz=LCZ, res=LC_RES, nodata=NODATA, datum="NAVD88 m",
                valid_frac=round(float(valid.mean()), 4), warp_s=round(s, 1),
                sources=[dict(project=t["project"], file=os.path.basename(p), bytes=t["bytes"])
                         for t, p in zip(tiles, paths)])
    with open(MOSAIC_META, "w") as f:
        json.dump(meta, f, indent=1)
    log("mosaic %d x %d, %.1f%% with 1 m DEM, range %.1f..%.1f m, warp %.0f s" % (
        LCX, LCZ, 100 * valid.mean(), a[valid].min(), a[valid].max(), s))


if __name__ == "__main__":
    main()

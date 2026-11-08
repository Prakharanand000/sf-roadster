"""Shared helpers for the real-data probes (MAP_RESOURCES.md §11, gap 3).

Offline only. Two interpreters, because Windows Smart App Control blocks parts
of conda-forge's Python (unicodedata, _socket) and the pyosmium wheel:
  - PDAL and osmium run as command-line tools from the conda `bake` env
    (tools/environment.yml), which the policy allows;
  - this module runs under python.org Python with numpy, pyproj, laspy[lazrs],
    matplotlib (the venv described in tools/probes/README.md).

USGS 3DEP EPT is read straight from the public S3 bucket, so only the octree
nodes inside the requested box are downloaded. EPT coordinates are EPSG:3857
(horizontal lengths inflated ~1.2655x at SF); Z is NAVD88 metres. Points
returned here are reprojected to the SFT1 transverse Mercator from
tile-format-proposal.md §2.1, so x/y are true metres.
"""
import hashlib
import json
import os
import subprocess
import threading
import time

import laspy
import numpy as np
from pyproj import Transformer

BAKE_ENV = os.environ.get("SF_BAKE_ENV", os.path.expanduser(r"~\miniforge3\envs\bake"))
PDAL = os.path.join(BAKE_ENV, "Library", "bin", "pdal.exe")
OSMIUM = os.path.join(BAKE_ENV, "Library", "bin", "osmium.exe")
CACHE = os.environ.get("SF_BAKE_CACHE", os.path.expanduser(r"~\Downloads\sf-roadster-bakecache"))

EPT_URL = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{}/ept.json"
SFT1_PROJ = ("+proj=tmerc +lat_0=37.7880 +lon_0=-122.4075 +k_0=1 "
             "+x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs")

_ll_to_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_ll_to_sft1 = Transformer.from_crs("EPSG:4326", SFT1_PROJ, always_xy=True)
_sft1_to_ll = Transformer.from_crs(SFT1_PROJ, "EPSG:4326", always_xy=True)
_sft1_to_3857 = Transformer.from_crs(SFT1_PROJ, "EPSG:3857", always_xy=True)
_3857_to_sft1 = Transformer.from_crs("EPSG:3857", SFT1_PROJ, always_xy=True)


def ll_to_sft1(lat, lon):
    """(lat, lon) -> SFT1 (easting, northing) in metres."""
    return _ll_to_sft1.transform(lon, lat)


def sft1_to_ll(x, y):
    lon, lat = _sft1_to_ll.transform(x, y)
    return lat, lon


def bounds_3857_from_ll(lat0, lon0, lat1, lon1):
    xs, ys = _ll_to_3857.transform([lon0, lon1, lon0, lon1], [lat0, lat0, lat1, lat1])
    return f"([{min(xs)}, {max(xs)}], [{min(ys)}, {max(ys)}])"


def bounds_3857_from_sft1(x0, y0, x1, y1):
    """Box in SFT1 metres -> EPT bounds string. Pads by 2 m for reprojection skew."""
    xs, ys = _sft1_to_3857.transform([x0 - 2, x1 + 2, x0 - 2, x1 + 2],
                                     [y0 - 2, y0 - 2, y1 + 2, y1 + 2])
    return f"([{min(xs)}, {max(xs)}], [{min(ys)}, {max(ys)}])"


def _tool_env():
    env = dict(os.environ)
    env["PROJ_DATA"] = os.path.join(BAKE_ENV, "Library", "share", "proj")
    env["GDAL_DATA"] = os.path.join(BAKE_ENV, "Library", "share", "gdal")
    return env


def run_pdal(stages):
    """Run a PDAL pipeline (list of stage dicts) with the CLI; returns wall seconds."""
    os.makedirs(os.path.join(CACHE, "lidar"), exist_ok=True)
    # unique per process and thread, so parallel fetches don't overwrite each other's spec
    spec = os.path.join(CACHE, "lidar", "_pipeline_%d_%d.json" % (os.getpid(), threading.get_ident()))
    with open(spec, "w") as f:
        json.dump(stages, f)
    t0 = time.perf_counter()
    r = subprocess.run([PDAL, "pipeline", spec], env=_tool_env(),
                       capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("pdal failed: " + r.stderr[-2000:])
    return time.perf_counter() - t0


def fetch_ept(project, bounds):
    """Download every point of `project` inside `bounds` (EPSG:3857 string) to a cached LAZ.

    Returns (path, stats). Nothing is filtered, so class histograms stay honest.
    """
    key = hashlib.sha1(f"{project}|{bounds}".encode()).hexdigest()[:12]
    out = os.path.join(CACHE, "lidar", project, f"{key}.laz")
    stats = {"project": project, "bounds_3857": bounds, "laz": out, "cached": os.path.exists(out)}
    if not stats["cached"]:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        stats["fetch_s"] = round(run_pdal([
            {"type": "readers.ept", "filename": EPT_URL.format(project),
             "bounds": bounds, "threads": 8},
            {"type": "writers.las", "filename": out.replace("\\", "/"), "compression": True,
             "minor_version": 4, "dataformat_id": 6, "forward": "header"}]), 2)
    stats["laz_bytes"] = os.path.getsize(out)
    return out, stats


def load_points(laz_path, reproject=True):
    """LAZ -> dict of numpy arrays (X, Y, Z, Classification, Withheld, Overlap, ...).

    X/Y are SFT1 metres when reproject=True, else EPSG:3857.
    """
    las = laspy.read(laz_path)
    x, y = np.asarray(las.x), np.asarray(las.y)
    if reproject:
        x, y = _3857_to_sft1.transform(x, y)
    return {
        "X": np.asarray(x), "Y": np.asarray(y), "Z": np.asarray(las.z),
        "Classification": np.asarray(las.classification, dtype=np.uint8),
        "Withheld": np.asarray(las.withheld, dtype=bool),
        "Overlap": np.asarray(las.overlap, dtype=bool),
        "ReturnNumber": np.asarray(las.return_number, dtype=np.uint8),
        "NumberOfReturns": np.asarray(las.number_of_returns, dtype=np.uint8),
        "Intensity": np.asarray(las.intensity),
    }


def read_ept(project, bounds, reproject=True):
    """fetch_ept + load_points. Returns (points dict, stats dict)."""
    path, stats = fetch_ept(project, bounds)
    t0 = time.perf_counter()
    pts = load_points(path, reproject)
    stats["load_s"] = round(time.perf_counter() - t0, 2)
    stats["points"] = int(pts["Z"].size)
    return pts, stats


def subset(pts, mask):
    return {k: v[mask] for k, v in pts.items()}


def drop_withheld(pts):
    return subset(pts, ~pts["Withheld"])


def class_histogram(pts):
    cls, cnt = np.unique(pts["Classification"], return_counts=True)
    return {int(c): int(n) for c, n in zip(cls, cnt)}

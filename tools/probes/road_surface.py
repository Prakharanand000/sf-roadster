"""Road-surface probe (MAP_RESOURCES.md §11 gaps 1 and 3).

For one block of one street:
  1. Take the OSM centreline between two cross streets (from an osmium GeoJSON export).
  2. Read every lidar point in a corridor around it straight from USGS EPT.
  3. Measure, from ground (class 2) points only:
       - the longitudinal profile (1 m stations) and the block's mean and peak grade,
       - the detrended cross-section (crown, gutter, curb step, sidewalk),
       - how much of the road centre band has no ground return (parked cars etc.).
  4. Compare the profile with the Terrarium DEM the game bakes from today.

Usage:
  python -I tools/probes/road_surface.py <lines.geojson> <street> <from> <to> <label> <outdir>
"""
import functools
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (bounds_3857_from_sft1, class_histogram, drop_withheld,  # noqa: E402
                    ll_to_sft1, read_ept, sft1_to_ll, subset)

PROJECT = "CA_SanFrancisco_1_B23"
DEM_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cache", "dem")
CENTRE_BAND = 2.5   # |offset| (m) treated as the road centre for the profile
CORRIDOR = 16.0     # |offset| (m) kept for the cross-section (road + sidewalks)
GUTTER_RANGE = (2.5, 13.0)  # |offset| (m) searched for the gutter; hits on either end are flagged


NOT_ROADS = {"footway", "pedestrian", "steps", "path", "cycleway", "busway", "corridor"}


def block_polyline(geojson_path, street, from_st, to_st):
    """Shortest path along `street`'s drivable ways from its node shared with
    `from_st` to its node shared with `to_st` (OSM node = identical coordinates)."""
    import heapq
    with open(geojson_path, encoding="utf-8") as f:
        feats = json.load(f)["features"]

    def lines_named(name):
        out = []
        for ft in feats:
            p = ft["properties"]
            if p.get("name") != name or p.get("highway") in NOT_ROADS or "highway" not in p:
                continue
            g = ft["geometry"]
            if g["type"] == "LineString":
                out.append(g["coordinates"])
            elif g["type"] == "MultiLineString":
                out.extend(g["coordinates"])
        return out

    graph = {}
    for line in lines_named(street):
        for a, b in zip(map(tuple, line[:-1]), map(tuple, line[1:])):
            w = math.dist(ll_to_sft1(a[1], a[0]), ll_to_sft1(b[1], b[0]))
            graph.setdefault(a, []).append((b, w))
            graph.setdefault(b, []).append((a, w))
    ends = {}
    for cross in (from_st, to_st):
        shared = {tuple(c) for l in lines_named(cross) for c in l} & graph.keys()
        if not shared:
            raise SystemExit(f"{street} has no shared node with {cross}")
        ends[cross] = shared
    dist = {n: 0.0 for n in ends[from_st]}
    prev = {}
    heap = [(0.0, n) for n in ends[from_st]]
    while heap:
        d, n = heapq.heappop(heap)
        if n in ends[to_st]:
            path = [n]
            while path[-1] in prev:
                path.append(prev[path[-1]])
            path.reverse()
            return [list(c) for c in path], {from_st: path[0], to_st: path[-1]}
        if d > dist[n]:
            continue
        for m, w in graph[n]:
            if d + w < dist.get(m, math.inf):
                dist[m] = d + w
                prev[m] = n
                heapq.heappush(heap, (d + w, m))
    raise SystemExit(f"no path along {street} from {from_st} to {to_st}")


def station_offset(px, py, poly):
    """Project points onto a polyline: station along it and signed offset (left +)."""
    best_d = np.full(px.shape, np.inf)
    st = np.zeros(px.shape)
    off = np.zeros(px.shape)
    s0 = 0.0
    for (x0, y0), (x1, y1) in zip(poly[:-1], poly[1:]):
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy)
        t = np.clip(((px - x0) * dx + (py - y0) * dy) / (L * L), 0, 1)
        cx, cy = x0 + t * dx, y0 + t * dy
        d = np.hypot(px - cx, py - cy)
        side = np.sign(dx * (py - y0) - dy * (px - x0))
        m = d < best_d
        best_d[m] = d[m]
        st[m] = s0 + t[m] * L
        off[m] = side[m] * d[m]
        s0 += L
    return st, off, s0


@functools.lru_cache(maxsize=None)
def _terrarium_tile(path):
    from PIL import Image  # matplotlib already depends on pillow
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def terrarium_height(lat, lon, z=14):
    """Bilinear height from the cached Terrarium tiles the current bake uses."""
    n = 2 ** z
    fx = (lon + 180) / 360 * n
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    tx, ty = int(fx), int(fy)
    p = os.path.join(DEM_DIR, f"{z}_{tx}_{ty}.png")
    if not os.path.exists(p):
        return float("nan")
    h = _terrarium_tile(p)
    u, v = (fx - tx) * 256 - 0.5, (fy - ty) * 256 - 0.5
    i0, j0 = int(np.clip(math.floor(v), 0, 254)), int(np.clip(math.floor(u), 0, 254))
    fu, fv = np.clip(u - j0, 0, 1), np.clip(v - i0, 0, 1)
    return float(h[i0, j0] * (1 - fu) * (1 - fv) + h[i0, j0 + 1] * fu * (1 - fv)
                 + h[i0 + 1, j0] * (1 - fu) * fv + h[i0 + 1, j0 + 1] * fu * fv)


CURB_MIN = 0.08     # m; smaller rises are gutter pans or driveway lips, not curbs
PUBLISHED_WINDOW = 62.9  # m; the 206.25 ft half-block behind SF's published steep grades


def window_curbs(st, off, gz, length, win=10.0, bin_w=0.2):
    """Curbs per 10 m of street, so a centreline that drifts off-centre doesn't
    smear the step. Per window: detrended ground cross-section in 0.2 m bins;
    gutter = lowest point of the 3-bin smoothed section within GUTTER_RANGE on
    each side (smoothing removes the low bias of a min over noisy bins);
    curb rise = median height 0.6-1.4 m outward of the gutter minus the gutter.
    A gutter on the edge of GUTTER_RANGE is marked at_cap: its offset and rise
    are censored, not measured."""
    ob = np.arange(-CORRIDOR, CORRIDOR + bin_w, bin_w)
    xm = ob[:-1] + bin_w / 2
    lo, hi = GUTTER_RANGE
    rows = []
    for s0 in np.arange(0.0, length - win + 1e-6, win):
        m = (st >= s0) & (st < s0 + win)
        if m.sum() < 200:
            rows.append({"s0": float(s0), "xsec": None})
            continue
        idx = np.digitize(off[m], ob) - 1
        g = gz[m]
        prof = np.full(len(xm), np.nan)
        for k in np.unique(idx):
            if 0 <= k < len(xm):
                sel = g[idx == k]
                if sel.size >= 3:
                    prof[k] = np.median(sel)
        row = {"s0": float(s0), "xsec": prof}
        padded = np.r_[np.nan, prof, np.nan]
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                smooth = np.nanmean(np.vstack([padded[:-2], padded[1:-1], padded[2:]]), axis=0)
        for side, sgn in (("left", 1), ("right", -1)):
            cand = np.where((sgn * xm >= lo) & (sgn * xm <= hi) & ~np.isnan(prof))[0]
            if not cand.size:
                continue
            kg = cand[np.argmin(smooth[cand])]
            d = sgn * (xm - xm[kg])
            top = prof[(d >= 0.6) & (d <= 1.4) & ~np.isnan(prof)]
            if top.size:
                row[side] = {"gutter_m": float(xm[kg]),
                             "rise_m": float(np.median(top) - smooth[kg]),
                             "at_cap": bool(kg in (cand.min(), cand.max()))}
        rows.append(row)
    return rows


def max_window_grade(s, z, window):
    best = 0.0
    for i in range(len(s)):
        j = np.searchsorted(s, s[i] + window)
        if j < len(s) and not (np.isnan(z[i]) or np.isnan(z[j])):
            best = max(best, abs(z[j] - z[i]) / (s[j] - s[i]))
    return best


def main(geojson_path, street, from_st, to_st, label, outdir):
    os.makedirs(outdir, exist_ok=True)
    ll_poly, ends = block_polyline(geojson_path, street, from_st, to_st)
    poly = [ll_to_sft1(lat, lon) for lon, lat in ll_poly]
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    bounds = bounds_3857_from_sft1(min(xs) - CORRIDOR, min(ys) - CORRIDOR,
                                   max(xs) + CORRIDOR, max(ys) + CORRIDOR)
    raw, io_stats = read_ept(PROJECT, bounds)
    pts = drop_withheld(raw)
    st, off, length = station_offset(pts["X"], pts["Y"], poly)
    inside = (np.abs(off) <= CORRIDOR) & (st > 0.5) & (st < length - 0.5)
    pts, st, off = subset(pts, inside), st[inside], off[inside]
    ground = pts["Classification"] == 2

    # Longitudinal profile: median ground z per 1 m station inside the centre band.
    nb = int(math.ceil(length))
    edges = np.arange(nb + 1, dtype=float)
    band = ground & (np.abs(off) <= CENTRE_BAND)
    which = np.digitize(st[band], edges) - 1
    prof = np.full(nb, np.nan)
    for k in range(nb):
        zk = pts["Z"][band][which == k]
        if zk.size:
            prof[k] = np.median(zk)
    centres = edges[:-1] + 0.5
    empty = float(np.isnan(prof).mean())
    ok = ~np.isnan(prof)
    fit_prof = np.interp(centres, centres[ok], prof[ok])

    # Detrended cross-section: ground z minus the profile at that station.
    gz = pts["Z"][ground] - np.interp(st[ground], centres, fit_prof)
    ob = np.arange(-CORRIDOR, CORRIDOR + 0.25, 0.25)
    wo = np.digitize(off[ground], ob) - 1
    xsec = np.array([np.median(gz[wo == k]) if np.any(wo == k) else np.nan
                     for k in range(len(ob) - 1)])
    xsec_n = np.array([int(np.sum(wo == k)) for k in range(len(ob) - 1)])
    xmid = ob[:-1] + 0.125
    windows = window_curbs(st[ground], off[ground], gz, length)
    curbs = {}
    for side in ("left", "right"):
        all_found = [w[side] for w in windows if side in w]
        found = [c for c in all_found if not c["at_cap"]]
        hits = [c for c in found if c["rise_m"] >= CURB_MIN]
        curbs[side] = {
            "windows": len(windows), "with_gutter": len(found),
            "gutter_at_search_cap": len(all_found) - len(found), "with_curb": len(hits),
            "gutter_offset_m_median": round(float(np.median([c["gutter_m"] for c in found])), 2) if found else None,
            "curb_rise_m_median": round(float(np.median([c["rise_m"] for c in hits])), 3) if hits else None,
            "curb_rise_m_range": [round(min(c["rise_m"] for c in hits), 3),
                                  round(max(c["rise_m"] for c in hits), 3)] if hits else None,
        }
    widths = [w["left"]["gutter_m"] - w["right"]["gutter_m"] for w in windows
              if "left" in w and "right" in w
              and not w["left"]["at_cap"] and not w["right"]["at_cap"]]
    curbs["gutter_to_gutter_m_median"] = round(float(np.median(widths)), 2) if widths else None

    # Station/offset folds where the centreline turns hard (hairpins); the
    # cross-section and curb numbers are not valid there.
    heading = np.degrees(np.arctan2(np.diff(ys), np.diff(xs)))
    seg_s = np.r_[0, np.cumsum(np.hypot(np.diff(xs), np.diff(ys)))]
    turn = 0.0
    for i in range(len(heading)):
        for j in range(i + 1, len(heading)):
            if seg_s[j] - seg_s[i + 1] > 20:
                break
            turn = max(turn, abs((heading[j] - heading[i] + 180) % 360 - 180))

    # Terrarium (current game terrain) along the same stations.
    tz = []
    for s in centres:
        x = np.interp(s, np.r_[0, np.cumsum(np.hypot(np.diff(xs), np.diff(ys)))], xs)
        y = np.interp(s, np.r_[0, np.cumsum(np.hypot(np.diff(xs), np.diff(ys)))], ys)
        lat, lon = sft1_to_ll(x, y)
        tz.append(terrarium_height(lat, lon))
    tz = np.array(tz)

    def grades(z):
        return {"mean_grade_pct": round(100 * abs(z[-1] - z[0]) / (centres[-1] - centres[0]), 2),
                "peak_grade_10m_pct": round(100 * max_window_grade(centres, z, 10.0), 2),
                "peak_grade_62.9m_pct": round(100 * max_window_grade(centres, z, PUBLISHED_WINDOW), 2)
                if centres[-1] - centres[0] > PUBLISHED_WINDOW else None,
                "drop_m": round(float(abs(z[-1] - z[0])), 2)}

    lidar_g = grades(fit_prof)
    terr_g = grades(tz) if not np.isnan(tz).any() else None
    resid = fit_prof - tz
    result = {
        "label": label, "street": street, "from": from_st, "to": to_st,
        "ends_lonlat": ends, "length_m": round(length, 1),
        "points_read": io_stats["points"], "fetch_s": io_stats.get("fetch_s"),
        "laz_bytes": io_stats["laz_bytes"], "corridor_points": int(pts["Z"].size), "class_hist_corridor": class_histogram(pts),
        "ground_pts_per_m2_corridor": round(float(ground.sum()) / (length * 2 * CORRIDOR), 2),
        "centre_band_empty_station_frac": round(empty, 3),
        "lidar": lidar_g, "terrarium": terr_g,
        "terrarium_minus_lidar_m": None if terr_g is None else {
            "mean": round(float(np.nanmean(-resid)), 2),
            "max_abs": round(float(np.nanmax(np.abs(resid))), 2)},
        "left_is": f"left when travelling from {from_st} to {to_st}",
        "max_turn_deg_20m": round(float(turn), 1),
        "cross_section_valid": bool(turn < 60),
        "crown_to_gutter_m": {
            side: round(float(np.nanmax(xsec[np.abs(xmid) <= 1.0])
                              - np.interp(curbs[side]["gutter_offset_m_median"], xmid, xsec)), 3)
            for side in ("left", "right") if curbs[side]["gutter_offset_m_median"] is not None},
        "curbs": curbs,
        "xsec": [[round(float(a), 3), None if np.isnan(b) else round(float(b), 3), int(c)]
                 for a, b, c in zip(xmid, xsec, xsec_n)],
        "profile": [[round(float(s), 1), None if np.isnan(a) else round(float(a), 3),
                     None if np.isnan(b) else round(float(b), 3)]
                    for s, a, b in zip(centres, prof, tz)],
    }
    with open(os.path.join(outdir, f"road_{label}.json"), "w") as f:
        json.dump(result, f, indent=1)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(13, 4.2))
    ax[0].plot(centres, prof, ".", ms=3, label="lidar ground, 1 m stations")
    ax[0].plot(centres, tz, "-", lw=1.5, label="Terrarium (current game)")
    ax[0].set_xlabel("station along centreline (m)")
    ax[0].set_ylabel("height, NAVD88 (m)")
    ax[0].set_title(f"{street}, {from_st} to {to_st}: profile")
    ax[0].legend()
    wx = np.arange(-CORRIDOR, CORRIDOR, 0.2) + 0.1
    for w in windows:
        if w["xsec"] is not None:
            ax[1].plot(wx, w["xsec"], "-", lw=0.6, alpha=0.35, color="tab:gray")
    ax[1].plot(xmid, xsec, "-", lw=2, color="tab:blue", label="whole block")
    ax[1].plot([], [], "-", lw=0.6, color="tab:gray", label="each 10 m window")
    ax[1].set_ylim(-0.4, 0.6)
    ax[1].legend(loc="upper center")
    ax[1].set_xlabel("offset from OSM centreline (m, left +)")
    ax[1].set_ylabel("height above profile (m)")
    ax[1].set_title("detrended cross-section (ground only)")
    ax[1].axhline(0, color="0.7", lw=0.8)
    fig.tight_layout()
    fig.savefig(os.path.join(outdir, f"road_{label}.png"), dpi=110)
    print(json.dumps({k: v for k, v in result.items() if k not in ("xsec", "profile")}, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:7])

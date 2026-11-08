"""Pass 2 of the lidar tile bake in blocks (tools/bake_lidar_tiles.py): bake_pilot.py's ground grid and
road ribbons over any set of tiles, a block at a time, with the same result whatever the block size.

bake_pilot bakes one box: it clips every road to the box before placing its stations, and takes each
road side's curb height and each junction's size from what lies inside. Baked box by box, the same road
would get different stations and statistics in two boxes and the tiles would not meet. So here:
- stations are placed once, along whole roads (bake_pilot.densify on the full polyline), and kept
  within STATION_PAD of covered tiles;
- what only needs the ground around it runs per block of `block` x `block` tiles plus a one-tile
  margin, for the stations and tiles in the block's core:
  - pass A: the 2 m grid (bake_pilot.FILL_JITTER and FILL_ANCHOR, so a filled node depends only on
    the ground around it, at the sea and the coverage edge too), with ground under the sea's level
    that the sea does not reach raised to a floor (pits: within PIT_REACH of a node), and each
    station's measured cross-section;
  - pass B: station heights (the grid in junctions) and where a ribbon lies under another (levels);
  - pass C: ribbons burnt into the grid, pits again off the ribbons (a road burnt in above a channel
    under the sea's level cuts off the ground beyond it), and the ribbons' outer edges set to it;
- what takes a whole road or junction runs once, over all stations, between passes A and B: per road
  side curb height, curb and crown (medians), the rolling medians along each run, junction sizes,
  the cross-section offsets; and, after pass B, the split of runs where a station lies under a ribbon.
Every tile's grid and every station's values come from the one block whose core holds them, and every
block sees a tile of ground around its core, so the result does not depend on the blocks
(tools/test_lidar_v2.mjs checks two block sizes against each other).
Lakes keep the 8 m ground's carved bed: the lidar's few returns over a lake are off its surface (or a
drained bed), and with the fill they would pave it over, so lake nodes count as without ground
(bake_pilot.WATER_EXTRA) and, like the sea, take the 8 m ground away from the shore.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from scipy import ndimage  # noqa: E402

import lidar_tiles as L  # noqa: E402
from lidar_tiles import P, TS, V  # noqa: E402

STATION_PAD = 16.0      # m: stations this far outside covered tiles join the whole-road statistics and
                        # rolling medians; split_levels drops them (no block holds them), so ribbons end
                        # at the last station inside coverage, where the edge feather has taken over
NT = int(TS / P.CELL)   # 256 grid cells per tile
PIT_FLOOR = 0.5         # m: ground of a pit (see pits) is raised to this, just above the sea plane
PIT_REACH = 128         # grid steps (256 m): how far the sea reaches through ground under its level;
                        # the longest reach in SF is under 128, and well inside a block's margin


def log(*a):
    P.log(*a)


# ---------------------------------------------------------------------------------- geometry
def tile_of(x, z):
    return np.floor(np.asarray(x) / TS).astype(np.int64), np.floor(np.asarray(z) / TS).astype(np.int64)


def tile_key(i, j):
    """A tile as one integer (tile indices stay well inside +-4096), for vectorised membership tests."""
    return (np.asarray(i, np.int64) + 4096) * 8192 + (np.asarray(j, np.int64) + 4096)


def set_tiles(u):
    i, j = tile_of(u["xy"][:, 0], u["xy"][:, 1])
    u["tile"] = np.stack([i, j], axis=1)
    u["tkey"] = tile_key(i, j)


def near_cover(xy, cover_keys):
    """Stations within STATION_PAD of a covered tile (cover_keys: tile_key of each covered tile)."""
    ok = np.zeros(len(xy), bool)
    for dx in (-STATION_PAD, 0.0, STATION_PAD):
        for dz in (-STATION_PAD, 0.0, STATION_PAD):
            ok |= np.isin(tile_key(*tile_of(xy[:, 0] + dx, xy[:, 1] + dz)), cover_keys)
    return ok


def per_station_keys(u):
    N = len(u["xy"])
    return [k for k, v in u.items() if isinstance(v, np.ndarray) and v.shape[:1] == (N,)]


def slice_run(u, idx):
    """The stations `idx` (contiguous) of run u, every per-station array sliced, the rest shared."""
    keys = per_station_keys(u)
    v = dict(u)
    for k in keys:
        v[k] = u[k][idx]
    return v


def build_runs(W, cover):
    """Runs of stations along whole roads, kept near coverage (bake_pilot.build_ribbons' first step,
    without the clip to a box)."""
    jq = {(int(round(x * 4)), int(round(z * 4))): k for k, (x, z) in enumerate(W["jxz"])}
    ci = np.array([t[0] for t in cover]); cj = np.array([t[1] for t in cover])
    bx0, bx1 = ci.min() * TS - 64, (ci.max() + 1) * TS + 64
    bz0, bz1 = cj.min() * TS - 64, (cj.max() + 1) * TS + 64
    cover_keys = tile_key(ci, cj)
    runs = []
    for r in W["roads"]:
        if r["bridge"] or len(r["pts"]) < 2:
            continue
        p = r["pts"]
        if p[:, 0].max() < bx0 or p[:, 0].min() > bx1 or p[:, 1].max() < bz0 or p[:, 1].min() > bz1:
            continue
        xy, s, t, n = P.densify(p)
        keep = near_cover(xy, cover_keys)
        if not keep.any():
            continue
        jn = sorted({jq[q] for q in ((int(round(x * 4)), int(round(z * 4))) for x, z in p) if q in jq})
        u = {"road": r, "xy": xy, "s": s, "t": t, "n": n, "junctions": jn}
        runs.extend(P.split_run(u, keep) if not keep.all() else [u])
    for u in runs:
        set_tiles(u)
    log("%d ribbon runs, %d stations" % (len(runs), sum(len(u["xy"]) for u in runs)))
    return runs


def blocks_of(cover, block):
    """Blocks of block x block tiles: {(bi, bj): [core tiles]}."""
    out = {}
    for i, j in cover:
        out.setdefault((i // block, j // block), []).append((i, j))
    return out


def block_box(bi, bj, block):
    """The block's core plus a one-tile margin, as (x0, z0, x1, z1)."""
    return ((bi * block - 1) * TS, (bj * block - 1) * TS, ((bi + 1) * block + 1) * TS, ((bj + 1) * block + 1) * TS)


def in_core(u, core):
    """Stations of u whose tile is one of `core` (a set of tiles)."""
    keys = np.fromiter((int(tile_key(i, j)) for i, j in core), np.int64, len(core))
    return np.isin(u["tkey"], keys)


def pieces_in(runs, box):
    """(run index, station indices) for each contiguous piece of a run inside `box`."""
    out = []
    for r, u in enumerate(runs):
        x, z = u["xy"][:, 0], u["xy"][:, 1]
        sel = (x >= box[0]) & (x <= box[2]) & (z >= box[1]) & (z <= box[3])
        if not sel.any():
            continue
        idx = np.flatnonzero(sel)
        for piece in np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1):
            out.append((r, piece))
    return out


def block_world(box):
    V.V2_BBOX = box
    P.BBOX = box
    return V.load_world_v2()


# ------------------------------------------------------------------------------------- lakes
def lake_mask(lakes, box, shape):
    """Grid nodes of `box` inside a lake ring (net.json lakes)."""
    x0, z0 = box[0], box[1]
    nz, nx = shape
    img = Image.new("1", (nx, nz), 0)
    dr = ImageDraw.Draw(img)
    for lk in lakes:
        ring = np.asarray(lk["ring"], float)
        if ring[:, 0].max() < box[0] or ring[:, 0].min() > box[2] or ring[:, 1].max() < box[1] or ring[:, 1].min() > box[3]:
            continue
        dr.polygon([((x - x0) / P.CELL, (z - z0) / P.CELL) for x, z in ring], fill=1)
    return np.asarray(img, dtype=bool)


def outside_cover(cover, box, shape):
    """Grid nodes of `box` on no covered tile (a node on a tile edge is on both tiles)."""
    nz, nx = shape
    keys = np.fromiter((int(tile_key(i, j)) for i, j in cover), np.int64, len(cover))
    x = box[0] + np.arange(nx) * P.CELL
    z = box[1] + np.arange(nz) * P.CELL
    inside = np.zeros(shape, bool)
    for ex in (0.0, 1.0):       # 1 m back: a node on a tile edge is also on the tile before it
        for ez in (0.0, 1.0):
            I, J = np.meshgrid(np.floor((x - ex) / TS), np.floor((z - ez) / TS))
            inside |= np.isin(tile_key(I, J), keys)
    return ~inside


# ------------------------------------------------------------------------------------- pits
def pits(W, G, box):
    """Nodes of `box`'s grid G under the sea's level (y < 0) that the sea does not reach. The game has
    one sea plane at y = 0, so all ground under it reads as sea: a garage ramp, a construction pit or
    an empty tank inland would be a pool. The sea is where the 8 m ground is under 0, and from there
    ground under 0 joined to it (8 neighbours) within PIT_REACH nodes: lidar may move the shore (slips,
    seawalls), but makes no water inland. Under 0 as the patch stores it (bake_lidar_tiles.write_patches:
    float32, whole cm on a whole-metre hBase): -0.004 m is stored as 0.00, dry ground, and must not
    join a pool to the sea."""
    below = np.rint(G.astype(np.float32).astype(np.float64) * 100) < 0
    if not below.any():
        return below
    nz, nx = G.shape
    XX, ZZ = np.meshgrid(box[0] + np.arange(nx) * P.CELL, box[1] + np.arange(nz) * P.CELL)
    seed = below & (P.old_height(W, XX, ZZ) < 0)
    sea = ndimage.binary_dilation(seed, structure=np.ones((3, 3), bool), iterations=PIT_REACH, mask=below)
    return below & ~sea


def raise_pits(r, pit):
    """Lidar cells (0.25 m raster r, in place) of pit nodes and the nodes around them, under
    PIT_FLOOR, to PIT_FLOOR: the grid filled again from r, and the road sections measured on it, then
    stand on the floor. Cells map to nodes as in bake_pilot.dtm_grid (+- CELL / 2 around a node)."""
    k = int(round(P.CELL / P.FINE))
    pad = k // 2
    for j, i in zip(*np.nonzero(ndimage.binary_dilation(pit, structure=np.ones((3, 3), bool)))):
        c = r[max(j * k - pad, 0):j * k - pad + k, max(i * k - pad, 0):i * k - pad + k]
        c[c < PIT_FLOOR] = PIT_FLOOR


# ------------------------------------------------------------------------------------ pass A
def pass_a(runs, cover, block, lakes, stats):
    """Per block: the 2 m grid of its core tiles (before burning) and the measurements of the
    stations in its core, pits raised in both. Returns {tile: G0 (257 x 257 float32)}."""
    G0 = {}
    stats["pits"] = {"nodes": 0, "left_after_raise": 0, "after_burn": 0}
    for u in runs:
        u["m"] = {k: np.full(len(u["xy"]), np.nan) for k in ("c", "gA", "riseA", "crownA", "gB", "riseB", "crownB")}
    blocks = blocks_of(cover, block)
    per = int(TS / P.FINE)
    t0 = time.perf_counter()
    for nb, ((bi, bj), core) in enumerate(sorted(blocks.items())):
        core = set(core)
        box = block_box(bi, bj, block)
        W = block_world(box)
        nzf, nxf = int((box[3] - box[1]) / P.FINE), int((box[2] - box[0]) / P.FINE)
        r = np.full((nzf, nxf), np.nan, np.float32)
        for j in range(int(box[1] // TS), int(box[3] // TS)):
            for i in range(int(box[0] // TS), int(box[2] // TS)):
                if (i, j) in cover:
                    rr, cc = int((j * TS - box[1]) / P.FINE), int((i * TS - box[0]) / P.FINE)
                    r[rr:rr + per, cc:cc + per] = L.load_r025(i, j)
        st = {"lidar": {}}
        r = P.mask_buildings(W, r, st)
        P.WATER_EXTRA = lambda shape, box=box: lake_mask(lakes, box, shape)
        P.ANCHOR_EXTRA = lambda shape, box=box: outside_cover(cover, box, shape)
        try:
            G = P.dtm_grid(W, r, st)
            pit = left = pits(W, G, box)
            if pit.any():
                raise_pits(r, pit)
                G = P.dtm_grid(W, r, st)
                left = pits(W, G, box)     # a few: nodes filled from ground farther off than the raise
                G[left] = PIT_FLOOR
        finally:
            P.WATER_EXTRA = P.ANCHOR_EXTRA = None
        for (i, j) in core:
            oi, oj = int((i * TS - box[0]) / P.CELL), int((j * TS - box[1]) / P.CELL)
            G0[(i, j)] = G[oj:oj + NT + 1, oi:oi + NT + 1].astype(np.float32).copy()
            stats["pits"]["nodes"] += int(pit[oj:oj + NT, oi:oi + NT].sum())
            stats["pits"]["left_after_raise"] += int(left[oj:oj + NT, oi:oi + NT].sum())
        for u in runs:
            sel = in_core(u, core)
            if sel.any():
                m = P.measure(r, u["xy"][sel], u["t"][sel], u["n"][sel])
                for k, v in m.items():
                    u["m"][k][sel] = v
        del r, G, W
        el = time.perf_counter() - t0
        log("pass A block %d/%d (%d tiles), %.0f s per block, %.1f min to go" % (
            nb + 1, len(blocks), len(core), el / (nb + 1), el / (nb + 1) * (len(blocks) - nb - 1) / 60))
    stats["passA_s"] = round(time.perf_counter() - t0, 1)
    return G0


# ------------------------------------------------------------------------- global, after A
def global_params(runs, W, stats):
    """bake_pilot.build_ribbons steps 1-5 that take whole roads and junctions: junction masking, per
    road side statistics, per station gutters, curb heights and crown line, junction sizes, knot
    offsets. Station heights (the grid in junctions) come per block in pass B."""
    for u in runs:
        if u["junctions"]:
            J = W["jxz"][u["junctions"]]
            d = np.min(np.hypot(u["xy"][:, None, 0] - J[None, :, 0], u["xy"][:, None, 1] - J[None, :, 1])
                       - W["jr"][u["junctions"]][None, :], axis=1)
            for k in ("gA", "riseA", "crownA", "gB", "riseB", "crownB"):
                u["m"][k][d < 8.0] = np.nan
    by_road = {}
    for u in runs:
        by_road.setdefault(u["road"]["i"], []).append(u)
    side_info = {}
    for ri, us in by_road.items():
        road = us[0]["road"]
        hw = max(2.0, road["width"] / 2)
        info = {}
        for side in "AB":
            g = np.concatenate([u["m"]["g" + side] for u in us])
            rise = np.concatenate([u["m"]["rise" + side] for u in us])
            crown = np.concatenate([u["m"]["crown" + side] for u in us])
            nv = int(np.isfinite(rise).sum())
            if nv >= 3:
                rv = float(np.clip(np.nanmedian(rise), 0.06, 0.25))
                info[side] = {"curb": True, "measured": True, "rise": rv, "n": nv,
                              "g": float(np.nanmedian(g)), "crown": float(np.clip(np.nanmedian(crown), 0.0, 0.30))}
            else:
                info[side] = {"curb": road["sidewalk"], "measured": False,
                              "rise": P.DEFAULT_RISE if road["sidewalk"] else 0.0, "n": nv, "g": hw, "crown": 0.02 * hw}
        side_info[ri] = info
    for u in runs:
        info = side_info[u["road"]["i"]]
        for side in "AB":
            g = P.rolling_nanmedian(u["m"]["g" + side], 5)
            u["g" + side] = np.clip(P.fill_along(u["s"], g, info[side]["g"]), P.SEARCH[0], P.SEARCH[1])
            if info[side]["measured"]:
                rr = P.rolling_nanmedian(u["m"]["rise" + side], 5)
                u["rise" + side] = np.clip(P.fill_along(u["s"], rr, info[side]["rise"]), 0.06, 0.25)
            else:
                u["rise" + side] = np.full(len(u["xy"]), info[side]["rise"])
        c = P.rolling_nanmedian(u["m"]["c"], 3)
        u["c_from_grid"] = not bool(np.isfinite(c).any())
        u["c"] = P.fill_along(u["s"], c, 0.0)
    parts = [u["m"]["rise" + side] - u["rise" + side] for u in runs for side in "AB" if side_info[u["road"]["i"]][side]["measured"]]
    dev = np.concatenate(parts) if parts else np.zeros(0)
    dev = dev[np.isfinite(dev)]
    stats["ribbons"] = {"curb_windows": int(dev.size),
                        "curb_windows_within_2cm_frac": round(float(np.mean(np.abs(dev) <= 0.02)), 3) if dev.size else None,
                        "curb_window_dev_m_p50_p90_abs": [round(float(np.percentile(np.abs(dev), q)), 3) for q in (50, 90)] if dev.size else None}
    r_eff = {}
    for u in runs:
        for j in u["junctions"]:
            J = W["jxz"][j]
            dj = np.hypot(u["xy"][:, 0] - J[0], u["xy"][:, 1] - J[1])
            k = int(np.argmin(dj))
            r_eff.setdefault(j, W["jr"][j])
            if dj[k] < 30.0:
                r_eff[j] = max(r_eff[j], max(u["gA"][k], u["gB"][k]) + P.BEVEL + 0.5)
    for u in runs:
        if u["junctions"]:
            J = W["jxz"][u["junctions"]]
            R = np.array([r_eff[j] for j in u["junctions"]])
            d = np.hypot(u["xy"][:, None, 0] - J[None, :, 0], u["xy"][:, None, 1] - J[None, :, 1]) - R[None, :]
            u["jd"] = d.min(axis=1)
        else:
            u["jd"] = np.full(len(u["xy"]), 1e3)
        u["w"] = P.smoothstep(u["jd"] / 4.0)
    for u in runs:
        info = side_info[u["road"]["i"]]
        N = len(u["xy"])
        off = np.zeros((N, 7))
        for side, sgn, (kg, kc, kw) in (("A", 1, (4, 5, 6)), ("B", -1, (2, 1, 0))):
            si = info[side]
            g = u["g" + side]
            Cc = g + np.maximum(0.01, (P.BEVEL if si["curb"] else 0.05) * u["w"])
            Wd = Cc + np.maximum(0.01, (P.WALK if si["curb"] else P.SHOULDER) * u["w"])
            off[:, kg], off[:, kc], off[:, kw] = sgn * g, sgn * Cc, sgn * Wd
        u["off"] = off
        u["kx"] = u["xy"][:, None, 0] + off * u["n"][:, None, 0]
        u["kz"] = u["xy"][:, None, 1] + off * u["n"][:, None, 1]
        u["info"] = info
        del u["m"]
    stats["ribbons"]["junctions"] = len(r_eff)
    stats["ribbons"]["measure_note"] = "per road side over whole roads"
    return side_info


# ------------------------------------------------------------------------------------ pass B
def block_grid(tiles_G, box, W):
    """The block's grid from the tiles' grids; where no tile has one (outside coverage), the 8 m ground."""
    nx, nz = int((box[2] - box[0]) / P.CELL) + 1, int((box[3] - box[1]) / P.CELL) + 1
    G = np.full((nz, nx), np.nan, np.float64)
    for j in range(int(box[1] // TS), int(box[3] // TS)):
        for i in range(int(box[0] // TS), int(box[2] // TS)):
            g = tiles_G.get((i, j))
            if g is not None:
                oi, oj = int((i * TS - box[0]) / P.CELL), int((j * TS - box[1]) / P.CELL)
                G[oj:oj + NT + 1, oi:oi + NT + 1] = g
    miss = np.isnan(G)
    if miss.any():
        XX, ZZ = np.meshgrid(box[0] + np.arange(nx) * P.CELL, box[1] + np.arange(nz) * P.CELL)
        G[miss] = P.old_height(W, XX[miss], ZZ[miss])
    return G


def station_heights(u, idx, G, box):
    """bake_pilot.build_ribbons step 5's heights for stations idx of run u: the measured section,
    the grid where it ramps into a junction."""
    v = slice_run(u, idx)
    c = P.tri_interp(G, box[0], box[1], P.CELL, v["xy"][:, 0], v["xy"][:, 1]) if u["c_from_grid"] else v["c"]
    hp = np.zeros((len(idx), 7))
    hp[:, 3] = c
    for side, kg, kc, kw in (("A", 4, 5, 6), ("B", 2, 1, 0)):
        si = u["info"][side]
        crown = si["crown"] if si["measured"] else 0.02 * v["g" + side]
        gutter = c - crown
        hp[:, kg] = gutter
        hp[:, kc] = gutter + v["rise" + side]
        hp[:, kw] = gutter + v["rise" + side]
    gk = P.tri_interp(G, box[0], box[1], P.CELL, v["kx"], v["kz"])
    w = v["w"][:, None]
    return w * hp + (1 - w) * gk


def under_flags(pieces, shape):
    """bake_pilot.resolve_levels' rule without the split: per piece, its stations whose roadway lies
    more than LEVEL_GAP under another run's ribbon. pieces: [(run id, piece dict with xy, n, off, h)]."""
    nodes, hs, rs = [], [], []
    for r, v in pieces:
        px, pz, h, _ = P.ribbon_samples(v)
        ii, jj, ok = P.node_index(px, pz, shape)
        nodes.append(jj[ok] * shape[1] + ii[ok]); hs.append(h[ok]); rs.append(np.full(int(ok.sum()), r))
    if not nodes:
        return []
    nodes, hs, rs = np.concatenate(nodes), np.concatenate(hs), np.concatenate(rs)
    order = np.lexsort((-hs, nodes))
    nodes, hs, rs = nodes[order], hs[order], rs[order]
    first = np.r_[True, nodes[1:] != nodes[:-1]]
    gid = np.cumsum(first) - 1
    ukeys = nodes[first]
    h1, r1 = hs[first], rs[first]
    other = rs != r1[gid]
    h2 = np.full(ukeys.size, -np.inf)
    on = nodes[other]
    if on.size:
        f2 = np.r_[True, on[1:] != on[:-1]]
        h2[np.searchsorted(ukeys, on[f2])] = hs[other][f2]
    out = []
    for r, v in pieces:
        px, pz, h, si = P.ribbon_samples(v, roadway_only=True)
        ii, jj, ok = P.node_index(px, pz, shape)
        k = np.searchsorted(ukeys, jj[ok] * shape[1] + ii[ok])
        top_other = np.where(r1[k] == r, h2[k], h1[k])
        under = np.zeros(len(v["xy"]), bool)
        under[si[ok][top_other - h[ok] > P.LEVEL_GAP]] = True
        out.append(under)
    return out


def pass_b(runs, cover, block, G0, stats):
    """Per block: heights of its core's stations, and which of them lie under another ribbon."""
    for u in runs:
        u["h"] = np.full((len(u["xy"]), 7), np.nan)
        u["under"] = np.zeros(len(u["xy"]), bool)
    blocks = blocks_of(cover, block)
    t0 = time.perf_counter()
    for (bi, bj), core in sorted(blocks.items()):
        core = set(core)
        box = block_box(bi, bj, block)
        W = block_world(box)
        G = block_grid(G0, box, W)
        pieces = []
        for r, idx in pieces_in(runs, box):
            u = runs[r]
            h = station_heights(u, idx, G, box)
            mine = in_core(slice_run(u, idx), core)
            u["h"][idx[mine]] = h[mine]
            v = {"xy": u["xy"][idx], "n": u["n"][idx], "off": u["off"][idx], "h": h}
            pieces.append((r, idx, v))
        flags = under_flags([(r, v) for r, _, v in pieces], G.shape)
        for (r, idx, v), un in zip(pieces, flags):
            mine = in_core(slice_run(runs[r], idx), core)
            runs[r]["under"][idx[mine]] = un[mine]
    stats["passB_s"] = round(time.perf_counter() - t0, 1)


def split_levels(runs, cover, stats):
    """Drop stations under another ribbon (splitting runs, bake_pilot.split_run), and the stations of
    the STATION_PAD fringe outside every covered tile: no block's core holds them, so they have no
    heights. (They were kept until now for the whole-road statistics and rolling medians.)"""
    out, dropped, total = [], 0, 0
    for u in runs:
        keep = ~u["under"] & np.isfinite(u["h"]).all(axis=1)
        total += len(keep)
        dropped += int(u["under"].sum())
        out.extend(P.split_run(u, keep) if not keep.all() else [u])
    stats["ribbons"]["stations_dropped_under_upper_level"] = dropped
    stats["ribbons"]["stations_dropped_frac"] = round(dropped / max(total, 1), 4)
    return out


# ------------------------------------------------------------------------------------ pass C
def pass_c(runs, cover, block, G0, stats):
    """Per block: the core tiles' grid with ribbons burnt in (bake_pilot.burn), pits off the ribbons
    raised to PIT_FLOOR, and the core stations' outer knots set to it. As in bake_pilot.burn, every
    block burns the ribbons as they were before any outer knot moved: the new knots go to `edge` and
    replace the old ones only after the last block.
    Returns {tile: G (257 x 257 float32)}."""
    for u in runs:
        set_tiles(u)
        u["edge"] = np.full((len(u["xy"]), 2), np.nan)
    Gb = {}
    blocks = blocks_of(cover, block)
    under_n = 0
    for (bi, bj), core in sorted(blocks.items()):
        core = set(core)
        box = block_box(bi, bj, block)
        W = block_world(box)
        G = block_grid(G0, box, W)
        pieces = [slice_run(runs[r], idx) for r, idx in pieces_in(runs, box)]
        top = P.ribbon_at_nodes(pieces, G.shape)
        inside = np.isfinite(top)
        G = G.copy()
        G[inside] = top[inside] - P.BURN
        late = pits(W, G, box) & ~inside
        G[late] = PIT_FLOOR
        for (i, j) in core:
            oi, oj = int((i * TS - box[0]) / P.CELL), int((j * TS - box[1]) / P.CELL)
            Gb[(i, j)] = G[oj:oj + NT + 1, oi:oi + NT + 1].astype(np.float32).copy()
            under_n += int(inside[oj:oj + NT, oi:oi + NT].sum())
            stats["pits"]["after_burn"] += int(late[oj:oj + NT, oi:oi + NT].sum())
        for r, idx in pieces_in(runs, box):
            u = runs[r]
            mine = idx[in_core(slice_run(u, idx), core)]
            if len(mine):
                for c, k in enumerate((0, 6)):
                    u["edge"][mine, c] = P.tri_interp(G, box[0], box[1], P.CELL, u["kx"][mine, k], u["kz"][mine, k])
    for u in runs:
        assert np.isfinite(u["edge"]).all(), "a station no block holds"
        u["h"][:, 0], u["h"][:, 6] = u["edge"][:, 0], u["edge"][:, 1]
        del u["edge"]
    stats["grid"] = {"tiles": len(Gb), "nodes_under_ribbons_frac": round(under_n / max(len(Gb) * NT * NT, 1), 3)}
    return Gb


# --------------------------------------------------------------------------------------- run
def bake(cover, block, lakes, stats):
    """Pass 2 over `cover` (set of tiles): returns (final runs, {tile: grid})."""
    t0 = time.perf_counter()
    V.V2_BBOX = (min(i for i, _ in cover) * TS, min(j for _, j in cover) * TS,
                 (max(i for i, _ in cover) + 1) * TS, (max(j for _, j in cover) + 1) * TS)
    P.BBOX = V.V2_BBOX
    W = V.load_world_v2()
    runs = build_runs(W, cover)
    G0 = pass_a(runs, cover, block, lakes, stats)
    global_params(runs, W, stats)
    pass_b(runs, cover, block, G0, stats)
    runs = split_levels(runs, cover, stats)
    Gb = pass_c(runs, cover, block, G0, stats)
    stats["pass2_s"] = round(time.perf_counter() - t0, 1)
    stats["ribbons"].update({"runs": len(runs), "stations": int(sum(len(u["xy"]) for u in runs)),
                             "km": round(sum(float(np.sum(np.hypot(*np.diff(u["xy"], axis=0).T))) for u in runs) / 1000, 1)})
    return runs, Gb, W

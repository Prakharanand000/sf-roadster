"""Bay Bridge deck heights from lidar, for the v2 bake (M6, tools/research/v2-build-plan.md).

For every OSM way of the crossing (I-80 from the SF approach to the Oakland touchdown, both
directions, the Yerba Buena Island tunnel, and every freeway ramp in the box), sample the deck surface every STEP m along the
way: the upper envelope (p90) of non-noise, non-water lidar returns within the way's lanes.
Lidar sees the top of a stacked structure only (lidar-probes.md §2), which on the west span is
the upper deck; that is the one the game builds. Stations with no deck returns (tunnel, gaps)
are left empty here and filled by the bake.

Writes CACHE/v2/bridge_profile.json: {way_id: {"xz": [[x, z], ...], "h": [h or null, ...],
"project": name, "points": n}} with x, z in v2 world metres (z = -northing) and h in NAVD88 m.

    python tools/probes/bridge_profile.py
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import numpy as np
import common as C
from geo2 import CACHE as V2CACHE, load_osm, proj

SF, A2, A3 = "CA_SanFrancisco_1_B23", "CA_AlamedaCo_2_2021", "CA_AlamedaCo_3_2021"
STEP = 8.0          # m between stations
ALONG = 4.0         # m: points within +-ALONG of a station count for it
CHUNK = 220.0       # m: lidar fetch boxes along the crossing
NOISE = (7, 9, 18)  # low noise, water, high noise
BOX = dict(s=37.776, n=37.835, w=-122.395, e=-122.285)   # the crossing, Rincon Hill to the toll plaza


def crossing_ways():
    """I-80 / Bay Bridge ways (and their ramps on structure) inside BOX, as (id, tags, Nx2 xz)."""
    out = []
    for e in load_osm('roads'):
        if e['type'] != 'way':
            continue
        t = e.get('tags', {})
        g = [p for p in e['geometry'] if p]
        if not g:
            continue
        lat = sum(p['lat'] for p in g) / len(g)
        lon = sum(p['lon'] for p in g) / len(g)
        if not (BOX['s'] < lat < BOX['n'] and BOX['w'] < lon < BOX['e']):
            continue
        # the crossing itself, and every freeway ramp in the box (on-ramps join the decks high up)
        bay = 'Bay Bridge' in t.get('bridge:name', '') or 'Bay Bridge' in t.get('name', '') or t.get('ref', '') == 'I 80'
        if not ((bay and t.get('highway') == 'motorway') or t.get('highway') == 'motorway_link'):
            continue
        xz = np.array([proj(p['lat'], p['lon']) for p in g])
        if xz[:, 0].mean() > 8700:   # beyond the toll plaza (tools/baybridge_v2.py EAST_LIMIT)
            continue
        out.append((e['id'], t, xz))
    return out


def stations(xz, step=STEP):
    seg = np.hypot(*np.diff(xz, axis=0).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(math.ceil(s[-1] / step)) + 1)
    q = np.linspace(0, s[-1], n)
    x = np.interp(q, s, xz[:, 0]); z = np.interp(q, s, xz[:, 1])
    dx = np.gradient(x); dz = np.gradient(z)
    L = np.hypot(dx, dz) + 1e-9
    return np.c_[x, z], np.c_[dx / L, dz / L]


def main():
    ways = crossing_ways()
    print('ways on the crossing:', len(ways))
    # stations of every way, each assigned to the CHUNK box it lies in; boxes are fetched with a 30 m
    # margin, so a station's neighbourhood (< 12 m) is always complete in its own box
    from scipy.spatial import cKDTree
    W = []
    for wid, t, xz in ways:
        st, tan = stations(xz)
        lanes = float(t.get('lanes', 2) or 2)
        W.append(dict(id=wid, t=t, st=st, tan=tan, hw=max(3.0, lanes * 3.6 / 2), lanes=lanes, h=[None] * len(st)))
    by_box = {}
    for wi, w in enumerate(W):
        for si, q in enumerate(w['st']):
            by_box.setdefault(tuple(np.floor(q / CHUNK).astype(int)), []).append((wi, si))
    print('lidar boxes:', len(by_box))
    src = {}
    for (kx, kz) in sorted(by_box):
        x0, z0 = kx * CHUNK - 30, kz * CHUNK - 30
        x1, z1 = x0 + CHUNK + 60, z0 + CHUNK + 60
        # SFT1 y is northing = -z
        b = C.bounds_3857_from_sft1(x0, -z1, x1, -z0)
        got = None
        for proj_name in (SF, A2, A3):
            try:
                p, st_ = C.read_ept(proj_name, b)
            except RuntimeError as err:
                print('  ', proj_name, 'failed:', str(err)[:120])
                continue
            keep = ~np.isin(p['Classification'], NOISE) & ~p['Withheld']
            if keep.sum() > 1000:
                got = (proj_name, p, keep)
                break
        if not got:
            print('  box', kx, kz, 'no lidar')
            continue
        name, p, keep = got
        src[(kx, kz)] = name
        X, Z, Hh, Cl = p['X'][keep], -p['Y'][keep], p['Z'][keep], p['Classification'][keep]
        del p
        tree = cKDTree(np.c_[X, Z])
        for wi, si in by_box[(kx, kz)]:
            w = W[wi]
            (x, z), (tx, tz), hw = w['st'][si], w['tan'][si], w['hw']
            idx = tree.query_ball_point([x, z], r=math.hypot(hw, ALONG))
            if not idx:
                continue
            idx = np.asarray(idx)
            dx, dz = X[idx] - x, Z[idx] - z
            along = dx * tx + dz * tz
            lat = -dx * tz + dz * tx
            m = (np.abs(along) <= ALONG) & (np.abs(lat) <= hw)
            # the deck: class 17 where tagged, else the highest dense layer of returns
            h = Hh[idx][m]; c = Cl[idx][m]
            if (c == 17).sum() >= 8:
                h = h[c == 17]
            if len(h) >= 8:
                w['h'][si] = round(float(np.percentile(h, 90)), 2)
        print('  box %d,%d: %s %d pts, %d stations' % (kx, kz, name, int(keep.sum()), len(by_box[(kx, kz)])), flush=True)
        del X, Z, Hh, Cl, tree
    out = {}
    for w in W:
        t, hs = w['t'], w['h']
        out[str(w['id'])] = dict(xz=np.round(w['st'], 2).tolist(), h=hs, name=t.get('name', ''), layer=t.get('layer', ''),
                                 tunnel=t.get('tunnel', ''), bridge=t.get('bridge', ''), lanes=w['lanes'],
                                 filled=int(sum(v is not None for v in hs)), n=len(hs))
        print('way %s %-28s layer %-3s tunnel %-4s %4d stations, %4d with deck' % (w['id'], t.get('name', '')[:28], t.get('layer', ''), t.get('tunnel', ''), len(hs), out[str(w['id'])]['filled']))
    path = os.path.join(V2CACHE, 'bridge_profile.json')
    with open(path, 'w') as f:
        json.dump(dict(ways=out, sources={'%d,%d' % k: v for k, v in src.items()}), f)
    print('wrote', path)


if __name__ == '__main__':
    main()

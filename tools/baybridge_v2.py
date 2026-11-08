"""San Francisco-Oakland Bay Bridge for the v2 bake (M6, tools/research/v2-build-plan.md).

The v1 bake drops every road over the bay (only the Golden Gate deck survives) and every tunnel.
This module puts the crossing back, built so that today's game code drives it unchanged:

- Roads: the I-80 ways of the crossing (tools/probes/bridge_profile.py lists them: Rincon Hill to
  the Oakland toll plaza), plus bridge/tunnel ramps joined to them, flagged F_BAYB and densified.
- Stacked decks side by side: the west span, the YBI tunnel and the YBI east viaduct carry
  westbound on the upper deck and eastbound on the lower. The world API is 2D (roadAt and
  groundHeight cannot tell decks apart, and traffic places cars with groundHeight), so both
  directions are laid side by side at the upper deck's measured height: each stacked way moves
  half a deck width to its own right, tapering to zero over TAPER m along the approaches.
- Heights: lidar upper envelope per 8 m station (bridge_profile.json, NAVD88 - Y0), median
  filtered, then a graph smoother limits grades to GRADE while pinning every junction with an
  ordinary (draped) road to the ground there. At-grade stretches snap to the ground; tunnel
  stations (lidar sees the hill) are interpolated between the portals.
- Terrain: carved below the deck wherever the deck would be under ground (the YBI tunnel and its
  portal cuts). Over the tunnel the original hill is kept as a roof surface (cars on the island
  drive over it; cars in the tunnel do not see it), with walls along the bores.
- Solids: railings where a deck stands more than RAIL_DROP above the ground, except where another
  deck road joins; tunnel walls.
"""
import heapq
import json
import math
import os

import numpy as np
from scipy.spatial import cKDTree

import bake as v1
from geo2 import CACHE, CELL, GX0, GZ0, NX, NZ, Y0, geom_xy, load_osm

F_BAYB = 128
DENSE = 8.0         # m: max spacing of deck road points (the lidar station spacing)
GRADE = 0.06        # max deck grade (unless the deck's own pinned ends are steeper: deck_heights)
MERGE_COS = 0.866   # unmeasured decks this close to parallel (30 deg) may be one pavement
STACK_D = 8.0       # m: an opposite-direction way this close is the other deck of a stack
TAPER = 220.0       # m: side-by-side offset fades to 0 over this distance along the approaches
EAST_LIMIT = 8500.0  # x: the crossing ends at the Oakland toll plaza (beyond: draped, as v1)
AT_GRADE = 2.0      # m: lidar this close to the ground is a road on the ground (cars, booths)
RAIL_DROP = 2.5     # m: railings where the deck stands higher than this above the ground
RAIL_TOP = 1.8      # m: collision railings reach this far above the deck
CARVE_PAD = 8.0     # m beyond the road edge: terrain grid nodes kept under the deck
BOX = dict(s=37.776, n=37.835, w=-122.395, e=-122.285)

log = v1.log


def load_profile():
    with open(os.path.join(CACHE, 'bridge_profile.json'), encoding='utf8') as f:
        return json.load(f)['ways']


def _median5(h):
    """Median of the valid values in a 5-station window (None stays None)."""
    out = list(h)
    for i in range(len(h)):
        if h[i] is None:
            continue
        w = [v for v in h[max(0, i - 2):i + 3] if v is not None]
        out[i] = float(np.median(w))
    return out


def make_road(e):
    """A road dict as bake.load_roads builds it, for one OSM way (no sea / tunnel filtering)."""
    t = e.get('tags', {})
    hw = t.get('highway')
    p = geom_xy(e['geometry'])
    nodes = list(e['nodes'])
    lanes = v1.num(t.get('lanes'))
    oneway = t.get('oneway') in ('yes', '1', 'true') or hw in ('motorway',) or t.get('junction') == 'roundabout'
    w = v1.num(t.get('width'))
    if w is None or w < 3 or w > 40:
        if lanes:
            w = lanes * 3.4 + (0 if oneway or hw.startswith('motorway') else 2.0)
            w = max(w, v1.DEF_W[hw] * (0.6 if oneway else 0.8))
        else:
            w = v1.DEF_W[hw] * (0.75 if oneway and hw not in ('motorway',) else 1.0)
    w = float(min(max(w, 4.5), 24))
    flags = F_BAYB | v1.F_BRIDGE
    if oneway:
        flags |= v1.F_ONEWAY
    rev = t.get('oneway') == '-1'
    if rev:   # as bake.load_roads: drawn the way traffic goes
        p = p[::-1]; nodes = nodes[::-1]; flags |= v1.F_ONEWAY
    return dict(id=e['id'], p=p, nodes=nodes, type=hw, w=w, lanes=int(lanes or 0), flags=flags,
                name=t.get('name', ''), ref=t.get('ref', ''), tunnel=t.get('tunnel') not in (None, 'no'), rev=rev)


def _densify(r, next_id):
    """Points every <= DENSE m (new nodes get negative ids); also returns along-distance per point."""
    p, nodes = r['p'], r['nodes']
    P, N, S = [p[0]], [nodes[0]], [0.0]
    s = 0.0
    for i in range(1, len(p)):
        a, b = p[i - 1], p[i]
        L = float(np.hypot(*(b - a)))
        k = max(1, int(math.ceil(L / DENSE)))
        for j in range(1, k):
            P.append(a + (b - a) * j / k); N.append(next_id[0]); next_id[0] -= 1; S.append(s + L * j / k)
        s += L
        P.append(b); N.append(nodes[i]); S.append(s)
    r['p'] = np.array(P); r['nodes'] = N; r['s'] = np.array(S)


def add_bridge_roads(roads, profile):
    """Replace / add the crossing's ways in `roads`; returns the indices of the bridge roads."""
    els = {e['id']: e for e in load_osm('roads') if e['type'] == 'way' and e.get('geometry') and e.get('nodes')}
    ids = {int(k) for k, w in profile.items() if np.mean(np.array(w['xz'])[:, 0]) < EAST_LIMIT and int(k) in els}
    # ramps on structure joined to the crossing (YBI and SF approach links), within the crossing box
    node_ways = {}
    for wid, e in els.items():
        for n in e['nodes']:
            node_ways.setdefault(n, []).append(wid)
    grew = True
    while grew:
        grew = False
        for wid in list(ids):
            for n in els[wid]['nodes']:
                for o in node_ways.get(n, []):
                    if o in ids:
                        continue
                    t = els[o].get('tags', {})
                    if t.get('highway') not in v1.RT or (t.get('bridge') in (None, 'no') and t.get('tunnel') in (None, 'no')):
                        continue
                    g = [q for q in els[o]['geometry'] if q]
                    la = sum(q['lat'] for q in g) / len(g); lo = sum(q['lon'] for q in g) / len(g)
                    if BOX['s'] < la < BOX['n'] and BOX['w'] < lo < BOX['e']:
                        ids.add(o); grew = True
    before = len(roads)
    roads[:] = [r for r in roads if r['id'] not in ids]
    next_id = [-1]
    out = []
    for wid in sorted(ids):
        r = make_road(els[wid])
        if len(r['p']) < 2:
            continue
        _densify(r, next_id)
        r['osm_s'] = r['s'].copy()
        out.append(len(roads))
        roads.append(r)
    log('bay bridge roads: %d ways (%d were on land in v1 terms and replaced), %d tunnel' % (
        len(out), before - (len(roads) - len(out)), sum(1 for k in out if roads[k]['tunnel'])))
    return out


def _right(d):
    """Right-hand normal of a direction (x east, z south)."""
    return np.array([-d[1], d[0]])


def _lidar_along(r, profile):
    """Lidar deck height (NAVD88) at each point of bridge road r, or None (no profile / tunnel)."""
    w = profile.get(str(r['id']))
    if w is None or r['tunnel']:
        return None
    st = np.array(w['xz'])
    hv = _median5(w['h'])
    if r.get('rev'):   # the profile runs along the OSM way; this road runs the other way
        st, hv = st[::-1], hv[::-1]
    ss = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(st, axis=0).T))])
    ok = np.array([v is not None for v in hv])
    if ok.sum() < 2:
        return None
    sc = r['osm_s'][-1] / max(ss[-1], 1e-6)
    return np.interp(r['osm_s'], ss[ok] * sc, np.array([v for v in hv if v is not None]))


def shift_stacked(roads, bidx, profile):
    """Move the decks of opposite directions apart (see module doc). A point moves to its right by
    what it needs to clear the nearest opposite-direction deck at the same level by 1 m (the full
    half width plus 0.5 m where the two are stacked, less as the real roads part), and at least
    what a TAPER m fade from the stacked stretch gives (smooth approaches). Same level: lidar
    heights within 8 m (ramps crossing over each other further apart are left alone). Every road sharing a moved
    node moves with it."""
    dirs, meas = {}, {}
    samples, sdir, sroad, shw, sh = [], [], [], [], []
    for k in bidx:
        r = roads[k]
        p = r['p']
        d = np.gradient(p, axis=0)
        d /= np.linalg.norm(d, axis=1)[:, None] + 1e-12
        dirs[k] = d
        meas[k] = _lidar_along(r, profile)
        for i in range(len(p) - 1):
            L = float(np.hypot(*(p[i + 1] - p[i])))
            for t in np.linspace(0, 1, max(2, int(L / 2) + 1)):
                samples.append(p[i] + (p[i + 1] - p[i]) * t); sdir.append(d[i]); sroad.append(k); shw.append(r['w'] * 0.5)
                sh.append(np.nan if meas[k] is None else meas[k][i] + (meas[k][i + 1] - meas[k][i]) * t)
    samples = np.array(samples); sdir = np.array(sdir); sroad = np.array(sroad); shw = np.array(shw); sh = np.array(sh)
    tree = cKDTree(samples)
    reach = 2 * float(shw.max()) + 1.0
    disp, stacked = {}, {}
    for k in bidx:
        r = roads[k]
        hw = r['w'] * 0.5
        for i, (q, d) in enumerate(zip(r['p'], dirs[k])):
            y = np.nan if meas[k] is None else meas[k][i]
            need = 0.0
            for j in tree.query_ball_point(q, reach):
                if sroad[j] == k or float(np.dot(sdir[j], d)) >= -0.8:
                    continue
                if np.isfinite(y) and np.isfinite(sh[j]) and abs(y - sh[j]) > 8.0:
                    continue   # another level (8 m: two decks closer than that cannot both carry traffic)
                sep = float(np.hypot(*(samples[j] - q)))
                need = max(need, 0.5 * (hw + shw[j] + 1.0 - sep))
            if need > 0:
                n = r['nodes'][i]
                v = _right(d) * need
                if n not in disp or np.linalg.norm(v) > np.linalg.norm(disp[n]):
                    disp[n] = v
                if need >= hw * 0.5:
                    stacked[n] = v
    # fade from the stacked stretch along the bridge road graph
    adj = {}
    for k in bidx:
        r = roads[k]
        for i in range(len(r['p']) - 1):
            L = float(np.hypot(*(r['p'][i + 1] - r['p'][i])))
            a, b = r['nodes'][i], r['nodes'][i + 1]
            adj.setdefault(a, []).append((b, L)); adj.setdefault(b, []).append((a, L))
    best = {n: 0.0 for n in stacked}
    src = {n: n for n in stacked}
    pq = [(0.0, n) for n in stacked]
    heapq.heapify(pq)
    while pq:
        dd, u = heapq.heappop(pq)
        if dd > best.get(u, 1e18) or dd > TAPER:
            continue
        for v, L in adj.get(u, []):
            nd = dd + L
            if nd < best.get(v, 1e18) and nd <= TAPER:
                best[v] = nd; src[v] = src[u]
                heapq.heappush(pq, (nd, v))
    tapered = 0
    for n, dd in best.items():
        v = stacked[src[n]] * (1.0 - dd / TAPER)
        if n not in disp or np.linalg.norm(v) > np.linalg.norm(disp[n]):
            disp[n] = v; tapered += 1
    moved = 0
    for r in roads:
        for i, n in enumerate(r['nodes']):
            if n in disp:
                r['p'][i] = r['p'][i] + disp[n]
                moved += 1
    log('decks of opposite directions apart: %d nodes moved by need, %d by the fade, %d road points moved' % (
        len(disp) - tapered, tapered, moved))
    return disp


def _bilinear(H, x, z):
    return v1.bilinear(H, np.atleast_1d(np.asarray(x, float)), np.atleast_1d(np.asarray(z, float)))


def pilot_ground(H):
    """The ground as the game sees it with the lidar pilot (data/v2/pilot.*, tools/bake_pilot_v2.py):
    f(x, z) -> y inside its box, NaN outside. As pilot.js heightAt: the pilot's 2 m grid, blended into
    the terrain `H` over the feather band. Decks pinned to it meet the streets the pilot draws. The
    pilot is baked after the net; its ground does not depend on the decks, so a previous one is fine."""
    import struct
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'v2')
    jp, bp = os.path.join(root, 'pilot.json'), os.path.join(root, 'pilot.bin.wasm')
    if not (os.path.exists(jp) and os.path.exists(bp)):
        return None
    with open(jp, encoding='utf8') as f:
        idx = json.load(f)
    a = idx['arrays']['grid']
    g = idx['grid']
    with open(bp, 'rb') as f:
        buf = f.read()
    G = np.frombuffer(buf, dtype='<u2', count=a['length'], offset=a['offset']).astype(np.float64).reshape(g['nz'], g['nx']) * 0.01 + g['hBase']
    b, fe = idx['bbox'], idx['feather']
    # road ribbon stations: the centre knot is the measured road surface (heightAt there)
    K = idx['knots']
    sa, sh = idx['arrays']['st_xz'], idx['arrays']['st_h']
    st_xz = np.frombuffer(buf, dtype='<f4', count=sa['length'], offset=sa['offset']).reshape(-1, 2).astype(np.float64)
    st_c = np.frombuffer(buf, dtype='<u2', count=sh['length'], offset=sh['offset']).reshape(-1, K)[:, K // 2] * 0.01 + g['hBase']
    st_tree = cKDTree(st_xz)

    def f(x, z):
        x = np.atleast_1d(np.asarray(x, float)); z = np.atleast_1d(np.asarray(z, float))
        inside = (x > b['x0']) & (x < b['x1']) & (z > b['z0']) & (z < b['z1'])
        out = np.full(x.shape, np.nan)
        if inside.any():
            xi, zi = x[inside], z[inside]
            e = np.minimum.reduce([xi - b['x0'], b['x1'] - xi, zi - b['z0'], b['z1'] - zi])
            u = np.clip(e / fe, 0, 1)
            f_ = u * u * (3 - 2 * u)
            base = _bilinear(H, xi, zi)
            v = _tri(G, g, xi, zi)
            d, j = st_tree.query(np.c_[xi, zi])
            v = np.where(d < 3.0, st_c[np.minimum(j, len(st_c) - 1)], v)   # on a ribbon: its surface
            out[inside] = base + (v - base) * f_
        return out
    log('deck junctions use the lidar pilot ground inside %s' % b)
    f.bbox, f.feather = b, fe
    f.boxes, f.kind = [b], 'pilot'
    return f


def lidar_ground(H):
    """The ground as the game sees it with the lidar tile patches (data/v2/lidar/,
    tools/bake_lidar_tiles.py): f(x, z) -> y inside their coverage, NaN outside. As lidar2.js heightAt:
    each tile's 2 m grid (the measured road surface on a ribbon), blended into the terrain `H` within
    the feather of the edge of coverage (the 8 neighbours rule). `f.boxes`: the islands' boxes. Decks
    pinned to it meet the streets the patches draw. Patches don't depend on the decks, and their road
    fingerprints only on road positions, so the previous bake's patches are fine."""
    import struct
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'v2', 'lidar')
    ip = os.path.join(root, 'index.json')
    if not os.path.exists(ip):
        return None
    with open(ip, encoding='utf8') as f:
        L = json.load(f)
    TS, fe = float(L['tile']), float(L['feather'])
    tiles, st_xz, st_c = {}, [], []
    for i, j, _ in L['cover']:
        with open(os.path.join(root, '%d_%d.bin.wasm' % (i, j)), 'rb') as fh:
            d = fh.read()
        hl = struct.unpack('<I', d[:4])[0]
        head = json.loads(d[4:4 + hl])
        base = 4 + hl + (-(4 + hl)) % 8
        A = head['arrays']
        g = head['grid']
        arr = lambda n, t: np.frombuffer(d, dtype=t, count=A[n]['length'], offset=base + A[n]['offset'])
        tiles[(i, j)] = (arr('grid', '<u2').astype(np.float64).reshape(g['nz'], g['nx']) * 0.01 + g['hBase'], g)
        K = head['knots']
        st_xz.append(arr('st_xz', '<f4').reshape(-1, 2).astype(np.float64))
        st_c.append(arr('st_h', '<u2').reshape(-1, K)[:, K // 2] * 0.01 + g['hBase'])
    st_xz, st_c = np.concatenate(st_xz), np.concatenate(st_c)
    st_tree = cKDTree(st_xz)
    cov = set(tiles)
    NBR = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)]

    def edge_dist(i, j, x, z):
        """lidar2.js edgeDist for points of tile (i, j)."""
        L_, R_, T_, B_ = x - i * TS, (i + 1) * TS - x, z - j * TS, (j + 1) * TS - z
        d = np.full(x.shape, np.inf)
        for (di, dj), v in zip(NBR, [L_, R_, T_, B_, np.hypot(L_, T_), np.hypot(R_, T_), np.hypot(L_, B_), np.hypot(R_, B_)]):
            if (i + di, j + dj) not in cov:
                d = np.minimum(d, v)
        return d

    def f(x, z):
        x = np.atleast_1d(np.asarray(x, float)); z = np.atleast_1d(np.asarray(z, float))
        out = np.full(x.shape, np.nan)
        ti, tj = np.floor(x / TS).astype(int), np.floor(z / TS).astype(int)
        for (i, j), (G, g) in tiles.items():
            m = (ti == i) & (tj == j)
            if not m.any():
                continue
            xi, zi = x[m], z[m]
            e = edge_dist(i, j, xi, zi)
            u = np.clip(e / fe, 0, 1)
            f_ = u * u * (3 - 2 * u)
            base = _bilinear(H, xi, zi)
            v = _tri(G, g, xi, zi)
            dd, k = st_tree.query(np.c_[xi, zi])
            v = np.where(dd < 3.0, st_c[np.minimum(k, len(st_c) - 1)], v)   # on a ribbon: its surface
            out[m] = np.where(e > 0, base + (v - base) * f_, np.nan)
        return out
    # where OSM bridges become decks (bake_lidar_tiles.overpass_boxes; older indexes: their islands)
    raw = L.get('overpassBoxes') or [isl['box'] for isl in L.get('islands', {}).values()]
    boxes = [dict(x0=b[0], z0=b[1], x1=b[2], z1=b[3]) for b in raw]
    log('deck junctions use the lidar tile patches: %d tiles in %s' % (len(tiles), boxes))
    f.boxes, f.feather, f.kind = boxes, fe, 'lidar tiles'
    return f


def add_overpasses(roads, bidx, box):
    """OSM bridges reaching into `box` (one of the lidar ground's boxes) as decks: the lidar ground
    there has the cut they cross (Beale Street under Harrison Street), and a road draped over it would
    sag into the cut. Each spans between its ends, which deck_heights pins to the ground."""
    b0 = set(bidx)
    x0, z0, x1, z1 = box['x0'], box['z0'], box['x1'], box['z1']
    next_id = [min([n for k in bidx for n in roads[k]['nodes'] if n < 0] + [0]) - 1]
    out = []
    for k, r in enumerate(roads):
        if k in b0 or not (r['flags'] & v1.F_BRIDGE) or (r['flags'] & (v1.F_GGB | F_BAYB)):
            continue
        p = r['p']
        if not ((p[:, 0] > x0) & (p[:, 0] < x1) & (p[:, 1] > z0) & (p[:, 1] < z1)).any():
            continue
        r['flags'] |= F_BAYB
        r.setdefault('tunnel', False)
        _densify(r, next_id)
        r['osm_s'] = r['s'].copy()
        out.append(k)
    log('overpasses on decks inside %s: %d' % ([round(v) for v in (x0, z0, x1, z1)], len(out)))
    return out


def _tri(G, g, x, z):
    """Triangle interpolation on a grid (the split heightAt uses)."""
    fx = np.clip((x - g['x0']) / g['cell'], 0, g['nx'] - 1.0001)
    fz = np.clip((z - g['z0']) / g['cell'], 0, g['nz'] - 1.0001)
    ix, iz = fx.astype(int), fz.astype(int)
    tx, tz = fx - ix, fz - iz
    h00, h10, h01, h11 = G[iz, ix], G[iz, ix + 1], G[iz + 1, ix], G[iz + 1, ix + 1]
    lower = tx + tz <= 1
    return np.where(lower, h00 + (h10 - h00) * tx + (h01 - h00) * tz, h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz))


def deck_heights(roads, bidx, H, profile, ground=None):
    """Height per bridge node (dict node id -> y) and the set of nodes pinned to the ground.
    `ground(x, z)` (optional) overrides the terrain where it is not NaN (the lidar pilot)."""
    bset = set(bidx)
    other_nodes = set()
    for k, r in enumerate(roads):
        if k not in bset:
            other_nodes.update(r['nodes'])
    soft, hard, pos, gnd, measured_road = {}, {}, {}, {}, {}
    for k in bidx:
        r = roads[k]
        g = _bilinear(H, r['p'][:, 0], r['p'][:, 1])
        if ground is not None:
            gg = ground(r['p'][:, 0], r['p'][:, 1])
            g = np.where(np.isfinite(gg), gg, g)
        meas = _lidar_along(r, profile)
        measured_road[k] = meas is not None
        if meas is not None:
            meas = meas - Y0
        for i, n in enumerate(r['nodes']):
            pos[n] = r['p'][i]; gnd[n] = float(g[i])
            if n in other_nodes:
                hard[n] = float(g[i])
                if meas is not None and meas[i] - g[i] > 3.0:
                    joins = sorted({(o['name'] or o['type'], o['id']) for o in roads if n in o['nodes'] and o is not r})
                    log('  junction pinned to the ground under a deck %.1f m up at (%.0f, %.0f) on %s: %s' % (
                        meas[i] - g[i], r['p'][i][0], r['p'][i][1], r['id'], joins))
            elif meas is not None:
                m = float(meas[i])
                soft[n] = float(g[i]) if m - g[i] < AT_GRADE else m
    adj = {}
    for k in bidx:
        r = roads[k]
        for i in range(len(r['p']) - 1):
            L = float(np.hypot(*(r['p'][i + 1] - r['p'][i])))
            a, b = r['nodes'][i], r['nodes'][i + 1]
            adj.setdefault(a, []).append((b, L)); adj.setdefault(b, []).append((a, L))

    # where two roads' decks overlap at one level (a ramp merging into the main deck) they are the
    # same pavement: each mutually nearest pair of their nodes becomes one height variable
    # (pairs only, so a long side-by-side stretch does not collapse into a single flat height)
    par = {n: n for n in pos}

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]; a = par[a]
        return a
    road_nodes = {k: [n for n in roads[k]['nodes']] for k in bidx}
    trees = {k: cKDTree(roads[k]['p']) for k in bidx}
    tang = {}
    for k in bidx:
        t = np.gradient(roads[k]['p'], axis=0) if len(roads[k]['p']) > 1 else np.zeros((1, 2))
        tang[k] = t / (np.linalg.norm(t, axis=1)[:, None] + 1e-12)
    pairs = 0
    for ka in bidx:
        ra = roads[ka]
        for kb in bidx:
            if kb <= ka:
                continue
            rb = roads[kb]
            reach = 0.75 * (ra['w'] + rb['w']) * 0.5
            d_ab, j_ab = trees[kb].query(ra['p'], distance_upper_bound=reach)
            for i, (d, j) in enumerate(zip(d_ab, j_ab)):
                if not np.isfinite(d):
                    continue
                _, back = trees[ka].query(rb['p'][j])
                if back != i:
                    continue   # not mutual
                na, nb = road_nodes[ka][i], road_nodes[kb][j]
                if na == nb:
                    continue
                sa, sb = soft.get(na), soft.get(nb)
                if sa is not None and sb is not None:
                    if abs(sa - sb) > 3.0:
                        continue   # different levels (a ramp crossing over or under)
                elif not (measured_road[ka] or measured_road[kb]) and abs(float(np.dot(tang[ka][i], tang[kb][j]))) < MERGE_COS:
                    continue   # unmeasured decks that cross (a street over a freeway): each its own level
                par[find(na)] = find(nb)
                pairs += 1
    if pairs:
        cs, ch = {}, {}
        for n, v in soft.items():
            cs.setdefault(find(n), []).append(v)
        for n, v in hard.items():
            ch.setdefault(find(n), []).append(v)
        hard_c = {c: float(np.mean(v)) for c, v in ch.items()}
        soft = {c: float(np.median(v)) for c, v in cs.items() if c not in hard_c}
        adj_c = {}
        for a, lst in adj.items():
            for b, L in lst:
                ca, cb = find(a), find(b)
                if ca != cb:
                    adj_c.setdefault(ca, []).append((cb, L))
        adj = adj_c
        node_of = {n: find(n) for n in pos}
        hard_nodes = hard
        hard = hard_c
    else:
        node_of = {n: n for n in pos}
        hard_nodes = hard
    log('overlapping deck nodes made one height: %d pairs' % pairs)

    # a deck climbs at most GRADE, unless the ground between two of its pinned junctions is steeper (a
    # street bridge on a hill): then each span between pins (the deck cut at its pinned nodes) may
    # climb as steeply as the steepest pin to pin grade across it, so the climb spreads along that span
    # instead of stepping up at a pin. Decks with lidar heights (the Bay Bridge's profile) keep GRADE:
    # their measured heights are clipped to it.
    comp = {}
    for s0 in adj:
        if s0 in comp:
            continue
        comp[s0] = s0
        stack = [s0]
        while stack:
            u = stack.pop()
            for v, _ in adj[u]:
                if v not in comp:
                    comp[v] = s0
                    stack.append(v)
    measured = {comp[c] for c in soft if c in comp}
    span = {}
    for s0 in adj:
        if s0 in hard or s0 in span or comp[s0] in measured:
            continue
        span[s0] = s0
        stack = [s0]
        while stack:
            u = stack.pop()
            for v, _ in adj[u]:
                if v not in hard and v not in span:
                    span[v] = s0
                    stack.append(v)
    ends = {}
    for u, sid in span.items():
        for v, _ in adj[u]:
            if v in hard:
                ends.setdefault(sid, set()).add(v)
    span_grade = {}
    for sid, ps in ends.items():
        need = 0.0
        for p in ps:
            dist, pq = {p: 0.0}, [(0.0, p)]
            while pq:
                d, u = heapq.heappop(pq)
                if d > dist[u]:
                    continue
                if u != p and u in hard:
                    if d > 0:   # (pins at one place are one cluster, their heights averaged)
                        need = max(need, abs(hard[u] - hard[p]) / d)
                    continue    # a pin ends the span
                for v, L in adj[u]:
                    if (span.get(v) == sid or (v in hard and u != p)) and d + L < dist.get(v, 1e18):
                        dist[v] = d + L
                        heapq.heappush(pq, (d + L, v))
        if need > GRADE:
            span_grade[sid] = need
    if span_grade:
        log('deck spans steeper than %.0f%% between their pins: %d, up to %.1f%%' % (
            GRADE * 100, len(span_grade), max(span_grade.values()) * 100))

    def grade(u, v, L):
        """The grade limit on edge u-v: its span's, or between two pins the grade they need."""
        sid = span.get(u, span.get(v))
        if sid is not None:
            return span_grade.get(sid, GRADE)
        if u in hard and v in hard and comp.get(u) not in measured and L > 0:
            return max(GRADE, abs(hard[u] - hard[v]) / L)
        return GRADE

    def envelope(vals, sign):
        """sign=+1: min over sources of v + grade * d; sign=-1: max of v - grade * d (grade: GRADE, or
        a span's own steeper one)."""
        best = {n: v * sign for n, v in vals.items()}
        pq = [(b, n) for n, b in best.items()]
        heapq.heapify(pq)
        while pq:
            b, u = heapq.heappop(pq)
            if b > best.get(u, 1e18):
                continue
            for v, L in adj.get(u, []):
                nb = b + grade(u, v, L) * L
                if nb < best.get(v, 1e18):
                    best[v] = nb
                    heapq.heappush(pq, (nb, v))
        return {n: b * sign for n, b in best.items()}

    # soft values may not break the grade limit around the pinned junctions
    if hard:
        hu, hl = envelope(hard, 1), envelope(hard, -1)
        soft = {n: min(max(v, hl.get(n, -1e9)), hu.get(n, 1e9)) for n, v in soft.items() if n not in hard}
    allv = dict(soft); allv.update(hard)
    up, lo = envelope(allv, 1), envelope(allv, -1)
    h = {}
    for n in pos:
        c = node_of[n]
        if c in hard:
            h[n] = hard[c]
        elif c in up and c in lo:
            h[n] = 0.5 * (up[c] + lo[c])
        else:
            h[n] = gnd[n]
    hard = hard_nodes
    # report: worst grade and the stretch above ground
    worst = 0.0
    for k in bidx:
        r = roads[k]
        for i in range(len(r['p']) - 1):
            L = float(np.hypot(*(r['p'][i + 1] - r['p'][i])))
            if L > 1:
                worst = max(worst, abs(h[r['nodes'][i + 1]] - h[r['nodes'][i]]) / L)
    log('deck heights: %d nodes (%d lidar, %d pinned to junctions), max grade %.1f%%, deck %.1f..%.1f m' % (
        len(h), len(soft), len(hard), worst * 100, min(h.values()), max(h.values())))
    return h, hard, gnd


def carve(roads, bidx, H, h):
    """Lower terrain under the decks; returns roofs [(points Nx2, heights, half width)] over tunnels."""
    H0 = H.copy()
    roofs = []
    carved = 0
    for k in bidx:
        r = roads[k]
        p = r['p']
        hh = np.array([h[n] for n in r['nodes']])
        hw = r['w'] * 0.5
        rad = hw + CARVE_PAD
        cells = {}
        for i in range(len(p) - 1):
            L = float(np.hypot(*(p[i + 1] - p[i])))
            for t in np.linspace(0, 1, max(2, int(L / 2) + 1)):
                q = p[i] + (p[i + 1] - p[i]) * t
                y = hh[i] + (hh[i + 1] - hh[i]) * t
                i0, i1 = int(math.floor((q[0] - rad - GX0) / CELL)), int(math.ceil((q[0] + rad - GX0) / CELL))
                j0, j1 = int(math.floor((q[1] - rad - GZ0) / CELL)), int(math.ceil((q[1] + rad - GZ0) / CELL))
                for jj in range(max(0, j0), min(NZ, j1 + 1)):
                    for ii in range(max(0, i0), min(NX, i1 + 1)):
                        gx, gz = GX0 + ii * CELL, GZ0 + jj * CELL
                        if math.hypot(gx - q[0], gz - q[1]) <= rad:
                            key = (jj, ii)
                            cells[key] = min(cells.get(key, 1e9), y)
        for (jj, ii), y in cells.items():
            # the tunnel bores are always cut; elsewhere only where the ground is above the deck
            if H[jj, ii] > y - 0.15 and (r['tunnel'] or H0[jj, ii] > y + 0.3):
                H[jj, ii] = y - 0.15
                carved += 1
        if r['tunnel']:
            # the hill as it was: centre line, and just outside the cut on either side (the roof
            # slopes across to these, so it meets the uncut ground at its edges)
            d = np.gradient(p, axis=0)
            d /= np.linalg.norm(d, axis=1)[:, None] + 1e-12
            rn = np.stack([-d[:, 1], d[:, 0]], axis=1)
            # one terrain cell wider than the cut, so it closes over the cut's sloping sides (the
            # 8 m terrain grid rises from the cut floor to the hill across that cell)
            rr = rad + CELL
            roof = np.maximum(_bilinear(H0, p[:, 0], p[:, 1]), hh + 7.0)
            el = p - rn * (rr + 1.0); er = p + rn * (rr + 1.0)
            hl = np.maximum(_bilinear(H0, el[:, 0], el[:, 1]), hh + 7.0)
            hr = np.maximum(_bilinear(H0, er[:, 0], er[:, 1]), hh + 7.0)
            roofs.append((p.copy(), roof, rr, hl, hr))
    log('terrain carved under the decks: %d grid nodes, %d tunnel roofs' % (carved, len(roofs)))
    return roofs


def solids(roads, bidx, h, H):
    """Railings and tunnel walls: [(quad 4x2, base, top, deck height at each corner)]. Collision walls
    stand RAIL_TOP above the higher end (a bouncing car must not hop over); drawn barriers are lower."""
    out = []
    foot = []   # (road index, points, half width) for the 'another deck joins here' test
    for k in bidx:
        foot.append((k, roads[k]['p'], roads[k]['w'] * 0.5))
    trees = {k: cKDTree(p) for k, p, _ in foot}
    hw_of = {k: w for k, _, w in foot}

    def joined(q, k, y, dk):
        """Another deck road's roadway at q, running the same way at about height y: a ramp merging,
        so no railing. A deck of the other direction alongside (the median) or at another height (the
        east span's two decks where they part) is not."""
        for o, tr in trees.items():
            if o == k:
                continue
            d, j = tr.query(q)
            if d < hw_of[o] + DENSE:
                p, ns = roads[o]['p'], roads[o]['nodes']
                # exact distance to the nearest two segments
                for a in (max(0, j - 1), j):
                    if a + 1 >= len(p):
                        continue
                    ab = p[a + 1] - p[a]
                    t = min(1, max(0, float(np.dot(q - p[a], ab) / max(np.dot(ab, ab), 1e-9))))
                    yo = h[ns[a]] + (h[ns[a + 1]] - h[ns[a]]) * t
                    same_way = float(np.dot(ab, dk)) > 0
                    if np.hypot(*(p[a] + ab * t - q)) < hw_of[o] + 0.8 and abs(yo - y) < 1.5 and same_way:
                        return True
        return False
    rails = walls = 0
    for k in bidx:
        r = roads[k]
        if r.get('on_roof'):
            continue
        p = r['p']
        hh = np.array([h[n] for n in r['nodes']])
        hw = r['w'] * 0.5
        for i in range(len(p) - 1):
            a, b = p[i], p[i + 1]
            d = b - a
            L = float(np.hypot(*d))
            if L < 0.5:
                continue
            nrm = _right(d / L)
            ha, hb = hh[i], hh[i + 1]
            mid = (a + b) / 2
            g = float(_bilinear(H, [mid[0]], [mid[1]])[0])
            if r['tunnel']:
                for s in (1, -1):
                    o0, o1 = hw + 0.4, hw + 0.8
                    q = [a + nrm * s * o0, b + nrm * s * o0, b + nrm * s * o1, a + nrm * s * o1]
                    out.append((np.array(q), min(ha, hb) - 3.0, max(ha, hb) + 6.0, [ha, hb, hb, ha]))
                    walls += 1
                continue
            if min(ha, hb) - g < RAIL_DROP:
                continue
            for s in (1, -1):
                o0, o1 = hw + 0.3, hw + 0.6
                if joined(mid + nrm * s * (hw + 0.45), k, 0.5 * (ha + hb), d):
                    continue
                q = [a + nrm * s * o0, b + nrm * s * o0, b + nrm * s * o1, a + nrm * s * o1]
                out.append((np.array(q), min(ha, hb) - 1.5, max(ha, hb) + RAIL_TOP, [ha, hb, hb, ha]))
                rails += 1
    log('bridge solids: %d railing pieces, %d tunnel wall pieces' % (rails, walls))
    return out


def add_roof_roads(roads, bidx, roofs, H0, h):
    """Ordinary roads that cross over a tunnel (YBI's Forest, Signal and Sims Roads): the ground under
    them is cut for the bore, so they become decks on the hill as it was (H0), flagged on_roof (no
    girders, piers or railings). Their ends are outside the cut, on uncut ground."""
    b0 = set(bidx)
    next_id = [min([n for r in roads for n in r['nodes'] if isinstance(n, int) and n < 0] + [0]) - 1]
    caps = [(p, rad) for p, _, rad, _, _ in roofs]

    def over(q):
        for p, rad in caps:
            for i in range(len(p) - 1):
                ab = p[i + 1] - p[i]
                t = float(np.dot(q - p[i], ab) / max(np.dot(ab, ab), 1e-9))
                if 0 <= t <= 1 and np.hypot(*(p[i] + ab * t - q)) < rad + 2.0:
                    return True
        return False
    if not caps:
        return []
    allp = np.vstack([p for p, _ in caps])
    rmax = max(rad for _, rad in caps) + 2.0
    bx0, bz0 = allp.min(axis=0) - rmax
    bx1, bz1 = allp.max(axis=0) + rmax
    out = []
    for k, r in enumerate(roads):
        if k in b0 or (r['flags'] & (v1.F_GGB | F_BAYB)):
            continue
        p = r['p']
        if p[:, 0].max() < bx0 or p[:, 0].min() > bx1 or p[:, 1].max() < bz0 or p[:, 1].min() > bz1:
            continue
        if not any(over(p[i] + (p[i + 1] - p[i]) * t) for i in range(len(p) - 1) for t in np.linspace(0, 1, 5)):
            continue
        r['flags'] |= F_BAYB
        r.setdefault('tunnel', False)
        r['on_roof'] = True
        _densify(r, next_id)
        r['osm_s'] = r['s'].copy()
        g = _bilinear(H0, r['p'][:, 0], r['p'][:, 1])
        for n, y in zip(r['nodes'], g):
            h[n] = float(y)
        out.append(k)
    log('roads over tunnel roofs, on the uncut hill: %d (%s)' % (len(out), ', '.join('%s %s at %.0f,%.0f' % (roads[k]['name'] or roads[k]['type'], roads[k]['id'], *roads[k]['p'].mean(axis=0)) for k in out)))
    return out


def deck_edges(roads, bidx, h, ground):
    """Height at each deck point's left and right edge. Near the ground a flat deck would stand
    proud of a cross-sloping street (a car crossing its edge can trip); so a deck follows the
    ground's cross-slope at grade and levels out by 3 m clearance. Roads on a tunnel roof follow
    the hill. ground(x, z) -> y (arrays)."""
    out = {}
    for k in bidx:
        r = roads[k]
        p = r['p']
        d = np.gradient(p, axis=0)
        d /= np.linalg.norm(d, axis=1)[:, None] + 1e-12
        rn = np.stack([-d[:, 1], d[:, 0]], axis=1)
        hw = r['w'] * 0.5
        gc = ground(p[:, 0], p[:, 1])
        gl = ground((p - rn * hw)[:, 0], (p - rn * hw)[:, 1])
        gr = ground((p + rn * hw)[:, 0], (p + rn * hw)[:, 1])
        for i, n in enumerate(r['nodes']):
            y = h[n]
            if r.get('on_roof'):
                w = 1.0
            elif r['tunnel']:
                w = 0.0
            else:
                w = float(np.clip(1.0 - (y - gc[i]) / 3.0, 0.0, 1.0))
            out[(k, i)] = (y + (gl[i] - gc[i]) * w, y + (gr[i] - gc[i]) * w)
    return out


def west_span_half_width(roads, bidx, span):
    """Distance from the west span's axis to the outer edge of its (side-by-side) decks."""
    a, b = np.array(span[0], float), np.array(span[1], float)
    ax = (b - a) / np.linalg.norm(b - a)
    L = float(np.linalg.norm(b - a))
    best = 0.0
    for k in bidx:
        r = roads[k]
        q = r['p'] - a
        t = q @ ax
        off = np.abs(q[:, 0] * ax[1] - q[:, 1] * ax[0])
        m = (t > 0.2 * L) & (t < 0.8 * L) & (off < 25)
        if m.any():
            best = max(best, float(off[m].max()) + r['w'] * 0.5)
    return best


def west_span_profile(roads, bidx, h, span):
    """Deck height along the west span's axis (for the scenery model): [[t, y], ...] every 25 m."""
    a, b = np.array(span[0], float), np.array(span[1], float)
    if a[0] > b[0]:
        a, b = b, a
    ax = (b - a) / np.linalg.norm(b - a)
    L = float(np.linalg.norm(b - a))
    ts, ys = [], []
    for k in bidx:
        r = roads[k]
        for i, n in enumerate(r['nodes']):
            q = r['p'][i] - a
            t = float(np.dot(q, ax)); off = abs(float(q[0] * ax[1] - q[1] * ax[0]))
            if -50 < t < L + 50 and off < 25:
                ts.append(t); ys.append(h[n])
    if len(ts) < 10:
        return None
    ts, ys = np.array(ts), np.array(ys)
    o = np.argsort(ts)
    grid = np.arange(0, L + 1, 25.0)
    prof = np.interp(grid, ts[o], ys[o])
    return [[round(float(t), 1), round(float(y), 2)] for t, y in zip(grid, prof)]

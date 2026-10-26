"""SF Roadster Rush map bake.

Inputs : tools/cache/osm_*.json (fetch_osm.py) and tools/cache/dem/*.png (fetch_dem.py)
Outputs: data/world.json (index, tracks, landmarks, names) + data/world.bin (typed arrays)

    python tools/bake.py

Pipeline: DEM -> heightfield, coastline flood fill -> land/water, OSM landuse -> landcover raster,
roads -> widths/graph/junctions + road-corridor flattening, buildings -> simplified footprints with
heights/styles/colours, landmarks (positions from OSM where possible), trees scatter, track routing.
"""
import json, math, os, sys, time, heapq, random, re
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import *  # noqa

T0 = time.time()
def log(*a):
    print('[%6.1fs]' % (time.time() - T0), *a, flush=True)

rng = random.Random(1906)
np.random.seed(1906)
BOUNDS = world_bounds()

# ----------------------------------------------------------------------------------------------
# 1. DEM
# ----------------------------------------------------------------------------------------------
def load_dem_sampler():
    files = [f for f in os.listdir(os.path.join(CACHE, 'dem')) if f.endswith('.png')]
    xs = sorted({int(f.split('_')[1]) for f in files}); ys = sorted({int(f.split('_')[2][:-4]) for f in files})
    tx0, ty0 = xs[0], ys[0]
    mos = np.zeros(((ys[-1] - ty0 + 1) * 256, (xs[-1] - tx0 + 1) * 256), dtype=np.float32)
    for f in files:
        _, tx, ty = f[:-4].split('_'); tx = int(tx); ty = int(ty)
        im = np.asarray(Image.open(os.path.join(CACHE, 'dem', f)).convert('RGB')).astype(np.float64)
        e = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
        mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = e
    n = 2 ** 14

    def sample(x, z):
        lat, lon = LAT0 - np.asarray(z) / KZ, LON0 + np.asarray(x) / KX
        px = ((lon + 180) / 360 * n - tx0) * 256 - 0.5
        lr = np.radians(lat)
        py = ((1 - np.arcsinh(np.tan(lr)) / math.pi) / 2 * n - ty0) * 256 - 0.5
        return ndimage.map_coordinates(mos, [py, px], order=1, mode='nearest')
    return sample


def grid_xz():
    xs = GX0 + np.arange(NX) * CELL
    zs = GZ0 + np.arange(NZ) * CELL
    return np.meshgrid(xs, zs)


def lc_xz():
    xs = GX0 + (np.arange(LCX) + 0.5) * LC_RES
    zs = GZ0 + (np.arange(LCZ) + 0.5) * LC_RES
    return np.meshgrid(xs, zs)


def to_px(p):
    """world Nx2 -> landcover pixel coords (float)"""
    return [((x - GX0) / LC_RES, (z - GZ0) / LC_RES) for x, z in p]


# ----------------------------------------------------------------------------------------------
# 2. Land / water from OSM coastline (flood fill), DEM fallback
# ----------------------------------------------------------------------------------------------
WATER, URBAN, PARK, WOOD, SAND, LAKE, PIER, PITCH, SCRUB, ROCK, PAVED = range(11)


def build_sea_mask(dem_lc):
    coast = load_osm('coast')
    img = Image.new('L', (LCX, LCZ), 0)
    dr = ImageDraw.Draw(img)
    for e in coast:
        if e['type'] != 'way' or not e.get('geometry'):
            continue
        p = geom_xy(e['geometry'])
        dr.line(to_px(p), fill=1, width=1)
    barrier = np.asarray(img) > 0
    lab, nlab = ndimage.label(~barrier)
    seeds = [(37.815, -122.400), (37.805, -122.488), (37.823, -122.440), (37.800, -122.376), (37.790, -122.380)]
    water_labels = set()
    for la, lo in seeds:
        x, z = proj(la, lo)
        i, j = int((x - GX0) / LC_RES), int((z - GZ0) / LC_RES)
        if 0 <= i < LCX and 0 <= j < LCZ and lab[j, i] > 0:
            water_labels.add(int(lab[j, i]))
    # components whose DEM is clearly under water also count (pieces cut off by the raster edge)
    idx = np.arange(1, nlab + 1)
    means = ndimage.mean(dem_lc, lab, idx)
    sizes = ndimage.sum(np.ones_like(dem_lc), lab, idx)
    for k, m, s in zip(idx, means, sizes):
        if m < -2.0 and s > 200:
            water_labels.add(int(k))
    sea = np.isin(lab, list(water_labels))
    # barrier pixels: water if surrounded mostly by water
    nb = ndimage.uniform_filter(sea.astype(np.float32), 3)
    sea = sea | (barrier & (nb > 0.6))
    log('sea mask: %.1f%% water, %d components, %d water comps' % (sea.mean() * 100, nlab, len(water_labels)))
    return sea


# ----------------------------------------------------------------------------------------------
# 3. Landcover
# ----------------------------------------------------------------------------------------------
def classify_landuse(t):
    le, lu, na, mm = t.get('leisure'), t.get('landuse'), t.get('natural'), t.get('man_made')
    if mm in ('pier', 'breakwater', 'groyne'):
        return PIER
    if na == 'water' or 'water' in t and t.get('water') not in (None, 'no'):
        return LAKE
    if na in ('beach', 'sand'):
        return SAND
    if na in ('wood',) or lu == 'forest':
        return WOOD
    if na in ('scrub', 'heath', 'grassland', 'wetland'):
        return SCRUB
    if na in ('bare_rock', 'cliff'):
        return ROCK
    if le in ('golf_course', 'pitch'):
        return PITCH
    if le in ('park', 'garden', 'playground', 'recreation_ground', 'common', 'dog_park') or \
            lu in ('grass', 'meadow', 'recreation_ground', 'cemetery', 'village_green', 'allotments', 'flowerbed'):
        return PARK
    if t.get('amenity') == 'parking' or 'area:highway' in t or t.get('highway') == 'pedestrian' or t.get('place') == 'square':
        return PAVED
    return None


def build_landcover(sea):
    els = load_osm('landuse')
    polys = {c: [] for c in range(11)}
    lakes = []
    piers = []
    seen = set()
    for e in els:
        k = (e['type'], e['id'])
        if k in seen:
            continue
        seen.add(k)
        t = e.get('tags', {})
        c = classify_landuse(t)
        if c is None:
            continue
        if c == PIER and e['type'] == 'way' and e.get('geometry'):
            p = geom_xy(e['geometry'])
            if np.hypot(*(p[0] - p[-1])) > 1.0:
                # linear pier: buffer to a 10 m strip
                piers.append(('line', p, float(t.get('width', 10) if str(t.get('width', '10')).replace('.', '').isdigit() else 10)))
                continue
        for ring in element_polygons(e):
            a = abs(poly_area(ring))
            if a < 30:
                continue
            polys[c].append((a, ring, t))
            if c == LAKE:
                lakes.append((ring, t))
            if c == PIER:
                piers.append(('poly', ring, 0))
    img = Image.new('L', (LCX, LCZ), URBAN)
    dr = ImageDraw.Draw(img)
    order = [PARK, PAVED, SCRUB, PITCH, WOOD, ROCK, SAND]
    for c in order:
        # big first so small features drawn on top
        for a, ring, t in sorted(polys[c], key=lambda r: -r[0]):
            if c == PARK and t.get('leisure') == 'nature_reserve':
                continue
            dr.polygon(to_px(ring), fill=c)
    lc = np.array(img)
    lc[sea] = WATER
    # piers on top of sea
    img2 = Image.fromarray(lc)
    dr = ImageDraw.Draw(img2)
    for kind, p, w in piers:
        if kind == 'poly':
            dr.polygon(to_px(p), fill=PIER)
        else:
            dr.line(to_px(p), fill=PIER, width=max(1, int(w / LC_RES)))
    lc = np.array(img2)
    # inland lakes (not touching the sea)
    lake_out = []
    for ring, t in lakes:
        a = abs(poly_area(ring))
        if a < 300:
            continue
        cx, cz = ring[:, 0].mean(), ring[:, 1].mean()
        i, j = int((cx - GX0) / LC_RES), int((cz - GZ0) / LC_RES)
        if not (0 <= i < LCX and 0 <= j < LCZ) or sea[j, i]:
            continue
        m = Image.new('L', (LCX, LCZ), 0)
        ImageDraw.Draw(m).polygon(to_px(ring), fill=1)
        mm = np.asarray(m) > 0
        if mm.sum() < 10 or (sea & mm).mean() > 0.001:
            continue
        lc[mm] = LAKE
        lake_out.append(dict(ring=ring, mask=mm, name=t.get('name', '')))
    log('landcover: ' + ', '.join('%s=%.1f%%' % (n, (lc == c).mean() * 100) for c, n in enumerate(
        ['water', 'urban', 'park', 'wood', 'sand', 'lake', 'pier', 'pitch', 'scrub', 'rock', 'paved'])),
        'lakes', len(lake_out), 'piers', len(piers))
    return lc, lake_out


# ----------------------------------------------------------------------------------------------
# 4. Roads
# ----------------------------------------------------------------------------------------------
RTYPES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
          'living_street', 'service', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']
RT = {n: i for i, n in enumerate(RTYPES)}
DEF_W = dict(motorway=15, trunk=14, primary=14, secondary=12.5, tertiary=11, unclassified=9.5, residential=9.5,
             living_street=7, service=5.5, motorway_link=7.5, trunk_link=7.5, primary_link=7.5,
             secondary_link=7.5, tertiary_link=7.5)
F_ONEWAY, F_BRIDGE, F_CABLE, F_GGB, F_MEDIAN, F_LOMBARD, F_SIDEWALK = 1, 2, 4, 8, 16, 32, 64


def num(v, default=None):
    if v is None:
        return default
    m = re.match(r'\s*([0-9]+(?:\.[0-9]+)?)\s*(m|ft|\')?', str(v))
    if not m:
        return default
    x = float(m.group(1))
    if m.group(2) in ('ft', "'"):
        x *= 0.3048
    return x


def cable_car_street(name, cx, cz):
    lat, lon = unproj(cx, cz)
    if name == 'Powell Street' and lat < 37.7965:
        return True
    if name == 'Hyde Street' and 37.7935 < lat < 37.8070:
        return True
    if name == 'Mason Street' and 37.7945 < lat < 37.8045:
        return True
    if name == 'California Street' and -122.4235 < lon < -122.3960:
        return True
    if name in ('Jackson Street', 'Washington Street') and -122.4190 < lon < -122.4105:
        return True
    return False


def load_roads(sea):
    els = load_osm('roads')
    roads = []
    for e in els:
        if e['type'] != 'way' or not e.get('geometry'):
            continue
        t = e.get('tags', {})
        hw = t.get('highway')
        if hw not in RT:
            continue
        if t.get('area') == 'yes':
            continue
        if hw == 'service' and t.get('service') in ('parking_aisle', 'driveway', 'drive-through', 'emergency_access'):
            continue
        if t.get('access') in ('private', 'no') and hw == 'service':
            continue
        if t.get('tunnel') not in (None, 'no'):
            continue
        if t.get('indoor') == 'yes' or t.get('level', '0').startswith('-'):
            continue
        p = geom_xy(e['geometry'])
        nodes = e['nodes']
        if len(p) != len(nodes) or len(p) < 2:
            continue
        name = t.get('name', '')
        # only the elevated (bridge=yes) Golden Gate ways form the deck; plaza/approach ways are ground roads
        ggb = t.get('bridge') == 'yes' and ('Golden Gate Bridge' in name or (t.get('ref', '').startswith('US 101') and
                                              p[:, 1].mean() < -3900 and p[:, 0].mean() < -5000))
        # drop roads over the open bay (Bay Bridge etc.) except the Golden Gate deck
        i = np.clip(((p[:, 0] - GX0) / LC_RES).astype(int), 0, LCX - 1)
        j = np.clip(((p[:, 1] - GZ0) / LC_RES).astype(int), 0, LCZ - 1)
        inside = (p[:, 0] > GX0) & (p[:, 0] < GX0 + LCX * LC_RES) & (p[:, 1] > GZ0) & (p[:, 1] < GZ0 + LCZ * LC_RES)
        if not inside.any():
            continue
        if not ggb and sea[j, i].mean() > 0.3:
            continue
        lanes = num(t.get('lanes'))
        oneway = t.get('oneway') in ('yes', '1', 'true') or hw in ('motorway',) or t.get('junction') == 'roundabout'
        w = num(t.get('width'))
        if w is None or w < 3 or w > 40:
            if lanes:
                w = lanes * 3.4 + (0 if oneway or hw.startswith('motorway') else 2.0)
                w = max(w, DEF_W[hw] * (0.6 if oneway else 0.8))
            else:
                w = DEF_W[hw] * (0.75 if oneway and hw not in ('motorway',) else 1.0)
        w = float(min(max(w, 4.5), 24))
        flags = 0
        if oneway: flags |= F_ONEWAY
        if t.get('bridge') not in (None, 'no'): flags |= F_BRIDGE
        if ggb:
            flags |= F_GGB
            w = max(w, 9.5)
        cx, cz = p[:, 0].mean(), p[:, 1].mean()
        if cable_car_street(name, cx, cz): flags |= F_CABLE
        if name == 'Lombard Street':
            flags |= F_LOMBARD
        if hw in ('primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'trunk') and not ggb:
            flags |= F_SIDEWALK
        if t.get('oneway') == '-1':
            p = p[::-1]; nodes = nodes[::-1]; flags |= F_ONEWAY
        roads.append(dict(id=e['id'], p=p, nodes=list(nodes), type=hw, w=w, lanes=int(lanes or 0), flags=flags,
                          name=name, ref=t.get('ref', '')))
    log('roads: %d ways' % len(roads))
    return roads


def build_graph(roads):
    use = {}
    for r in roads:
        for k, n in enumerate(r['nodes']):
            use[n] = use.get(n, 0) + (1 if 0 < k < len(r['nodes']) - 1 else 1)
        use[r['nodes'][0]] = use.get(r['nodes'][0], 0) + 1   # endpoints are always vertices
        use[r['nodes'][-1]] = use.get(r['nodes'][-1], 0) + 1
    vid = {}
    vpos = []
    edges = []   # (a, b, length, road index, i0, i1)
    arms = {}
    for ri, r in enumerate(roads):
        ns, p = r['nodes'], r['p']
        last = 0
        for k in range(1, len(ns)):
            if use.get(ns[k], 0) >= 2 or k == len(ns) - 1:
                a, b = ns[last], ns[k]
                for n, q in ((a, p[last]), (b, p[k])):
                    if n not in vid:
                        vid[n] = len(vpos); vpos.append(q)
                seg = p[last:k + 1]
                L = float(np.sum(np.hypot(*np.diff(seg, axis=0).T)))
                if L > 0.5:
                    edges.append((vid[a], vid[b], L, ri, last, k))
                    arms[vid[a]] = arms.get(vid[a], 0) + 1
                    arms[vid[b]] = arms.get(vid[b], 0) + 1
                last = k
    vpos = np.array(vpos)
    log('graph: %d nodes, %d edges' % (len(vpos), len(edges)))
    return vid, vpos, edges, arms


# ----------------------------------------------------------------------------------------------
# 5. Heightfield
# ----------------------------------------------------------------------------------------------
def bilinear(H, x, z):
    fx = np.clip((np.asarray(x) - GX0) / CELL, 0, NX - 1.001)
    fz = np.clip((np.asarray(z) - GZ0) / CELL, 0, NZ - 1.001)
    return ndimage.map_coordinates(H, [fz, fx], order=1, mode='nearest')


def build_heightfield(dem_sample, sea_lc, lc, lakes, roads):
    GXs, GZs = grid_xz()
    dem = dem_sample(GXs, GZs).astype(np.float64)
    log('dem range %.1f..%.1f' % (dem.min(), dem.max()))
    # sea mask at grid samples (nearest 4 m pixel)
    ii = np.clip(((GXs - GX0) / LC_RES).astype(int), 0, LCX - 1)
    jj = np.clip(((GZs - GZ0) / LC_RES).astype(int), 0, LCZ - 1)
    sea = sea_lc[jj, ii]
    cls = lc[jj, ii]
    land = ~sea
    # light smoothing of noise (land only, keep coast shape)
    sm = ndimage.gaussian_filter(dem, 0.8)
    h = np.where(land, sm, dem)
    # distance to the other medium (m)
    d_land = ndimage.distance_transform_edt(sea) * CELL      # for sea cells: distance to land
    d_sea = ndimage.distance_transform_edt(land) * CELL      # for land cells: distance to sea
    sand = cls == SAND
    hw_ = np.minimum(h, -0.8 - np.minimum(d_land, 200) * 0.06)
    h = np.where(sea, hw_, h)
    land_min = np.where(sand, 0.35 + np.minimum(d_sea, 60) * 0.03, 1.4 + np.minimum(d_sea, 40) * 0.02)
    h = np.where(land, np.maximum(h, land_min), h)
    # piers: flat decks 2.6 m above the water
    pier = cls == PIER
    h = np.where(pier, np.maximum(2.6, np.where(land, h, 2.6)), h)
    h[pier & sea] = 2.6

    # road corridor flattening:
    #  1) centreline heights sampled every 2 m along each road and smoothed ALONG the road (removes DEM noise
    #     but keeps hills/crests), accumulated on the 4 m raster (junction pixels average the crossing roads)
    #  2) every grid sample near a road takes the height of its nearest centreline pixel (flat cross-section)
    #  3) the road-height target is smoothed once more in 2D within the corridor (removes junction seams)
    hs = ndimage.gaussian_filter(h, 0.8)
    CHs = np.zeros((LCZ, LCX)); CHc = np.zeros((LCZ, LCX))
    rimg = Image.new('I', (LCX, LCZ), 0)
    dr = ImageDraw.Draw(rimg)
    order = sorted(range(len(roads)), key=lambda k: roads[k]['w'])
    for k in order:
        r = roads[k]
        if r['flags'] & F_GGB:
            continue
        dr.line(to_px(r['p']), fill=k + 1, width=1)
        q, L = resample(r['p'], 2.0)
        hh = bilinear(hs, q[:, 0], q[:, 1])
        if len(hh) > 3:
            hh = ndimage.gaussian_filter1d(hh, sigma=5.0, mode='nearest')   # ~10 m along-road smoothing
        pi = np.clip(((q[:, 0] - GX0) / LC_RES).astype(int), 0, LCX - 1)
        pj = np.clip(((q[:, 1] - GZ0) / LC_RES).astype(int), 0, LCZ - 1)
        np.add.at(CHs, (pj, pi), hh)
        np.add.at(CHc, (pj, pi), 1)
    R = np.asarray(rimg)
    has = CHc > 0
    CH = np.where(has, CHs / np.maximum(CHc, 1), 0)
    dist, (ni, nj) = ndimage.distance_transform_edt(~has, return_indices=True)
    Rn = R.copy()
    Rn[has & (R == 0)] = 0
    # road id per centreline pixel: use R where drawn, else nearest drawn pixel id
    dR, (ri_, rj_) = ndimage.distance_transform_edt(R == 0, return_indices=True)
    rid = R[ri_, rj_] - 1
    gd = dist[jj, ii] * LC_RES
    pjx, pix = ni[jj, ii], nj[jj, ii]
    gr = rid[pjx, pix]
    halfw = np.array([r['w'] * 0.5 for r in roads] + [0])[gr]
    hc = CH[pjx, pix]
    wgt = np.clip(1 - (gd - (halfw + 3.0)) / 9.0, 0, 1)
    wgt = wgt * wgt * (3 - 2 * wgt)
    wgt[sea & ~pier] = 0
    # 2D normalised smoothing of the target inside the corridor
    core = (wgt > 0.99).astype(float)
    num_ = ndimage.gaussian_filter(hc * core, 0.9)
    den_ = ndimage.gaussian_filter(core, 0.9)
    hc = np.where(den_ > 0.2, num_ / np.maximum(den_, 1e-6), hc)
    h = h + (hc - h) * wgt
    # lakes: carve
    lake_defs = []
    for L in lakes:
        mm = L['mask'][jj, ii]
        if mm.sum() == 0:
            # tiny lake: sample around centroid
            pass
        ring = L['ring']
        vals = bilinear(h, ring[:, 0], ring[:, 1])
        level = float(np.percentile(vals, 20)) - 0.3
        if mm.any():
            dil = ndimage.binary_dilation(mm, iterations=1)
            h = np.where(mm, np.minimum(h, level - 1.5), h)
            h = np.where(dil & ~mm, np.minimum(h, level + 0.4), h)
        lake_defs.append(dict(level=level, ring=ring, name=L['name']))
    log('heightfield range %.1f..%.1f, %d lakes' % (h.min(), h.max(), len(lake_defs)))
    return h, lake_defs, R


# ----------------------------------------------------------------------------------------------
# 6. Landmarks
# ----------------------------------------------------------------------------------------------
LANDMARKS = [
    # id, name, lat, lon, exclusion radius (m), blurb, osm name regex
    ('goldengate', 'Golden Gate Bridge', 37.8199, -122.4783, 0,
     'Opened 1937, painted International Orange; its 227 m towers held the world record span for 27 years.', None),
    ('baybridge', 'Bay Bridge (West Span)', 37.7983, -122.3778, 0,
     'Twin suspension spans joined by a massive central anchorage, linking SF to Yerba Buena Island since 1936.', None),
    ('transamerica', 'Transamerica Pyramid', 37.79520, -122.40279, 42,
     'The 260 m pyramid of 1972 - once hated, now the icon of the Financial District skyline.', r'Transamerica Pyramid'),
    ('salesforce', 'Salesforce Tower', 37.78977, -122.39694, 45,
     'At 326 m the tallest tower in San Francisco; its crown is an LED art screen at night.', r'^Salesforce Tower$'),
    ('coit', 'Coit Tower', 37.80239, -122.40582, 16,
     'A 64 m fluted concrete column atop Telegraph Hill (1933), lined with WPA-era murals.', r'^Coit Tower$'),
    ('ferry', 'Ferry Building', 37.79554, -122.39360, 0,
     'The 1898 Beaux-Arts terminal with its 75 m clock tower, now a beloved food hall.', r'^(San Francisco )?Ferry Building$'),
    ('finearts', 'Palace of Fine Arts', 37.80283, -122.44836, 0,
     'A Roman-ruin rotunda built for the 1915 Panama-Pacific Exposition, mirrored in its lagoon.', r'^Palace of Fine Arts'),
    ('cityhall', 'San Francisco City Hall', 37.77927, -122.41924, 0,
     'Beaux-Arts landmark of 1915 whose gilded dome rises taller than the US Capitol.', r'^(San Francisco )?City Hall$'),
    ('alcatraz', 'Alcatraz Island', 37.82670, -122.42300, 0,
     '"The Rock": federal penitentiary 1934-1963, with the oldest lighthouse on the West Coast.', r'^Alcatraz'),
    ('pier39', 'Pier 39', 37.80870, -122.40980, 0,
     'Waterfront shopping pier famous for the sea lions that moved in after the 1989 earthquake.', r'^Pier 39$'),
    ('paintedladies', 'Painted Ladies', 37.77623, -122.43293, 0,
     'The row of pastel Victorians on Alamo Square - "Postcard Row" - built 1892-1896.', None),
    ('oraclepark', 'Oracle Park', 37.77857, -122.38927, 0,
     'Waterfront ballpark of the Giants; home runs over right field splash into McCovey Cove.', r'^Oracle Park$'),
    ('ghirardelli', 'Ghirardelli Square', 37.80590, -122.42280, 0,
     'Chocolate factory turned plaza; its glowing rooftop sign has lit the Wharf since 1923.', r'^Ghirardelli Square$'),
    ('dragongate', 'Chinatown Dragon Gate', 37.79060, -122.40564, 10,
     'The 1970 gateway at Grant & Bush, entrance to the oldest Chinatown in North America.', r'Dragon Gate'),
    ('lombard', 'Lombard Street', 37.80210, -122.41870, 0,
     '"The crookedest street in the world": eight hairpins down one brick-paved block of Russian Hill.', None),
    ('fortpoint', 'Fort Point', 37.81061, -122.47706, 0,
     'Civil War-era brick fort tucked under the southern arch of the Golden Gate Bridge.', None),
]


def min_area_rect(p):
    """returns (cx, cz, angle, length, width) of the minimum-area bounding rectangle."""
    best = None
    q = p - p.mean(axis=0)
    for i in range(len(q)):
        d = q[(i + 1) % len(q)] - q[i]
        a = math.atan2(d[1], d[0])
        c, s = math.cos(a), math.sin(a)
        u = q[:, 0] * c + q[:, 1] * s
        v = -q[:, 0] * s + q[:, 1] * c
        area = (u.max() - u.min()) * (v.max() - v.min())
        if best is None or area < best[0]:
            cu, cv = (u.max() + u.min()) / 2, (v.max() + v.min()) / 2
            cx = p[:, 0].mean() + cu * c - cv * s
            cz = p[:, 1].mean() + cu * s + cv * c
            L, W = u.max() - u.min(), v.max() - v.min()
            if W > L:
                L, W, a = W, L, a + math.pi / 2
            best = (area, cx, cz, a, L, W)
    return best[1:]


def find_named_footprints(blds_raw, misc):
    """name -> list of footprints (Nx2) from buildings/misc with names."""
    out = {}
    for e in list(misc) + blds_raw:
        t = e.get('tags', {})
        n = t.get('name')
        if not n:
            continue
        for ring in element_polygons(e):
            out.setdefault(n, []).append((ring, t))
    return out


def gg_bridge_geometry(roads, H):
    """Golden Gate Bridge frame from the OSM tower piers (axis south->north tower), deck coverage slices
    (lateral extent per 10 m of axis) from the OSM deck ways incl. the curved approaches."""
    towers = {'s': [], 'n': []}
    for e in load_osm('bridges'):
        t = e.get('tags', {})
        if t.get('man_made') == 'tower' and t.get('bridge:support') == 'pier' and e.get('geometry'):
            p = geom_xy(e['geometry']).mean(axis=0)
            if p[0] < -5500 and -3200 < p[1] < -2600:
                towers['s'].append(p)
            elif p[0] < -5500 and -4400 < p[1] < -3900:
                towers['n'].append(p)
    if towers['s'] and towers['n']:
        st, nt = np.mean(towers['s'], axis=0), np.mean(towers['n'], axis=0)
    else:
        st, nt = np.array(proj(37.81080, -122.47735)), np.array(proj(37.82230, -122.47872))
    d = (nt - st) / np.linalg.norm(nt - st)
    centre = (st + nt) / 2
    half = float(np.linalg.norm(nt - st) / 2)
    lat = np.array([-d[1], d[0]])
    segs = []
    for r in roads:
        if not r['flags'] & F_GGB:
            continue
        q = r['p'] - centre
        tt, ll = q @ d, q @ lat
        for i in range(len(tt) - 1):
            segs.append((tt[i], ll[i], tt[i + 1], ll[i + 1], r['w'] * 0.5 + 1.2))
    tmin = min(min(a_, c_) for a_, _, c_, _, _ in segs)
    tmax = max(max(a_, c_) for a_, _, c_, _, _ in segs)
    step = 10.0
    ts = np.arange(tmin, tmax + step, step)
    lmin = np.full(len(ts), 1e9); lmax = np.full(len(ts), -1e9)
    for (t0, l0, t1, l1, hw) in segs:
        lo, hi = min(t0, t1), max(t0, t1)
        for k, t in enumerate(ts):
            if lo - step * 0.5 <= t <= hi + step * 0.5 and hi - lo > 1e-6:
                u = min(1, max(0, (t - t0) / (t1 - t0)))
                l = l0 + (l1 - l0) * u
                lmin[k] = min(lmin[k], l - hw); lmax[k] = max(lmax[k], l + hw)
    # straight core: full 27 m deck (walkways pass outside the tower legs)
    core = (np.abs(ts) < half + 343 + 120)
    lmin[core] = np.minimum(lmin[core], -13.6); lmax[core] = np.maximum(lmax[core], 13.6)
    bad = lmin > lmax
    lmin[bad] = 0; lmax[bad] = 0
    south = centre + d * tmin; north = centre + d * tmax
    # end heights: ground under the extreme deck points
    def end_ground(tt_):
        k = int(np.argmin(np.abs(ts - tt_)))
        lm = (lmin[k] + lmax[k]) / 2
        p = centre + d * tt_ + lat * lm
        return float(bilinear(H, [p[0]], [p[1]])[0])
    log('GGB towers %s %s span %.0f m, deck t %.0f..%.0f, ground S %.1f N %.1f' % (st.round(), nt.round(), half * 2, tmin, tmax, end_ground(tmin), end_ground(tmax)))
    return dict(axis=d, centre=centre, st=st, nt=nt, half=half, south=south, north=north, tmin=tmin, tmax=tmax,
                slices=dict(t0=round(float(ts[0]), 2), step=step, lmin=[round(float(v), 1) for v in lmin], lmax=[round(float(v), 1) for v in lmax]),
                gS=end_ground(tmin), gN=end_ground(tmax))


# ----------------------------------------------------------------------------------------------
# 7. Buildings
# ----------------------------------------------------------------------------------------------
GLASS, OFFICE, BRICK, VICT, STUCCO, DECO, WARE, MODERN = range(8)
PAL = {
    GLASS: [(140, 165, 182), (118, 146, 166), (165, 176, 184), (120, 160, 170), (95, 120, 140)],
    OFFICE: [(200, 195, 185), (182, 182, 180), (214, 204, 188), (170, 168, 160), (225, 220, 210)],
    BRICK: [(150, 82, 62), (168, 96, 72), (130, 72, 58), (182, 120, 92), (158, 110, 88)],
    VICT: [(232, 186, 198), (186, 214, 198), (198, 188, 226), (240, 220, 166), (172, 204, 226), (240, 198, 168),
           (236, 230, 212), (198, 220, 178), (226, 168, 158), (170, 188, 212), (248, 238, 200), (210, 170, 200),
           (160, 200, 196), (244, 210, 140)],
    STUCCO: [(236, 228, 212), (226, 214, 194), (242, 236, 226), (216, 204, 184), (230, 214, 198), (222, 226, 214),
             (240, 224, 200), (214, 220, 226)],
    DECO: [(222, 206, 180), (206, 192, 170), (232, 222, 200), (196, 186, 172)],
    WARE: [(176, 166, 150), (150, 142, 132), (190, 170, 150), (160, 96, 76), (140, 120, 104)],
    MODERN: [(204, 204, 208), (96, 100, 106), (226, 226, 220), (150, 156, 160), (70, 76, 84)],
}
ROOFS = [(108, 108, 110), (90, 90, 95), (72, 72, 74), (150, 148, 140), (125, 120, 112), (100, 96, 92)]
NAMED_COLOURS = dict(white=(240, 240, 236), grey=(160, 160, 160), gray=(160, 160, 160), red=(170, 70, 60),
                     brown=(140, 100, 70), yellow=(236, 210, 130), beige=(222, 208, 180), blue=(150, 175, 205),
                     green=(160, 190, 160), black=(60, 60, 60), pink=(232, 186, 198), orange=(220, 150, 90))


def parse_colour(v):
    if not v:
        return None
    v = v.strip().lower()
    if v.startswith('#') and len(v) in (4, 7):
        if len(v) == 4:
            v = '#' + ''.join(ch * 2 for ch in v[1:])
        try:
            return tuple(int(v[i:i + 2], 16) for i in (1, 3, 5))
        except ValueError:
            return None
    return NAMED_COLOURS.get(v)


def district(x, z):
    lat, lon = unproj(x, z)
    def near(la, lo, r):
        return math.hypot((lon - lo) * KX, (lat - la) * KZ) < r
    if near(37.7915, -122.3990, 950):
        return 'fidi'
    if near(37.7860, -122.3950, 1100) or (lat < 37.7830 and lon > -122.4150):
        return 'soma'
    if near(37.7880, -122.4100, 900):
        return 'downtown'
    if near(37.8010, -122.4380, 700):
        return 'marina'
    return 'res'


def load_buildings(H, lm_excl):
    raw = []
    seen = set()
    names = sorted(f for f in os.listdir(CACHE) if f.startswith('osm_bld_'))
    for f in names:
        for e in load_osm(f[4:-5]):
            k = (e['type'], e['id'])
            if k in seen:
                continue
            seen.add(k)
            raw.append(e)
    log('raw buildings: %d' % len(raw))
    out = []
    drop = dict(small=0, outside=0, landmark=0, kind=0)
    for e in raw:
        t = e.get('tags', {})
        b = t.get('building')
        if b in ('roof', 'carport', 'canopy', 'construction', 'ruins', 'no', 'collapsed', 'shelter') or t.get('building:part'):
            drop['kind'] += 1; continue
        if t.get('location') in ('underground', 'underwater') or str(t.get('layer', '0')).startswith('-') or                 str(t.get('max_level', '0')).startswith('-'):
            drop['kind'] += 1; continue
        if num(t.get('min_height'), 0) > 2.5 or num(t.get('building:min_level'), 0) >= 1:
            drop['kind'] += 1; continue
        rings = element_polygons(e)
        if not rings:
            continue
        ring = max(rings, key=lambda r: abs(poly_area(r)))
        area = abs(poly_area(ring))
        if area < 25:
            drop['small'] += 1; continue
        cx, cz = ring[:, 0].mean(), ring[:, 1].mean()
        if not (BOUNDS['minX'] - 50 < cx < BOUNDS['maxX'] + 50 and BOUNDS['minZ'] - 50 < cz < BOUNDS['maxZ'] + 50):
            drop['outside'] += 1; continue
        hit = False
        for (lx, lz, lr, poly) in lm_excl:
            if poly is not None:
                if point_in_poly(cx, cz, poly):
                    hit = True; break
            elif math.hypot(cx - lx, cz - lz) < lr:
                hit = True; break
        if hit:
            drop['landmark'] += 1; continue
        tol = 0.5 if area < 400 else 0.8
        p = simplify_ring(ring, tol)
        if len(p) > 60:
            p = simplify_ring(np.vstack([p, p[:1]]), 2.0)
        if len(p) < 3:
            continue
        a2 = poly_area(np.vstack([p, p[:1]]))
        if abs(a2) < 25:
            drop['small'] += 1; continue
        if a2 < 0:
            p = p[::-1]
        out.append(dict(p=p, area=abs(a2), tags=t, cx=cx, cz=cz))
    log('buildings kept %d, dropped %s' % (len(out), drop))
    return out


def point_in_poly(x, z, p):
    inside = False
    n = len(p)
    j = n - 1
    for i in range(n):
        xi, zi = p[i]; xj, zj = p[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def finish_buildings(blds, H, cap=62000):
    for b in blds:
        t = b['tags']
        h = num(t.get('height'))
        lv = num(t.get('building:levels'))
        dist = district(b['cx'], b['cz'])
        bt = t.get('building', 'yes')
        if h is None or h < 2:
            if lv:
                h = lv * 3.2 + num(t.get('roof:levels'), 0) * 2.0
            else:
                if dist == 'fidi':
                    h = rng.uniform(18, 70) if b['area'] > 300 else rng.uniform(10, 25)
                elif dist in ('soma', 'downtown'):
                    h = rng.uniform(10, 30)
                elif bt in ('garage', 'shed', 'garages', 'hut', 'kiosk'):
                    h = 3.5
                else:
                    h = rng.uniform(7, 12.5)
        h = float(min(max(h, 3.0), 330))
        b['h'] = h
        b['dist'] = dist
    # cap: drop smallest/lowest first
    if len(blds) > cap:
        blds.sort(key=lambda b: -(b['area'] * (b['h'] ** 0.5)))
        blds = blds[:cap]
    for b in blds:
        p = b['p']
        g = bilinear(H, np.append(p[:, 0], b['cx']), np.append(p[:, 1], b['cz']))
        b['gmin'], b['gmax'] = float(g.min()), float(g.max())
        b['top'] = b['gmin'] + b['h'] + 0.5 * (b['gmax'] - b['gmin'])
        t = b['tags']
        h, dist, a = b['h'], b['dist'], b['area']
        bt = t.get('building', 'yes')
        mat = t.get('building:material', '')
        r = rng.random()
        if mat == 'brick':
            st = BRICK
        elif mat in ('glass',):
            st = GLASS
        elif h >= 70:
            st = GLASS if r < 0.5 else OFFICE if r < 0.8 else DECO
        elif h >= 26:
            st = OFFICE if r < 0.3 else BRICK if r < 0.48 else DECO if r < 0.62 else MODERN if r < 0.88 else GLASS
        elif bt in ('industrial', 'warehouse') or (dist == 'soma' and a > 700 and r < 0.6):
            st = WARE
        elif dist == 'marina' and a < 600:
            st = STUCCO if r < 0.75 else VICT
        elif dist == 'res' and a < 420 and h < 16:
            st = VICT if r < 0.62 else STUCCO
        elif dist in ('fidi', 'downtown', 'soma'):
            st = BRICK if r < 0.35 else OFFICE if r < 0.6 else DECO if r < 0.75 else MODERN
        else:
            st = STUCCO if r < 0.35 else BRICK if r < 0.55 else MODERN if r < 0.75 else VICT if r < 0.9 else OFFICE
        b['style'] = st
        col = parse_colour(t.get('building:colour')) or rng.choice(PAL[st])
        jit = rng.uniform(0.92, 1.06)
        b['wall'] = tuple(int(min(255, c * jit)) for c in col)
        b['roof'] = parse_colour(t.get('roof:colour')) or rng.choice(ROOFS)
    log('buildings final: %d, tallest %.0f m' % (len(blds), max(b['h'] for b in blds)))
    return blds


# ----------------------------------------------------------------------------------------------
# 8. Routing + tracks
# ----------------------------------------------------------------------------------------------
COST_MUL = dict(service=4.0, living_street=2.0, residential=1.05, unclassified=1.05)


class Router:
    def __init__(self, roads, vpos, edges):
        self.roads, self.vpos, self.edges = roads, vpos, edges
        self.adj = [[] for _ in range(len(vpos))]
        for ei, (a, b, L, ri, i0, i1) in enumerate(edges):
            r = roads[ri]
            m = COST_MUL.get(r['type'], 1.0)
            if r['type'].startswith('motorway'):
                m = 1.6
            self.adj[a].append((b, L * m, ei, False))
            back = L * m * (6.0 if r['flags'] & F_ONEWAY else 1.0)
            self.adj[b].append((a, back, ei, True))
        # largest connected component (waypoints must snap into it)
        par = list(range(len(vpos)))
        def f(a):
            while par[a] != a:
                par[a] = par[par[a]]; a = par[a]
            return a
        for a, b, *_ in edges:
            par[f(a)] = f(b)
        from collections import Counter
        roots = [f(i) for i in range(len(vpos))]
        main = Counter(roots).most_common(1)[0][0]
        self.main = np.array([r == main for r in roots])

    def nearest(self, x, z, names=None):
        best, bi = 1e18, -1
        for vi, (vx, vz) in enumerate(self.vpos):
            if not self.main[vi]:
                continue
            d = (vx - x) ** 2 + (vz - z) ** 2
            if d < best:
                best, bi = d, vi
        return bi

    def intersection(self, a, b, hint=None):
        na, nb = set(), set()
        for (u, v, L, ri, i0, i1) in self.edges:
            n = self.roads[ri]['name']
            if n == a:
                na.update((u, v))
            if n == b:
                nb.update((u, v))
        common = [k for k in (na & nb) if self.main[k]]
        if not common:
            raise RuntimeError('no intersection %s / %s' % (a, b))
        if hint is not None:
            hx, hz = proj(*hint)
            common.sort(key=lambda k: (self.vpos[k][0] - hx) ** 2 + (self.vpos[k][1] - hz) ** 2)
        return common[0]

    def route(self, s, t, avoid=None, via=None):
        dist = {s: 0.0}
        prev = {}
        pq = [(0.0, s)]
        avoid = avoid or set()
        while pq:
            d, u = heapq.heappop(pq)
            if u == t:
                break
            if d > dist.get(u, 1e18):
                continue
            for v, c, ei, rev in self.adj[u]:
                if ei in avoid:
                    c *= 8.0
                if via is not None and self.roads[self.edges[ei][3]]['name'] == via:
                    c *= 0.3
                nd = d + c
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    prev[v] = (u, ei, rev)
                    heapq.heappush(pq, (nd, v))
        if t not in prev and s != t:
            raise RuntimeError('no route')
        seq = []
        v = t
        while v != s:
            u, ei, rev = prev[v]
            seq.append((ei, rev))
            v = u
        seq.reverse()
        pts = []
        for ei, rev in seq:
            a, b, L, ri, i0, i1 = self.edges[ei]
            g = self.roads[ri]['p'][i0:i1 + 1]
            if rev:
                g = g[::-1]
            pts.extend(g if not pts else g[1:])
        return np.array(pts), [e for e, _ in seq]


def resample(pts, step):
    d = np.hypot(*np.diff(pts, axis=0).T)
    keep = np.concatenate([[True], d > 0.05])
    pts = pts[keep]
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
    n = max(2, int(round(s[-1] / step)) + 1)
    ss = np.linspace(0, s[-1], n)
    return np.stack([np.interp(ss, s, pts[:, 0]), np.interp(ss, s, pts[:, 1])], axis=1), s[-1]


def turn_at(p, k):
    a = p[k] - p[k - 1]; b = p[k + 1] - p[k]
    return abs((math.atan2(b[1], b[0]) - math.atan2(a[1], a[0]) + math.pi) % (2 * math.pi) - math.pi)


def despur(p, skip=lambda q: False):
    """remove hook/spur reversals (U-turns at ramp junctions) from a path"""
    p = [tuple(q) for k, q in enumerate(p) if k == 0 or np.hypot(q[0] - p[k - 1][0], q[1] - p[k - 1][1]) > 0.05]
    for _ in range(50):
        arr = np.array(p)
        found = None
        for k in range(1, len(p) - 1):
            if not skip(p[k]) and turn_at(arr, k) > 2.3:
                found = k
                break
        if found is None:
            break
        k = found
        best = None
        for m in range(1, 12):
            a, b = max(0, k - m), min(len(p) - 1, k + m)
            q = p[:a + 1] + p[b:]
            j = a + 1 if a + 1 < len(q) - 1 else a
            if a == 0 or b == len(p) - 1 or j <= 0 or turn_at(np.array(q), j) < 1.6:
                best = q
                break
        p = best if best is not None else p[:k] + p[k + 1:]
    return np.array(p)


def smooth_path(p, loop, iters=2):
    p = p.copy()
    for _ in range(iters):
        if loop:
            q = (np.roll(p, 1, 0) + 2 * p + np.roll(p, -1, 0)) / 4
        else:
            q = p.copy()
            q[1:-1] = (p[:-2] + 2 * p[1:-1] + p[2:]) / 4
        p = q
    return p


TRACK_DEFS = [
    dict(id='embarcadero-sprint', name='Embarcadero Sprint', area="Fisherman's Wharf to Oracle Park",
         description="Flat-out along the waterfront: Jefferson St past Pier 39, down The Embarcadero's palm-lined boulevard, "
                     "past the Ferry Building clock tower and the Bay Bridge to the ballpark.",
         laps=1, loop=False, difficulty=2,
         wps=[('Jefferson Street', 'Hyde Street', (37.8077, -122.4205), None),
              ('Jefferson Street', 'Powell Street', None, 'Jefferson Street'),
              ('The Embarcadero', 'Bay Street', None, 'The Embarcadero'),
              ('The Embarcadero', 'Broadway', None, 'The Embarcadero'),
              ('The Embarcadero', 'Mission Street', None, 'The Embarcadero'),
              ('King Street', '3rd Street', None, 'The Embarcadero')]),
    dict(id='lombard-zigzag', name='Lombard Zigzag', area='Russian Hill',
         description='Tight Russian Hill circuit: plunge down the eight hairpins of crooked Lombard Street, '
                     'loop the flats by the bay and claw back up Hyde Street past the cable cars.',
         laps=3, loop=True, difficulty=4,
         wps=[('Hyde Street', 'Union Street', None, 'Union Street'), ('Hyde Street', 'Lombard Street', None, 'Hyde Street'),
              ('Leavenworth Street', 'Lombard Street', None, 'Lombard Street'), ('Leavenworth Street', 'Bay Street', None, 'Leavenworth Street'),
              ('Larkin Street', 'Bay Street', None, 'Bay Street'), ('Larkin Street', 'Union Street', None, 'Larkin Street')]),
    dict(id='golden-gate-run', name='Golden Gate Run', area='Marina to the Golden Gate Bridge',
         description='From the Marina Green along Crissy Field and up through the Presidio, then onto the Golden Gate '
                     'Bridge deck, 67 m above the water, and across past the north tower.',
         laps=1, loop=False, difficulty=3,
         wps=[('Marina Boulevard', 'Laguna Street', None, None), ('Marina Boulevard', 'Baker Street', None, 'Marina Boulevard'),
              ('GGB_NORTH', 'Golden Gate Bridge')]),
    dict(id='nob-hill-jumps', name='Nob Hill Jumps', area='Nob Hill and Russian Hill',
         description='Bullitt-style hill bombing: California Street over Nob Hill, then Jones and Taylor Streets '
                     'where every cross street is a launch ramp.',
         laps=2, loop=True, difficulty=5,
         wps=[('California Street', 'Taylor Street', None, 'Taylor Street'), ('California Street', 'Jones Street', None, 'California Street'),
              ('Jones Street', 'Filbert Street', None, 'Jones Street'), ('Taylor Street', 'Filbert Street', None, 'Filbert Street')]),
    dict(id='downtown-gp', name='Downtown Grand Prix', area='Financial District',
         description='A street circuit between the skyscrapers: Market Street, Montgomery to the Transamerica '
                     'Pyramid, Columbus Avenue, Broadway and back down The Embarcadero.',
         laps=3, loop=True, difficulty=3,
         wps=[('Montgomery Street', 'California Street', None, 'California Street'),
              ('Montgomery Street', 'Washington Street', None, 'Montgomery Street'),
              ('Columbus Avenue', 'Broadway', None, 'Columbus Avenue'),
              ('The Embarcadero', 'Broadway', None, 'Broadway'),
              ('Market Street', 'Drumm Street', None, 'The Embarcadero'),
              ('Market Street', 'Bush Street', None, 'Market Street')]),
    dict(id='painted-ladies', name='Painted Ladies Tour', area='Alamo Square, the Panhandle and Golden Gate Park',
         description='Past Postcard Row on Alamo Square, west along the Panhandle on Fell Street to the edge of '
                     'Golden Gate Park and back on Oak Street.',
         laps=2, loop=True, difficulty=2,
         wps=[('Steiner Street', 'Fulton Street', None, 'Fulton Street'), ('Steiner Street', 'Fell Street', None, 'Steiner Street'),
              ('Stanyan Street', 'Fell Street', None, 'Fell Street'), ('Stanyan Street', 'Oak Street', None, 'Stanyan Street'),
              ('Scott Street', 'Oak Street', None, 'Oak Street'), ('Scott Street', 'Fulton Street', None, 'Scott Street')]),
]


def road_width_at(roads_idx, x, z):
    return 9.0


def build_tracks(router, roads, ggb):
    tracks = []
    fine_boxes = []
    for r in roads:
        if r['name'] == 'Lombard Street' and len(r['p']) > 40:
            fine_boxes.append((r['p'][:, 0].min() - 6, r['p'][:, 1].min() - 6, r['p'][:, 0].max() + 6, r['p'][:, 1].max() + 6))
    log('fine routing zones (crooked Lombard): %d' % len(fine_boxes))
    for td in TRACK_DEFS:
        nodes, vias = [], []
        for w in td['wps']:
            if w[0] == 'GGB_SOUTH':
                p = ggb['south'] - ggb['axis'] * 60
                nodes.append(router.nearest(*p))
            elif w[0] == 'GGB_NORTH':
                p = ggb['nt'] + ggb['axis'] * 380
                nodes.append(router.nearest(*p))
            else:
                nodes.append(router.intersection(w[0], w[1], w[2]))
            vias.append(w[-1])
        seq = nodes + ([nodes[0]] if td['loop'] else [])
        legvia = vias[1:] + ([vias[0]] if td['loop'] else [])
        pts = []
        used = set()
        for (a, b), via in zip(zip(seq[:-1], seq[1:]), legvia):
            seg, es = router.route(a, b, avoid=used, via=via)
            used.update(es)
            pts.extend(seg if not pts else seg[1:])
        pts = np.array(pts)
        if td['loop'] and np.hypot(*(pts[0] - pts[-1])) < 1:
            pts = pts[:-1]
        if td['loop']:
            pts = np.vstack([pts, pts[:1]])
        fine = lambda q: any(b[0] <= q[0] <= b[2] and b[1] <= q[1] <= b[3] for b in fine_boxes)
        pts = despur(pts, fine)
        dense, L = resample(pts, 2.0)
        keep = [0]
        for i in range(1, len(dense) - 1):
            if fine(dense[i]) or fine(dense[i + 1]) or (i - keep[-1]) * (L / (len(dense) - 1)) >= 7.9:
                keep.append(i)
        keep.append(len(dense) - 1)
        path = despur(dense[keep], fine)
        if td['loop']:
            path = path[:-1]
        fz = np.array([fine(q) for q in path])
        sm = smooth_path(path, td['loop'])
        path = np.where(fz[:, None], path, sm)
        # report sharp reversals (spurs)
        d = np.diff(np.vstack([path, path[:1]]) if td['loop'] else path, axis=0)
        ang = np.arctan2(d[:, 1], d[:, 0])
        turn = np.abs((np.diff(ang) + np.pi) % (2 * np.pi) - np.pi)
        for k in np.flatnonzero(turn > 2.3):
            log('  WARNING %s: reversal at %s' % (td['id'], path[k + 1].round()))
        tracks.append(dict(td=td, path=path, L=L))
        log('track %s: %.0f m, %d pts' % (td['id'], L, len(path)))
    return tracks


# ----------------------------------------------------------------------------------------------
# 9. Trees
# ----------------------------------------------------------------------------------------------
def scatter_trees(lc, bmask, roadR, roads, trees_osm, embarcadero_palms):
    out = []
    # road clearance mask (distance to centerline > halfwidth + 1.5)
    dist = ndimage.distance_transform_edt(roadR == 0) * LC_RES
    halfw = np.array([0] + [r['w'] * 0.5 for r in roads])
    # approximate: use local max halfwidth via dilation of halfwidth raster
    hwr = halfw[roadR]
    hwr = ndimage.maximum_filter(hwr, size=7)
    clear = dist > (hwr + 2.0)
    ok = clear & ~bmask & np.isin(lc, [URBAN, PARK, WOOD, SCRUB, PITCH, ROCK])

    def okat(x, z):
        i, j = int((x - GX0) / LC_RES), int((z - GZ0) / LC_RES)
        return 0 <= i < LCX and 0 <= j < LCZ and ok[j, i]

    for (x, z) in embarcadero_palms:
        out.append((x, z, 2, rng.uniform(0.9, 1.15)))
    n_osm = 0
    rng.shuffle(trees_osm)
    for (x, z) in trees_osm:
        if n_osm >= 6500:
            break
        if okat(x, z):
            out.append((x, z, 0 if rng.random() < 0.85 else 1, rng.uniform(0.7, 1.15))); n_osm += 1
    # jittered grid scatter in vegetated classes, clustered by low-frequency noise
    noise = ndimage.gaussian_filter(np.random.rand(LCZ // 8 + 1, LCX // 8 + 1), 2.0)
    noise = (noise - noise.min()) / (noise.max() - noise.min() + 1e-9)
    budget = {WOOD: 10500, PARK: 5200, SCRUB: 700}
    spacing = {WOOD: 9.0, PARK: 13.0, SCRUB: 18.0}
    for cls in (WOOD, PARK, SCRUB):
        cand = []
        s = spacing[cls]
        xs = np.arange(GX0 + s / 2, GX0 + LCX * LC_RES, s)
        zs = np.arange(GZ0 + s / 2, GZ0 + LCZ * LC_RES, s)
        X, Z = np.meshgrid(xs, zs)
        X = X + np.random.uniform(-s * 0.45, s * 0.45, X.shape)
        Z = Z + np.random.uniform(-s * 0.45, s * 0.45, Z.shape)
        I = np.clip(((X - GX0) / LC_RES).astype(int), 0, LCX - 1)
        J = np.clip(((Z - GZ0) / LC_RES).astype(int), 0, LCZ - 1)
        m = (lc[J, I] == cls) & ok[J, I]
        nz = noise[J // 8, I // 8]
        prob = nz if cls != WOOD else 0.35 + 0.65 * nz
        m &= np.random.rand(*X.shape) < prob
        X, Z = X[m], Z[m]
        order = np.random.permutation(len(X))[:budget[cls]]
        for k in order:
            x, z = float(X[k]), float(Z[k])
            lat, lon = unproj(x, z)
            r = rng.random()
            if cls == WOOD:
                ty = 1 if r < 0.45 else 3 if r < 0.75 else 0
            elif cls == SCRUB:
                ty = 1 if r < 0.5 else 0
            else:
                ty = 0 if r < 0.7 else 1 if r < 0.85 else 3
            out.append((x, z, ty, rng.uniform(0.75, 1.3)))
    log('trees: %d (palms %d, osm %d)' % (len(out), len(embarcadero_palms), n_osm))
    return out


def embarcadero_palms(roads):
    emb = [r for r in roads if r['name'] == 'The Embarcadero']
    pts = []
    if len(emb) < 2:
        return pts
    allp = np.vstack([resample(r['p'], 4.0)[0] for r in emb])
    owner = np.concatenate([[k] * len(resample(r['p'], 4.0)[0]) for k, r in enumerate(emb)])
    for k, r in enumerate(emb):
        q, L = resample(r['p'], 20.0)
        for x, z in q:
            d = np.hypot(allp[:, 0] - x, allp[:, 1] - z)
            d[owner == k] = 1e9
            j = int(np.argmin(d))
            if 9 < d[j] < 28:
                mx, mz = (x + allp[j, 0]) / 2, (z + allp[j, 1]) / 2
                lat, lon = unproj(mx, mz)
                if lat < 37.8075 and lon > -122.4050:
                    pts.append((mx, mz))
    # dedupe (both carriageways produce the same midpoints)
    out = []
    for p in pts:
        if all(math.hypot(p[0] - q[0], p[1] - q[1]) > 12 for q in out[-40:]):
            out.append(p)
    return out


# ----------------------------------------------------------------------------------------------
# 10. Output
# ----------------------------------------------------------------------------------------------
class Packer:
    def __init__(self):
        self.parts = []
        self.index = {}
        self.off = 0

    def add(self, name, arr):
        arr = np.ascontiguousarray(arr)
        pad = (-self.off) % 8
        if pad:
            self.parts.append(b'\0' * pad); self.off += pad
        b = arr.tobytes()
        self.index[name] = dict(offset=self.off, length=int(arr.size), type=str(arr.dtype))
        self.parts.append(b)
        self.off += len(b)

    def write(self, path):
        with open(path, 'wb') as f:
            for p in self.parts:
                f.write(p)


def q25(v):
    """world meters -> int16 quarter meters"""
    a = np.round(np.asarray(v) * 4)
    assert np.abs(a).max() < 32767, 'coordinate overflow'
    return a.astype(np.int16)


def rle(a):
    a = a.ravel()
    out = bytearray()
    i, n = 0, len(a)
    change = np.flatnonzero(np.diff(a)) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [n]])
    for s, e in zip(starts, ends):
        v = int(a[s]); L = int(e - s)
        while L > 0:
            k = min(L, 65535)
            out += bytes((v, k & 255, k >> 8))
            L -= k
    return np.frombuffer(bytes(out), dtype=np.uint8)


def dp_keep(p, keep_mask, tol):
    """DP simplify polyline but always keep flagged vertices."""
    idx = np.flatnonzero(keep_mask)
    out = [p[0:1]]
    for a, b in zip(idx[:-1], idx[1:]):
        seg = dp_simplify(p[a:b + 1], tol)
        out.append(seg[1:])
    return np.vstack(out)


def main():
    dem_sample = load_dem_sampler()
    LX, LZ = lc_xz()
    dem_lc = dem_sample(LX, LZ)
    sea = build_sea_mask(dem_lc)
    lc, lakes = build_landcover(sea)
    roads = load_roads(sea)
    H, lake_defs, roadR = build_heightfield(dem_sample, sea, lc, lakes, roads)
    ggb = gg_bridge_geometry(roads, H)
    vid, vpos, edges, arms = build_graph(roads)
    router = Router(roads, vpos, edges)

    # landmarks: refine with OSM footprints
    misc = load_osm('misc')
    raw_b = []
    for f in sorted(os.listdir(CACHE)):
        if f.startswith('osm_bld_'):
            raw_b += [e for e in load_osm(f[4:-5]) if e.get('tags', {}).get('name')]
    named = find_named_footprints(raw_b, misc)
    lms = []
    lm_excl = []
    for (lid, name, la, lo, excl, blurb, rx) in LANDMARKS:
        x, z = proj(la, lo)
        rot, L, W = 0.0, 0.0, 0.0
        fp = None
        if rx:
            cands = []
            for n, lst in named.items():
                if re.search(rx, n):
                    for ring, t in lst:
                        cx, cz = ring[:, 0].mean(), ring[:, 1].mean()
                        d = math.hypot(cx - x, cz - z)
                        if d < 600:
                            cands.append((abs(poly_area(ring)) if t.get('building') else abs(poly_area(ring)) * 0.5, d, ring, t))
            if cands:
                cands.sort(key=lambda c: -c[0])
                ring = cands[0][2]
                cx, cz, rot, L, W = min_area_rect(simplify_ring(ring, 0.5))
                fp = ring
                if lid not in ('alcatraz', 'pier39', 'ghirardelli', 'oraclepark'):
                    x, z = cx, cz
                log('landmark %s: OSM footprint %.0fx%.0f m rot %.1f deg (moved %.0f m)' % (
                    lid, L, W, math.degrees(rot), math.hypot(cx - proj(la, lo)[0], cz - proj(la, lo)[1])))
        if lid in ('paintedladies', 'dragongate'):
            x, z, rot = street_aligned(lid, roads, router)
        g = float(bilinear(H, [x], [z])[0])
        lm = dict(id=lid, name=name, x=round(float(x), 1), z=round(float(z), 1), ground=round(g, 2),
                  rot=round(float(rot), 4), L=round(float(L), 1), W=round(float(W), 1), blurb=blurb)
        if lid == 'baybridge':
            lm.update(bay_bridge_geometry())
        if lid == 'oraclepark':
            # U axis from home plate (3rd & King corner) towards centre field
            hp = router.vpos[router.intersection('King Street', '3rd Street')]
            d = np.array([x, z]) - hp
            lm['rot'] = round(math.atan2(d[1], d[0]), 4)
            lm['L'], lm['W'] = 200.0, 200.0
        if lid in ('ferry', 'cityhall', 'alcatraz', 'fortpoint'):
            # which V side faces the city / land (+1 or -1)
            c, s_ = math.cos(rot), math.sin(rot)
            vx, vz = -s_, c
            def wet(px_, pz_):
                i, j = int((px_ - GX0) / LC_RES), int((pz_ - GZ0) / LC_RES)
                return 0 <= i < LCX and 0 <= j < LCZ and bool(sea[j, i])
            lm['front'] = -1 if wet(x + vx * 70, z + vz * 70) and not wet(x - vx * 70, z - vz * 70) else 1
        lms.append(lm)
        # exclusion of OSM buildings
        if lid in ('ferry', 'finearts', 'cityhall', 'oraclepark', 'transamerica', 'salesforce', 'coit') and fp is not None:
            lm_excl.append((x, z, 0, fp))
        if excl:
            lm_excl.append((x, z, excl, None))
        if lid == 'paintedladies':
            lm_excl.append((x, z, 0, painted_ladies_box(x, z, rot)))
        if lid == 'alcatraz':
            lm_excl.append((x, z, 260, None))
        if lid == 'ghirardelli':
            lm_excl.append((x, z, 16, None))
        if lid == 'dragongate':
            lm_excl.append((x, z, 12, None))
        if lid == 'fortpoint':
            lm_excl.append((x, z, 45, None))
    # GG bridge towers on the water: nothing to exclude; Fort Point under the arch handled above

    blds = load_buildings(H, lm_excl)
    blds = finish_buildings(blds, H)
    # drop footprints that sit on top of a street centreline (OSM artifacts: stations, passages, plazas)
    bimg_ = Image.new('I', (LCX, LCZ), 0)
    d_ = ImageDraw.Draw(bimg_)
    for k_, b in enumerate(blds):
        d_.polygon(to_px(b['p']), fill=k_ + 1)
    Bid = np.asarray(bimg_)
    major = np.array([0] + [0 if r['type'] == 'service' else 1 for r in roads])[roadR]
    hit = Bid[(roadR > 0) & (major > 0) & (Bid > 0)] - 1
    cnt = np.bincount(hit, minlength=len(blds))
    bad = set(np.flatnonzero(cnt >= 3).tolist())
    log('buildings covering street centrelines dropped: %d %s' % (len(bad), [(blds[i]['tags'].get('name'), blds[i]['tags'].get('building'), int(cnt[i])) for i in list(bad)[:12]]))
    blds = [b for i, b in enumerate(blds) if i not in bad]

    tracks = build_tracks(router, roads, ggb)

    # trees
    bimg = Image.new('L', (LCX, LCZ), 0)
    dr = ImageDraw.Draw(bimg)
    for b in blds:
        dr.polygon(to_px(b['p']), fill=1)
    bmask = ndimage.binary_dilation(np.asarray(bimg) > 0, iterations=1)
    tosm = []
    for e in load_osm('trees'):
        if e['type'] == 'node':
            tosm.append(proj(e['lat'], e['lon']))
    palms = embarcadero_palms(roads)
    trees = scatter_trees(lc, bmask, roadR, roads, tosm, palms)

    # ---------------------------------------------------------------- pack
    P = Packer()
    P.add('height', np.round(H * 10).clip(-32000, 32000).astype(np.int16))
    P.add('landcover_rle', rle(lc.astype(np.uint8)))
    # buildings
    bstart = np.zeros(len(blds), np.uint32); bcount = np.zeros(len(blds), np.uint8)
    coords = []
    off = 0
    for k, b in enumerate(blds):
        bstart[k] = off; bcount[k] = len(b['p']); off += len(b['p'])
        coords.append(b['p'])
    coords = np.vstack(coords)
    P.add('bld_xz', q25(coords.ravel()))
    P.add('bld_start', bstart)
    P.add('bld_count', bcount)
    P.add('bld_gmin', np.round(np.array([b['gmin'] for b in blds]) * 10).astype(np.int16))
    P.add('bld_gmax', np.round(np.array([b['gmax'] for b in blds]) * 10).astype(np.int16))
    P.add('bld_top', np.round(np.array([b['top'] for b in blds]) * 10).astype(np.int16))
    P.add('bld_style', np.array([b['style'] for b in blds], np.uint8))
    P.add('bld_wall', np.array([b['wall'] for b in blds], np.uint8).ravel())
    P.add('bld_roof', np.array([b['roof'] for b in blds], np.uint8).ravel())
    # roads (simplified, junction vertices kept)
    node_is_v = set(vid.keys())
    names = ['']
    name_idx = {'': 0}
    rstart, rcount, rwidth, rtype, rflags, rlanes, rname = [], [], [], [], [], [], []
    rcoords = []
    off = 0
    for r in roads:
        keep = np.array([n in node_is_v for n in r['nodes']])
        keep[0] = keep[-1] = True
        p = dp_keep(r['p'], keep, 0.35)
        rstart.append(off); rcount.append(len(p)); off += len(p)
        rcoords.append(p)
        rwidth.append(int(round(r['w'] * 10)))
        rtype.append(RT[r['type']]); rflags.append(r['flags']); rlanes.append(min(r['lanes'], 255))
        if r['name'] not in name_idx:
            name_idx[r['name']] = len(names); names.append(r['name'])
        rname.append(name_idx[r['name']])
    P.add('road_xz', q25(np.vstack(rcoords).ravel()))
    P.add('road_start', np.array(rstart, np.uint32))
    P.add('road_count', np.array(rcount, np.uint16))
    P.add('road_width', np.array(rwidth, np.uint16))
    P.add('road_type', np.array(rtype, np.uint8))
    P.add('road_flags', np.array(rflags, np.uint8))
    P.add('road_lanes', np.array(rlanes, np.uint8))
    P.add('road_name', np.array(rname, np.uint16))
    # graph
    P.add('graph_xz', q25(vpos.ravel()))
    P.add('graph_edges', np.array([(a, b) for a, b, L, ri, i0, i1 in edges], np.uint32).ravel())
    P.add('graph_len', np.array([L for a, b, L, ri, i0, i1 in edges], np.float32))
    P.add('graph_road', np.array([ri for a, b, L, ri, i0, i1 in edges], np.uint32))
    # junctions: >= 3 arms
    jx, jr = [], []
    vhw = np.zeros(len(vpos))
    for a, b, L, ri, i0, i1 in edges:
        hw = roads[ri]['w'] * 0.5
        vhw[a] = max(vhw[a], hw); vhw[b] = max(vhw[b], hw)
    for v, n in arms.items():
        if n >= 3:
            jx.append(vpos[v]); jr.append(vhw[v])
    P.add('junction_xz', q25(np.array(jx).ravel()))
    P.add('junction_r', np.round(np.array(jr) * 4).astype(np.uint8))
    # trees
    tr = np.array(trees)
    P.add('tree_xz', q25(tr[:, :2].ravel()))
    P.add('tree_type', tr[:, 2].astype(np.uint8))
    P.add('tree_scale', np.round(tr[:, 3] * 100).astype(np.uint8))

    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    P.write(os.path.join(ROOT, 'data', 'world.bin.wasm'))

    # tracks json
    tracks_out = []
    for tk in tracks:
        td, path, L = tk['td'], tk['path'], tk['L']
        tracks_out.append(dict(id=td['id'], name=td['name'], area=td['area'], description=td['description'],
                               laps=td['laps'], loop=td['loop'], difficulty=td['difficulty'],
                               path=[[round(float(x), 1), round(float(z), 1)] for x, z in path]))
    lakes_out = [dict(name=l['name'], level=round(l['level'], 2),
                      ring=[[round(float(x), 1), round(float(z), 1)] for x, z in simplify_ring(l['ring'], 1.0)])
                 for l in lake_defs]
    index = dict(
        version=1,
        attribution='(c) OpenStreetMap contributors (ODbL); elevation: Mapzen Terrarium / AWS Terrain Tiles',
        bounds=BOUNDS,
        grid=dict(x0=GX0, z0=GZ0, cell=CELL, nx=NX, nz=NZ),
        landcover=dict(x0=GX0, z0=GZ0, res=LC_RES, nx=LCX, nz=LCZ,
                       classes=['water', 'urban', 'park', 'wood', 'sand', 'lake', 'pier', 'pitch', 'scrub', 'rock', 'paved']),
        road_types=RTYPES,
        road_flags=dict(oneway=F_ONEWAY, bridge=F_BRIDGE, cablecar=F_CABLE, ggbridge=F_GGB, median=F_MEDIAN,
                        lombard=F_LOMBARD, sidewalk=F_SIDEWALK),
        styles=['glass', 'office', 'brick', 'victorian', 'stucco', 'deco', 'warehouse', 'modern'],
        names=names,
        arrays=P.index,
        counts=dict(buildings=len(blds), roads=len(roads), trees=len(trees), graphNodes=len(vpos), graphEdges=len(edges),
                    junctions=len(jx)),
        ggbridge=dict(axis=[round(float(v), 6) for v in ggb['axis']],
                      centre=[round(float(v), 2) for v in ggb['centre']], halfSpan=round(ggb['half'], 1),
                      south=[round(float(v), 2) for v in ggb['south']], north=[round(float(v), 2) for v in ggb['north']],
                      southTower=[round(float(v), 2) for v in ggb['st']], northTower=[round(float(v), 2) for v in ggb['nt']],
                      tmin=round(float(ggb['tmin']), 1), tmax=round(float(ggb['tmax']), 1),
                      groundSouth=round(ggb['gS'], 2), groundNorth=round(ggb['gN'], 2), slices=ggb['slices']),
        landmarks=lms,
        lakes=lakes_out,
        tracks=tracks_out,
    )
    with open(os.path.join(ROOT, 'data', 'world.json'), 'w', encoding='utf8') as f:
        json.dump(index, f, separators=(',', ':'), ensure_ascii=False)
    sz = os.path.getsize(os.path.join(ROOT, 'data', 'world.bin.wasm')), os.path.getsize(os.path.join(ROOT, 'data', 'world.json'))
    log('wrote world.bin %.2f MB, world.json %.2f MB' % (sz[0] / 1e6, sz[1] / 1e6))
    for k, v in sorted(P.index.items(), key=lambda kv: -kv[1]['length'] * np.dtype(kv[1]['type']).itemsize):
        print('   %-16s %8.1f KB' % (k, v['length'] * np.dtype(v['type']).itemsize / 1024))


def bay_bridge_geometry():
    """West span towers (W2..W6 from OSM) and the deck alignment (I-80 upper deck way)."""
    els = load_osm('bridges')
    towers = {}
    deck = None
    for e in els:
        t = e.get('tags', {})
        g = e.get('geometry') or []
        if not g:
            continue
        if t.get('man_made') == 'tower' and t.get('ref') in ('W2', 'W3', 'W5', 'W6'):
            p = geom_xy(g).mean(axis=0)
            towers[t['ref']] = [round(float(p[0]), 1), round(float(p[1]), 1)]
        if e['id'] == 8921938:
            deck = geom_xy(g)
    if deck is None or len(towers) < 4:
        x0, z0 = proj(37.7889, -122.3915); x1, z1 = proj(37.8100, -122.3685)
        deck = np.array([[x0, z0], [x1, z1]])
        towers = {}
    out = dict(span=[[round(float(deck[0][0]), 1), round(float(deck[0][1]), 1)], [round(float(deck[-1][0]), 1), round(float(deck[-1][1]), 1)]])
    if towers:
        out['towers'] = [towers[k] for k in ('W2', 'W3', 'W5', 'W6')]
        w3, w5 = np.array(towers['W3']), np.array(towers['W5'])
        out['anchorage'] = [round(float(v), 1) for v in (w3 + w5) / 2]
    log('bay bridge: %s' % out)
    return out


def painted_ladies_box(x, z, rot):
    # houses row along U (Steiner St), depth along V (away from the street)
    c, s = math.cos(rot), math.sin(rot)
    P = lambda u, v: [x + u * c - v * s, z + u * s + v * c]
    return np.array([P(-30, -11), P(30, -11), P(30, 12), P(-30, 12)])


def street_aligned(lid, roads, router):
    """Place Painted Ladies on the east side of Steiner St (Hayes-Grove) and the Dragon Gate across Grant Ave at Bush."""
    if lid == 'paintedladies':
        a = router.vpos[router.intersection('Steiner Street', 'Hayes Street')]
        b = router.vpos[router.intersection('Steiner Street', 'Grove Street')]
        m = (a + b) / 2
        u = (b - a) / np.linalg.norm(b - a)
        v = np.array([-u[1], u[0]])
        if v[0] < 0:          # V must point east (away from Alamo Square)
            u, v = -u, -v
        hw = 5.5
        c = m + v * (hw + 3.0 + 9.0)
        return float(c[0]), float(c[1]), math.atan2(u[1], u[0])
    a = router.vpos[router.intersection('Grant Avenue', 'Bush Street')]
    b = router.vpos[router.intersection('Grant Avenue', 'Sutter Street')]
    u = (b - a) / np.linalg.norm(b - a)     # pointing south along Grant
    c = a + u * 11.0
    return float(c[0]), float(c[1]), math.atan2(u[1], u[0])


if __name__ == '__main__':
    main()

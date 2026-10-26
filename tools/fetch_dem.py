"""Download AWS Terrarium elevation tiles (z14) covering the SF map area.

Run once:  python tools/fetch_dem.py
Tiles are cached in tools/cache/dem/ as PNG.
"""
import math, os, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache', 'dem')
os.makedirs(CACHE, exist_ok=True)
UA = 'SFRoadsterRush/1.0 (personal game build)'
Z = 14
# a little margin around the play area (Bay Bridge scenery etc.)
S, N, W, E = 37.755, 37.842, -122.505, -122.355


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    lr = math.radians(lat)
    y = (1 - math.asinh(math.tan(lr)) / math.pi) / 2 * n
    return x, y


def main():
    x0, y0 = tile_xy(N, W, Z)
    x1, y1 = tile_xy(S, E, Z)
    for ty in range(int(y0), int(y1) + 1):
        for tx in range(int(x0), int(x1) + 1):
            p = os.path.join(CACHE, '%d_%d_%d.png' % (Z, tx, ty))
            if os.path.exists(p) and os.path.getsize(p) > 0:
                continue
            url = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png' % (Z, tx, ty)
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            with open(p, 'wb') as f:
                f.write(body)
            print('tile', tx, ty, len(body))
            time.sleep(0.05)
    print('tiles x', int(x0), int(x1), 'y', int(y0), int(y1))


if __name__ == '__main__':
    main()

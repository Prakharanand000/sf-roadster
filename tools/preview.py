"""Render a debug overview of data/world.* to tools/cache/preview*.png (hillshade, landcover, roads, tracks)."""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import *

idx = json.load(open(os.path.join(ROOT, 'data', 'world.json'), encoding='utf8'))
buf = open(os.path.join(ROOT, 'data', 'world.bin.wasm'), 'rb').read()


def A(name):
    a = idx['arrays'][name]
    return np.frombuffer(buf, dtype=a['type'], count=a['length'], offset=a['offset'])


g = idx['grid']
H = A('height').reshape(g['nz'], g['nx']) * 0.1
lc = idx['landcover']
rle = A('landcover_rle')
L = np.repeat(rle[0::3], rle[1::3].astype(np.int64) | (rle[2::3].astype(np.int64) << 8)).reshape(lc['nz'], lc['nx'])
pal = np.array([[30, 60, 90], [120, 120, 120], [90, 150, 80], [50, 100, 50], [220, 200, 150], [60, 110, 160], [150, 140, 120],
                [110, 180, 90], [130, 140, 90], [140, 130, 120], [160, 160, 160]], np.uint8)
img = pal[L]
# hillshade from H (upsample x2)
gy, gx = np.gradient(H, 8.0)
sh = np.clip(0.6 + (-gx * 0.6 - gy * 0.4) * 1.5, 0.3, 1.3)
sh = np.kron(sh, np.ones((2, 2)))[:lc['nz'], :lc['nx']]
img = np.clip(img * sh[..., None], 0, 255).astype(np.uint8)
im = Image.fromarray(img)
dr = ImageDraw.Draw(im)
P = lambda x, z: ((x - g['x0']) / 4, (z - g['z0']) / 4)
rxz = A('road_xz') * 0.25
rs, rc = A('road_start'), A('road_count')
for i in range(len(rs)):
    pts = [P(rxz[(rs[i] + k) * 2], rxz[(rs[i] + k) * 2 + 1]) for k in range(rc[i])]
    dr.line(pts, fill=(235, 235, 235), width=1)
bxz = A('bld_xz') * 0.25
bs, bc = A('bld_start'), A('bld_count')
for i in range(0, len(bs)):
    pts = [P(bxz[(bs[i] + k) * 2], bxz[(bs[i] + k) * 2 + 1]) for k in range(bc[i])]
    dr.polygon(pts, fill=(60, 50, 50))
cols = [(255, 0, 0), (255, 140, 0), (255, 255, 0), (0, 255, 255), (255, 0, 255), (0, 255, 0)]
for t, c in zip(idx['tracks'], cols):
    dr.line([P(x, z) for x, z in t['path']], fill=c, width=3)
for l in idx['landmarks']:
    x, y = P(l['x'], l['z'])
    dr.ellipse([x - 5, y - 5, x + 5, y + 5], outline=(255, 255, 255), width=2)
b = idx['bounds']
dr.rectangle([P(b['minX'], b['minZ']), P(b['maxX'], b['maxZ'])], outline=(255, 0, 0))
out = os.path.join(CACHE, 'preview.png')
im.save(out)
if len(sys.argv) > 1:
    x0, z0, x1, z1 = map(float, sys.argv[1:5])
    a, bb = P(x0, z0), P(x1, z1)
    crop = im.crop((int(a[0]), int(a[1]), int(bb[0]), int(bb[1])))
    crop = crop.resize((crop.width * 2, crop.height * 2), Image.NEAREST)
    crop.save(os.path.join(CACHE, 'preview_crop.png'))
im.resize((im.width // 2, im.height // 2)).save(os.path.join(CACHE, 'preview_small.png'))
print('ok')

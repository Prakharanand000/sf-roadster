// Buildings' ground on the lidar patches (tools/bake_lidar_tiles.py runs this after writing them).
// For each building of every covered tile and its neighbours with a footprint corner inside lidar
// coverage: the lowest and highest lidar ground under its corners, as worlddata.js re-grounds
// buildings over the pilot. The game applies them when the tile loads, before its meshes are built,
// so buildings stand on the lidar ground even where the patch itself loads later.
// Writes data/v2/lidar/bground.bin (float32 gmin, gmax per building, NaN = keep the tile's) and
// index.json `bground`: { tiles: [[i, j, offset, count, buildingsHash], ...] }.
//   node tools/lidar_bground.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWorldData2 } from '../src/world/v2/city2.js';
import { createLidar, buildingsHash } from '../src/world/v2/lidar2.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'data/v2'), ldir = path.join(dir, 'lidar');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const index = JSON.parse(readFileSync(path.join(dir, 'net.json'), 'utf8'));
const buffer = ab(readFileSync(path.join(dir, 'net.bin.wasm')));
const file = (f) => (existsSync(f) ? ab(readFileSync(f)) : null);
// the plain world: tiles with the ground ranges the bake gave them
const world = createWorldData2(index, buffer, (i, j) => file(path.join(dir, 'tiles', `${i}_${j}.bin.wasm`)));
const L = JSON.parse(readFileSync(path.join(ldir, 'index.json'), 'utf8'));
const T = { uint16: Uint16Array, uint32: Uint32Array, float32: Float32Array };
const arr = (n) => { const s = index.arrays[n]; return new T[s.type](buffer, s.offset, s.length); };
const lidar = createLidar(L, world.Q.baseHeightAt, {
  net: { xz: arr('road_xz'), start: arr('road_start'), count: arr('road_count') },
  loadSync: (i, j) => file(path.join(ldir, `${i}_${j}.bin.wasm`)),
});
if (lidar.refused.length) throw new Error('patches refused by their fingerprints: ' + JSON.stringify(lidar.refused));

const TS = L.tile;
const todo = new Map();
for (const [i, j] of lidar.cover) {
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (world.Q.tileExists(i + di, j + dj)) todo.set(`${i + di},${j + dj}`, [i + di, j + dj]);
}
const out = [], rows = [];
let offset = 0, changed = 0, total = 0, maxMove = 0;
for (const [i, j] of [...todo.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
  const t = world.Q.tileAt((i + 0.5) * TS, (j + 0.5) * TS);
  if (!t || !t.B.count) continue;
  const B = t.B, vals = new Float32Array(B.count * 2).fill(NaN);
  let n = 0;
  for (let k = 0; k < B.count; k++) {
    const s0 = B.start[k];
    let lo = Infinity, hi = -Infinity, any = false;
    for (let v = 0; v < B.n[k]; v++) {
      const x = B.xz[(s0 + v) * 2], z = B.xz[(s0 + v) * 2 + 1];
      if (lidar.contains(x, z)) any = true;
      const h = lidar.heightAt(x, z);
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    if (!any) continue;
    vals[k * 2] = lo; vals[k * 2 + 1] = hi;
    maxMove = Math.max(maxMove, Math.abs(lo - B.gmin[k]));
    n++;
  }
  if (!n) continue;
  rows.push([i, j, offset, B.count, buildingsHash(B)]);
  out.push(vals);
  offset += B.count;
  changed += n;
  total += B.count;
}
const data = new Float32Array(offset * 2);
let o = 0;
for (const v of out) { data.set(v, o); o += v.length; }
writeFileSync(path.join(ldir, 'bground.bin'), Buffer.from(data.buffer));
L.bground = { tiles: rows, buildings: changed, maxGroundMove: Math.round(maxMove * 100) / 100 };
writeFileSync(path.join(ldir, 'index.json'), JSON.stringify(L, null, 1));
console.log(`bground: ${changed} buildings on the lidar ground in ${rows.length} tiles (${total} buildings listed; largest change of a building's lowest ground ${maxMove.toFixed(2)} m), ${(data.byteLength / 1e3).toFixed(0)} KB`);

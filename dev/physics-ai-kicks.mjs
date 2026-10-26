// list short "kickers" (abrupt slope increases) along each track: DEM roughness on roads
import { readFileSync, existsSync } from 'node:fs';
import { createWorldData } from '../src/world/city.js';
import { TrackPath } from '../src/physics/ai.js';
const index = JSON.parse(readFileSync('data/world.json', 'utf8'));
const bin = readFileSync(existsSync('data/world.bin') ? 'data/world.bin' : 'data/world.bin.wasm');
const { Q, tracks } = createWorldData(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const thr = +(process.argv[2] || 0.12);
for (const t of tracks) {
  const P = TrackPath.for(t, Q);
  const hs = P.hs, out = [];
  for (let k = 3; k < hs.length - 4; k++) {
    const sBefore = (hs[k] - hs[k - 2]) / 4, sAfter = (hs[k + 2] - hs[k]) / 4;
    const kick = sAfter - sBefore;
    if (kick > thr) { const pt = {}; P.pointAt(k * 2, pt); out.push(`${k * 2}m(${pt.x.toFixed(0)},${pt.z.toFixed(0)}) +${kick.toFixed(2)}`); k += 3; }
  }
  console.log(t.id, 'kickers >', thr, ':', out.length, out.slice(0, 14).join('  '));
}

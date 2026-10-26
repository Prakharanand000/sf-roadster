import { readFileSync, existsSync } from 'node:fs';
import { createWorldData } from '../src/world/city.js';
import { TrackPath } from '../src/physics/ai.js';
const index = JSON.parse(readFileSync('data/world.json', 'utf8'));
const bin = readFileSync(existsSync('data/world.bin') ? 'data/world.bin' : 'data/world.bin.wasm');
const { D, Q, tracks } = createWorldData(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const [tid, s0, s1, step] = process.argv.slice(2);
const P = TrackPath.for(tracks.find(t => t.id === tid), { ...Q });
const pt = {};
for (let s = +s0; s <= +s1; s += +(step || 10)) {
  P.pointAt(s, pt); const lx = pt.tz, lz = -pt.tx;
  const row = [];
  for (let d = -16; d <= 16; d += 2) { const x = pt.x + lx * d, z = pt.z + lz * d; row.push(Q.groundHeight(x, z).toFixed(0).padStart(4) + (Q.roadAt(x, z) === 1 ? 'r' : ' ')); }
  console.log(`s ${s} h ${P.heightAtS(s).toFixed(1)} | ${row.join('')}`);
}

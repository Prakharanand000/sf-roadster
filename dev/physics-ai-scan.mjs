// Scan track paths for points where the centreline is inside a wall (collideCircle at path height).
import { readFileSync, existsSync } from 'node:fs';
import { createWorldData } from '../src/world/city.js';
const index = JSON.parse(readFileSync('data/world.json', 'utf8'));
const bin = readFileSync(existsSync('data/world.bin') ? 'data/world.bin' : 'data/world.bin.wasm');
const { Q, tracks } = createWorldData(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
for (const t of tracks) {
  const bad = []; let L = 0, y = Q.groundHeight(t.path[0][0], t.path[0][1]);
  for (let i = 0; i < t.path.length; i++) {
    if (i) L += Math.hypot(t.path[i][0] - t.path[i - 1][0], t.path[i][1] - t.path[i - 1][1]);
    const [x, z] = t.path[i];
    y = Q.surfaceHeight(x, z, y + 2);
    const h = {};
    if (Q.collideCircle(x, z, 0.3, y, h)) bad.push(`${L.toFixed(0)}@solid${Q.solidAt(x, z)}(${x.toFixed(0)},${z.toFixed(0)})`);
  }
  console.log(t.id, 'centreline points inside walls:', bad.length, bad.slice(0, 12).join(' '));
}

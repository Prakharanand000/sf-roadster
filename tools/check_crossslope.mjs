// cross-slope (left vs right of the centreline at +-3 m) along all tracks
import { readFileSync } from 'node:fs';
import { createWorldData } from '../src/world/city.js';
const index = JSON.parse(readFileSync('data/world.json', 'utf8'));
const bin = readFileSync('data/world.bin.wasm');
const { Q, tracks } = createWorldData(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
for (const t of tracks) {
  const xs = [];
  for (let i = 1; i < t.path.length - 1; i++) {
    const [x, z] = t.path[i], dx = t.path[i + 1][0] - t.path[i - 1][0], dz = t.path[i + 1][1] - t.path[i - 1][1];
    const L = Math.hypot(dx, dz), nx = -dz / L, nz = dx / L;
    if (Q.deckAt(x, z) === Q.deckAt(x, z)) continue;
    const c = Math.abs(Q.heightAt(x + nx * 3, z + nz * 3) - Q.heightAt(x - nx * 3, z - nz * 3)) / 6;
    xs.push([c, i, x, z]);
  }
  xs.sort((a, b) => b[0] - a[0]);
  const avg = xs.reduce((a, b) => a + b[0], 0) / xs.length;
  const out = xs.filter((v) => v[0] > 0.08 && !(v[2] > -1075 && v[2] < -910 && v[3] > -1600 && v[3] < -1520)).slice(0, 8).map((v) => (v[0] * 100).toFixed(0) + '%@' + v[2].toFixed(0) + ',' + v[3].toFixed(0));
  console.log(t.id, 'outside crooked block >8%:', out.join(' '));
  console.log(t.id, 'cross-slope avg', (avg * 100).toFixed(1) + '%', 'max', (xs[0][0] * 100).toFixed(1) + '% at', xs[0][2].toFixed(0), xs[0][3].toFixed(0), ' >8%:', xs.filter((v) => v[0] > 0.08).length);
}

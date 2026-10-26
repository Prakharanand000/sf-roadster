// max grade (2 m steps) and max grade change on every track, plus the north deck end
import { readFileSync } from 'node:fs';
import { createWorldData } from '../src/world/city.js';
const index = JSON.parse(readFileSync('data/world.json', 'utf8'));
const bin = readFileSync('data/world.bin.wasm');
const { Q, tracks } = createWorldData(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
for (const t of tracks) {
  let y = Q.groundHeight(...t.path[0]), prev = null, s = 0, maxStep = 0, at = '', maxG = 0, atG = '';
  const pts = t.loop ? t.path.concat([t.path[0]]) : t.path;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0);
    for (let u = 0; u < L; u += 2) {
      const x = x0 + (x1 - x0) * u / L, z = z0 + (z1 - z0) * u / L;
      y = Q.surfaceHeight(x, z, y + 1);
      if (prev != null) {
        const d = Math.abs(y - prev);
        if (d > maxStep) { maxStep = d; at = `${(s + u).toFixed(0)} (${x.toFixed(0)},${z.toFixed(0)})`; }
      }
      prev = y;
    }
    s += L;
  }
  console.log(t.id, 'max height change per 2 m:', maxStep.toFixed(2), 'm (', (maxStep / 2 * 100).toFixed(0), '% ) at', at);
}

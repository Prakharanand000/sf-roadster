// v1 vs v2 at the same places (M4 parity): the v2 world must reproduce v1 inside v1's area, apart
// from the datum (v2 heights are NAVD88 - 0.969 m, v1 heights are the DEM as is).
//   node tools/test_parity_v2.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWorldData } from '../src/world/city.js';
import { createWorldData2 } from '../src/world/v2/city2.js';
import { v1ToV2 } from '../src/world/v2/proj2.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const i1 = JSON.parse(readFileSync(path.join(root, 'data/world.json'), 'utf8'));
const w1 = createWorldData(i1, ab(readFileSync(path.join(root, 'data/world.bin.wasm'))));   // no pilot: the plain v1 bake
const dir = path.join(root, 'data/v2');
const i2 = JSON.parse(readFileSync(path.join(dir, 'net.json'), 'utf8'));
const w2 = createWorldData2(i2, ab(readFileSync(path.join(dir, 'net.bin.wasm'))), (i, j) => {
  const f = path.join(dir, 'tiles', `${i}_${j}.bin.wasm`);
  return existsSync(f) ? ab(readFileSync(f)) : null;
});
const Q1 = w1.Q, Q2 = w2.Q;
const Y0 = i2.datum.y0_navd88;

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok  ', msg); } else { fails++; console.log('  FAIL', msg); } };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// deterministic sample of v1's area, 300 m in from its edges
const b = i1.bounds;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const N = 40000;
const dh = [], dhRoad = [];
let n = 0, land = 0, kindSame = 0, roadSame = 0, waterSame = 0, wallSame = 0, walls1 = 0;
for (let k = 0; k < N; k++) {
  const x1 = b.minX + 300 + rnd() * (b.maxX - b.minX - 600), z1 = b.minZ + 300 + rnd() * (b.maxZ - b.minZ - 600);
  const [x2, z2] = v1ToV2(x1, z1);
  n++;
  const w1w = Q1.isWater(x1, z1), w2w = Q2.isWater(x2, z2);
  if (w1w === w2w) waterSame++;
  if (w1w) continue;
  land++;
  const h1 = Q1.heightAt(x1, z1), h2 = Q2.heightAt(x2, z2);
  dh.push(h2 - (h1 - Y0));
  const r1 = Q1.roadAt(x1, z1), r2 = Q2.roadAt(x2, z2);
  if (r1 === r2) roadSame++;
  if (r1 === 1) dhRoad.push(h2 - (h1 - Y0));
  const s1 = Q1.surfaceAt(x1, z1, h1 + 0.5), s2 = Q2.surfaceAt(x2, z2, h2 + 0.5);
  if (s1 === s2) kindSame++;
  const c1 = Q1.collideCircle(x1, z1, 0.5, h1, {}) !== null, c2 = Q2.collideCircle(x2, z2, 0.5, h2, {}) !== null;
  if (c1) walls1++;
  if (c1 === c2) wallSame++;
}
const med = pct(dh, 0.5), absd = dh.map((v) => Math.abs(v)), absr = dhRoad.map((v) => Math.abs(v));
console.log(`${n} points, ${land} on land; height diff after datum: median ${med.toFixed(3)} m, |d| p50 ${pct(absd, 0.5).toFixed(2)} p95 ${pct(absd, 0.95).toFixed(2)} p99 ${pct(absd, 0.99).toFixed(2)} m; on roads p95 ${pct(absr, 0.95).toFixed(2)} m`);
ok(waterSame / n > 0.995, `water vs land agrees at ${(100 * waterSame / n).toFixed(2)}% of points`);
if (i2.stats && i2.stats.lidar_ground) {
  // v2's land is USGS's 1 m lidar DEM (tools/dem1m_v2.py), v1's is Terrarium: heights differ by what
  // the lidar corrects (the pilot measured lidar vs v1's terrain: mean 0.25 m, rms 1.28 m, p95 2.12 m).
  // A datum or projection error would still move the median or blow the spread on SF's hills.
  ok(Math.abs(med) < 0.5, `heights agree after the datum shift, lidar vs v1's Terrarium (median ${med.toFixed(3)} m)`);
  ok(pct(absd, 0.95) < 2.5 && pct(absr, 0.95) < 2.0, `95% of land within ${pct(absd, 0.95).toFixed(2)} m of v1, roads within ${pct(absr, 0.95).toFixed(2)} m (lidar ground)`);
} else {
  ok(Math.abs(med) < 0.1, `heights agree after the datum shift (median ${med.toFixed(3)} m)`);
  ok(pct(absd, 0.95) < 1.0 && pct(absr, 0.95) < 0.6, `95% of land within ${pct(absd, 0.95).toFixed(2)} m, roads within ${pct(absr, 0.95).toFixed(2)} m`);
}
ok(roadSame / land > 0.98, `road / sidewalk / off-road agrees at ${(100 * roadSame / land).toFixed(2)}% of land points`);
ok(kindSame / land > 0.97, `surface kind agrees at ${(100 * kindSame / land).toFixed(2)}% of land points`);
ok(wallSame / land > 0.98, `building walls agree at ${(100 * wallSame / land).toFixed(2)}% of land points (${walls1} inside a v1 building)`);
// building heights, building by building: v1's towers (> 30 m) against the v2 building at the same
// place, where v2 says its height came from OSM (bld_src 1; untagged buildings get a random height
// in each bake, so only tagged ones can agree)
{
  const B1 = w1.D.B;
  let tagged = 0, same = 0, found = 0, towers = 0;
  for (let k = 0; k < B1.count; k++) {
    if (B1.top[k] - B1.gmin[k] <= 30) continue;
    towers++;
    let cx = 0, cz = 0;
    for (let i = 0; i < B1.n[k]; i++) { cx += B1.xz[(B1.start[k] + i) * 2] / B1.n[k]; cz += B1.xz[(B1.start[k] + i) * 2 + 1] / B1.n[k]; }
    const [x2, z2] = v1ToV2(cx, cz);
    const T = Q2.tileAt(x2, z2);
    if (!T) continue;
    // footprint area: a tower inside its podium shares the podium's centroid, so of the buildings
    // within 3 m take the one whose area is closest to v1's
    const area = (xz, st, n) => { let a = 0; for (let i = 0, j = n - 1; i < n; j = i++) a += xz[(st + j) * 2] * xz[(st + i) * 2 + 1] - xz[(st + i) * 2] * xz[(st + j) * 2 + 1]; return Math.abs(a) / 2; };
    const a1 = area(B1.xz, B1.start[k], B1.n[k]);
    for (const S of [T, ...[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([di, dj]) => Q2.tileByIndex(T.i + di, T.j + dj)).filter(Boolean)]) {
      const B2 = S.B;
      let hit = -1, bestA = Infinity;
      for (let m = 0; m < B2.count; m++) {
        let mx = 0, mz = 0;
        for (let i = 0; i < B2.n[m]; i++) { mx += B2.xz[(B2.start[m] + i) * 2] / B2.n[m]; mz += B2.xz[(B2.start[m] + i) * 2 + 1] / B2.n[m]; }
        if (Math.hypot(mx - x2, mz - z2) >= 3) continue;
        const da = Math.abs(area(B2.xz, B2.start[m], B2.n[m]) - a1);
        if (da < bestA) { bestA = da; hit = m; }
      }
      if (hit < 0) continue;
      found++;
      if (B2.src && B2.src[hit] === 1) {
        tagged++;
        // the building's own height: the bake sets top = gmin + h + (gmax - gmin) / 2, and the ground
        // relief under a footprint is the lidar's in v2, so compare h, not top - gmin
        const h1 = B1.top[k] - (B1.gmin[k] + B1.gmax[k]) / 2, h2 = B2.top[hit] - (B2.gmin[hit] + B2.gmax[hit]) / 2;
        if (Math.abs(h2 - h1) < 0.5) same++;
      }
      break;
    }
  }
  ok(found > towers * 0.98 && tagged > 200 && same === tagged, `towers: ${found}/${towers} found in v2; all ${same}/${tagged} with an OSM height have the same height`);
}

// tracks: the same route (v1 path converted vs v2 path)
const dens = (p) => { const out = []; for (let i = 1; i < p.length; i++) { const [ax, az] = p[i - 1], [bx, bz] = p[i]; const L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L)); for (let t = 0; t < m; t++) out.push([ax + ((bx - ax) * t) / m, az + ((bz - az) * t) / m]); } out.push(p[p.length - 1]); return out; };
for (const t1 of w1.tracks) {
  const t2 = w2.tracks.find((t) => t.id === t1.id);
  const a = dens(t1.path.map(([x, z]) => v1ToV2(x, z))), c = dens(t2.path);
  let far = 0;
  for (const [x, z] of a) { let best = Infinity; for (let i = 0; i < c.length; i += 1) { const d = (c[i][0] - x) ** 2 + (c[i][1] - z) ** 2; if (d < best) best = d; } if (best > 25) far++; }
  ok(far / a.length < 0.03 && Math.abs(t1.lengthMeters - t2.lengthMeters) < 60, `${t1.id}: v1 ${t1.lengthMeters} m, v2 ${t2.lengthMeters} m, ${(100 * far / a.length).toFixed(1)}% of v1's path more than 5 m from v2's`);
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

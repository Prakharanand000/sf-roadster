// Node sanity test for the baked SF world + query API.   node tools/test_world.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWorldData, ATTRIBUTION } from '../src/world/city.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = JSON.parse(readFileSync(path.join(root, 'data/world.json'), 'utf8'));
const bin = readFileSync(path.join(root, 'data/world.bin.wasm'));
const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok  ', msg); } else { fails++; console.log('  FAIL', msg); } };
const proj = (lat, lon) => [(lon + 122.4075) * 111320 * Math.cos((37.788 * Math.PI) / 180), -(lat - 37.788) * 110540];

const t0 = performance.now();
const { D, Q, tracks, spawn } = createWorldData(index, buffer);
console.log(`decoded + indexed in ${(performance.now() - t0).toFixed(0)} ms; buildings ${D.B.count}, roads ${D.roads.length}, trees ${D.trees.type.length}`);
ok(ATTRIBUTION.includes('OpenStreetMap'), 'attribution string');

console.log('terrain');
const coit = index.landmarks.find((l) => l.id === 'coit');
ok(Q.heightAt(coit.x, coit.z) > 70 && Q.heightAt(coit.x, coit.z) < 110, `Telegraph Hill top ${Q.heightAt(coit.x, coit.z).toFixed(1)} m`);
const nob = proj(37.7918, -122.4130);
ok(Q.heightAt(...nob) > 85 && Q.heightAt(...nob) < 120, `Nob Hill (California & Taylor) ${Q.heightAt(...nob).toFixed(1)} m`);
const bay = proj(37.818, -122.41);
ok(Q.heightAt(...bay) < -3 && Q.isWater(...bay) && Q.surfaceAt(...bay, 0) === 'water', `bay is water, seabed ${Q.heightAt(...bay).toFixed(1)} m`);
const marina = proj(37.8055, -122.437);
ok(Q.heightAt(...marina) > 0 && !Q.isWater(...marina), `Marina Green is land ${Q.heightAt(...marina).toFixed(1)} m`);
ok(Q.surfaceAt(spawn.x, spawn.z, 1e4) === 'road', `spawn on road (${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)}) heading ${spawn.heading.toFixed(2)}`);
const n = Q.normalAt(...nob, 1e4);
ok(Math.abs(n.length() - 1) < 1e-6 && n.y > 0.8, `normalAt unit ${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}`);
const b = index.bounds;
ok(b.minX < -7000 && b.maxX > 3000 && b.minZ < -4800 && b.maxZ > 2500, 'bounds cover the area');

console.log('Golden Gate deck');
const gg = index.ggbridge;
const c = gg.centre;
const hDeck = Q.surfaceHeight(c[0], c[1], 1e4);
ok(hDeck > 64 && hDeck < 72, `deck at mid-span ${hDeck.toFixed(1)} m`);
ok(Q.surfaceAt(c[0], c[1], 1e4) === 'bridge', 'surfaceAt mid-span = bridge');
ok(!Q.isWater(c[0], c[1]), 'isWater false under deck');
ok(Q.surfaceHeight(c[0], c[1], 5) < 0 && Q.surfaceAt(c[0], c[1], 5) === 'water', 'below deck -> water');
const st = gg.southTower;
const legX = st[0] - gg.axis[1] * 13.6, legZ = st[1] + gg.axis[0] * 13.6;
const hit = Q.collideCircle(legX, legZ, 2.2, 0, {});
ok(hit !== null, 'tower leg collides at water level');
const onDeck = Q.collideCircle(st[0] + gg.axis[0] * 30, st[1] + gg.axis[1] * 30, 2.2, 66, {});
ok(onDeck === null, 'deck centre lane is free of walls');
const rail = Q.collideCircle(c[0] - gg.axis[1] * 12.5, c[1] + gg.axis[0] * 12.5, 2.0, hDeck, {});
ok(rail !== null, 'railing stops a car at the deck edge');

console.log('buildings');
let tallest = 0;
for (let k = 1; k < D.B.count; k++) if (D.B.top[k] - D.B.gmin[k] > D.B.top[tallest] - D.B.gmin[tallest]) tallest = k;
let cx = 0, cz = 0;
const s0 = D.B.start[tallest], nv = D.B.n[tallest];
for (let i = 0; i < nv; i++) { cx += D.B.xz[(s0 + i) * 2] / nv; cz += D.B.xz[(s0 + i) * 2 + 1] / nv; }
const top = D.B.top[tallest];
ok(Math.abs(Q.surfaceHeight(cx, cz, top + 2) - top) < 0.01 && Q.surfaceAt(cx, cz, top + 2) === 'roof', `roof of tallest building ${(top - D.B.gmin[tallest]).toFixed(0)} m tall`);
ok(Q.surfaceHeight(cx, cz, D.B.gmin[tallest] + 1) < top - 5, 'car below the roof sees the ground');
// collide just outside first edge of building 100
const k = 100, s1 = D.B.start[k];
const ax = D.B.xz[s1 * 2], az = D.B.xz[s1 * 2 + 1], bx = D.B.xz[(s1 + 1) * 2], bz = D.B.xz[(s1 + 1) * 2 + 1];
const L = Math.hypot(bx - ax, bz - az), onx = (bz - az) / L, onz = -(bx - ax) / L;
const mx = (ax + bx) / 2 + onx * 1.0, mz = (az + bz) / 2 + onz * 1.0;
const ch = Q.collideCircle(mx, mz, 2, D.B.gmin[k], {});
ok(ch && ch.depth > 0.5 && ch.nx * onx + ch.nz * onz > 0.7, `wall hit pushes outward (depth ${ch && ch.depth.toFixed(2)})`);
ok(Q.collideCircle(mx, mz, 2, D.B.top[k] + 1, {}) === null, 'no wall hit when above the roof');

console.log('tracks');
const want = ['embarcadero-sprint', 'lombard-zigzag', 'golden-gate-run', 'nob-hill-jumps', 'downtown-gp', 'painted-ladies'];
ok(want.every((id) => tracks.find((t) => t.id === id)), 'all six tracks present');
for (const t of tracks) {
  let onRoad = 0, maxGap = 0;
  for (let i = 0; i < t.path.length; i++) {
    const [x, z] = t.path[i];
    if (Q.roadAt(x, z) === 1 || Q.deckAt(x, z) === Q.deckAt(x, z)) onRoad++;
    if (i) maxGap = Math.max(maxGap, Math.hypot(x - t.path[i - 1][0], z - t.path[i - 1][1]));
  }
  const frac = onRoad / t.path.length;
  // checkpoint order: project each onto the path index
  const idxOf = (p) => { let bi = 0, bd = Infinity; t.path.forEach(([x, z], i) => { const d = Math.hypot(x - p.x, z - p.z); if (d < bd) { bd = d; bi = i; } }); return bi; };
  const cpi = t.checkpoints.map(idxOf);
  if (t.loop) cpi[cpi.length - 1] = t.path.length;
  const ordered = cpi.every((v, i) => i === 0 || v > cpi[i - 1]);
  const gaps = t.checkpoints.map((p, i) => (i ? Math.hypot(p.x - t.checkpoints[i - 1].x, p.z - t.checkpoints[i - 1].z) : 0)).slice(1);
  const gridOk = t.grid.length === 6 && t.grid.every((g) => Q.roadAt(g.x, g.z) === 1 || Q.deckAt(g.x, g.z) === Q.deckAt(g.x, g.z));
  ok(frac > 0.97 && maxGap < 12 && ordered && gridOk && t.laps >= 1 && t.difficulty >= 1 && t.difficulty <= 5,
    `${t.id}: ${t.lengthMeters} m x${t.laps}, ${t.path.length} pts, on-road ${(frac * 100).toFixed(1)}%, max step ${maxGap.toFixed(1)} m, ${t.checkpoints.length} cps (max gap ${Math.max(...gaps).toFixed(0)} m), grid ${gridOk ? 'ok' : 'OFF ROAD'}`);
}
const ggr = tracks.find((t) => t.id === 'golden-gate-run');
let deckPts = 0, maxH = 0;
for (const [x, z] of ggr.path) { const h = Q.surfaceHeight(x, z, 1e4); if (Q.surfaceAt(x, z, 1e4) === 'bridge') deckPts++; maxH = Math.max(maxH, h); }
ok(deckPts * 8 > 1200 && maxH > 64 && maxH < 80, `Golden Gate Run crosses the deck (${(deckPts * 8).toFixed(0)} m on deck, max ${maxH.toFixed(1)} m)`);
const end = ggr.path[ggr.path.length - 1];
const tEnd = (end[0] - gg.centre[0]) * gg.axis[0] + (end[1] - gg.centre[1]) * gg.axis[1];
ok(tEnd > 700, `Golden Gate Run ends past the north tower (t=${tEnd.toFixed(0)} m, tower at 640)`);

console.log('performance');
let t1 = performance.now(), acc = 0;
for (let i = 0; i < 200000; i++) acc += Q.surfaceHeight(-2000 + (i % 400) * 10, -1000 + (i % 377) * 7, 50);
const sh = (performance.now() - t1) / 200;
t1 = performance.now();
const out = {};
for (let i = 0; i < 200000; i++) Q.collideCircle(-500 + (i % 300) * 3, -800 + (i % 211) * 4, 2.2, 30, out);
const cc = (performance.now() - t1) / 200;
t1 = performance.now();
for (let i = 0; i < 100000; i++) Q.surfaceAt(-500 + (i % 300) * 3, -800 + (i % 211) * 4, 30);
const sa = (performance.now() - t1) / 100;
ok(sh < 1 && cc < 2, `surfaceHeight ${sh.toFixed(3)} us, collideCircle ${cc.toFixed(3)} us, surfaceAt ${sa.toFixed(3)} us per call`);
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

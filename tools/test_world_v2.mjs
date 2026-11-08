// Node test for the v2 world (data/v2 from tools/bake_v2.py) and its query API.
//   node tools/test_world_v2.mjs
// Tiles load from disk on first touch, so every query sees full data.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWorldData2, pinnedTiles } from '../src/world/v2/city2.js';
import { proj2 } from '../src/world/v2/proj2.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'data/v2');
const index = JSON.parse(readFileSync(path.join(dir, 'net.json'), 'utf8'));
const bin = readFileSync(path.join(dir, 'net.bin.wasm'));
const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
let tileReads = 0;
const readTile = (i, j) => {
  const f = path.join(dir, 'tiles', `${i}_${j}.bin.wasm`);
  if (!existsSync(f)) return null;
  tileReads++;
  const b = readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok  ', msg); } else { fails++; console.log('  FAIL', msg); } };
// without the pilot (PILOT=0, the ?pilot=0 comparison mode) the decks inside the lidar box still meet
// the lidar ground they were fitted to: their ends step onto the DEM ground there, so those checks
// are reported, not failed
const note = (cond, msg) => console.log(cond ? '  ok  ' : '  note', msg);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

console.log('projection');
// reference values from pyproj (tools/geo2.TM)
const REF = [[37.7918, -122.413, -484.441, -421.786], [37.818, -122.41, -220.123, -3329.786], [37.8716, -122.2727, 11860.432, -9287.601],
  [37.7, -122.52, -9921.271, 9761.308], [37.905, -122.2, 18248.731, -13006.549]];
let perr = 0;
for (const [la, lo, x, z] of REF) { const [px, pz] = proj2(la, lo); perr = Math.max(perr, Math.hypot(px - x, pz - z)); }
ok(perr < 0.005, `proj2 matches PROJ (max error ${(perr * 1000).toFixed(2)} mm)`);
ok(index.projection.includes('+proj=tmerc') && index.projection.includes('+lat_0=37.7880') && index.datum.y0_navd88 === 0.969, 'net.json declares the projection and datum');

// the lidar tile patches (data/v2/lidar/), else the lidar pilot (data/v2/pilot.*), as the game loads
// them; PILOT=0 tests the world without either, LIDAR=0 with the pilot instead of the patches
let pilotFiles = null, lidarFiles = null;
const fileAB = (f) => { const b = readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
if (process.env.PILOT !== '0') {
  if (process.env.LIDAR !== '0' && existsSync(path.join(dir, 'lidar/index.json'))) {
    lidarFiles = {
      index: JSON.parse(readFileSync(path.join(dir, 'lidar/index.json'), 'utf8')),
      bground: existsSync(path.join(dir, 'lidar/bground.bin')) ? fileAB(path.join(dir, 'lidar/bground.bin')) : null,
      readPatch: (i, j) => (existsSync(path.join(dir, `lidar/${i}_${j}.bin.wasm`)) ? fileAB(path.join(dir, `lidar/${i}_${j}.bin.wasm`)) : null),
    };
  } else if (existsSync(path.join(dir, 'pilot.json'))) {
    pilotFiles = { index: JSON.parse(readFileSync(path.join(dir, 'pilot.json'), 'utf8')), buffer: fileAB(path.join(dir, 'pilot.bin.wasm')) };
  }
}
const t0 = performance.now();
const { D, Q, tracks, spawn } = createWorldData2(index, buffer, readTile, pilotFiles, lidarFiles);
// the measured lidar ground and ribbons, from either source
const overlay = !!(D.lidar || D.pilot);
// the ground the bake fitted the decks to (net.json stats.deck_ground; older nets: the pilot). On any
// other ground the deck ends step onto ground they weren't fitted to, so those checks are notes.
const deckGround = (index.stats && index.stats.deck_ground) || 'pilot';
const fitted = deckGround === 'lidar tiles' ? !!D.lidar : deckGround === 'pilot' ? !!D.pilot : !overlay;
if (lidarFiles) {
  console.log(`lidar patches ${D.lidar ? 'loaded' : 'REFUSED'} (${lidarFiles.index.cover.length} tiles)`);
  ok(!!D.lidar && Q.lidar.refused.length === 0, `lidar patches match this net (${Q.lidar ? Q.lidar.cover.length : 0} tiles, ${Q.lidar ? Q.lidar.refused.length : '-'} refused by their fingerprints)`);
} else console.log(pilotFiles ? `pilot overlay ${D.pilot ? 'loaded' : 'REFUSED'} (${JSON.stringify(pilotFiles.index.bbox)})` : 'no lidar overlay');
if (pilotFiles) ok(!!D.pilot, 'v2 pilot matches this net (fingerprint)');
console.log(`net decoded + indexed in ${(performance.now() - t0).toFixed(0)} ms; roads ${D.roads.length}, skyline ${D.sky.count}, tiles ${index.tiles.count}`);
ok(D.roads.length === index.counts.roads && D.graph.nodes.length === index.counts.graphNodes && D.junctions.r.length === index.counts.junctions && D.sky.count === index.counts.skyline,
  'decoded counts match net.json');
ok(D.manifest.length === index.tiles.count * 5, `tile manifest has ${index.tiles.count} tiles`);

console.log('terrain');
const at = (la, lo) => proj2(la, lo);
const coit = index.landmarks.find((l) => l.id === 'coit');
ok(Q.heightAt(coit.x, coit.z) > 70 && Q.heightAt(coit.x, coit.z) < 110, `Telegraph Hill top ${Q.heightAt(coit.x, coit.z).toFixed(1)} m`);
const nob = at(37.7918, -122.4130);
ok(Q.heightAt(...nob) > 85 && Q.heightAt(...nob) < 120, `Nob Hill (California & Taylor) ${Q.heightAt(...nob).toFixed(1)} m`);
const bay = at(37.818, -122.41);
ok(Q.heightAt(...bay) < -3 && Q.isWater(...bay) && Q.surfaceAt(...bay, 0) === 'water', `bay is water, seabed ${Q.heightAt(...bay).toFixed(1)} m`);
const marina = at(37.8055, -122.437);
ok(Q.heightAt(...marina) > 0 && !Q.isWater(...marina), `Marina Green is land ${Q.heightAt(...marina).toFixed(1)} m`);
const twin = at(37.7544, -122.4477);
ok(Q.heightAt(...twin) > 230 && Q.heightAt(...twin) < 290, `Twin Peaks ${Q.heightAt(...twin).toFixed(1)} m (new area, south of v1)`);
const berkeley = at(37.8716, -122.2727);
ok(Q.heightAt(...berkeley) > 20 && Q.heightAt(...berkeley) < 80 && !Q.isWater(...berkeley), `Berkeley (Shattuck & Center) ${Q.heightAt(...berkeley).toFixed(1)} m`);
const oak = at(37.8044, -122.2712);
ok(Q.heightAt(...oak) > 2 && Q.heightAt(...oak) < 30 && !Q.isWater(...oak), `Oakland City Hall ${Q.heightAt(...oak).toFixed(1)} m`);
const merritt = at(37.8010, -122.2580);
ok(Q.isWater(...merritt), `Lake Merritt is water (${Q.surfaceAt(...merritt, 1e4)})`);
const yerba = at(37.8115, -122.3650);
ok(Q.heightAt(...yerba) > 30 && !Q.isWater(...yerba), `Yerba Buena Island ${Q.heightAt(...yerba).toFixed(1)} m`);
ok(Q.surfaceAt(spawn.x, spawn.z, 1e4) === 'road', `spawn on road (${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)}) heading ${spawn.heading.toFixed(2)}`);
ok(Q.collideCircle(spawn.x, spawn.z, 2.2, Q.heightAt(spawn.x, spawn.z), {}) === null, 'spawn is clear of walls');
const n = Q.normalAt(...nob, 1e4);
ok(Math.abs(n.length() - 1) < 1e-6 && n.y > 0.8, `normalAt unit ${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}`);
const b = index.bounds;
ok(b.minX < -9900 && b.maxX > 18200 && b.minZ < -13000 && b.maxZ > 9700, `bounds cover SF to Berkeley (${b.minX}..${b.maxX} x ${b.minZ}..${b.maxZ})`);

console.log('tiles vs net');
// the net's 16 m heights are every other 8 m sample of the same grid: tiles must agree exactly there
const g = index.grid;
let maxNode = 0, nodes = 0, maxEdge = 0, edges = 0;
for (let k = 0; k < 4000; k++) {
  const i = 20 + ((k * 7919) % (g.nx - 40)), j = 20 + ((k * 104729) % (g.nz - 40));
  const x = g.x0 + i * g.cell, z = g.z0 + j * g.cell;
  if (!Q.tileAt(x + 0.5, z + 0.5)) continue;
  maxNode = Math.max(maxNode, Math.abs(Q.baseHeightAt(x, z) - Q.coarseHeight(x, z)));   // the tile grid (the pilot overrides heightAt in its box)
  nodes++;
}
ok(nodes > 500 && maxNode < 1e-3, `tile heights equal the net at shared 16 m nodes (${nodes} nodes, max diff ${maxNode.toExponential(1)} m)`);
const TS = index.tiles.size;
for (let k = 0; k < 3000; k++) {
  const ti = index.tiles.i0 + 1 + ((k * 31) % (index.tiles.ni - 2)), tj = index.tiles.j0 + 1 + ((k * 17) % (index.tiles.nj - 2));
  if (!Q.tileExists(ti, tj) || !Q.tileExists(ti + 1, tj)) continue;
  const x = (ti + 1) * TS, z = tj * TS + ((k * 13) % 500) + 3.3;
  const d = Math.abs(Q.heightAt(x - 1e-4, z) - Q.heightAt(x + 1e-4, z));
  maxEdge = Math.max(maxEdge, d);
  edges++;
}
ok(edges > 100 && maxEdge < 0.01, `heights continuous across tile edges (${edges} samples, max step ${maxEdge.toFixed(4)} m)`);
// every query, everywhere in bounds: finite, no throw
let bad = 0, samples = 0;
const nrm = { x: 0, y: 0, z: 0, set(a, b2, c) { this.x = a; this.y = b2; this.z = c; return this; }, normalize() { const l = Math.hypot(this.x, this.y, this.z); this.x /= l; this.y /= l; this.z /= l; return this; } };
const kinds = new Set(['road', 'sidewalk', 'grass', 'sand', 'water', 'roof', 'bridge']);
for (let z = b.minZ + 5; z < b.maxZ; z += 211) {
  for (let x = b.minX + 5; x < b.maxX; x += 197) {
    samples++;
    try {
      const h = Q.heightAt(x, z), s = Q.surfaceHeight(x, z, 1e4), gh = Q.groundHeight(x, z);
      Q.normalAt(x, z, 1e4, nrm);
      const k = Q.surfaceAt(x, z, 1e4), lc = Q.landcoverAt(x, z), r = Q.roadAt(x, z);
      const c = Q.collideCircle(x, z, 2.2, h, {});
      if (!fin(h) || !fin(s) || !fin(gh) || s < h - 1e-6 || !fin(nrm.y) || nrm.y <= 0 || !kinds.has(k) || !(lc >= 0 && lc <= 10) || !(r >= 0 && r <= 2) ||
          (c && !(fin(c.nx) && fin(c.nz) && fin(c.depth)))) bad++;
    } catch (e) { bad++; if (bad < 3) console.log('   ', e.message); }
  }
}
ok(bad === 0, `all queries finite on a ~200 m grid over the whole map (${samples} points, ${bad} bad, ${tileReads} tiles read)`);

console.log('Golden Gate deck');
const gg = index.ggbridge;
const c = gg.centre;
const hDeck = Q.surfaceHeight(c[0], c[1], 1e4);
ok(hDeck > 63 && hDeck < 72, `deck at mid-span ${hDeck.toFixed(1)} m`);
ok(Q.surfaceAt(c[0], c[1], 1e4) === 'bridge' && !Q.isWater(c[0], c[1]), 'mid-span is bridge, not water');
ok(Q.surfaceHeight(c[0], c[1], 5) < 0 && Q.surfaceAt(c[0], c[1], 5) === 'water', 'below deck -> water');
const st = gg.southTower;
ok(Q.collideCircle(st[0] - gg.axis[1] * 13.6, st[1] + gg.axis[0] * 13.6, 2.2, 0, {}) !== null, 'tower leg collides at water level');
ok(Q.collideCircle(st[0] + gg.axis[0] * 30, st[1] + gg.axis[1] * 30, 2.2, 66, {}) === null, 'deck centre lane is free of walls');
ok(Q.collideCircle(c[0] - gg.axis[1] * 12.5, c[1] + gg.axis[0] * 12.5, 2.0, hDeck, {}) !== null, 'railing stops a car at the deck edge');

console.log('buildings');
// the tallest building of the tile under Salesforce Tower's block, and a wall in a dense block
const sf = index.landmarks.find((l) => l.id === 'transamerica');
const tl = Q.tileAt(sf.x, sf.z);
ok(tl && tl.B.count > 50, `downtown tile has ${tl ? tl.B.count : 0} buildings`);
const B = tl.B;
let tallest = 0;
for (let k = 1; k < B.count; k++) if (B.top[k] - B.gmin[k] > B.top[tallest] - B.gmin[tallest]) tallest = k;
let cx = 0, cz = 0;
for (let i = 0; i < B.n[tallest]; i++) { cx += B.xz[(B.start[tallest] + i) * 2] / B.n[tallest]; cz += B.xz[(B.start[tallest] + i) * 2 + 1] / B.n[tallest]; }
const top = B.top[tallest];
ok(Math.abs(Q.surfaceHeight(cx, cz, top + 2) - top) < 0.01 && Q.surfaceAt(cx, cz, top + 2) === 'roof', `roof of the tile's tallest building ${(top - B.gmin[tallest]).toFixed(0)} m`);
ok(Q.surfaceHeight(cx, cz, B.gmin[tallest] + 1) < top - 5, 'car below the roof sees the ground');
// probe 1 m outside an edge of building k: a car at its base hits the wall, pushed outward; a car
// above its roof does not (probes within reach of another building are skipped: a taller
// neighbour would rightly still hit)
let wallOk = 0, wallTried = 0;
for (const [la, lo] of [[37.7952, -122.4028], [37.8044, -122.2712], [37.8716, -122.2727], [37.7600, -122.4350], [37.7300, -122.4500]]) {
  const T = Q.tileAt(...at(la, lo));
  if (!T) continue;
  const BB = T.B;
  const boxes = Array.from({ length: BB.count }, (_, m) => {
    let a = Infinity, b2 = -Infinity, c2 = Infinity, d2 = -Infinity;
    for (let i = 0; i < BB.n[m]; i++) { const x = BB.xz[(BB.start[m] + i) * 2], z = BB.xz[(BB.start[m] + i) * 2 + 1]; a = Math.min(a, x); b2 = Math.max(b2, x); c2 = Math.min(c2, z); d2 = Math.max(d2, z); }
    return [a, b2, c2, d2];
  });
  let here = 0;
  for (let k = 0; k < BB.count && here < 15; k++) {
    const s1 = BB.start[k];
    const ax = BB.xz[s1 * 2], az = BB.xz[s1 * 2 + 1], bx = BB.xz[(s1 + 1) * 2], bz = BB.xz[(s1 + 1) * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 6) continue;
    const onx = (bz - az) / L, onz = -(bx - ax) / L;
    const mx = (ax + bx) / 2 + onx, mz = (az + bz) / 2 + onz;
    if (boxes.some((bb, m) => m !== k && mx > bb[0] - 3 && mx < bb[1] + 3 && mz > bb[2] - 3 && mz < bb[3] + 3)) continue;
    here++; wallTried++;
    const ch = Q.collideCircle(mx, mz, 2, BB.gmin[k], {});
    if (ch && ch.depth > 0.5 && ch.nx * onx + ch.nz * onz > 0.7 && Q.collideCircle(mx, mz, 2, BB.top[k] + 1, {}) === null) wallOk++;
  }
}
ok(wallTried >= 30 && wallOk === wallTried, `free-standing walls push cars outward and not over the roof (${wallOk}/${wallTried}, SF + East Bay)`);
// East Bay buildings exist and collide
const ot = Q.tileAt(...oak);
ok(ot && ot.B.count > 20, `Oakland City Hall tile has ${ot ? ot.B.count : 0} buildings`);

console.log('skyline');
ok(D.sky.count > 300 && D.sky.tile && D.sky.tile.length === D.sky.count * 2, `${D.sky.count} skyline towers with their tile ids`);
let skyBad = 0;
for (let k = 0; k < D.sky.count; k++) if (!Q.tileExists(D.sky.tile[k * 2], D.sky.tile[k * 2 + 1])) skyBad++;
ok(skyBad === 0, 'every skyline tower belongs to a tile that exists');

console.log('tracks');
const want = ['embarcadero-sprint', 'lombard-zigzag', 'golden-gate-run', 'nob-hill-jumps', 'downtown-gp', 'painted-ladies'];
ok(want.every((id) => tracks.find((t) => t.id === id)), 'all six tracks present');
for (const t of tracks) {
  let onRoad = 0, maxGap = 0, wet = 0;
  for (let i = 0; i < t.path.length; i++) {
    const [x, z] = t.path[i];
    if (Q.roadAt(x, z) === 1 || Q.deckAt(x, z) === Q.deckAt(x, z)) onRoad++;
    if (Q.isWater(x, z)) wet++;
    if (i) maxGap = Math.max(maxGap, Math.hypot(x - t.path[i - 1][0], z - t.path[i - 1][1]));
  }
  const frac = onRoad / t.path.length;
  const idxOf = (p) => { let bi = 0, bd = Infinity; t.path.forEach(([x, z], i) => { const d = Math.hypot(x - p.x, z - p.z); if (d < bd) { bd = d; bi = i; } }); return bi; };
  const cpi = t.checkpoints.map(idxOf);
  if (t.loop) cpi[cpi.length - 1] = t.path.length;
  const ordered = cpi.every((v, i) => i === 0 || v > cpi[i - 1]);
  const gridOk = t.grid.length === 6 && t.grid.every((q) => Q.roadAt(q.x, q.z) === 1 || Q.deckAt(q.x, q.z) === Q.deckAt(q.x, q.z));
  ok(frac > 0.97 && maxGap < 12 && ordered && gridOk && wet === 0 && t.laps >= 1,
    `${t.id}: ${t.lengthMeters} m x${t.laps}, on-road ${(frac * 100).toFixed(1)}%, max step ${maxGap.toFixed(1)} m, ${t.checkpoints.length} cps, grid ${gridOk ? 'ok' : 'OFF ROAD'}, water pts ${wet}`);
}
const ggr = tracks.find((t) => t.id === 'golden-gate-run');
let deckPts = 0, maxH = 0;
for (const [x, z] of ggr.path) { const h = Q.surfaceHeight(x, z, 1e4); if (Q.surfaceAt(x, z, 1e4) === 'bridge') deckPts++; maxH = Math.max(maxH, h); }
ok(deckPts * 8 > 1200 && maxH > 63 && maxH < 80, `Golden Gate Run crosses the deck (${(deckPts * 8).toFixed(0)} m on deck, max ${maxH.toFixed(1)} m)`);

console.log('Bay Bridge');
const bbr = tracks.find((t) => t.id === 'bay-bridge-run');
ok(!!bbr, 'Bay Bridge Run track present');
if (bbr) {
  // drive the path every 2 m: each point's surface seen from the previous height (a car on it).
  // The AI hops any rise over 0.55 m between 2 m samples (src/physics/ai.js): none may appear.
  let y = Q.surfaceHeight(bbr.path[0][0], bbr.path[0][1], 1e4), maxY = -1e9, wet = 0, off = 0, inTunnel = 0, tunnelOk = 0, bridgePts = 0, hops = 0, spawnOk = 0, drops = 0, maxRise = 0;
  for (let i = 1; i < bbr.path.length; i++) {
    const [x, z] = bbr.path[i], [px, pz] = bbr.path[i - 1];
    const L = Math.hypot(x - px, z - pz), m = Math.max(1, Math.ceil(L / 2));
    for (let q = 1; q <= m; q++) {
      const ny = Q.surfaceHeight(px + ((x - px) * q) / m, pz + ((z - pz) * q) / m, y + 1.0);
      maxRise = Math.max(maxRise, ny - y);
      if (ny - y > 0.55) hops++;
      if (y - ny > 1.0) drops++;
      y = ny;
    }
    maxY = Math.max(maxY, y);
    if (Q.isWater(x, z)) wet++;
    if (!(Q.roadAt(x, z) === 1 || Q.deckAt(x, z) === Q.deckAt(x, z))) off++;
    if (Q.surfaceAt(x, z, y + 0.5) === 'bridge') bridgePts++;
    const roof = Q.deckSurf(x, z, 1, 1e4);
    if (roof === roof) {
      inTunnel++;
      // a spawn there (traffic, reset: no height reference) lands in the bore, not on the hill
      if (Math.abs(Q.surfaceHeight(x, z, 1e4) - y) < 0.05) spawnOk++;
      // in the bore: the car stands on the floor, the ground (physics clamp) is not above it, the roof is above
      // (the floor deck at the car's level: hill roads over the bore are decks too)
      if (Math.abs(y - Q.deckSurf(x, z, 0, y + 1)) < 0.05 && Q.heightAt(x, z) <= y + 0.01 && roof > y + 6 && Q.surfaceHeight(x, z, y + 6) < roof) tunnelOk++;
    }
  }
  ok(wet === 0 && off / bbr.path.length < 0.03, `${bbr.lengthMeters} m, ${bbr.path.length} pts: on road ${(100 - 100 * off / bbr.path.length).toFixed(1)}%, water pts ${wet}`);
  (fitted ? ok : note)(hops === 0 && drops === 0, `driven every 2 m: no rise over 0.55 m (max ${maxRise.toFixed(2)} m) and no drop over 1 m (${hops} rises, ${drops} drops)${fitted ? '' : ` [decks fitted to the ${deckGround} ground, not this one]`}`);
  ok(maxY > 70 && maxY < 85 && bridgePts * 8 > 6000, `crosses the bay on decks (top ${maxY.toFixed(1)} m, ${(bridgePts * 8 / 1000).toFixed(1)} km on deck)`);
  ok(inTunnel > 10 && spawnOk === inTunnel, `a spawn with no height reference in the bore lands on its floor (${spawnOk}/${inTunnel})`);
  ok(inTunnel > 10 && tunnelOk === inTunnel, `Yerba Buena tunnel: ${tunnelOk}/${inTunnel} points with floor under the car, ground below it, roof above`);
  // side by side on the west span: the two directions' decks do not overlap
  const span = index.landmarks.find((l) => l.id === 'baybridge').span;
  const mid = [(span[0][0] + span[1][0]) / 2, (span[0][1] + span[1][1]) / 2];
  const near = D.decks.filter((d) => d.kind === 0 && Array.from(d.x).some((vx, i) => Math.hypot(vx - mid[0], d.z[i] - mid[1]) < 60));
  let minSep = Infinity;
  for (let a = 0; a < near.length; a++) for (let c = a + 1; c < near.length; c++) {
    for (let i = 0; i < near[a].x.length; i++) {
      if (Math.hypot(near[a].x[i] - mid[0], near[a].z[i] - mid[1]) > 60) continue;
      for (let j = 0; j < near[c].x.length; j++) minSep = Math.min(minSep, Math.hypot(near[a].x[i] - near[c].x[j], near[a].z[i] - near[c].z[j]) - near[a].hw - near[c].hw);
    }
  }
  ok(near.length >= 2 && minSep > -0.5, `west span mid-span: ${near.length} decks side by side, edge gap ${minSep.toFixed(2)} m (no overlap)`);
  // a car at the deck edge meets a railing; one in the middle of a lane does not
  const dk = near[0];
  const i0 = Math.floor(dk.x.length / 2);
  const ux = dk.x[i0 + 1] - dk.x[i0], uz = dk.z[i0 + 1] - dk.z[i0], ul = Math.hypot(ux, uz);
  const rx = -uz / ul, rz = ux / ul, h0 = dk.h[i0];
  let edgeHits = 0;
  for (const s of [1, -1]) if (Q.collideCircle(dk.x[i0] + rx * s * (dk.hw - 0.6), dk.z[i0] + rz * s * (dk.hw - 0.6), 1.2, h0, {})) edgeHits++;
  ok(edgeHits === 2 && Q.collideCircle(dk.x[i0], dk.z[i0], 1.2, h0, {}) === null, `deck edges have barriers (${edgeHits}/2), lane centre is free`);
  ok(Q.collideCircle(dk.x[i0] + rx * (dk.hw - 0.6), dk.z[i0] + rz * (dk.hw - 0.6), 1.2, h0 + 0.9, {}) !== null, 'barrier still stops a car bouncing 0.9 m');
}

console.log('AI height profiles');
// src/physics/ai.js samples groundHeight every 2 m along each track and hops any rise over 0.55 m;
// tracks that pass under a deck (Embarcadero Sprint under the Bay Bridge) must not see the deck.
// v1's own tracks have a few (Lombard's 27% crooked block, Nob Hill Jumps): no more than v1 has,
// measured the same way on data/world.* (with its pilot when this run has one).
const V1_HOPS = overlay ? { 'lombard-zigzag': [4, 0.59], 'nob-hill-jumps': [2, 1.15] } : { 'lombard-zigzag': [4, 0.59], 'nob-hill-jumps': [4, 0.60] };
for (const t of tracks) {
  const pts = t.loop ? [...t.path, t.path[0]] : t.path;
  let prev = null, hopsAI = 0, maxStep = 0, at = null;
  for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1], [x1, z1] = pts[i];
    const m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2));
    for (let q = 0; q < m; q++) {
      const yy = Q.groundHeight(x0 + ((x1 - x0) * q) / m, z0 + ((z1 - z0) * q) / m);
      if (prev !== null) { const r = yy - prev; if (r > maxStep) { maxStep = r; at = [x0, z0]; } if (r > 0.55) hopsAI++; }
      prev = yy;
    }
  }
  const [vh, vr] = V1_HOPS[t.id] || [0, 0.55];
  // without the pilot both worlds stand on the DEM, resampled on different grids (parity p99 ~1 m)
  const tol = overlay ? 0.1 : 0.2;
  (fitted || t.id !== 'bay-bridge-run' ? ok : note)(hopsAI <= vh && maxStep <= vr + tol, `${t.id}: AI profile hop steps ${hopsAI} (v1: ${vh}), max rise ${maxStep.toFixed(2)} m per 2 m${at ? ` near ${at[0].toFixed(0)},${at[1].toFixed(0)}` : ''}`);
}

console.log('pinned tiles');
const pins = pinnedTiles(index);
const corr = new Set(pins.corridors.map(([i, j]) => i + ',' + j));
let uncovered = 0;
for (const t of tracks) for (const [x, z] of t.path) if (!corr.has(Math.floor(x / TS) + ',' + Math.floor(z / TS))) uncovered++;
ok(uncovered === 0, `track corridors pin every tile a track touches (${pins.corridors.length} corridor tiles, ${pins.landmarks.length} landmark tiles)`);

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
ok(sh < 1.5 && cc < 3, `surfaceHeight ${sh.toFixed(3)} us, collideCircle ${cc.toFixed(3)} us, surfaceAt ${sa.toFixed(3)} us per call`);
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

// Gates for the lidar tile patches (data/v2/lidar/, tools/bake_lidar_tiles.py, src/world/v2/lidar2.js)
// as the v2 world loads them: every patch matches the net; the patches answer as the one-box bake of
// their island (kept in the bake cache) with no step at tile edges; a tile answers the same alone;
// coverage blends into the 8 m ground; each ribbon segment is drawn by exactly one tile with its lane
// markings in phase; buildings stand on the lidar ground; the old pilot's box stays covered.
//   node --expose-gc tools/test_lidar_v2.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createWorldData2 } from '../src/world/v2/city2.js';
import { decodePilot, createPilotQueries } from '../src/world/pilot.js';
import { createLidar, parsePatchFile } from '../src/world/v2/lidar2.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// LIDAR_DIR=<folder> tests another bake of the patches (tools/bake_lidar_tiles.py --out) on this net
const V2 = path.join(root, 'data/v2'), LD = process.env.LIDAR_DIR || path.join(V2, 'lidar');
const CACHE = process.env.SF_BAKE_CACHE || path.join(os.homedir(), 'Downloads', 'sf-roadster-bakecache');
const ISL = path.join(CACHE, 'lidar_tiles', 'islands');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const file = (f) => (existsSync(f) ? ab(readFileSync(f)) : null);
const readJ = (f) => JSON.parse(readFileSync(f, 'utf8'));
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok  ', msg); } else { fails++; console.log('  FAIL', msg); } };
const pct = (a, p) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const TOL = 1e-9;   // m: a patch's grid starts at its tile, the island bake's at the island (weights round apart)
let seed = 20261028;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const fine = () => rnd() * 1e-7;

const netIndex = readJ(path.join(V2, 'net.json')), netBuf = file(path.join(V2, 'net.bin.wasm'));
const L = readJ(path.join(LD, 'index.json'));
const TS = L.tile;
const readPatch = (i, j) => file(path.join(LD, `${i}_${j}.bin.wasm`));
const lidarFiles = { index: L, bground: file(path.join(LD, 'bground.bin')), readPatch };
// the world as the game loads it (patches on first touch), and the plain world for the 8 m ground
const W = createWorldData2(netIndex, netBuf, (i, j) => file(path.join(V2, 'tiles', `${i}_${j}.bin.wasm`)), null, lidarFiles);
const plain = createWorldData2(netIndex, netBuf, (i, j) => file(path.join(V2, 'tiles', `${i}_${j}.bin.wasm`)));
const base = plain.Q.baseHeightAt;
const LQ = W.Q.lidar;
const T = { uint16: Uint16Array, uint32: Uint32Array, float32: Float32Array };
const narr = (n) => { const s = netIndex.arrays[n]; return new T[s.type](netBuf, s.offset, s.length); };
const net = { xz: narr('road_xz'), start: narr('road_start'), count: narr('road_count') };

console.log(`lidar patches: ${L.cover.length} tiles${L.islands ? ` in ${Object.keys(L.islands).length} islands` : `, baked in blocks of ${L.stats.block} x ${L.stats.block}`}`);
ok(!!LQ && LQ.refused.length === 0 && LQ.cover.length === L.cover.length, `the world loads the patches; ${LQ ? LQ.refused.length : '-'} refused by their fingerprints`);
let loadable = 0;
for (const [i, j] of L.cover) if (LQ.add(readPatch(i, j))) loadable++;
ok(loadable === L.cover.length, `every patch file is the one index.json lists (${loadable}/${L.cover.length})`);

// shared edges: identical nodes on both sides
{
  let nodes = 0, bad = 0, pairs = 0;
  for (const [i, j] of L.cover) {
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      if (!LQ.has(i + di, j + dj)) continue;
      pairs++;
      const a = LQ.patch(i, j).P, b = LQ.patch(i + di, j + dj).P, n = a.grid.nx;
      for (let k = 0; k < n; k++) {
        const va = di ? a.G[k * n + n - 1] : a.G[(n - 1) * n + k], vb = di ? b.G[k * n] : b.G[k];
        nodes++;
        if (va !== vb) bad++;
      }
    }
  }
  ok(bad === 0 && pairs > 0, `shared edges: ${nodes} nodes on ${pairs} tile edges identical in both patches`);
}

// --- coverage-wide (any bake): what needs no one-box reference
// seams: on every shared tile edge both patches give the same ribbon at the same point. Their ground
// shares its edge nodes (checked above); between nodes pilot.js gridHeight clamps a point within
// 0.2 mm of its patch's far edge back inside, so the two differ by slope x 0.2 mm there (reported).
{
  let edges = 0, pts = 0, gWorst = 0, rWorst = 0, oneSided = 0;
  for (const [i, j] of L.cover) {
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      if (!LQ.has(i + di, j + dj)) continue;
      edges++;
      const A = LQ.patch(i, j).PQ, B = LQ.patch(i + di, j + dj).PQ;
      for (let s = 0.37; s < TS; s += 0.5) {
        const x = di ? (i + 1) * TS : i * TS + s, z = di ? j * TS + s : (j + 1) * TS;
        pts++;
        gWorst = Math.max(gWorst, Math.abs(A.gridHeight(x, z) - B.gridHeight(x, z)));
        const ra = A.ribbonAt(x, z), rb = B.ribbonAt(x, z);
        if ((ra === ra) !== (rb === rb)) oneSided++;
        else if (ra === ra) rWorst = Math.max(rWorst, Math.abs(ra - rb));
      }
    }
  }
  ok(rWorst < 1e-6 && oneSided === 0, `${edges} shared tile edges, ${pts} points on them: ribbons within ${rWorst.toExponential(1)} m in both patches, ${oneSided} on one side only (ground between edge nodes within ${(gWorst * 1000).toFixed(2)} mm: the 0.2 mm clamp on steep cells)`);
}
// the edge of coverage meets the 8 m ground
{
  let n = 0, worst = 0;
  for (const [i, j] of L.cover) {
    for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (LQ.isCovered(i + di, j + dj)) continue;
      for (let s = 1; s < TS; s += 4) {
        const x = di ? (di < 0 ? i * TS + 0.01 : (i + 1) * TS - 0.01) : i * TS + s;
        const z = dj ? (dj < 0 ? j * TS + 0.01 : (j + 1) * TS - 0.01) : j * TS + s;
        if (!(LQ.edgeDist(x, z) > 0)) continue;
        n++;
        worst = Math.max(worst, Math.abs(W.Q.heightAt(x, z) - base(x, z)));
      }
    }
  }
  ok(n > 0 && worst < 0.001, `edge of coverage: ${n} points 1 cm inside, within ${(worst * 1000).toFixed(3)} mm of the 8 m ground`);
}
// every ribbon segment drawn by exactly one tile (midpoint rule, patchmesh2.js), lane markings in phase
if (L.stats && L.stats.ribbons) {
  const owner = new Map(), along = new Map();
  let owned = 0, phaseErr = 0;
  for (const [i, j] of L.cover) {
    const P = LQ.patch(i, j).P, s0 = LQ.runS0(i, j), x0 = i * TS, z0 = j * TS;
    for (let r = 0; r < P.runs.start.length; r++) {
      const s = P.runs.start[r], e = s + P.runs.count[r];
      let a = s0[r];
      for (let q = s; q + 1 < e; q++) {
        if (q > s) a += Math.hypot(P.xz[q * 2] - P.xz[q * 2 - 2], P.xz[q * 2 + 1] - P.xz[q * 2 - 1]);
        const sk = P.xz[q * 2] + ',' + P.xz[q * 2 + 1] + '>' + P.xz[q * 2 + 2] + ',' + P.xz[q * 2 + 3] + ',' + P.runs.road[r];
        if (along.has(sk)) phaseErr = Math.max(phaseErr, Math.abs(along.get(sk) - a)); else along.set(sk, a);
        const mx = (P.xz[q * 2] + P.xz[q * 2 + 2]) / 2, mz = (P.xz[q * 2 + 1] + P.xz[q * 2 + 3]) / 2;
        if (mx >= x0 && mx < x0 + TS && mz >= z0 && mz < z0 + TS) { owner.set(sk, (owner.get(sk) || 0) + 1); owned++; }
      }
    }
  }
  const segs = L.stats.ribbons.stations - L.stats.ribbons.runs;
  const twice = [...owner.values()].filter((v) => v > 1).length;
  ok(owned === segs && twice === 0, `each ribbon segment owned by one tile: ${owned} owned of the bake's ${segs}, ${twice} by two`);
  ok(phaseErr < 0.01, `lane markings in phase across cuts: a segment's along-road distance in two tiles differs by ${(phaseErr * 1000).toFixed(3)} mm at most`);
}
// lakes stay water: lidar has no ground over them, and the bake keeps the 8 m ground's carved bed there
{
  let lakes = 0, inside = 0, wet = 0;
  const inRing = (ring, x, z) => { let c = false; for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) { const [xa, za] = ring[a], [xb, zb] = ring[b]; if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) c = !c; } return c; };
  for (const lk of netIndex.lakes) {
    const xs = lk.ring.map((p) => p[0]), zs = lk.ring.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    if ((x1 - x0) * (z1 - z0) < 20000) continue;
    let allIn = true;
    for (const [x, z] of lk.ring) if (!(LQ.edgeDist(x, z) > 0)) allIn = false;
    if (!allIn) continue;
    lakes++;
    for (let k = 0; k < 400; k++) {
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
      if (!inRing(lk.ring, x, z)) continue;
      // 20 m in from the shore (the shore band keeps the lidar fill)
      let near = false;
      for (let a = 0; a < lk.ring.length && !near; a++) if (Math.hypot(lk.ring[a][0] - x, lk.ring[a][1] - z) < 20) near = true;
      if (near) continue;
      inside++;
      if (W.Q.isWater(x, z)) wet++;
    }
  }
  if (lakes) ok(wet / inside > 0.95, `lakes inside coverage stay water: ${lakes} lakes, ${wet}/${inside} points 20 m from the shore are water`);
  else console.log('  --   no lake inside coverage');
}

for (const [name, isl] of Object.entries(L.islands || {})) {
  const [X0, Z0, X1, Z1] = isl.box;
  console.log(`\nisland ${name}: ${isl.tiles.length} tiles, box ${isl.box.join(',')}`);
  const refI = readJ(path.join(ISL, name + '.json'));
  const ref = createPilotQueries(decodePilot(refI, file(path.join(ISL, name + '.bin.wasm'))), base);
  const refKind = (x, z) => ref.surfaceKind(x, z);
  // the patches answer as the island's one-box bake
  {
    let n = 0, hBad = 0, kBad = 0, maxD = 0;
    for (let k = 0; k < 200000; k++) {
      const x = X0 + 0.01 + rnd() * (X1 - X0 - 0.02) + fine(), z = Z0 + 0.01 + rnd() * (Z1 - Z0 - 0.02) + fine();
      const d = Math.abs(W.Q.heightAt(x, z) - ref.heightAt(x, z));
      maxD = Math.max(maxD, d);
      if (!(d <= TOL)) hBad++;
      if (W.Q.pilot.surfaceKind(x, z) !== refKind(x, z)) kBad++;
      n++;
    }
    ok(hBad === 0 && kBad === 0, `${n} random points: the world's heightAt equals the island bake (max diff ${maxD.toExponential(1)} m), surface kind identical (${kBad} differ)`);
  }
  // across interior tile edges: the step vs the bake's step, and ribbon hits near the edges
  {
    let pairs = 0, seam = 0, miss = 0, extra = 0, near = 0;
    const edges = [];
    for (let x = X0 + TS; x < X1; x += TS) edges.push(['x', x]);
    for (let z = Z0 + TS; z < Z1; z += TS) edges.push(['z', z]);
    for (const [ax, v] of edges) {
      const [a0, a1] = ax === 'x' ? [Z0, Z1] : [X0, X1];
      for (let s = a0 + 0.125; s < a1; s += 0.25) {
        const p = ax === 'x' ? [[v - 0.005, s], [v + 0.005, s]] : [[s, v - 0.005], [s, v + 0.005]];
        const h1 = W.Q.heightAt(...p[0]), h2 = W.Q.heightAt(...p[1]), r1 = ref.heightAt(...p[0]), r2 = ref.heightAt(...p[1]);
        pairs++;
        seam = Math.max(seam, Math.abs((h2 - h1) - (r2 - r1)));
      }
      for (let k = 0; k < 5000; k++) {
        const s = a0 + rnd() * (a1 - a0), o = (rnd() * 2 - 1) * 2;
        const [x, z] = ax === 'x' ? [v + o, s] : [s, v + o];
        const rh = ref.ribbonAt(x, z), ph = W.Q.pilot.ribbonAt(x, z);
        near++;
        if (rh === rh && ph !== ph) miss++;
        if (rh !== rh && ph === ph) extra++;
      }
    }
    if (edges.length) {
      ok(seam <= TOL, `across ${edges.length} tile edges, ${pairs} pairs 1 cm apart: steps match the bake's within ${seam.toExponential(1)} m`);
      ok(miss === 0 && extra === 0, `ribbons within 2 m of tile edges: ${near} points, ${miss} misses, ${extra} extra hits`);
    }
  }
  // the outer edge meets the 8 m ground
  {
    let worst = 0, n = 0;
    for (let s = 0; s <= 1; s += 0.001) {
      for (const [x, z] of [[X0 + 0.01, Z0 + s * (Z1 - Z0)], [X1 - 0.01, Z0 + s * (Z1 - Z0)], [X0 + s * (X1 - X0), Z0 + 0.01], [X0 + s * (X1 - X0), Z1 - 0.01]]) {
        worst = Math.max(worst, Math.abs(W.Q.heightAt(x, z) - base(x, z)));
        n++;
      }
    }
    ok(worst < 0.001, `outer edge: 1 cm inside within ${(worst * 1000).toFixed(3)} mm of the 8 m ground (${n} points)`);
  }
  // each segment drawn by exactly one tile (midpoint rule, patchmesh2.js), markings in phase
  {
    const owner = new Map(), along = new Map();
    let owned = 0, phaseErr = 0;
    for (const [i, j] of isl.tiles) {
      const tp = LQ.patch(i, j), P = tp.P, s0 = LQ.runS0(i, j), x0 = i * TS, z0 = j * TS;
      for (let r = 0; r < P.runs.start.length; r++) {
        const s = P.runs.start[r], e = s + P.runs.count[r];
        let a = s0[r];
        for (let q = s; q < e; q++) {
          if (q > s) a += Math.hypot(P.xz[q * 2] - P.xz[q * 2 - 2], P.xz[q * 2 + 1] - P.xz[q * 2 - 1]);
          if (q + 1 >= e) continue;
          // a segment, not a station: a loop road's first and last stations coincide, and two runs of a
          // road can meet at one point, each with its own distance along
          const sk = P.xz[q * 2] + ',' + P.xz[q * 2 + 1] + '>' + P.xz[q * 2 + 2] + ',' + P.xz[q * 2 + 3] + ',' + P.runs.road[r];
          if (along.has(sk)) phaseErr = Math.max(phaseErr, Math.abs(along.get(sk) - a)); else along.set(sk, a);
          const mx = (P.xz[q * 2] + P.xz[q * 2 + 2]) / 2, mz = (P.xz[q * 2 + 1] + P.xz[q * 2 + 3]) / 2;
          if (mx >= x0 && mx < x0 + TS && mz >= z0 && mz < z0 + TS) {
            owner.set(sk, (owner.get(sk) || 0) + 1);
            owned++;
          }
        }
      }
    }
    const refSegs = refI.counts.stations - refI.counts.runs;
    const twice = [...owner.values()].filter((v) => v > 1).length;
    ok(owned === refSegs && twice === 0, `each ribbon segment owned by one tile: ${owned} owned of ${refSegs} in the bake, ${twice} by two`);
    ok(phaseErr < 0.01, `lane markings in phase across cuts: along-road distance of a segment in two tiles differs by ${(phaseErr * 1000).toFixed(3)} mm at most`);
  }
}

// buildings stand on the lidar ground (tools/lidar_bground.mjs, applied when a tile loads)
{
  let checked = 0, bad = 0, moved = 0;
  const bt = L.bground ? L.bground.tiles : [];
  for (const [i, j] of bt) {
    const t = W.Q.tileAt((i + 0.5) * TS, (j + 0.5) * TS), tp = plain.Q.tileAt((i + 0.5) * TS, (j + 0.5) * TS);
    const B = t.B;
    for (let k = 0; k < B.count; k++) {
      let lo = Infinity, hi = -Infinity, any = false;
      for (let v = 0; v < B.n[k]; v++) {
        const x = B.xz[(B.start[k] + v) * 2], z = B.xz[(B.start[k] + v) * 2 + 1];
        if (LQ.contains(x, z)) any = true;
        const hv = W.Q.heightAt(x, z);
        if (hv < lo) lo = hv; if (hv > hi) hi = hv;
      }
      if (!any) continue;
      checked++;
      if (Math.abs(B.gmin[k] - lo) > 1e-4 || Math.abs(B.gmax[k] - hi) > 1e-4) bad++;
      if (Math.abs(B.gmin[k] - tp.B.gmin[k]) > 0.05) moved++;
    }
  }
  if (!L.bground) console.log('  --   no bground in this bake (tools/lidar_bground.mjs runs for data/v2/lidar only)');
  else ok(checked > 1000 && bad === 0, `buildings on the lidar ground: ${checked} with a corner in coverage take their lowest and highest lidar ground (${bad} don't; ${moved} moved > 5 cm from the 8 m ground)`);
}

// the old pilot box stays covered (switching to patches loses no lidar)
{
  const pb = readJ(path.join(V2, 'pilot.json')).bbox;
  let out = 0, n = 0;
  for (let k = 0; k < 20000; k++) {
    const x = pb.x0 + rnd() * (pb.x1 - pb.x0), z = pb.z0 + rnd() * (pb.z1 - pb.z0);
    n++;
    if (!(LQ.edgeDist(x, z) > 0)) out++;
  }
  ok(out === 0, `the old pilot box is inside coverage (${out} of ${n} points outside)`);
  const pilot = createPilotQueries(decodePilot(readJ(path.join(V2, 'pilot.json')), file(path.join(V2, 'pilot.bin.wasm'))), base);
  const d = [];
  for (let k = 0; k < 100000; k++) {
    const x = pb.x0 + 64 + rnd() * (pb.x1 - pb.x0 - 128), z = pb.z0 + 64 + rnd() * (pb.z1 - pb.z0 - 128);
    d.push(Math.abs(W.Q.heightAt(x, z) - pilot.heightAt(x, z)));
  }
  console.log(`  note vs today's v2 pilot inside its box (> 64 m from its edge): |dh| p50 ${(pct(d, 0.5) * 100).toFixed(2)} p99 ${(pct(d, 0.99) * 100).toFixed(2)} max ${(pct(d, 1) * 100).toFixed(1)} cm, ${(100 * d.filter((v) => v <= 0.02).length / d.length).toFixed(2)}% within 2 cm (its fill was not local; lidar-tiles-spike.md)`);
}

// memory and decode time per patch
{
  const times = [], mem = [], sizes = [], gz = [];
  for (const [i, j] of L.cover) {
    const buf = readPatch(i, j);
    sizes.push(buf.byteLength / 1e3);
    gz.push(gzipSync(Buffer.from(buf), { level: 9 }).length / 1e3);
    const t = [];
    for (let rep = 0; rep < 3; rep++) {
      const one = createLidar(L, base, { net });
      const t0 = performance.now();
      one.add(buf.slice(0));
      t.push(performance.now() - t0);
    }
    times.push(pct(t, 0.5));
  }
  if (globalThis.gc) {
    const keep = [];
    gc(); gc(); const m0 = process.memoryUsage();
    const one = createLidar(L, base, { net });
    for (const [i, j] of L.cover) one.add(readPatch(i, j));
    keep.push(one);
    gc(); gc(); const m1 = process.memoryUsage();
    mem.push(((m1.arrayBuffers - m0.arrayBuffers) + (m1.heapUsed - m0.heapUsed)) / L.cover.length / 1e6);
  }
  console.log(`  info per patch: decode ${pct(times, 0.5).toFixed(1)} ms median (max ${pct(times, 1).toFixed(1)}); memory ${mem.length ? mem[0].toFixed(2) + ' MB average' : '(run with --expose-gc)'}; file ${pct(sizes, 0.5).toFixed(0)} KB median (max ${pct(sizes, 1).toFixed(0)}), ${pct(gz, 0.5).toFixed(0)} KB gzip median; all ${L.cover.length}: ${(gz.reduce((a, b) => a + b, 0) / 1e3).toFixed(1)} MB gzip`);
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

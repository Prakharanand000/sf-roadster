// Gates for the lidar-tiles spike (tools/research/lidar-tiles-plan.md, tools/spike_lidar_tiles.py):
// patches cut per 512 m tile must answer exactly as the one-box bake they were cut from, meet
// without steps at tile edges, blend into the 8 m ground only at the edge of coverage, and match
// today's v2 pilot away from the island's edges. Also measures decode time and memory per patch.
//   node --expose-gc tools/test_lidar_spike.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createWorldData2 } from '../src/world/v2/city2.js';
import { decodePilot, createPilotQueries } from '../src/world/pilot.js';
import { createPatchSet, roadBoxes, tileHash } from '../src/world/v2/lidar2.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const V2 = path.join(root, 'data/v2'), SP = path.join(V2, 'lidar_spike');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const readJ = (f) => JSON.parse(readFileSync(f, 'utf8'));
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok  ', msg); } else { fails++; console.log('  FAIL', msg); } };
const TOL = 1e-9;   // m: a patch's grid starts at its tile, the bake's at the island, so weights round apart (~1e-14 m)
const T0 = performance.now();
const lap = (what) => console.log(`  time ${what}: ${((performance.now() - T0) / 1000).toFixed(1)} s`);
const pct = (a, p) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
let seed = 20261028;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

const netIndex = readJ(path.join(V2, 'net.json')), netBuf = readFileSync(path.join(V2, 'net.bin.wasm'));
const world = createWorldData2(netIndex, ab(netBuf), (i, j) => {
  const f = path.join(V2, 'tiles', `${i}_${j}.bin.wasm`);
  return existsSync(f) ? ab(readFileSync(f)) : null;
});
const base = world.Q.baseHeightAt;
const spike = readJ(path.join(SP, 'spike.json'));
const TS = 512;
const loadPilotFiles = (name) => ({ index: readJ(path.join(SP, name + '.json')), buffer: ab(readFileSync(path.join(SP, name + '.bin.wasm'))) });

const report = {};
for (const [name, isl] of Object.entries(spike.islands)) {
  console.log(`\nisland ${name}: tiles ${isl.tiles.map((t) => t.tile.join(',')).join(' ')}, box ${isl.box.join(',')}`);
  const [X0, Z0, X1, Z1] = isl.box;
  const refF = loadPilotFiles('island_' + name);
  const ref = createPilotQueries(decodePilot(refF.index, refF.buffer), base);
  const F = refF.index.feather;
  const cover = refF.index.cover;
  const files = isl.tiles.map((t) => loadPilotFiles(t.tile.join('_')));
  const set = createPatchSet(cover, F, base, TS);
  for (const f of files) set.add(f.index, f.buffer);
  const refKind = (x, z) => ref.surfaceKind(x, z);

  // 1. shared edges: the same grid values on both sides (raw uint16 and decoded)
  {
    let pairs = 0, nodes = 0, bad = 0;
    for (const a of files) for (const b of files) {
      const [ai, aj] = a.index.tile, [bi, bj] = b.index.tile;
      if (!((bi === ai + 1 && bj === aj) || (bi === ai && bj === aj + 1))) continue;
      pairs++;
      const Ga = set.patch(ai, aj).P.G, Gb = set.patch(bi, bj).P.G, n = a.index.grid.nx;
      for (let k = 0; k < n; k++) {
        const va = bi > ai ? Ga[k * n + n - 1] : Ga[(n - 1) * n + k];
        const vb = bi > ai ? Gb[k * n] : Gb[k];
        nodes++;
        if (va !== vb) bad++;
      }
    }
    if (pairs) ok(bad === 0, `shared edges: ${nodes} nodes on ${pairs} tile edges identical in both patches (${bad} differ)`);
    else console.log('  --   no shared edges in a one-tile island');
  }

  // 2. the patch set answers exactly as the one-box bake, all over the island
  const cmp = (xs, zs) => {
    let n = 0, hBad = 0, kBad = 0, maxD = 0;
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k], z = zs[k];
      const h1 = ref.heightAt(x, z), h2 = set.heightAt(x, z);
      n++;
      const dd = Math.abs(h1 - h2);
      maxD = Math.max(maxD, dd);
      if (!(dd <= TOL)) hBad++;
      if (refKind(x, z) !== set.surfaceKind(x, z)) kBad++;
    }
    return { n, hBad, kBad, maxD };
  };
  {
    const xs = [], zs = [];
    // + a sub-micrometre part, so coordinates use every mantissa bit and tile vs island grid
    // origins round apart (a 32-bit fraction times the box size alone is exact in both)
    const fine = () => rnd() * 1e-7;
    for (let k = 0; k < 200000; k++) { xs.push(X0 + 0.01 + rnd() * (X1 - X0 - 0.02) + fine()); zs.push(Z0 + 0.01 + rnd() * (Z1 - Z0 - 0.02) + fine()); }
    const r = cmp(xs, zs);
    ok(r.hBad === 0 && r.kBad === 0, `${r.n} random points: heights equal to the one-box bake (max diff ${r.maxD.toExponential(1)} m; ${r.hBad} over 1 nm), surface kind identical (${r.kBad} differ)`);
    lap('random points');
  }

  // 3./4. across interior tile edges: pairs 1 cm apart every 0.25 m, and ribbon hits within 2 m
  {
    const edges = [];
    for (let x = X0 + TS; x < X1; x += TS) edges.push(['x', x]);
    for (let z = Z0 + TS; z < Z1; z += TS) edges.push(['z', z]);
    let pairs = 0, seam = 0, worst = 0, miss = 0, extra = 0, near = 0;
    for (const [ax, v] of edges) {
      const [a0, a1] = ax === 'x' ? [Z0, Z1] : [X0, X1];
      for (let s = a0 + 0.125; s < a1; s += 0.25) {
        const p = ax === 'x' ? [[v - 0.005, s], [v + 0.005, s]] : [[s, v - 0.005], [s, v + 0.005]];
        const h1 = set.heightAt(...p[0]), h2 = set.heightAt(...p[1]);
        const r1 = ref.heightAt(...p[0]), r2 = ref.heightAt(...p[1]);
        pairs++;
        seam = Math.max(seam, Math.abs((h2 - h1) - (r2 - r1)));
        worst = Math.max(worst, Math.abs(h2 - h1));
      }
      for (let k = 0; k < 20000; k++) {
        const s = a0 + rnd() * (a1 - a0), o = (rnd() * 2 - 1) * 2;
        const [x, z] = ax === 'x' ? [v + o, s] : [s, v + o];
        const rh = ref.ribbonAt(x, z), ph = set.ribbonAt(x, z);
        near++;
        if (rh === rh && ph !== ph) miss++;
        if (rh !== rh && ph === ph) extra++;
      }
    }
    if (edges.length) {
      ok(seam <= TOL, `across ${edges.length} tile edges: ${pairs} pairs 1 cm apart; the step across an edge differs from the bake's at the same place by at most ${seam.toExponential(1)} m (the largest step itself, a slope or curb in the bake: ${(worst * 1000).toFixed(1)} mm)`);
      ok(miss === 0 && extra === 0, `ribbons within 2 m of tile edges: ${near} points, ${miss} misses, ${extra} extra hits`);
    }
    lap('tile edges');
  }

  // 5. load-state independence: each tile alone answers as with all tiles loaded
  {
    let n = 0, bad = 0;
    for (const f of files) {
      const alone = createPatchSet(cover, F, base, TS);
      alone.add(f.index, f.buffer);
      const [i, j] = f.index.tile;
      for (let k = 0; k < 20000; k++) {
        const x = i * TS + 1 + rnd() * (TS - 2), z = j * TS + 1 + rnd() * (TS - 2);
        n++;
        if (alone.heightAt(x, z) !== set.heightAt(x, z) || alone.surfaceKind(x, z) !== set.surfaceKind(x, z)) bad++;
      }
    }
    ok(bad === 0, `each tile loaded alone answers as with all loaded (${n} points >= 1 m inside, ${bad} differ)`);
    lap('load state');
  }

  // 6. the outer edge meets the 8 m ground
  {
    let n = 0, worst = 0;
    for (let s = 0; s <= 1; s += 0.0005) {
      for (const [x, z] of [[X0 + 0.01, Z0 + s * (Z1 - Z0)], [X1 - 0.01, Z0 + s * (Z1 - Z0)], [X0 + s * (X1 - X0), Z0 + 0.01], [X0 + s * (X1 - X0), Z1 - 0.01]]) {
        n++;
        worst = Math.max(worst, Math.abs(set.heightAt(x, z) - base(x, z)));
      }
    }
    ok(worst < 0.001, `outer edge: 1 cm inside coverage within ${(worst * 1000).toFixed(3)} mm of the 8 m ground (${n} points)`);
  }

  // 8. a 4-tile corner with roads through it
  if (isl.tiles.length === 4) {
    const cx = X0 + TS, cz = Z0 + TS;
    const xs = [], zs = [];
    for (let z = cz - 30; z <= cz + 30; z += 0.1) for (let x = cx - 30; x <= cx + 30; x += 0.1) { xs.push(x); zs.push(z); }
    const r = cmp(xs, zs);
    let ribbonPts = 0, quads = new Set();
    for (let k = 0; k < xs.length; k++) if (ref.ribbonAt(xs[k], zs[k]) === ref.ribbonAt(xs[k], zs[k])) { ribbonPts++; quads.add(ref.hit.i); }
    ok(r.hBad === 0 && r.kBad === 0 && ribbonPts > 1000, `4-tile corner (${cx}, ${cz}), 60 x 60 m at 10 cm: ${r.n} points (${ribbonPts} on ${quads.size} ribbon segments) equal to the bake (max diff ${r.maxD.toExponential(1)} m; ${r.hBad} heights over 1 nm, ${r.kBad} kinds differ)`);
    lap('corner');
  }

  // 7. against a bigger bake: island A's interior must come out as it does inside the 3 x 2 tile
  // reference C (tools/spike_lidar_tiles.py REFERENCE, the same fill), and today's v2 pilot for scale
  const refC = spike.references && spike.references.C;
  if (refC && X0 >= refC.box[0] && X1 <= refC.box[2] && Z0 >= refC.box[1] && Z1 <= refC.box[3] && isl.tiles.length > 1) {
    const C = loadPilotFiles('island_C');
    const big = createPilotQueries(decodePilot(C.index, C.buffer), base);
    const pilotIdx = readJ(path.join(V2, 'pilot.json'));
    const pilot = createPilotQueries(decodePilot(pilotIdx, ab(readFileSync(path.join(V2, 'pilot.bin.wasm')))), base);
    const M = F + 40;
    const dIn = [], dRib = [], dPilot = [];
    for (let k = 0; k < 200000; k++) {
      const x = X0 + rnd() * (X1 - X0), z = Z0 + rnd() * (Z1 - Z0);
      if (!(x - X0 > M && X1 - x > M && z - Z0 > M && Z1 - z > M)) continue;
      const h = set.heightAt(x, z);
      const d = Math.abs(h - big.heightAt(x, z));
      dIn.push(d);
      if (set.ribbonAt(x, z) === set.ribbonAt(x, z)) dRib.push(d);
      dPilot.push(Math.abs(h - pilot.heightAt(x, z)));
    }
    const within = (a, t) => (100 * a.filter((v) => v <= t).length / a.length).toFixed(2);
    ok(pct(dIn, 0.99) < 0.02, `vs the 3 x 2 tile bake, > ${M} m inside island A: ${dIn.length} points, |dh| p50 ${(pct(dIn, 0.5) * 100).toFixed(2)} p99 ${(pct(dIn, 0.99) * 100).toFixed(2)} max ${(pct(dIn, 1) * 100).toFixed(1)} cm (${within(dIn, 0.02)}% within 2 cm, ${within(dIn, 0)}% identical; on ribbons p99 ${(pct(dRib, 0.99) * 100).toFixed(2)} cm)`);
    console.log(`  note vs today's v2 pilot (degenerate fill, float raster) at the same points: |dh| p50 ${(pct(dPilot, 0.5) * 100).toFixed(2)} p99 ${(pct(dPilot, 0.99) * 100).toFixed(2)} max ${(pct(dPilot, 1) * 100).toFixed(1)} cm, ${within(dPilot, 0.02)}% within 2 cm`);
    report.vsReference = { p50: pct(dIn, 0.5), p99: pct(dIn, 0.99), max: pct(dIn, 1) };
    report.vsTodaysPilot = { p50: pct(dPilot, 0.5), p99: pct(dPilot, 0.99), max: pct(dPilot, 1) };
    lap('vs reference');
  }

  // 9. fingerprints: per tile, and a changed road refuses only the tiles it meets
  {
    const TYPED = { uint16: Uint16Array, uint32: Uint32Array, float32: Float32Array };
    const arr = (n) => { const s = netIndex.arrays[n]; return new TYPED[s.type](netBuf.buffer, netBuf.byteOffset + s.offset, s.length); };
    const xz = arr('road_xz'), st = arr('road_start'), ct = arr('road_count');
    const R = roadBoxes(xz, st, ct);
    const match = files.every((f) => tileHash(R, ...f.index.tile) === f.index.tileHash);
    ok(match, `per-tile fingerprints match the net (${files.map((f) => f.index.tileHashRoads).join('/')} roads per tile)`);
    if (files.length === 4) {
      // move one road that meets only the first tile (+-32 m) by 1 cm
      const [ti, tj] = files[0].index.tile;
      const meets = (r, i, j) => !(R.hi[r * 2] < i * TS - 32 || R.lo[r * 2] > (i + 1) * TS + 32 || R.hi[r * 2 + 1] < j * TS - 32 || R.lo[r * 2 + 1] > (j + 1) * TS + 32);
      let road = -1;
      for (let r = 0; r < st.length && road < 0; r++) if (meets(r, ti, tj) && files.slice(1).every((f) => !meets(r, ...f.index.tile))) road = r;
      const xz2 = Float32Array.from(xz);
      xz2[st[road] * 2] += 0.01;
      const R2 = roadBoxes(xz2, st, ct);
      const changed = files.filter((f) => tileHash(R2, ...f.index.tile) !== f.index.tileHash).map((f) => f.index.tile.join(','));
      ok(changed.length === 1 && changed[0] === `${ti},${tj}`, `a road moved 1 cm in tile ${ti},${tj} refuses only that patch (refused: ${changed.join(' ')})`);
    }
    lap('fingerprints');
  }

  // memory and decode time per patch
  {
    const times = [], mem = [];
    for (const f of files) {
      const t = [];
      for (let rep = 0; rep < 5; rep++) {
        const s = createPatchSet(cover, F, base, TS);
        const t0 = performance.now();
        s.add(f.index, f.buffer);
        t.push(performance.now() - t0);
      }
      times.push(pct(t, 0.5));
      if (globalThis.gc) {
        // 30 copies kept alive, so one collection's noise is a thirtieth of the answer
        const COPIES = 30, keep = [];
        gc(); gc(); const m0 = process.memoryUsage();
        for (let c = 0; c < COPIES; c++) { const s = createPatchSet(cover, F, base, TS); s.add(f.index, f.buffer.slice(0)); keep.push(s); }
        gc(); gc(); const m1 = process.memoryUsage();
        mem.push(((m1.arrayBuffers - m0.arrayBuffers) + (m1.heapUsed - m0.heapUsed)) / COPIES / 1e6);
        keep.length = 0;
      }
    }
    const raw = files.map((f) => f.buffer.byteLength / 1e3), gz = files.map((f) => gzipSync(Buffer.from(f.buffer), { level: 9 }).length / 1e3);
    console.log(`  info decode + queries per patch: ${times.map((v) => v.toFixed(1)).join(' / ')} ms; memory ${mem.length ? mem.map((v) => v.toFixed(2)).join(' / ') + ' MB' : '(run with --expose-gc)'}; file ${raw.map((v) => v.toFixed(0)).join(' / ')} KB raw, ${gz.map((v) => v.toFixed(0)).join(' / ')} KB gzip`);
    report[name] = { decodeMs: times, memMB: mem, rawKB: raw, gzipKB: gz };
  }
}
console.log(`\n${passes} passed, ${fails} failed`);
console.log('JSON' + JSON.stringify(report));
process.exit(fails ? 1 : 0);

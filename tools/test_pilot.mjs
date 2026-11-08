// Node checks for the pilot overlay (data/pilot.*; MAP_RESOURCES.md §9 Phase 0 step 5).
// Gates from tools/research/tile-format-proposal.md §2.7 that apply to a single overlay:
//   - the world outside the box is unchanged; the box edge is seamless;
//   - steps where a ribbon meets the ground grid are <= 2 cm;
//   - no other unintended steps (curb faces are intended);
//   - crowns and curbs are present; tracks stay on road; queries stay fast.
//   node tools/test_pilot.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWorldData } from '../src/world/city.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (f) => { const b = readFileSync(path.join(root, 'data', f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const index = JSON.parse(readFileSync(path.join(root, 'data/world.json'), 'utf8'));
const pIndex = JSON.parse(readFileSync(path.join(root, 'data/pilot.json'), 'utf8'));

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok  ', msg); } else { fails++; console.log('  FAIL', msg); } };
const info = (msg) => console.log('  ..  ', msg);
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pct = (a, q) => { const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

const W0 = createWorldData(index, load('world.bin.wasm'));
const t0 = performance.now();
const W1 = createWorldData(index, load('world.bin.wasm'), { index: pIndex, buffer: load('pilot.bin.wasm') });
const decodeMs = performance.now() - t0;
const Q0 = W0.Q, Q1 = W1.Q, P = W1.D.pilot, PQ = Q1.pilot;
const B = P.bbox;
const inBox = (x, z) => x > B.x0 && x < B.x1 && z > B.z0 && z < B.z1;
console.log(`pilot: box x ${B.x0}..${B.x1} z ${B.z0}..${B.z1}, ${P.N} stations, ${P.runs.start.length} runs, ${PQ.segments} segments; world + pilot decoded and indexed in ${decodeMs.toFixed(0)} ms`);

console.log('outside the box: unchanged');
{
  const wb = Q0.bounds;
  let diffH = 0, diffS = 0, diffK = 0, diffC = 0, n = 0;
  while (n < 200000) {
    const x = wb.minX + rnd() * (wb.maxX - wb.minX), z = wb.minZ + rnd() * (wb.maxZ - wb.minZ);
    if (x > B.x0 - 60 && x < B.x1 + 60 && z > B.z0 - 60 && z < B.z1 + 60) continue;
    n++;
    if (Q0.heightAt(x, z) !== Q1.heightAt(x, z)) diffH++;
    if (Q0.surfaceHeight(x, z, 1e4) !== Q1.surfaceHeight(x, z, 1e4)) diffS++;
    if (Q0.surfaceAt(x, z, 1e4) !== Q1.surfaceAt(x, z, 1e4)) diffK++;
    const y = Q0.heightAt(x, z);
    if ((Q0.collideCircle(x, z, 2, y, {}) === null) !== (Q1.collideCircle(x, z, 2, y, {}) === null)) diffC++;
  }
  ok(diffH + diffS + diffK + diffC === 0, `200k points more than 60 m outside: heightAt ${diffH}, surfaceHeight ${diffS}, surfaceAt ${diffK}, collideCircle ${diffC} differences`);
}

console.log('box edge');
{
  let maxEdge = 0, maxGrade = 0, at = '';
  for (let k = 0; k < 4000; k++) {
    const side = k % 4, u = rnd();
    let x, z, dx = 0, dz = 0;
    if (side === 0) { x = B.x0; z = B.z0 + u * (B.z1 - B.z0); dx = 1; }
    else if (side === 1) { x = B.x1; z = B.z0 + u * (B.z1 - B.z0); dx = -1; }
    else if (side === 2) { z = B.z0; x = B.x0 + u * (B.x1 - B.x0); dz = 1; }
    else { z = B.z1; x = B.x0 + u * (B.x1 - B.x0); dz = -1; }
    const xe = x + dx * 1e-4, ze = z + dz * 1e-4;
    maxEdge = Math.max(maxEdge, Math.abs(Q1.heightAt(xe, ze) - Q0.heightAt(xe, ze)));
    let prev = Q1.heightAt(x - dx * 4, z - dz * 4);
    for (let s = -3.5; s <= P.feather + 4; s += 0.5) {
      const hh = Q1.heightAt(x + dx * s, z + dz * s);
      if (PQ.contains(x + dx * s, z + dz * s) && PQ.ribbonAt(x + dx * s, z + dz * s) === PQ.ribbonAt(x + dx * s, z + dz * s) && (PQ.hit.band === 1 || PQ.hit.band === 4)) { prev = hh; continue; }
      const g = Math.abs(hh - prev) / 0.5;
      if (g > maxGrade) { maxGrade = g; at = `(${(x + dx * s).toFixed(0)},${(z + dz * s).toFixed(0)})`; }
      prev = hh;
    }
  }
  ok(maxEdge < 0.005, `height at the box edge matches today's terrain (max diff ${(maxEdge * 100).toFixed(2)} cm)`);
  info(`steepest 0.5 m step across the feather band (curb faces excluded): ${(maxGrade * 100).toFixed(0)}% at ${at}`);
}

console.log('ribbon edges and ends (gate: <= 2 cm)');
{
  const K = P.K, steps = [], worst = [];
  for (let r = 0; r < P.runs.start.length; r++) {
    const s0 = P.runs.start[r], e = s0 + P.runs.count[r];
    for (let i = s0; i < e; i++) {
      const cx = P.xz[i * 2], cz = P.xz[i * 2 + 1], nx = P.nrm[i * 2], nz = P.nrm[i * 2 + 1];
      for (const q of [0, K - 1]) {
        const o = P.off[i * K + q], sg = q === 0 ? -1 : 1;
        const a = [cx + nx * (o - sg * 0.005), cz + nz * (o - sg * 0.005)], b = [cx + nx * (o + sg * 0.005), cz + nz * (o + sg * 0.005)];
        if (!inBox(...a) || !inBox(...b) || PQ.featherAt(...a) < 1) continue;
        // only where the outside point is plain grid (no other ribbon)
        if (PQ.ribbonAt(...b) === PQ.ribbonAt(...b)) continue;
        const d = Math.abs(Q1.heightAt(...a) - Q1.heightAt(...b));
        steps.push(d);
        if (d > 0.02) worst.push([d, b]);
      }
    }
    // run ends: step along the tangent past the last / first station
    for (const [i, j] of [[s0, s0 + 1], [e - 1, e - 2]]) {
      const tx = P.xz[i * 2] - P.xz[j * 2], tz = P.xz[i * 2 + 1] - P.xz[j * 2 + 1], l = Math.hypot(tx, tz) || 1;
      // a ribbon reaches 2 cm past its last station's cut line
      const a = [P.xz[i * 2] + (tx / l) * 0.01, P.xz[i * 2 + 1] + (tz / l) * 0.01], b = [P.xz[i * 2] + (tx / l) * 0.03, P.xz[i * 2 + 1] + (tz / l) * 0.03];
      if (!inBox(...b) || PQ.featherAt(...b) < 1 || PQ.ribbonAt(...b) === PQ.ribbonAt(...b)) continue;
      const d = Math.abs(Q1.heightAt(...a) - Q1.heightAt(...b));
      steps.push(d);
      if (d > 0.02) worst.push([d, b]);
    }
  }
  worst.sort((p, q) => q[0] - p[0]);
  const frac = steps.filter((d) => d <= 0.02).length / steps.length;
  ok(frac >= 0.99, `${steps.length} ribbon-to-grid crossings: ${(frac * 100).toFixed(1)}% within 2 cm; p50 ${(pct(steps, 0.5) * 100).toFixed(1)} cm, p99 ${(pct(steps, 0.99) * 100).toFixed(1)} cm, max ${(pct(steps, 1) * 100).toFixed(1)} cm`);
  if (worst.length) info('largest: ' + worst.slice(0, 5).map(([d, p]) => `${(d * 100).toFixed(0)} cm @(${p[0].toFixed(0)},${p[1].toFixed(0)})`).join(' '));
}

console.log('unintended steps (random 1 cm pairs, curb faces excluded)');
{
  let n = 0, bad = 0;
  const worst = [];
  while (n < 200000) {
    const x = B.x0 + P.feather + rnd() * (B.x1 - B.x0 - 2 * P.feather), z = B.z0 + P.feather + rnd() * (B.z1 - B.z0 - 2 * P.feather);
    const a = rnd() * Math.PI * 2, x2 = x + Math.cos(a) * 0.01, z2 = z + Math.sin(a) * 0.01;
    const c1 = PQ.ribbonAt(x, z) === PQ.ribbonAt(x, z) && (PQ.hit.band === 1 || PQ.hit.band === 4);
    const c2 = PQ.ribbonAt(x2, z2) === PQ.ribbonAt(x2, z2) && (PQ.hit.band === 1 || PQ.hit.band === 4);
    if (c1 || c2) continue;
    n++;
    const d = Math.abs(Q1.heightAt(x, z) - Q1.heightAt(x2, z2));
    if (d > 0.02) { bad++; if (worst.length < 400) worst.push([d, x, z]); }
  }
  worst.sort((p, q) => q[0] - p[0]);
  ok(bad / n < 0.001, `${n} pairs: ${bad} (${((bad / n) * 100).toFixed(3)}%) jump more than 2 cm over 1 cm`);
  if (worst.length) info('largest: ' + worst.slice(0, 6).map(([d, x, z]) => `${(d * 100).toFixed(0)} cm @(${x.toFixed(0)},${z.toFixed(0)})`).join(' '));
}

console.log('physics matches the drawn ribbons (points inside the mesh quads, bends included)');
{
  const K = P.K;
  let n = 0, miss = 0, overlap = 0, below = 0;
  const diffs = [];
  for (let r = 0; r < P.runs.start.length; r++) {
    const s0 = P.runs.start[r], e = s0 + P.runs.count[r];
    for (let i = s0; i < e - 1; i++) {
      if (rnd() > 0.15) continue;
      const j = i + 1, t = 0.05 + 0.9 * rnd(), q = Math.floor(rnd() * (K - 1)), u = 0.05 + 0.9 * rnd();
      const kp = (s, k) => [P.xz[s * 2] + P.nrm[s * 2] * P.off[s * K + k], P.xz[s * 2 + 1] + P.nrm[s * 2 + 1] * P.off[s * K + k]];
      const [ax, az] = kp(i, q), [bx, bz] = kp(i, q + 1), [cx, cz] = kp(j, q), [dx, dz] = kp(j, q + 1);
      const x = (ax + (bx - ax) * u) * (1 - t) + (cx + (dx - cx) * u) * t, z = (az + (bz - az) * u) * (1 - t) + (cz + (dz - cz) * u) * t;
      if (!inBox(x, z) || PQ.featherAt(x, z) < 1) continue;
      const hm = (P.h[i * K + q] + (P.h[i * K + q + 1] - P.h[i * K + q]) * u) * (1 - t) + (P.h[j * K + q] + (P.h[j * K + q + 1] - P.h[j * K + q]) * u) * t;
      n++;
      const v = PQ.ribbonAt(x, z);
      if (v !== v) { miss++; continue; }
      // where another road's ribbon overlaps, physics follows the highest (the one drawn on top)
      if (P.runOf[PQ.hit.i] !== r) { overlap++; if (v < hm - 0.02) below++; continue; }
      if (q !== 1 && q !== 4) diffs.push(Math.abs(Q1.heightAt(x, z) - hm));   // curb faces: position-sensitive
    }
  }
  ok(miss / n < 0.005, `${n} points inside ribbon quads: ${miss} (${((miss / n) * 100).toFixed(2)}%) not found by physics`);
  ok(pct(diffs, 0.99) < 0.02, `physics vs mesh height where one ribbon (outside curb faces): p50 ${(pct(diffs, 0.5) * 100).toFixed(2)} cm, p99 ${(pct(diffs, 0.99) * 100).toFixed(2)} cm, max ${(pct(diffs, 1) * 100).toFixed(1)} cm`);
  ok(below === 0, `${overlap} points (${((overlap / n) * 100).toFixed(1)}%) where ribbons overlap: physics on the highest, ${below} more than 2 cm below the drawn ribbon`);
}

console.log('crown and curbs');
{
  const K = P.K;
  let crowned = 0, total = 0;
  const rises = [];
  for (let r = 0; r < P.runs.start.length; r++) {
    const fl = P.runs.flags[r];
    const s0 = P.runs.start[r], e = s0 + P.runs.count[r];
    for (let i = s0; i < e; i++) {
      if (P.jd[i] < 4) continue;
      total++;
      if (P.h[i * K + 3] > P.h[i * K + 2] && P.h[i * K + 3] > P.h[i * K + 4]) crowned++;
      if (fl & 4) rises.push(P.h[i * K + 5] - P.h[i * K + 4]);
      if (fl & 8) rises.push(P.h[i * K + 1] - P.h[i * K + 2]);
    }
  }
  ok(crowned / total > 0.8, `crown above both gutters at ${((crowned / total) * 100).toFixed(0)}% of stations outside junctions`);
  ok(pct(rises, 0.5) > 0.08 && pct(rises, 0.5) < 0.2, `measured curb rise p10/p50/p90 ${[0.1, 0.5, 0.9].map((q) => (pct(rises, q) * 100).toFixed(1)).join('/')} cm`);
  const st = pIndex.stats.ribbons;
  if (st.curb_windows_within_2cm_frac != null) info(`curb height vs each measured 10 m window: ${(st.curb_windows_within_2cm_frac * 100).toFixed(0)}% within 2 cm (${st.curb_windows} windows)`);
  // a curb you can feel: step across the curb band on a measured side
  let felt = 0, tried = 0;
  for (let r = 0; r < P.runs.start.length && tried < 2000; r++) {
    if (!(P.runs.flags[r] & 4)) continue;
    const s0 = P.runs.start[r], e = s0 + P.runs.count[r];
    for (let i = s0; i < e; i += 7) {
      if (P.jd[i] < 6) continue;
      const cx = P.xz[i * 2], cz = P.xz[i * 2 + 1], nx = P.nrm[i * 2], nz = P.nrm[i * 2 + 1];
      const g = P.off[i * K + 4], c = P.off[i * K + 5];
      const a = [cx + nx * (g - 0.1), cz + nz * (g - 0.1)], b = [cx + nx * (c + 0.1), cz + nz * (c + 0.1)];
      if (PQ.featherAt(...a) < 1) continue;
      tried++;
      if (Q1.heightAt(...b) - Q1.heightAt(...a) > 0.06 && Q1.surfaceAt(...a, 1e4) === 'road' && Q1.surfaceAt(...b, 1e4) === 'sidewalk') felt++;
    }
  }
  ok(felt / tried > 0.85, `heightAt rises > 6 cm from road to sidewalk across ${((felt / tried) * 100).toFixed(0)}% of ${tried} sampled curbs, surfaceAt road -> sidewalk`);
}

console.log('tracks through the box');
for (const id of ['nob-hill-jumps', 'downtown-gp', 'embarcadero-sprint']) {
  const t0r = W0.tracks.find((t) => t.id === id), t1r = W1.tracks.find((t) => t.id === id);
  const stat = (Q, t) => {
    let on = 0, n = 0, y = Q.groundHeight(...t.path[0]), prev = null, maxStep = 0, maxG = 0;
    const pts = t.loop ? t.path.concat([t.path[0]]) : t.path;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0);
      for (let u = 0; u < L; u += 2) {
        const x = x0 + ((x1 - x0) * u) / L, z = z0 + ((z1 - z0) * u) / L;
        if (!inBox(x, z)) { prev = null; continue; }
        n++;
        if (Q.surfaceAt(x, z, 1e4) === 'road') on++;
        y = Q.surfaceHeight(x, z, (prev ?? Q.heightAt(x, z)) + 1);
        if (prev != null) { maxStep = Math.max(maxStep, Math.abs(y - prev)); maxG = Math.max(maxG, Math.abs(y - prev) / 2); }
        prev = y;
      }
    }
    return { on: on / n, n, maxStep, maxG };
  };
  const a = stat(Q0, t0r), b = stat(Q1, t1r);
  ok(b.on > 0.97, `${id}: ${b.n * 2} m in the box, on road ${(b.on * 100).toFixed(1)}% (before ${(a.on * 100).toFixed(1)}%), steepest 2 m ${(b.maxG * 100).toFixed(0)}% (before ${(a.maxG * 100).toFixed(0)}%)`);
}
ok(Q1.surfaceAt(W1.spawn.x, W1.spawn.z, 1e4) === 'road', `spawn (${W1.spawn.x.toFixed(0)}, ${W1.spawn.z.toFixed(0)}) on road`);

console.log('buildings');
{
  const Bd0 = W0.D.B, Bd1 = W1.D.B;
  let moved = 0, maxUp = 0, maxDown = 0;
  for (let k = 0; k < Bd1.count; k++) {
    const d = Bd1.gmin[k] - Bd0.gmin[k];
    if (d !== 0) { moved++; maxUp = Math.max(maxUp, d); maxDown = Math.min(maxDown, d); }
  }
  info(`${moved} buildings re-grounded on the lidar surface; ground moved ${maxDown.toFixed(1)} .. +${maxUp.toFixed(1)} m`);
  ok(moved > 0, 'buildings in the box re-grounded');
}

console.log('performance (inside the box)');
{
  const pts = [];
  for (let i = 0; i < 20000; i++) pts.push([B.x0 + 30 + rnd() * (B.x1 - B.x0 - 60), B.z0 + 30 + rnd() * (B.z1 - B.z0 - 60)]);
  const time = (fn) => { const t = performance.now(); for (let r = 0; r < 5; r++) for (const [x, z] of pts) fn(x, z); return ((performance.now() - t) * 1000) / (5 * pts.length); };
  const hA = time((x, z) => Q1.heightAt(x, z)), sH = time((x, z) => Q1.surfaceHeight(x, z, 1e4)), sA = time((x, z) => Q1.surfaceAt(x, z, 1e4));
  const h0 = time((x, z) => Q0.heightAt(x, z));
  ok(sH < 5, `heightAt ${hA.toFixed(2)} us (today ${h0.toFixed(2)} us), surfaceHeight ${sH.toFixed(2)} us, surfaceAt ${sA.toFixed(2)} us per call`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

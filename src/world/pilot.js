// SF Roadster Rush - pilot overlay: lidar ground + measured road ribbons over Nob Hill + FiDi
// (baked by tools/bake_pilot.py; MAP_RESOURCES.md §9 Phase 0 step 5). Optional: without
// data/pilot.json + data/pilot.bin.wasm the world is exactly as before.
//
// Inside the pilot box, heightAt is:
//   - on a ribbon: one cross-section per station (<= 2 m apart) with 7 knots across
//     (sidewalk edge, curb top, gutter, crown, gutter, curb top, sidewalk edge), piecewise linear
//     across and linear between stations. Crown, gutters and curbs are measured from lidar;
//   - elsewhere: the 2 m lidar ground grid, with the same triangle split as its mesh;
//   - blended into today's terrain over the outer `feather` metres of the box.
// The meshes built here use exactly those heights (ribbons are lifted RIB_LIFT for rendering
// only), so what you see is what physics drives on.
import * as THREE from 'three';
import { markingInfo } from './roads.js';
import { terrainMaterial as makeTerrainMaterial } from './terrain.js';

const TYPED = { int16: Int16Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array, uint8: Uint8Array, float32: Float32Array, int8: Int8Array };
const HC = 8;              // ribbon spatial hash cell (m)
const RIB_LIFT = 0.02;     // render-only lift of ribbons over the physics surface
const EDGE_LIFT = 0.1;     // roads.js lifts today's ribbons this much; match it at the box edge
const CHUNK_NODES = 128;   // terrain chunk = 256 m
const RIB_CHUNK = 256;

export async function fetchPilotFiles(base = 'data/') {
  try {
    const [jr, br] = await Promise.all([fetch(base + 'pilot.json'), fetch(base + 'pilot.bin.wasm')]);
    if (!jr.ok || !br.ok) return null;
    return { index: await jr.json(), buffer: await br.arrayBuffer() };
  } catch (e) {
    return null;
  }
}

export function decodePilot(index, buffer) {
  const arr = (name) => {
    const s = index.arrays[name];
    if (!s) throw new Error('pilot.bin: missing array ' + name);
    return new TYPED[s.type](buffer, s.offset, s.length);
  };
  const g = index.grid, hb = g.hBase, K = index.knots;
  const g16 = arr('grid');
  const G = new Float32Array(g16.length);
  for (let i = 0; i < g16.length; i++) G[i] = g16[i] * 0.01 + hb;
  const N = index.counts.stations;
  const xz = Float32Array.from(arr('st_xz'));
  const o16 = arr('st_off'), h16 = arr('st_h'), j16 = arr('st_jd');
  const off = new Float32Array(N * K), h = new Float32Array(N * K), jd = new Float32Array(N);
  for (let i = 0; i < N * K; i++) { off[i] = o16[i] * 0.01; h[i] = h16[i] * 0.01 + hb; }
  for (let i = 0; i < N; i++) jd[i] = j16[i] * 0.1;
  const runs = { start: arr('run_start'), count: arr('run_count'), road: arr('run_road'), flags: arr('run_flags') };
  // per-station unit normal, as in the bake: central difference inside the run, one-sided at the ends.
  // Lidar tile patches store them (`st_n`): a run cut at a tile edge keeps the normals it had whole.
  const stored = !!index.arrays.st_n;
  const nrm = stored ? Float32Array.from(arr('st_n')) : new Float32Array(N * 2), runOf = new Uint32Array(N);
  for (let r = 0; r < runs.start.length; r++) {
    const s = runs.start[r], e = s + runs.count[r];
    for (let i = s; i < e; i++) {
      runOf[i] = r;
      if (stored) continue;
      const a = Math.max(s, i - 1), b = Math.min(e - 1, i + 1);
      let tx = xz[b * 2] - xz[a * 2], tz = xz[b * 2 + 1] - xz[a * 2 + 1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      nrm[i * 2] = -tz; nrm[i * 2 + 1] = tx;
    }
  }
  return { index, bbox: index.bbox, feather: index.feather, grid: g, G, N, K, xz, off, h, jd, nrm, runs, runOf };
}

/** Height queries over the pilot box; `baseHeight` is today's terrain (used outside and in the feather). */
export function createPilotQueries(P, baseHeight) {
  const { bbox, grid, G, K, xz, off, h, nrm, runs, runOf } = P;
  const X0 = bbox.x0, X1 = bbox.x1, Z0 = bbox.z0, Z1 = bbox.z1, F = P.feather;
  const GX0 = grid.x0, GZ0 = grid.z0, GC = grid.cell, GNX = grid.nx, GNZ = grid.nz, GINV = 1 / GC;

  function gridHeight(x, z) {
    let fx = (x - GX0) * GINV, fz = (z - GZ0) * GINV;
    if (fx < 0) fx = 0; else if (fx > GNX - 1.0001) fx = GNX - 1.0001;
    if (fz < 0) fz = 0; else if (fz > GNZ - 1.0001) fz = GNZ - 1.0001;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const o = iz * GNX + ix;
    if (tx + tz <= 1) {
      const h00 = G[o];
      return h00 + (G[o + 1] - h00) * tx + (G[o + GNX] - h00) * tz;
    }
    const h11 = G[o + GNX + 1];
    return h11 + (G[o + GNX] - h11) * (1 - tx) + (G[o + 1] - h11) * (1 - tz);
  }

  // ---- ribbon segments (station i -> i + 1 inside a run) in a CSR spatial hash
  const segs = [];
  for (let r = 0; r < runs.start.length; r++) {
    const s = runs.start[r], e = s + runs.count[r];
    for (let i = s; i < e - 1; i++) segs.push(i);
  }
  const nSeg = segs.length;
  const segI = Uint32Array.from(segs);
  const sMinX = new Float32Array(nSeg), sMaxX = new Float32Array(nSeg), sMinZ = new Float32Array(nSeg), sMaxZ = new Float32Array(nSeg);
  const HNX = Math.ceil((X1 - X0) / HC) + 1, HNZ = Math.ceil((Z1 - Z0) / HC) + 1;
  const cellOf = (v, o, n) => { let c = Math.floor((v - o) / HC); return c < 0 ? 0 : c >= n ? n - 1 : c; };
  for (let k = 0; k < nSeg; k++) {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const i of [segI[k], segI[k] + 1]) {
      for (const q of [0, K - 1]) {
        const o = off[i * K + q];
        const x = xz[i * 2] + nrm[i * 2] * o, z = xz[i * 2 + 1] + nrm[i * 2 + 1] * o;
        if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z;
      }
    }
    sMinX[k] = a - 0.5; sMaxX[k] = b + 0.5; sMinZ[k] = c - 0.5; sMaxZ[k] = d + 0.5;
  }
  const cnt = new Uint32Array(HNX * HNZ + 1);
  const each = (k, fn) => {
    const i0 = cellOf(sMinX[k], X0, HNX), i1 = cellOf(sMaxX[k], X0, HNX);
    const j0 = cellOf(sMinZ[k], Z0, HNZ), j1 = cellOf(sMaxZ[k], Z0, HNZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * HNX + i);
  };
  for (let k = 0; k < nSeg; k++) each(k, (c) => cnt[c + 1]++);
  for (let i = 1; i < cnt.length; i++) cnt[i] += cnt[i - 1];
  const items = new Uint32Array(cnt[cnt.length - 1]);
  const fill = cnt.slice(0, HNX * HNZ);
  for (let k = 0; k < nSeg; k++) each(k, (c) => { items[fill[c]++] = k; });

  /** last ribbon hit: station i, t along to i+1, lateral d along the interpolated normal, band (0..5) */
  const hit = { i: -1, t: 0, d: 0, band: -1, cx: 0, cz: 0, nx: 0, nz: 0 };

  /** height of the ribbon from station i at fraction t, lateral offset d; sets `bandOut[0]` */
  const bandOut = [0];
  function sectionHeight(i, t, d) {
    const j = i + 1;
    let band = K - 2;
    for (let q = 0; q < K - 1; q++) {
      const oq1 = off[i * K + q + 1] + (off[j * K + q + 1] - off[i * K + q + 1]) * t;
      if (d <= oq1) { band = q; break; }
    }
    const oa = off[i * K + band] + (off[j * K + band] - off[i * K + band]) * t;
    const ob = off[i * K + band + 1] + (off[j * K + band + 1] - off[i * K + band + 1]) * t;
    const ha = h[i * K + band] + (h[j * K + band] - h[i * K + band]) * t;
    const hb = h[i * K + band + 1] + (h[j * K + band + 1] - h[i * K + band + 1]) * t;
    bandOut[0] = band;
    return ha + (hb - ha) * (ob > oa ? (d - oa) / (ob - oa) : 0);
  }

  /** ribbon height at (x,z) or NaN when no ribbon covers it; fills `hit`. Where ribbons of
   *  different roads overlap (junction mouths, close parallel roads) the highest one wins: that is
   *  the one the depth buffer shows, so physics drives on what is drawn. */
  function ribbonAt(x, z) {
    const c = cellOf(z, Z0, HNZ) * HNX + cellOf(x, X0, HNX);
    let best = -1, bestH = -Infinity, bT = 0, bD = 0, bNx = 0, bNz = 0, bCx = 0, bCz = 0, bBand = 0;
    for (let p = cnt[c], e = cnt[c + 1]; p < e; p++) {
      const k = items[p];
      if (x < sMinX[k] || x > sMaxX[k] || z < sMinZ[k] || z > sMaxZ[k]) continue;
      const i = segI[k], j = i + 1;
      const ax = xz[i * 2], az = xz[i * 2 + 1], vx = xz[j * 2] - ax, vz = xz[j * 2 + 1] - az;
      // The mesh quad lies between the two stations' cut lines (through each station along its
      // normal), so on bends it is a fan, not a rectangle: locate the point between those lines.
      // Along-distance from cut line q is (p - c_q) . (n_q.z, -n_q.x).
      const ai = (x - ax) * nrm[i * 2 + 1] - (z - az) * nrm[i * 2];
      const aj = (x - xz[j * 2]) * nrm[j * 2 + 1] - (z - xz[j * 2 + 1]) * nrm[j * 2];
      if (ai < -0.02 || aj > 0.02 || ai - aj <= 1e-6) continue;
      let t = ai / (ai - aj);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + vx * t, cz = az + vz * t;
      let nx = nrm[i * 2] + (nrm[j * 2] - nrm[i * 2]) * t, nz = nrm[i * 2 + 1] + (nrm[j * 2 + 1] - nrm[i * 2 + 1]) * t;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      const d = (x - cx) * nx + (z - cz) * nz;
      const o0 = off[i * K] + (off[j * K] - off[i * K]) * t;
      const o6 = off[i * K + K - 1] + (off[j * K + K - 1] - off[i * K + K - 1]) * t;
      if (d < o0 || d > o6) continue;
      const hh = sectionHeight(i, t, d);
      if (hh > bestH) { bestH = hh; best = i; bT = t; bD = d; bNx = nx; bNz = nz; bCx = cx; bCz = cz; bBand = bandOut[0]; }
    }
    if (best < 0) { hit.i = -1; return NaN; }
    hit.i = best; hit.t = bT; hit.d = bD; hit.band = bBand; hit.cx = bCx; hit.cz = bCz; hit.nx = bNx; hit.nz = bNz;
    return bestH;
  }

  /** 0..1: 0 at the box edge, 1 deeper than `feather` inside */
  function featherAt(x, z) {
    const e = Math.min(x - X0, X1 - x, z - Z0, Z1 - z);
    if (e >= F) return 1;
    if (e <= 0) return 0;
    const u = e / F;
    return u * u * (3 - 2 * u);
  }

  function contains(x, z) { return x > X0 && x < X1 && z > Z0 && z < Z1; }

  function heightAt(x, z) {
    if (!(x > X0 && x < X1 && z > Z0 && z < Z1)) return baseHeight(x, z);
    let v = ribbonAt(x, z);
    if (v !== v) v = gridHeight(x, z);
    const f = featherAt(x, z);
    if (f < 1) { const b = baseHeight(x, z); v = b + (v - b) * f; }
    return v;
  }

  /** 0 = no ribbon here, 1 = roadway (or a curbless shoulder), 2 = curb or sidewalk */
  function surfaceKind(x, z) {
    if (!contains(x, z)) return 0;
    const v = ribbonAt(x, z);
    if (v !== v) return 0;
    if (hit.band === 2 || hit.band === 3) return 1;
    const fl = runs.flags[runOf[hit.i]];
    const curb = hit.band < 2 ? fl & 2 : fl & 1;   // band 0/1 = side B (flag bit 1), 4/5 = side A (bit 0)
    return curb ? 2 : 1;
  }

  /** a point beside a ribbon's roadway, moved onto its sidewalk (for lamp posts); null if not on a ribbon */
  function toSidewalk(x, z, out) {
    if (!contains(x, z)) return null;
    const v = ribbonAt(x, z);
    if (v !== v) return null;
    const i = hit.i, j = i + 1, t = hit.t;
    const side = hit.d >= 0 ? 1 : -1;
    const q = side > 0 ? 5 : 1;
    const oc = off[i * K + q] + (off[j * K + q] - off[i * K + q]) * t;
    const d = oc + side * 0.6;
    out[0] = hit.cx + hit.nx * d; out[1] = hit.cz + hit.nz * d;
    return out;
  }

  // roads (indices into D.roads) that the pilot draws inside its box
  const covered = new Set(runs.road);
  function coversRoad(ri) { return covered.has(ri); }

  return { bbox, contains, heightAt, gridHeight, ribbonAt, featherAt, surfaceKind, toSidewalk, coversRoad, hit, segments: nSeg };
}

/** 32-bit FNV-1a over the world's road vertices (same as fnv1a16 in tools/bake_pilot.py) */
function roadsHash(worldIndex, worldBuffer) {
  const a = worldIndex.arrays.road_xz;
  const v = new Uint16Array(worldBuffer, a.offset, a.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v[i], 0x01000193) >>> 0;
  return h;
}

/** null when the pilot was baked against this world, else the reason it can't be used */
export function pilotMismatch(pilotIndex, worldIndex, worldBuffer) {
  if (pilotIndex.version !== 1) return 'unknown pilot version ' + pilotIndex.version;
  const w = pilotIndex.world;
  if (!w) return 'pilot.json has no world fingerprint';
  const c = worldIndex.counts;
  if (w.roads !== c.roads || w.buildings !== c.buildings) return `baked for a different world.json (roads ${w.roads}/${c.roads}, buildings ${w.buildings}/${c.buildings})`;
  if (worldBuffer && w.roadsHash !== roadsHash(worldIndex, worldBuffer)) return 'baked for different road geometry';
  return null;
}

/** Meshes: a 2 m terrain patch over the box and the ribbons (asphalt, curbs, sidewalks). */
export function buildPilot(D, Q, { quality = 'high', groundTexture, uniforms, roadMaterial } = {}) {
  const P = D.pilot, PQ = Q.pilot;
  const { bbox, grid, G, K, xz, off, h, nrm, jd, runs } = P;
  const group = new THREE.Group();
  group.name = 'pilot';
  const base = Q.baseHeightAt;
  // same ground texture as terrain.js, plus concrete on the lidar's near-vertical retaining walls
  const terrainMaterial = makeTerrainMaterial(groundTexture, uniforms, { walls: true });
  const wg = D.grid, WW = (wg.nx - 1) * wg.cell, WD = (wg.nz - 1) * wg.cell;

  // ---- terrain patch: same material and ground texture as terrain.js, 2/4/8 m LODs
  const nx = grid.nx, nz = grid.nz, C = grid.cell;
  const vh = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = grid.x0 + i * C, z = grid.z0 + j * C;
      const f = PQ.featherAt(x, z), g = G[j * nx + i];
      vh[j * nx + i] = f < 1 ? base(x, z) + (g - base(x, z)) * f : g;
    }
  }
  const hAt = (i, j) => vh[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  function patch(i0, i1, j0, j1, s, skirt) {
    const xs = [], zs = [];
    for (let i = i0; i < i1; i += s) xs.push(i);
    xs.push(i1);
    for (let j = j0; j < j1; j += s) zs.push(j);
    zs.push(j1);
    const cx = xs.length, cz = zs.length;
    const nv = cx * cz + 2 * (cx + cz);
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const idx = [];
    let v = 0;
    const put = (i, j, dy) => {
      const x = grid.x0 + i * C, z = grid.z0 + j * C;
      pos[v * 3] = x; pos[v * 3 + 1] = hAt(i, j) - dy; pos[v * 3 + 2] = z;
      const hx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * C), hz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * C);
      const l = Math.hypot(hx, 1, hz);
      nor[v * 3] = -hx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = -hz / l;
      uv[v * 2] = (x - wg.x0) / WW; uv[v * 2 + 1] = (z - wg.z0) / WD;
      return v++;
    };
    for (let b = 0; b < cz; b++) for (let a = 0; a < cx; a++) put(xs[a], zs[b], 0);
    for (let b = 0; b < cz - 1; b++) {
      for (let a = 0; a < cx - 1; a++) {
        const p00 = b * cx + a, p10 = p00 + 1, p01 = p00 + cx, p11 = p01 + 1;
        idx.push(p00, p01, p10, p01, p11, p10);   // same split as gridHeight
      }
    }
    if (skirt > 0) {
      const edge = (list) => {
        const sk = list.map(([, i, j]) => put(i, j, skirt));
        for (let k = 0; k < list.length - 1; k++) {
          const a = list[k][0], b = list[k + 1][0], c = sk[k], d = sk[k + 1];
          idx.push(a, c, b, b, c, d, a, b, c, b, d, c);
        }
      };
      edge(xs.map((i, a) => [a, i, zs[0]]));
      edge(xs.map((i, a) => [(cz - 1) * cx + a, i, zs[cz - 1]]));
      edge(zs.map((j, b) => [b * cx, xs[0], j]));
      edge(zs.map((j, b) => [b * cx + cx - 1, xs[cx - 1], j]));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, v * 2), 2));
    geo.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }
  const levels = quality === 'low' ? [[2, 0], [4, 500]] : [[1, 0], [2, quality === 'high' ? 600 : 400], [4, 1300]];
  let terrainTris = 0;
  for (let j0 = 0; j0 < nz - 1; j0 += CHUNK_NODES) {
    for (let i0 = 0; i0 < nx - 1; i0 += CHUNK_NODES) {
      const i1 = Math.min(i0 + CHUNK_NODES, nx - 1), j1 = Math.min(j0 + CHUNK_NODES, nz - 1);
      const lod = new THREE.LOD();
      const cxm = grid.x0 + ((i0 + i1) / 2) * C, czm = grid.z0 + ((j0 + j1) / 2) * C;
      for (const [s, dist] of levels) {
        // the skirt only drops a little: the patch sits on today's (lowered) terrain at the box edge
        const geo = patch(i0, i1, j0, j1, s, s === 1 ? 0.6 : 2);
        const m = new THREE.Mesh(geo, terrainMaterial);
        m.receiveShadow = true;
        m.position.set(-cxm, 0, -czm);
        m.updateMatrix();
        m.matrixAutoUpdate = false;
        lod.addLevel(m, dist);
        if (s === levels[0][0]) terrainTris += geo.index.count / 3;
      }
      lod.position.set(cxm, 0, czm);
      group.add(lod);
    }
  }

  // ---- ribbons: per station 11 vertices (road: gutter B, crown, gutter A; curb B/A: gutter, top;
  // sidewalk B/A: curb top, edge), strips split into 256 m chunks for culling
  const bufs = new Map();
  const getBuf = (key) => {
    let b = bufs.get(key);
    if (!b) bufs.set(key, (b = { pos: [], ruv: [], rinfo: [], rj: [], idx: [], n: 0 }));
    return b;
  };
  const NCX = Math.ceil((bbox.x1 - bbox.x0) / RIB_CHUNK);
  let ribTris = 0;
  for (let r = 0; r < runs.start.length; r++) {
    const road = D.roads[runs.road[r]];
    const { info, fl } = markingInfo(road);
    const s0 = runs.start[r], e = s0 + runs.count[r];
    // null, not -1: a lidar tile patch's run may start just outside its tile, where a key is negative
    let along = 0, cur = null, curKey = null, prev = -1;
    for (let i = s0; i < e; i++) {
      if (i > s0) along += Math.hypot(xz[i * 2] - xz[i * 2 - 2], xz[i * 2 + 1] - xz[i * 2 - 1]);
      const key = Math.floor((xz[i * 2 + 1] - bbox.z0) / RIB_CHUNK) * NCX + Math.floor((xz[i * 2] - bbox.x0) / RIB_CHUNK);
      if (key !== curKey) {
        const nb = getBuf(key);
        prev = cur && i > s0 ? emit(nb, i - 1, along - Math.hypot(xz[i * 2] - xz[i * 2 - 2], xz[i * 2 + 1] - xz[i * 2 - 1])) : -1;
        cur = nb; curKey = key;
      }
      const v = emit(cur, i, along);
      if (prev >= 0) {
        // bands: sidewalk B (v+7,v+8), curb B (v+5,v+6), road B half (v+0,v+1), road A half (v+1,v+2),
        // curb A (v+3,v+4), sidewalk A (v+9,v+10); each pair ordered by increasing offset
        for (const [a, b] of [[7, 8], [5, 6], [0, 1], [1, 2], [3, 4], [9, 10]]) {
          // up-facing: `a` is on the -n (right) side, `b` on the +n side, `v` is one station further
          cur.idx.push(prev + a, prev + b, v + a, prev + b, v + b, v + a);
          ribTris += 2;
        }
      }
      prev = v;
    }
    function emit(buf, i, s) {
      const v = buf.n;
      const cxp = xz[i * 2], czp = xz[i * 2 + 1], nxp = nrm[i * 2], nzp = nrm[i * 2 + 1];
      const gB = -off[i * K + 2], gA = off[i * K + 4];
      const hw = (gA + gB) / 2, mid = (gA - gB) / 2;
      const P3 = (q) => {
        const o = off[i * K + q];
        const x = cxp + nxp * o, z = czp + nzp * o;
        const f = PQ.featherAt(x, z);
        let y = h[i * K + q];
        if (f < 1) { const b = base(x, z); y = b + (y - b) * f; }
        return [x, y + RIB_LIFT + (EDGE_LIFT - RIB_LIFT) * (1 - f), z, o];
      };
      const k = [0, 1, 2, 3, 4, 5, 6].map(P3);
      const push = (p, lat, kind) => {
        buf.pos.push(p[0], p[1], p[2]);
        buf.ruv.push(lat, s);
        buf.rinfo.push(hw, kind === 0 ? info : 0, kind === 0 ? fl : 0, kind);
        buf.rj.push(jd[i]);
      };
      // road: gutter B, crown, gutter A (lat relative to the measured road middle)
      push(k[2], k[2][3] - mid, 0); push(k[3], -mid, 0); push(k[4], k[4][3] - mid, 0);
      // curb A: gutter, top; curb B: top, gutter (increasing offset within each pair)
      push(k[4], 0, 2); push(k[5], 0, 2);
      push(k[1], 0, 2); push(k[2], 0, 2);
      // sidewalk B: edge, curb top; sidewalk A: curb top, edge (lat = distance from the curb)
      push(k[0], Math.abs(k[0][3] - k[1][3]), 1); push(k[1], 0, 1);
      push(k[5], 0, 1); push(k[6], Math.abs(k[6][3] - k[5][3]), 1);
      buf.n += 11;
      return v;
    }
  }
  const chunks = [];
  for (const [, b] of bufs) {
    if (!b.idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('ruv', new THREE.Float32BufferAttribute(b.ruv, 2));
    geo.setAttribute('rinfo', new THREE.Float32BufferAttribute(b.rinfo, 4));
    geo.setAttribute('rj', new THREE.Float32BufferAttribute(b.rj, 1));
    geo.setIndex(b.n > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, roadMaterial);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    group.add(mesh);
    chunks.push({ mesh, cx: geo.boundingSphere.center.x, cz: geo.boundingSphere.center.z, r: geo.boundingSphere.radius });
  }
  const dist = quality === 'high' ? 2600 : quality === 'medium' ? 1700 : 1100;
  function update(camera) {
    const px = camera.position.x, pz = camera.position.z;
    for (const c of chunks) c.mesh.visible = Math.hypot(c.cx - px, c.cz - pz) - c.r < dist;
  }
  return { group, update, stats: { terrainTrianglesLod0: terrainTris, ribbonTriangles: ribTris, ribbonMeshes: chunks.length } };
}

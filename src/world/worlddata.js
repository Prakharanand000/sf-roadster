// SF Roadster Rush - world data decoding + fast spatial queries (no DOM; runs in Node for tests).
//
// Data: data/world.json (index, tracks, landmarks) + data/world.bin.wasm (raw typed arrays; .wasm only so static hosts serve it as-is), produced by tools/bake.py.
// All queries are allocation-free (except the first call building lazy tables) and O(1)-ish via grids.
//
// Choices documented here (see CONTRACTS.md):
// - heightAt uses the same triangle split as the terrain mesh (diagonal from (i,j+1) to (i+1,j)), so the
//   rendered ground and the physics ground agree exactly at LOD0.
// - surfaceHeight considers terrain, the Golden Gate deck and FLAT building / landmark roofs.
// - collideCircle additionally skips solids whose base is more than 3 m above the car base (so a car
//   on the water under the bridge does not hit the deck railings). This only removes impossible hits.
// - surfaceAt for paved non-road urban ground (plazas, lots, piers) returns 'sidewalk'; woods/parks 'grass'.
// - With the optional pilot overlay (D.pilot, src/world/pilot.js), heightAt inside its box is lidar
//   ground plus measured road ribbons (crown, gutters, curbs); surfaceAt uses the measured road and
//   sidewalk bands there, and buildings in the box take their ground range from that surface.
import * as THREE from 'three';
import { buildLandmarkSolids, makeDeckProfile } from './landmarkdefs.js';
import { createPilotQueries } from './pilot.js';

export const LC = { WATER: 0, URBAN: 1, PARK: 2, WOOD: 3, SAND: 4, LAKE: 5, PIER: 6, PITCH: 7, SCRUB: 8, ROCK: 9, PAVED: 10 };
const LC_SURFACE = ['water', 'sidewalk', 'grass', 'grass', 'sand', 'water', 'sidewalk', 'grass', 'grass', 'sidewalk', 'sidewalk'];

const TYPED = { int16: Int16Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array, uint8: Uint8Array, float32: Float32Array, int8: Int8Array };

export async function fetchWorldFiles(base = 'data/') {
  const [jr, br] = await Promise.all([fetch(base + 'world.json'), fetch(base + 'world.bin.wasm')]);
  if (!jr.ok || !br.ok) throw new Error('world data missing (' + jr.status + '/' + br.status + ')');
  const index = await jr.json();
  const buffer = await br.arrayBuffer();
  return { index, buffer };
}

function arr(index, buffer, name) {
  const a = index.arrays[name];
  if (!a) throw new Error('world.bin: missing array ' + name);
  return new TYPED[a.type](buffer, a.offset, a.length);
}

function unrle(src, n) {
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i + 2 < src.length; i += 3) {
    const v = src[i], len = src[i + 1] | (src[i + 2] << 8);
    out.fill(v, o, o + len);
    o += len;
  }
  return out;
}

/** Decode the binary into plain typed arrays + JS objects. */
export function decodeWorld(index, buffer) {
  const g = index.grid, lc = index.landcover;
  const h16 = arr(index, buffer, 'height');
  const H = new Float32Array(h16.length);
  for (let i = 0; i < h16.length; i++) H[i] = h16[i] * 0.1;
  const landcover = unrle(arr(index, buffer, 'landcover_rle'), lc.nx * lc.nz);

  // buildings
  const bxz = arr(index, buffer, 'bld_xz');
  const B = {
    count: index.counts.buildings,
    xz: new Float32Array(bxz.length),
    start: arr(index, buffer, 'bld_start'), n: arr(index, buffer, 'bld_count'),
    gmin: new Float32Array(index.counts.buildings), gmax: new Float32Array(index.counts.buildings),
    top: new Float32Array(index.counts.buildings),
    style: arr(index, buffer, 'bld_style'), wall: arr(index, buffer, 'bld_wall'), roof: arr(index, buffer, 'bld_roof'),
  };
  for (let i = 0; i < bxz.length; i++) B.xz[i] = bxz[i] * 0.25;
  const gmin = arr(index, buffer, 'bld_gmin'), gmax = arr(index, buffer, 'bld_gmax'), top = arr(index, buffer, 'bld_top');
  for (let i = 0; i < B.count; i++) { B.gmin[i] = gmin[i] * 0.1; B.gmax[i] = gmax[i] * 0.1; B.top[i] = top[i] * 0.1; }

  // roads
  const rxz = arr(index, buffer, 'road_xz');
  const rstart = arr(index, buffer, 'road_start'), rcount = arr(index, buffer, 'road_count');
  const rwidth = arr(index, buffer, 'road_width'), rtype = arr(index, buffer, 'road_type');
  const rflags = arr(index, buffer, 'road_flags'), rlanes = arr(index, buffer, 'road_lanes'), rname = arr(index, buffer, 'road_name');
  const F = index.road_flags;
  const roads = [];
  for (let i = 0; i < rstart.length; i++) {
    const pts = [];
    for (let k = 0; k < rcount[i]; k++) {
      const o = (rstart[i] + k) * 2;
      pts.push([rxz[o] * 0.25, rxz[o + 1] * 0.25]);
    }
    const fl = rflags[i];
    roads.push({
      points: pts, width: rwidth[i] * 0.1, type: index.road_types[rtype[i]], name: index.names[rname[i]],
      oneway: !!(fl & F.oneway), lanes: rlanes[i], flags: fl,
      bridge: !!(fl & F.ggbridge), cableCar: !!(fl & F.cablecar), sidewalk: !!(fl & F.sidewalk),
    });
  }
  // graph
  const gxz = arr(index, buffer, 'graph_xz');
  const ge = arr(index, buffer, 'graph_edges'), gl = arr(index, buffer, 'graph_len'), gr = arr(index, buffer, 'graph_road');
  const nodes = [];
  for (let i = 0; i < gxz.length; i += 2) nodes.push([gxz[i] * 0.25, gxz[i + 1] * 0.25]);
  const edges = [];
  for (let i = 0; i < gl.length; i++) edges.push([ge[i * 2], ge[i * 2 + 1], Math.round(gl[i] * 10) / 10, gr[i]]);
  // junctions
  const jxz = arr(index, buffer, 'junction_xz'), jr = arr(index, buffer, 'junction_r');
  const junctions = { xz: new Float32Array(jxz.length), r: new Float32Array(jr.length) };
  for (let i = 0; i < jxz.length; i++) junctions.xz[i] = jxz[i] * 0.25;
  for (let i = 0; i < jr.length; i++) junctions.r[i] = jr[i] * 0.25;
  // trees
  const txz = arr(index, buffer, 'tree_xz');
  const trees = { xz: new Float32Array(txz.length), type: arr(index, buffer, 'tree_type'), scale: arr(index, buffer, 'tree_scale') };
  for (let i = 0; i < txz.length; i++) trees.xz[i] = txz[i] * 0.25;

  return { index, grid: g, H, lcInfo: lc, landcover, B, roads, graph: { nodes, edges }, junctions, trees };
}

/** Build the query API (heightAt, surfaceHeight, ...) on decoded data. */
export function createQueries(D) {
  const { grid, H, lcInfo, landcover, B } = D;
  const NX = grid.nx, NZ = grid.nz, CELL = grid.cell, GX0 = grid.x0, GZ0 = grid.z0;
  const INV = 1 / CELL;
  const bounds = { ...D.index.bounds };

  function gridHeightAt(x, z) {
    let fx = (x - GX0) * INV, fz = (z - GZ0) * INV;
    if (fx < 0) fx = 0; else if (fx > NX - 1.0001) fx = NX - 1.0001;
    if (fz < 0) fz = 0; else if (fz > NZ - 1.0001) fz = NZ - 1.0001;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const o = iz * NX + ix;
    if (tx + tz <= 1) {
      const h00 = H[o];
      return h00 + (H[o + 1] - h00) * tx + (H[o + NX] - h00) * tz;
    }
    const h11 = H[o + NX + 1];
    return h11 + (H[o + NX] - h11) * (1 - tx) + (H[o + 1] - h11) * (1 - tz);
  }
  // pilot overlay (src/world/pilot.js): lidar ground + measured road ribbons inside its box
  const PQ = D.pilot ? createPilotQueries(D.pilot, gridHeightAt) : null;
  const heightAt = PQ ? PQ.heightAt : gridHeightAt;
  if (PQ) {
    // buildings in the box stand on the lidar ground: re-measure their ground range there
    for (let k = 0; k < B.count; k++) {
      const s = B.start[k], n = B.n[k];
      let lo = Infinity, hi = -Infinity, any = false;
      for (let i = 0; i < n; i++) {
        const x = B.xz[(s + i) * 2], z = B.xz[(s + i) * 2 + 1];
        if (PQ.contains(x, z)) any = true;
        const hv = heightAt(x, z);
        if (hv < lo) lo = hv; if (hv > hi) hi = hv;
      }
      if (any) { B.gmin[k] = lo; B.gmax[k] = hi; }
    }
  }

  // ---- landcover
  const LX0 = lcInfo.x0, LZ0 = lcInfo.z0, LRES = lcInfo.res, LNX = lcInfo.nx, LNZ = lcInfo.nz;
  function landcoverAt(x, z) {
    let i = Math.floor((x - LX0) / LRES), j = Math.floor((z - LZ0) / LRES);
    if (i < 0) i = 0; else if (i >= LNX) i = LNX - 1;
    if (j < 0) j = 0; else if (j >= LNZ) j = LNZ - 1;
    return landcover[j * LNX + i];
  }
  // lakes: level lookup by bbox + polygon
  const lakes = (D.index.lakes || []).map((l) => {
    const xs = l.ring.map((p) => p[0]), zs = l.ring.map((p) => p[1]);
    return { level: l.level, ring: l.ring, name: l.name, minx: Math.min(...xs), maxx: Math.max(...xs), minz: Math.min(...zs), maxz: Math.max(...zs) };
  });
  function lakeLevelAt(x, z) {
    for (const l of lakes) {
      if (x < l.minx - 8 || x > l.maxx + 8 || z < l.minz - 8 || z > l.maxz + 8) continue;
      return l.level;
    }
    return NaN;
  }

  // ---- solids: buildings + landmark parts (polygons with base/top)
  const lmSolids = buildLandmarkSolids(D.index, heightAt);
  let nSol = B.count + lmSolids.length;
  let nV = B.xz.length / 2;
  for (const s of lmSolids) nV += s.poly.length;
  const S = {
    x: new Float32Array(nV), z: new Float32Array(nV), start: new Uint32Array(nSol), n: new Uint16Array(nSol),
    base: new Float32Array(nSol), top: new Float32Array(nSol), roof: new Uint8Array(nSol),
    minx: new Float32Array(nSol), maxx: new Float32Array(nSol), minz: new Float32Array(nSol), maxz: new Float32Array(nSol),
  };
  let vo = 0;
  for (let k = 0; k < B.count; k++) {
    const s = B.start[k], n = B.n[k];
    S.start[k] = vo; S.n[k] = n;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = B.xz[(s + i) * 2], z = B.xz[(s + i) * 2 + 1];
      S.x[vo] = x; S.z[vo] = z; vo++;
      if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z;
    }
    S.minx[k] = a; S.maxx[k] = b; S.minz[k] = c; S.maxz[k] = d;
    S.base[k] = B.gmin[k] - 3; S.top[k] = B.top[k]; S.roof[k] = 1;
  }
  lmSolids.forEach((sd, j) => {
    const k = B.count + j;
    S.start[k] = vo; S.n[k] = sd.poly.length;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of sd.poly) {
      S.x[vo] = x; S.z[vo] = z; vo++;
      if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z;
    }
    S.minx[k] = a; S.maxx[k] = b; S.minz[k] = c; S.maxz[k] = d;
    S.base[k] = sd.base; S.top[k] = sd.top; S.roof[k] = sd.roof ? 1 : 0;
  });

  // spatial hash (CSR)
  const HC = 24, HX0 = GX0, HZ0 = GZ0;
  const HNX = Math.ceil((NX * CELL) / HC) + 1, HNZ = Math.ceil((NZ * CELL) / HC) + 1;
  const cellOf = (v, o, n) => { let c = Math.floor((v - o) / HC); return c < 0 ? 0 : c >= n ? n - 1 : c; };
  const cnt = new Uint32Array(HNX * HNZ + 1);
  for (let k = 0; k < nSol; k++) {
    const i0 = cellOf(S.minx[k], HX0, HNX), i1 = cellOf(S.maxx[k], HX0, HNX);
    const j0 = cellOf(S.minz[k], HZ0, HNZ), j1 = cellOf(S.maxz[k], HZ0, HNZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cnt[j * HNX + i + 1]++;
  }
  for (let i = 1; i < cnt.length; i++) cnt[i] += cnt[i - 1];
  const items = new Uint32Array(cnt[cnt.length - 1]);
  const fillp = cnt.slice(0, HNX * HNZ);
  for (let k = 0; k < nSol; k++) {
    const i0 = cellOf(S.minx[k], HX0, HNX), i1 = cellOf(S.maxx[k], HX0, HNX);
    const j0 = cellOf(S.minz[k], HZ0, HNZ), j1 = cellOf(S.maxz[k], HZ0, HNZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) items[fillp[j * HNX + i]++] = k;
  }
  const stamp = new Uint32Array(nSol);
  let stampId = 1;

  function pointInSolid(k, x, z) {
    if (x < S.minx[k] || x > S.maxx[k] || z < S.minz[k] || z > S.maxz[k]) return false;
    const s = S.start[k], n = S.n[k];
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = S.x[s + i], zi = S.z[s + i], xj = S.x[s + j], zj = S.z[s + j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---- Golden Gate deck
  const deck = makeDeckProfile(D.index.ggbridge);
  const lr = [0, 0];
  const DB = deck.bbox;
  function deckAt(x, z) {
    if (x < DB.minx || x > DB.maxx || z < DB.minz || z > DB.maxz) return NaN;
    const dx = x - deck.cx, dz = z - deck.cz;
    const t = dx * deck.ax + dz * deck.az;
    if (t < deck.tmin || t > deck.tmax) return NaN;
    const l = -dx * deck.az + dz * deck.ax;
    deck.lateralRange(t, lr);
    if (l < lr[0] || l > lr[1]) return NaN;
    let hp = deck.heightAtT(t);
    // blend into the real road surface over the last 50 m so deck ends are seamless
    const de = Math.min(t - deck.tmin, deck.tmax - t);
    if (de < 50) {
      // only follow the ground where it is close to the deck (never dip towards a falling bluff)
      const u = de / 50, sm = u * u * (3 - 2 * u);
      let hg = heightAt(x, z);
      if (hg < hp - 0.6) hg = hp - 0.6; else if (hg > hp + 0.6) hg = hp + 0.6;
      hp = hg + (hp - hg) * sm;
    }
    return hp;
  }

  // ---- surface selection (kind: 0 terrain, 1 roof, 2 deck)
  let _kind = 0;
  function surfaceHeight(x, z, yRef = 1e4) {
    let best = heightAt(x, z);
    _kind = 0;
    const lim = yRef + 0.75;
    const dh = deckAt(x, z);
    if (dh === dh && dh <= lim && dh > best) { best = dh; _kind = 2; }
    const ci = cellOf(x, HX0, HNX), cj = cellOf(z, HZ0, HNZ), c = cj * HNX + ci;
    for (let p = cnt[c], e = cnt[c + 1]; p < e; p++) {
      const k = items[p];
      if (!S.roof[k]) continue;
      const t = S.top[k];
      if (t <= best || t > lim) continue;
      if (pointInSolid(k, x, z)) { best = t; _kind = 1; }
    }
    return best;
  }

  /** terrain or bridge deck (no roofs): handy for traffic / AI. */
  function groundHeight(x, z) {
    const h = heightAt(x, z);
    const dh = deckAt(x, z);
    return dh === dh && dh > h ? dh : h;
  }

  function normalAt(x, z, yRef = 1e4, out = new THREE.Vector3()) {
    surfaceHeight(x, z, yRef);
    if (_kind === 1) return out.set(0, 1, 0);
    if (_kind === 2) {
      const e = 1.0;
      const h0 = deckAt(x, z);
      let hx = deckAt(x + e, z), hz = deckAt(x, z + e);
      if (!(hx === hx)) hx = h0 - (deckAt(x - e, z) - h0);
      if (!(hz === hz)) hz = h0 - (deckAt(x, z - e) - h0);
      const gx = hx === hx ? (hx - h0) / e : 0, gz = hz === hz ? (hz - h0) / e : 0;
      return out.set(-gx, 1, -gz).normalize();
    }
    const e = 1.5;
    const hx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const hz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    return out.set(-hx, 1, -hz).normalize();
  }

  // ---- road segments hash for 'road' / 'sidewalk'
  const RC = 32;
  const RNX = Math.ceil((NX * CELL) / RC) + 1, RNZ = Math.ceil((NZ * CELL) / RC) + 1;
  const segs = [];
  D.roads.forEach((r, ri) => {
    const sw = r.sidewalk ? 3.0 : 0.8;
    for (let i = 1; i < r.points.length; i++) segs.push(r.points[i - 1][0], r.points[i - 1][1], r.points[i][0], r.points[i][1], r.width * 0.5, sw, ri);
  });
  const SEGN = 7, nSeg = segs.length / SEGN;
  const segA = new Float32Array(segs);
  const rcellOf = (v, o, n) => { let c = Math.floor((v - o) / RC); return c < 0 ? 0 : c >= n ? n - 1 : c; };
  const rcnt = new Uint32Array(RNX * RNZ + 1);
  const segCells = (k, fn) => {
    const o = k * SEGN, m = segA[o + 4] + segA[o + 5];
    const i0 = rcellOf(Math.min(segA[o], segA[o + 2]) - m, GX0, RNX), i1 = rcellOf(Math.max(segA[o], segA[o + 2]) + m, GX0, RNX);
    const j0 = rcellOf(Math.min(segA[o + 1], segA[o + 3]) - m, GZ0, RNZ), j1 = rcellOf(Math.max(segA[o + 1], segA[o + 3]) + m, GZ0, RNZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * RNX + i);
  };
  for (let k = 0; k < nSeg; k++) segCells(k, (c) => rcnt[c + 1]++);
  for (let i = 1; i < rcnt.length; i++) rcnt[i] += rcnt[i - 1];
  const ritems = new Uint32Array(rcnt[rcnt.length - 1]);
  const rfill = rcnt.slice(0, RNX * RNZ);
  for (let k = 0; k < nSeg; k++) segCells(k, (c) => { ritems[rfill[c]++] = k; });

  /** nearest road info at (x,z): returns 0 none, 1 road, 2 sidewalk; fills roadHit.{road, dist, along} */
  const roadHit = { road: -1, dist: 0, halfWidth: 0 };
  function roadAt(x, z) {
    const c = rcellOf(z, GZ0, RNZ) * RNX + rcellOf(x, GX0, RNX);
    let res = 0, bestD = Infinity;
    for (let p = rcnt[c], e = rcnt[c + 1]; p < e; p++) {
      const o = ritems[p] * SEGN;
      const ax = segA[o], az = segA[o + 1], bx = segA[o + 2], bz = segA[o + 3];
      const vx = bx - ax, vz = bz - az, wx = x - ax, wz = z - az;
      const L2 = vx * vx + vz * vz;
      let t = L2 > 0 ? (wx * vx + wz * vz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = wx - vx * t, dz = wz - vz * t;
      const d = Math.sqrt(dx * dx + dz * dz);
      const hw = segA[o + 4];
      if (d <= hw) {
        if (res !== 1 || d < bestD) { res = 1; bestD = d; roadHit.road = segA[o + 6]; roadHit.dist = d; roadHit.halfWidth = hw; }
      } else if (res !== 1 && d <= hw + segA[o + 5] && d < bestD) {
        res = 2; bestD = d; roadHit.road = segA[o + 6]; roadHit.dist = d; roadHit.halfWidth = hw;
      }
    }
    return res;
  }

  function terrainIsWater(x, z, h) {
    if (h < 0) return true;
    const c = landcoverAt(x, z);
    if (c === LC.LAKE) {
      const lv = lakeLevelAt(x, z);
      return !(lv === lv) || h < lv;
    }
    return false;
  }

  function isWater(x, z) {
    const h = heightAt(x, z);
    if (!terrainIsWater(x, z, h)) return false;
    const dh = deckAt(x, z);
    return !(dh === dh);
  }

  function surfaceAt(x, z, yRef = 1e4) {
    const h = surfaceHeight(x, z, yRef);
    if (_kind === 1) return 'roof';
    if (_kind === 2) return 'bridge';
    if (terrainIsWater(x, z, h)) return 'water';
    if (PQ) {
      const k = PQ.surfaceKind(x, z);
      if (k === 1) return 'road';
      if (k === 2) return 'sidewalk';
    }
    const r = roadAt(x, z);
    if (r === 1) return 'road';
    if (r === 2) return 'sidewalk';
    return LC_SURFACE[landcoverAt(x, z)] || 'grass';
  }

  const tmpN = { nx: 0, nz: 0, depth: 0 };
  function collideCircle(x, z, r, y, out) {
    stampId = (stampId + 1) >>> 0;
    if (stampId === 0) { stamp.fill(0); stampId = 1; }
    let best = 0, found = false;
    const i0 = cellOf(x - r, HX0, HNX), i1 = cellOf(x + r, HX0, HNX);
    const j0 = cellOf(z - r, HZ0, HNZ), j1 = cellOf(z + r, HZ0, HNZ);
    const yTop = y + 0.75, yBase = y + 3.0;
    for (let cj = j0; cj <= j1; cj++) {
      for (let ci = i0; ci <= i1; ci++) {
        const c = cj * HNX + ci;
        for (let p = cnt[c], e = cnt[c + 1]; p < e; p++) {
          const k = items[p];
          if (stamp[k] === stampId) continue;
          stamp[k] = stampId;
          if (S.top[k] <= yTop || S.base[k] > yBase) continue;
          if (x + r < S.minx[k] || x - r > S.maxx[k] || z + r < S.minz[k] || z - r > S.maxz[k]) continue;
          const s = S.start[k], n = S.n[k];
          let inside = false, md2 = Infinity, qx = 0, qz = 0, enx = 0, enz = 0;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = S.x[s + i], zi = S.z[s + i], xj = S.x[s + j], zj = S.z[s + j];
            if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
            const vx = xi - xj, vz = zi - zj, wx = x - xj, wz = z - zj;
            const L2 = vx * vx + vz * vz;
            let t = L2 > 0 ? (wx * vx + wz * vz) / L2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = xj + vx * t, pz = zj + vz * t;
            const dx = x - px, dz = z - pz, d2 = dx * dx + dz * dz;
            if (d2 < md2) { md2 = d2; qx = px; qz = pz; const il = 1 / Math.sqrt(L2 || 1); enx = vz * il; enz = -vx * il; }
          }
          const d = Math.sqrt(md2);
          let depth, nx, nz;
          if (inside) {
            depth = r + d;
            if (d > 1e-4) { nx = (qx - x) / d; nz = (qz - z) / d; } else { nx = enx; nz = enz; }
          } else {
            if (d >= r) continue;
            depth = r - d;
            if (d > 1e-4) { nx = (x - qx) / d; nz = (z - qz) / d; } else { nx = enx; nz = enz; }
          }
          if (depth > best) { best = depth; found = true; tmpN.nx = nx; tmpN.nz = nz; tmpN.depth = depth; }
        }
      }
    }
    if (!found) return null;
    const o = out || {};
    o.nx = tmpN.nx; o.nz = tmpN.nz; o.depth = tmpN.depth;
    return o;
  }

  /** which solid (building index < buildings.count, else landmark part) contains point; -1 if none */
  function solidAt(x, z) {
    const c = cellOf(z, HZ0, HNZ) * HNX + cellOf(x, HX0, HNX);
    for (let p = cnt[c], e = cnt[c + 1]; p < e; p++) if (pointInSolid(items[p], x, z)) return items[p];
    return -1;
  }

  return {
    bounds, heightAt, surfaceHeight, groundHeight, normalAt, surfaceAt, isWater, collideCircle,
    landcoverAt, roadAt, roadHit, deckAt, deck, solidAt, lakes, solids: S, solidCount: nSol, landmarkSolids: lmSolids,
    pilot: PQ, baseHeightAt: gridHeightAt,
  };
}

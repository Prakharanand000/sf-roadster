// SF Roadster Rush - v2 lidar patch meshes for one 512 m tile (lidar2.js patches; tiles2.js builds
// them). The same meshes the lidar pilot draws (pilot.js buildPilot) cut to the tile, built a piece at
// a time so no tile takes more than a few ms of a frame:
// - ground: 256 m chunks with 2/4/8 m LODs (same triangle split as the queries). The coarse levels are
//   built first; a chunk's finest level only when the camera comes within FINE_BUILD of the switch
//   distance, and it goes again beyond FINE_DROP (it is most of a tile's triangles and memory).
//   Normals at the tile's edge read the neighbour's nodes, so tiles shade without a seam.
// - ribbons: each segment is drawn by the tile holding its midpoint (patches copy a segment into every
//   tile it touches), and lane markings keep their phase across a cut (run_s0).
import * as THREE from 'three';
import { markingInfo } from '../roads.js';

const CHUNK_NODES = 128;   // 256 m ground chunks (2 x 2 per tile)
const RIB_LIFT = 0.02;     // render-only lift of ribbons over the physics surface (pilot.js)
const EDGE_LIFT = 0.1;     // roads.js lifts its ribbons this much; match it at the edge of coverage
const FINE_BUILD = 400;    // m before a chunk's finest LOD shows that it gets built
const FINE_DROP = 700;     // m past that switch distance that it is dropped (300 m of hysteresis)

/** `lodLevels(quality)`: [[node step, switch distance], ...] finest first (pilot.js buildPilot's). */
function lodLevels(quality) {
  return quality === 'low' ? [[2, 0], [4, 500]] : [[1, 0], [2, quality === 'high' ? 600 : 400], [4, 1300]];
}

/**
 * Pieces of tile t's lidar meshes: `units` (run in order: ground at its coarse levels, then ribbons),
 * then `fine(x, z)` -> the units still due for the finest ground level near (x, z).
 * `lidar`: Q.lidar; `roads`: D.roads (marking info); `base`: Q.baseHeightAt.
 */
export function createPatchMesh(t, { lidar, roads, base, quality = 'high', groundMaterial, roadMaterial }) {
  const tp = lidar.patch(t.i, t.j);
  const P = tp.P, K = P.K, g = P.grid, C = g.cell, N = g.nx;
  const s0r = lidar.runS0(t.i, t.j);
  const TS = (N - 1) * C, X0 = t.x0, Z0 = t.z0;
  const gi0 = Math.round(X0 / C), gj0 = Math.round(Z0 / C);
  const group = new THREE.Group();
  group.name = 'lidar-' + t.key;
  const stats = { groundTris: 0, ribbonTris: 0, fineChunks: 0 };

  // ---- node heights with a one-node ring from the neighbours (normals across the tile edge)
  const NH = N + 2;
  const vh = new Float32Array(NH * NH);
  const F = lidar.index.feather;
  // blend only where coverage ends within the feather band of this tile (else the grid as is)
  const open = (di, dj) => !lidar.isCovered(t.i + di, t.j + dj);
  const near = (i, j) => {
    const x = i * C, z = j * C, b = F + C;
    return (x < b && (open(-1, 0) || (z < b && open(-1, -1)) || (z > TS - b && open(-1, 1)))) ||
      (x > TS - b && (open(1, 0) || (z < b && open(1, -1)) || (z > TS - b && open(1, 1)))) ||
      (z < b && open(0, -1)) || (z > TS - b && open(0, 1));
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let v = P.G[j * N + i];
      if (near(i, j)) {
        const x = X0 + i * C, z = Z0 + j * C, f = lidar.featherAt(x, z);
        if (f < 1) { const b0 = base(x, z); v = b0 + (v - b0) * f; }
      }
      vh[(j + 1) * NH + i + 1] = v;
    }
  }
  for (let k = -1; k <= N; k++) {
    vh[k + 1] = lidar.nodeHeight(gi0 + k, gj0 - 1, C);
    vh[(N + 1) * NH + k + 1] = lidar.nodeHeight(gi0 + k, gj0 + N, C);
    vh[(k + 1) * NH] = lidar.nodeHeight(gi0 - 1, gj0 + k, C);
    vh[(k + 1) * NH + N + 1] = lidar.nodeHeight(gi0 + N, gj0 + k, C);
  }
  const hAt = (i, j) => vh[(j + 1) * NH + i + 1];

  function chunkGeometry(i0, i1, j0, j1, s, skirt) {
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
      const x = X0 + i * C, z = Z0 + j * C;
      pos[v * 3] = x; pos[v * 3 + 1] = hAt(i, j) - dy; pos[v * 3 + 2] = z;
      const hx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * C), hz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * C);
      const l = Math.hypot(hx, 1, hz);
      nor[v * 3] = -hx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = -hz / l;
      uv[v * 2] = (i * C) / TS; uv[v * 2 + 1] = (j * C) / TS;
      return v++;
    };
    for (let b = 0; b < cz; b++) for (let a = 0; a < cx; a++) put(xs[a], zs[b], 0);
    for (let b = 0; b < cz - 1; b++) {
      for (let a = 0; a < cx - 1; a++) {
        const p00 = b * cx + a, p10 = p00 + 1, p01 = p00 + cx, p11 = p01 + 1;
        idx.push(p00, p01, p10, p01, p11, p10);   // same split as the grid queries
      }
    }
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
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, v * 2), 2));
    geo.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  // ---- ground chunks: one LOD each, coarse levels as units, the finest level on demand
  const levels = lodLevels(quality);
  const [fineStep, fineDist] = levels[0], fineSwitch = levels.length > 1 ? levels[1][1] : Infinity;
  const chunks = [];
  for (let j0 = 0; j0 < N - 1; j0 += CHUNK_NODES) {
    for (let i0 = 0; i0 < N - 1; i0 += CHUNK_NODES) {
      const i1 = Math.min(i0 + CHUNK_NODES, N - 1), j1 = Math.min(j0 + CHUNK_NODES, N - 1);
      const lod = new THREE.LOD();
      const cx = X0 + ((i0 + i1) / 2) * C, cz = Z0 + ((j0 + j1) / 2) * C;
      lod.position.set(cx, 0, cz);
      group.add(lod);
      chunks.push({ i0, i1, j0, j1, lod, cx, cz, fine: false });
    }
  }
  const addLevel = (c, s, dist) => {
    // the skirt only drops a little: neighbours are patches, or the 8 m ground at the edge of coverage
    const geo = chunkGeometry(c.i0, c.i1, c.j0, c.j1, s, s === 1 ? 0.6 : 2);
    const m = new THREE.Mesh(geo, groundMaterial);
    m.receiveShadow = true;
    m.position.set(-c.cx, 0, -c.cz);
    m.updateMatrix();
    m.matrixAutoUpdate = false;
    c.lod.addLevel(m, dist);
    stats.groundTris += geo.index.count / 3;
    return m;
  };
  const units = [];
  const unit = (label, fn) => Object.assign(fn, { label });
  for (const c of chunks) units.push(unit('ground', () => { for (const [s, d] of levels.slice(1)) addLevel(c, s, d); }));
  if (levels.length === 1) for (const c of chunks) units.push(unit('ground', () => { addLevel(c, fineStep, fineDist); c.fine = true; }));

  // ---- ribbons: per station 11 vertices (pilot.js buildPilot), segments this tile owns
  const { xz, off, h, nrm, jd, runs } = P;
  const owns = (i) => {
    const mx = (xz[i * 2] + xz[i * 2 + 2]) / 2, mz = (xz[i * 2 + 1] + xz[i * 2 + 3]) / 2;
    return mx >= X0 && mx < X0 + TS && mz >= Z0 && mz < Z0 + TS;
  };
  const NCX = Math.ceil(TS / (CHUNK_NODES * C));
  const chunkOf = (i) => {
    const mx = (xz[i * 2] + xz[i * 2 + 2]) / 2, mz = (xz[i * 2 + 1] + xz[i * 2 + 3]) / 2;
    const a = Math.min(NCX - 1, Math.max(0, Math.floor((mx - X0) / (CHUNK_NODES * C))));
    const b = Math.min(NCX - 1, Math.max(0, Math.floor((mz - Z0) / (CHUNK_NODES * C))));
    return b * NCX + a;
  };
  const featherAt = lidar.featherAt;
  function ribbonChunk(ck) {
    const buf = { pos: [], ruv: [], rinfo: [], rj: [], idx: [], n: 0 };
    let tris = 0;
    for (let r = 0; r < runs.start.length; r++) {
      const s0 = runs.start[r], e = s0 + runs.count[r];
      const road = roads[runs.road[r]];
      const { info, fl } = markingInfo(road);
      let along = s0r[r], prev = -1;
      for (let i = s0; i < e - 1; i++) {
        const seg = Math.hypot(xz[i * 2 + 2] - xz[i * 2], xz[i * 2 + 3] - xz[i * 2 + 1]);
        if (owns(i) && chunkOf(i) === ck) {
          if (prev < 0) prev = emit(i, along);
          const v = emit(i + 1, along + seg);
          for (const [a, b] of [[7, 8], [5, 6], [0, 1], [1, 2], [3, 4], [9, 10]]) {
            buf.idx.push(prev + a, prev + b, v + a, prev + b, v + b, v + a);
            tris += 2;
          }
          prev = v;
        } else prev = -1;
        along += seg;
      }
      function emit(i, s) {
        const v = buf.n;
        const cxp = xz[i * 2], czp = xz[i * 2 + 1], nxp = nrm[i * 2], nzp = nrm[i * 2 + 1];
        const gB = -off[i * K + 2], gA = off[i * K + 4];
        const hw = (gA + gB) / 2, mid = (gA - gB) / 2;
        const P3 = (q) => {
          const o = off[i * K + q];
          const x = cxp + nxp * o, z = czp + nzp * o;
          const f = featherAt(x, z);
          let y = h[i * K + q];
          if (f < 1) { const b0 = base(x, z); y = b0 + (y - b0) * f; }
          return [x, y + RIB_LIFT + (EDGE_LIFT - RIB_LIFT) * (1 - f), z, o];
        };
        const k = [0, 1, 2, 3, 4, 5, 6].map(P3);
        const push = (p, lat, kind) => {
          buf.pos.push(p[0], p[1], p[2]);
          buf.ruv.push(lat, s);
          buf.rinfo.push(hw, kind === 0 ? info : 0, kind === 0 ? fl : 0, kind);
          buf.rj.push(jd[i]);
        };
        push(k[2], k[2][3] - mid, 0); push(k[3], -mid, 0); push(k[4], k[4][3] - mid, 0);
        push(k[4], 0, 2); push(k[5], 0, 2);
        push(k[1], 0, 2); push(k[2], 0, 2);
        push(k[0], Math.abs(k[0][3] - k[1][3]), 1); push(k[1], 0, 1);
        push(k[5], 0, 1); push(k[6], Math.abs(k[6][3] - k[5][3]), 1);
        buf.n += 11;
        return v;
      }
    }
    if (!buf.idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('ruv', new THREE.Float32BufferAttribute(buf.ruv, 2));
    geo.setAttribute('rinfo', new THREE.Float32BufferAttribute(buf.rinfo, 4));
    geo.setAttribute('rj', new THREE.Float32BufferAttribute(buf.rj, 1));
    geo.setIndex(buf.n > 65535 ? new THREE.Uint32BufferAttribute(buf.idx, 1) : new THREE.Uint16BufferAttribute(buf.idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, roadMaterial);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    group.add(mesh);
    stats.ribbonTris += tris;
  }
  for (let ck = 0; ck < NCX * NCX; ck++) units.push(unit('ribbons', () => ribbonChunk(ck)));

  /** Units still due for the finest ground level of chunks near (x, z), nearest first. */
  function fine(x, z) {
    if (levels.length === 1) return [];
    const due = [];
    for (const c of chunks) {
      if (c.fine || c.pending) continue;
      const d = Math.hypot(c.cx - x, c.cz - z);
      if (d < fineSwitch + FINE_BUILD) due.push([d, c]);
    }
    return due.sort((a, b) => a[0] - b[0]).map(([d, c]) => {
      c.pending = true;
      return {
        d,
        due: (x2, z2) => Math.hypot(c.cx - x2, c.cz - z2) < fineSwitch + FINE_BUILD,
        run: () => { c.fineMesh = addLevel(c, fineStep, fineDist); c.fine = true; c.pending = false; stats.fineChunks++; },
        cancel: () => { c.pending = false; },
      };
    });
  }

  /** Drop the finest level of chunks the camera has left (beyond FINE_DROP); the number dropped. */
  function coarsen(x, z) {
    if (levels.length === 1) return 0;
    let n = 0;
    for (const c of chunks) {
      if (!c.fineMesh || Math.hypot(c.cx - x, c.cz - z) < fineSwitch + FINE_DROP) continue;
      const k = c.lod.levels.findIndex((l) => l.object === c.fineMesh);   // r160's LOD has no removeLevel
      if (k >= 0) c.lod.levels.splice(k, 1);
      c.lod.remove(c.fineMesh);
      stats.groundTris -= c.fineMesh.geometry.index.count / 3;
      c.fineMesh.geometry.dispose();
      c.fineMesh = null;
      c.fine = false;
      stats.fineChunks--;
      n++;
    }
    return n;
  }

  return { group, units, fine, coarsen, stats };
}

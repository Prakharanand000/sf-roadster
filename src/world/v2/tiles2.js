// SF Roadster Rush - v2 world: tile streaming around the camera (data, ground, roads, trees,
// buildings) on top of the always-loaded net. See city2.js for how it is wired up.
//
// Three rings, measured from the camera to each 512 m tile square:
// - near (1.2 km on high): the tile's own 8 m ground with a painted ground texture, road ribbons,
//   sidewalks, street lights and trees. Built only once the tile's 8 neighbours have data, so
//   roads and ground normals that reach across an edge sample the same heights on both sides.
// - buildings (3 km on high): the tile's buildings. Beyond it the net's skyline (towers >= 30 m)
//   stands in, one mesh per tile, hidden while that tile's own buildings are up.
// - data (the larger of the two plus a margin): the decoded tile, registered with the queries.
//   Pinned tiles (track corridors, landmarks) keep their data wherever the camera is.
// - lidar patches (lidar2.js): around the near ring and its neighbours, plus pinned track corridors.
//   A covered tile's near meshes wait for its own and its covered neighbours' patches, and are then its
//   2 m lidar ground and measured ribbons (patchmesh2.js) instead of the 8 m ground, built a piece at a
//   time within the frame budget; each chunk's finest ground level is built as the camera nears it.
// Each ring unloads HYST metres beyond where it loads. The coarse net terrain is discarded (shader)
// under every tile whose own ground is built.
import * as THREE from 'three';
import { decodeTile } from './worlddata2.js';
import { buildRoads } from '../roads.js';
import { buildBuildings } from '../buildings.js';
import { buildTrees } from '../trees.js';
import { terrainMaterial, LC_COL, buildingMask, boxBlur, pilotSink } from '../terrain.js';
import { createPatchMesh } from './patchmesh2.js';

export const RADII = {
  high: { near: 1200, bld: 3000, tex: 512 },
  medium: { near: 1000, bld: 2200, tex: 256 },
  low: { near: 800, bld: 1500, tex: 256 },
};
const HYST = 450;
const DIAG = 725;           // > 512 * sqrt(2): any point of a tile to its farthest neighbour
const DATA_PAD = 300;
const MAX_FETCH = 6;
const SKIRT = 25;           // m: hides cracks where an 8 m tile meets the coarse 16 m terrain
const ROAD_MARGIN = 100;    // m of road kept around a tile so junctions and lamps are seen whole
const BIG = 1e9;
const RETRY_MS = 5000;

const EMPTY = { count: 0, xz: new Float32Array(0), start: new Uint32Array(0), n: new Uint8Array(0) };

/** Squared-free distance from (x, z) to the square [x0, x0 + s] x [z0, z0 + s]. */
function rectDist(x, z, x0, z0, s) {
  const dx = x < x0 ? x0 - x : x > x0 + s ? x - x0 - s : 0;
  const dz = z < z0 ? z0 - z : z > z0 + s ? z - z0 - s : 0;
  return Math.hypot(dx, dz);
}

/** Buildings `list` of B as one B (footprint fields only, for buildingMask). */
export function mergeFootprints(list) {
  let nb = 0, nv = 0;
  for (const B of list) { nb += B.count; nv += B.xz.length; }
  if (!nb) return EMPTY;
  const xz = new Float32Array(nv), start = new Uint32Array(nb), n = new Uint8Array(nb);
  let b = 0, v = 0;
  for (const B of list) {
    for (let k = 0; k < B.count; k++) {
      start[b] = v / 2; n[b] = B.n[k];
      const s = B.start[k] * 2, e = s + B.n[k] * 2;
      for (let i = s; i < e; i++) xz[v++] = B.xz[i];
      b++;
    }
  }
  return { count: nb, xz, start, n };
}

/** A subset of a building set as its own B (all fields buildBuildings reads). */
export function subsetBuildings(S, list) {
  let nv = 0;
  for (const k of list) nv += S.n[k];
  const m = list.length;
  const B = {
    count: m, xz: new Float32Array(nv * 2), start: new Uint32Array(m), n: new Uint8Array(m),
    gmin: new Float32Array(m), gmax: new Float32Array(m), top: new Float32Array(m), style: new Uint8Array(m),
    wall: new Uint8Array(m * 3), roof: new Uint8Array(m * 3),
  };
  let v = 0;
  list.forEach((k, o) => {
    B.start[o] = v; B.n[o] = S.n[k];
    for (let i = 0; i < S.n[k]; i++) { B.xz[(v + i) * 2] = S.xz[(S.start[k] + i) * 2]; B.xz[(v + i) * 2 + 1] = S.xz[(S.start[k] + i) * 2 + 1]; }
    v += S.n[k];
    B.gmin[o] = S.gmin[k]; B.gmax[o] = S.gmax[k]; B.top[o] = S.top[k]; B.style[o] = S.style[k];
    for (let c = 0; c < 3; c++) { B.wall[o * 3 + c] = S.wall[k * 3 + c]; B.roof[o * 3 + c] = S.roof[k * 3 + c]; }
  });
  return B;
}

/** Dispose every geometry under `group` (materials are shared and stay). */
function disposeGeometries(group) {
  group.traverse((o) => {
    if (o.isInstancedMesh) o.dispose();             // instance buffers; the geometry is shared
    else if (o.geometry) o.geometry.dispose();
  });
}

/** `keepNear`: [[i, j], ...] tiles whose near meshes stay built wherever the camera is (the tiles under
 *  the lidar pilot: its patch is drawn everywhere, and only tile ground is sunk under it).
 *  `lidar`: Q.lidar (lidar tile patches), or null. */
export function createTileStreamer({ D, Q, base, quality = 'high', uniforms, shared, parent, onTileChange, keepNear = [], lidar = null }) {
  const R = RADII[quality] || RADII.high;
  const TS = Q.tiles.size, TI0 = Q.tiles.i0, TJ0 = Q.tiles.j0, TNI = Q.tiles.ni, TNJ = Q.tiles.nj;
  const NT = TNI * TNJ;
  const dataLoad = Math.max(R.bld, R.near + DIAG) + DATA_PAD;
  const dataDrop = dataLoad + 2 * HYST;
  const fetching = new Uint8Array(NT), pinned = new Uint8Array(NT);
  const retryAt = new Float64Array(NT);
  const near = new Array(NT).fill(null), bld = new Array(NT).fill(null);
  const loaded = new Set(), meshed = new Set();
  let inflight = 0;
  const group = new THREE.Group();
  group.name = 'tiles';
  parent.add(group);

  // coarse-terrain discard mask: one texel per tile, set while the tile's own ground is built
  const maskData = new Uint8Array(NT);
  const maskTex = new THREE.DataTexture(maskData, TNI, TNJ, THREE.RedFormat, THREE.UnsignedByteType);
  maskTex.magFilter = maskTex.minFilter = THREE.NearestFilter;
  maskTex.needsUpdate = true;
  const maskRect = new THREE.Vector4(TI0 * TS, TJ0 * TS, TNI * TS, TNJ * TS);

  // road bounding boxes, for picking the roads around a tile
  const roadBox = new Float32Array(D.roads.length * 4);
  D.roads.forEach((r, k) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of r.points) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
    const hw = r.width * 0.5 + 4;
    roadBox[k * 4] = a - hw; roadBox[k * 4 + 1] = b + hw; roadBox[k * 4 + 2] = c - hw; roadBox[k * 4 + 3] = d + hw;
  });

  const idx = (i, j) => (j - TJ0) * TNI + (i - TI0);
  const inGrid = (i, j) => i >= TI0 && j >= TJ0 && i < TI0 + TNI && j < TJ0 + TNJ;
  const keep = new Uint8Array(NT);
  for (const [i, j] of keepNear) if (inGrid(i, j)) keep[idx(i, j)] = 1;
  const sinkAt = D.pilot ? pilotSink(D.pilot) : null;   // tile ground under the pilot patch

  // lidar patches: their own ring, covering the near ring's tiles and their neighbours
  const pLoad = R.near + DIAG, pDrop = pLoad + HYST;
  const pFetching = new Uint8Array(NT), pPinned = new Uint8Array(NT), pFailed = new Uint8Array(NT);
  const pRetryAt = new Float64Array(NT), pTries = new Uint8Array(NT);
  const P_TRIES = 3;          // a patch that fails this often is given up: its tile keeps the 8 m ground
  const pLoaded = new Set(), pPinList = [];
  let pInflight = 0;
  const covered = (i, j) => !!lidar && inGrid(i, j) && lidar.isCovered(i, j);
  const jobs = new Map();     // near meshes being built a piece at a time: k -> job
  let fineQ = [];             // finest ground levels due near the camera: { d, run }
  // build cost per kind of piece (stats().cost): the frame budget is only as good as its largest piece
  const cost = {};
  const timed = (label, fn) => {
    const t0 = performance.now();
    const r = fn();
    const ms = performance.now() - t0, c = cost[label] || (cost[label] = { n: 0, total: 0, max: 0 });
    c.n++; c.total += ms; if (ms > c.max) c.max = ms;
    return r;
  };

  function setData(k, t) {
    if (t) { Q.addTile(t); loaded.add(k); } else {
      Q.removeTile((k % TNI) + TI0, Math.floor(k / TNI) + TJ0); loaded.delete(k);
    }
  }

  async function fetchTile(i, j) {
    const res = await fetch(base + 'tiles/' + i + '_' + j + '.bin.wasm');
    if (!res.ok) throw new Error('tile ' + i + ',' + j + ': HTTP ' + res.status);
    return decodeTile(await res.arrayBuffer(), TS);
  }

  function startFetch(i, j) {
    const k = idx(i, j);
    fetching[k] = 1; inflight++;
    return fetchTile(i, j).then((t) => {
      if (!Q.tileByIndex(i, j)) setData(k, t);
    }).catch((e) => {
      retryAt[k] = performance.now() + RETRY_MS;
      console.warn('v2 world: ' + e.message);
    }).finally(() => { fetching[k] = 0; inflight--; });
  }

  function startPatchFetch(i, j) {
    const k = idx(i, j);
    pFetching[k] = 1; pInflight++;
    return fetch(base + 'lidar/' + i + '_' + j + '.bin.wasm').then((res) => {
      if (!res.ok) throw new Error('lidar patch ' + i + ',' + j + ': HTTP ' + res.status);
      return res.arrayBuffer();
    }).then((buf) => {
      if (lidar.has(i, j)) return;
      if (lidar.add(buf)) pLoaded.add(k);
      else { pFailed[k] = 1; console.warn('v2 world: lidar patch ' + i + ',' + j + ' refused (not the one index.json lists); the tile keeps its 8 m ground'); }
    }).catch((e) => {
      pRetryAt[k] = performance.now() + RETRY_MS;
      if (++pTries[k] >= P_TRIES) { pFailed[k] = 1; console.warn('v2 world: ' + e.message + '; given up, the tile keeps its 8 m ground'); }
      else console.warn('v2 world: ' + e.message);
    }).finally(() => { pFetching[k] = 0; pInflight--; });
  }

  /** Fetch and register the lidar patches of `list` now (awaitable, at load). */
  async function preloadPatches(list) {
    const todo = [...new Map(list.filter(([i, j]) => covered(i, j) && !lidar.has(i, j)).map((t) => [t.join(','), t])).values()];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const [i, j] = todo[next++];
        if (!pFetching[idx(i, j)]) await startPatchFetch(i, j);
      }
    };
    await Promise.all(Array.from({ length: MAX_FETCH }, worker));
  }

  function pinPatch(i, j) {
    if (!covered(i, j) || pPinned[idx(i, j)]) return;
    pPinned[idx(i, j)] = 1;
    pPinList.push([i, j]);
  }

  /** The tile's own and its covered neighbours' patches are in (or refused for good). */
  function patchesReady(i, j) {
    if (!lidar) return true;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if (covered(a, b) && !lidar.has(a, b) && !pFailed[idx(a, b)]) return false;
      }
    }
    return true;
  }

  /** Fetch and register tiles now (awaitable): used at load for pins and the start area. */
  async function preload(list, onProgress) {
    const seen = new Set();
    const todo = list.filter(([i, j]) => {
      if (!inGrid(i, j) || !Q.tileExists(i, j) || Q.tileByIndex(i, j) || seen.has(i + ',' + j)) return false;
      seen.add(i + ',' + j);
      return true;
    });
    let done = 0, next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const [i, j] = todo[next++];
        const k = idx(i, j);
        if (fetching[k]) continue;
        await startFetch(i, j);
        done++;
        if (onProgress) onProgress(done / todo.length);
      }
    };
    await Promise.all(Array.from({ length: MAX_FETCH }, worker));
  }

  const pinList = [];
  function pin(i, j) {
    if (!inGrid(i, j) || !Q.tileExists(i, j) || pinned[idx(i, j)]) return;
    pinned[idx(i, j)] = 1;
    pinList.push([i, j]);
  }

  function neighboursReady(i, j) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if (Q.tileExists(a, b) && !Q.tileByIndex(a, b)) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ near ring: ground + roads + trees
  function paintGround(t) {
    const li = t.lcInfo, N = li.nx, P = N + 2, res = li.res;
    const W = R.tex;
    // landcover with a one-pixel border from the neighbours, so edges blend like the interior
    const src = document.createElement('canvas');
    src.width = P; src.height = P;
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(P, P);
    const gi0 = Math.round(li.x0 / res), gj0 = Math.round(li.z0 / res);
    for (let j = -1; j <= N; j++) {
      for (let i = -1; i <= N; i++) {
        const cls = i >= 0 && j >= 0 && i < N && j < N ? t.landcover[j * N + i] : Q.landcoverAt(li.x0 + (i + 0.5) * res, li.z0 + (j + 0.5) * res);
        const c = LC_COL[cls] || LC_COL[1];
        const h = Math.imul(Math.imul(gi0 + i, 73856093) ^ Math.imul(gj0 + j, 19349663), 2654435761) >>> 24;
        const d = (h / 255) * 8 - 4;
        const o = ((j + 1) * P + (i + 1)) * 4;
        img.data[o] = c[0] + d; img.data[o + 1] = c[1] + d; img.data[o + 2] = c[2] + d; img.data[o + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = W;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    const px1 = W / N;
    ctx.drawImage(src, -px1, -px1, W + 2 * px1, W + 2 * px1);
    // building AO halo from this tile's and the neighbours' footprints
    const Bs = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const n = Q.tileByIndex(t.i + di, t.j + dj); if (n && n.B.count) Bs.push(n.B); }
    const B = mergeFootprints(Bs);
    if (B.count) {
      const ext = { lcInfo: { x0: li.x0 - res, z0: li.z0 - res, res, nx: P, nz: P }, B };
      const blurred = boxBlur(buildingMask(ext), P, P, 1);
      const mc = document.createElement('canvas');
      mc.width = P; mc.height = P;
      const mctx = mc.getContext('2d');
      const mi = mctx.createImageData(P, P);
      for (let i = 0; i < blurred.length; i++) { mi.data[i * 4] = 28; mi.data[i * 4 + 1] = 28; mi.data[i * 4 + 2] = 30; mi.data[i * 4 + 3] = blurred[i] * 0.6; }
      mctx.putImageData(mi, 0, 0);
      ctx.drawImage(mc, -px1, -px1, W + 2 * px1, W + 2 * px1);
    }
    // sidewalks then asphalt under the road meshes (as paintGroundCanvas)
    const s = W / TS;
    const px = (x) => (x - t.x0) * s, pz = (z) => (z - t.z0) * s;
    const list = roadsNear(t, 20);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass === 0 ? 'rgb(140,138,132)' : 'rgb(58,59,62)';
      for (const k of list) {
        const r = D.roads[k];
        if (r.bridge) continue;
        ctx.lineWidth = Math.max(1, Math.round((pass === 0 ? (r.sidewalk ? r.width + 6 : r.width + 1) : r.width) * s * 2) / 2);
        ctx.beginPath();
        r.points.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))));
        ctx.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  function roadsNear(t, margin) {
    const x0 = t.x0 - margin, x1 = t.x0 + TS + margin, z0 = t.z0 - margin, z1 = t.z0 + TS + margin;
    const out = [];
    for (let k = 0; k < D.roads.length; k++) {
      const o = k * 4;
      if (roadBox[o] > x1 || roadBox[o + 1] < x0 || roadBox[o + 2] > z1 || roadBox[o + 3] < z0) continue;
      out.push(k);
    }
    return out;
  }

  /** The part of road r around box b (+ROAD_MARGIN), with points inserted where it crosses any
   *  tile edge (kept by the simplifier), and s0 = distance along r at its first point. */
  function roadPiece(r, t) {
    const P = r.points, n = P.length;
    const x0 = t.x0 - ROAD_MARGIN, x1 = t.x0 + TS + ROAD_MARGIN, z0 = t.z0 - ROAD_MARGIN, z1 = t.z0 + TS + ROAD_MARGIN;
    let first = -1, last = -1;
    for (let i = 0; i + 1 < n; i++) {
      const ax = P[i][0], az = P[i][1], bx = P[i + 1][0], bz = P[i + 1][1];
      if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(az, bz) < z0 || Math.min(az, bz) > z1) continue;
      if (first < 0) first = i;
      last = i + 1;
    }
    if (first < 0) return null;
    const p0 = Math.max(0, first - 1), p1 = Math.min(n - 1, last + 1);
    let s0 = 0;
    for (let i = 1; i <= p0; i++) s0 += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const pts = [P[p0]], keep = [0];
    const cuts = [];
    for (let i = p0 + 1; i <= p1; i++) {
      const a = P[i - 1], b = P[i];
      cuts.length = 0;
      for (const ax of [0, 1]) {
        const u = a[ax], v = b[ax];
        if (u === v) continue;
        const g0 = Math.floor(Math.min(u, v) / TS) + 1, g1 = Math.ceil(Math.max(u, v) / TS) - 1;
        for (let g = g0; g <= g1; g++) {
          const tt = (g * TS - u) / (v - u);
          if (tt > 1e-6 && tt < 1 - 1e-6) cuts.push([tt, ax, g * TS]);
        }
      }
      cuts.sort((p, q) => p[0] - q[0]);
      let lastT = -1;
      for (const [tt, ax, val] of cuts) {
        if (tt - lastT < 1e-6) continue;
        lastT = tt;
        const q = [a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt];
        q[ax] = val;   // exactly on the edge
        pts.push(q); keep.push(1);
      }
      pts.push(b); keep.push(0);
    }
    return { ...r, points: pts, s0, keepPts: keep };
  }

  function tileTerrain(t, material) {
    const g = t.grid, n = g.nx, cell = g.cell, H = t.H;
    const nv = n * n + 4 * n;
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const idxs = [];
    let v = 0;
    const put = (i, j, dy) => {
      const x = t.x0 + i * cell, z = t.z0 + j * cell;
      const h0 = H[j * n + i];
      pos[v * 3] = x; pos[v * 3 + 1] = h0 - (sinkAt ? sinkAt(x, z, h0) : 0) - dy; pos[v * 3 + 2] = z;
      // central differences through the queries: across an edge they read the neighbour tile
      const hx = (Q.heightAt(x + cell, z) - Q.heightAt(x - cell, z)) / (2 * cell);
      const hz = (Q.heightAt(x, z + cell) - Q.heightAt(x, z - cell)) / (2 * cell);
      const l = Math.hypot(hx, 1, hz);
      nor[v * 3] = -hx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = -hz / l;
      uv[v * 2] = i / (n - 1); uv[v * 2 + 1] = j / (n - 1);
      return v++;
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(i, j, 0);
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const p00 = j * n + i, p10 = p00 + 1, p01 = p00 + n, p11 = p01 + 1;
        idxs.push(p00, p01, p10, p01, p11, p10);   // the split heightAt interpolates on
      }
    }
    const edge = (list) => {
      const sk = list.map(([, i, j]) => put(i, j, SKIRT));
      for (let k = 0; k < list.length - 1; k++) {
        const a = list[k][0], b = list[k + 1][0], c = sk[k], d = sk[k + 1];
        idxs.push(a, c, b, b, c, d, a, b, c, b, d, c);
      }
    };
    const r = [...Array(n).keys()];
    edge(r.map((i) => [i, i, 0]));
    edge(r.map((i) => [(n - 1) * n + i, i, n - 1]));
    edge(r.map((j) => [j * n, 0, j]));
    edge(r.map((j) => [j * n + n - 1, n - 1, j]));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, v * 2), 2));
    geo.setIndex(new THREE.Uint16BufferAttribute(idxs, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'ground-' + t.key;
    return mesh;
  }

  function buildNear(t) {
    const tex = paintGround(t);
    const material = terrainMaterial(tex, uniforms);
    const g = new THREE.Group();
    g.name = 'near-' + t.key;
    g.add(tileTerrain(t, material));
    const pieces = [];
    for (const k of roadsNear(t, ROAD_MARGIN)) {
      const p = roadPiece(D.roads[k], t);
      if (p) { p.index = k; pieces.push(p); }
    }
    const roads = buildRoads({ roads: pieces, junctions: D.junctions, grid: t.grid }, Q, {
      quality, uniforms, material: shared.roadMaterial, lights: shared.lights,
      clip: { x0: t.x0, z0: t.z0, x1: t.x0 + TS, z1: t.z0 + TS }, chunk: BIG, deckLamps: false,
    });
    g.add(roads.group);
    const trees = buildTrees(t, Q, { quality, uniforms, material: shared.treeMaterial, geos: shared.treeGeos });
    g.add(trees.group);
    group.add(g);
    return {
      group: g,
      update(camera) { roads.update(camera); trees.update(camera); },
      dispose() {
        group.remove(g);
        disposeGeometries(g);
        material.dispose();
        tex.dispose();
      },
      stats: { roads: roads.stats, trees: trees.stats },
    };
  }

  /** A near-mesh build as a job: step(deadline) runs pieces until done (true) or the deadline,
   *  always at least one. Tiles without a lidar patch build in one piece (buildNear). */
  function nearJob(t) {
    if (!(lidar && lidar.has(t.i, t.j))) {
      let result = null;
      return { step() { result = timed('near8', () => buildNear(t)); return true; }, get result() { return result; }, cancel() { if (result) result.dispose(); } };
    }
    const g = new THREE.Group();
    g.name = 'near-' + t.key;
    let tex = null, material = null, pm = null, roads = null, trees = null, alive = true, next = 0;
    const queue = [
      Object.assign(() => { tex = paintGround(t); material = terrainMaterial(tex, uniforms, { walls: true }); }, { label: 'paint' }),
      Object.assign(() => {
        pm = createPatchMesh(t, { lidar, roads: D.roads, base: Q.baseHeightAt, quality, groundMaterial: material, roadMaterial: shared.roadMaterial });
        g.add(pm.group);
        queue.splice(next, 0, ...pm.units);
      }, { label: 'setup' }),
      Object.assign(() => {
        // today's road meshes where no lidar ribbon is (roads.js skips what the patch draws), and lamps
        const pieces = [];
        for (const k of roadsNear(t, ROAD_MARGIN)) {
          const p = roadPiece(D.roads[k], t);
          if (p) { p.index = k; pieces.push(p); }
        }
        roads = buildRoads({ roads: pieces, junctions: D.junctions, grid: t.grid }, Q, {
          quality, uniforms, material: shared.roadMaterial, lights: shared.lights,
          clip: { x0: t.x0, z0: t.z0, x1: t.x0 + TS, z1: t.z0 + TS }, chunk: BIG, deckLamps: false,
        });
        g.add(roads.group);
      }, { label: 'roads' }),
      Object.assign(() => { trees = buildTrees(t, Q, { quality, uniforms, material: shared.treeMaterial, geos: shared.treeGeos }); g.add(trees.group); }, { label: 'trees' }),
    ];
    const dispose = () => {
      alive = false;
      group.remove(g);
      disposeGeometries(g);
      if (material) material.dispose();
      if (tex) tex.dispose();
    };
    const result = {
      group: g,
      update(camera) { roads.update(camera); trees.update(camera); },
      fine: (x, z) => pm.fine(x, z).map((u) => ({ d: u.d, due: u.due, cancel: u.cancel, run: () => { if (alive) timed('fine', u.run); } })),
      coarsen: (x, z) => pm.coarsen(x, z),
      dispose,
      stats: { get roads() { return roads.stats; }, get trees() { return trees.stats; }, get lidar() { return pm.stats; } },
    };
    return {
      step(deadline) {
        do { const u = queue[next++]; timed('lidar-' + (u.label || 'piece'), u); } while (next < queue.length && performance.now() < deadline);
        if (next < queue.length) return false;
        group.add(g);
        return true;
      },
      result,
      cancel: dispose,
    };
  }

  function buildBld(t) {
    const b = buildBuildings(t, Q, { quality, uniforms, material: shared.buildingMaterial, facadeTex: shared.facadeTex, chunk: BIG });
    group.add(b.group);
    return {
      group: b.group,
      update: b.update,
      dispose() { group.remove(b.group); disposeGeometries(b.group); },
      stats: b.stats,
    };
  }

  // ------------------------------------------------------------------ scheduling
  let lastX = Infinity, lastZ = Infinity, frame = 0, work = true;
  const fetchCand = [], buildCand = [], patchCand = [];

  function setNear(k, v) {
    near[k] = v;
    maskData[k] = v ? 255 : 0;
    maskTex.needsUpdate = true;
    if (v) meshed.add(k); else if (!bld[k]) meshed.delete(k);
  }
  function setBld(k, v) {
    bld[k] = v;
    if (v) meshed.add(k); else if (!near[k]) meshed.delete(k);
    if (onTileChange) onTileChange((k % TNI) + TI0, Math.floor(k / TNI) + TJ0, !!v);
  }

  /** Plan around (x, z): returns nothing; fills fetchCand / buildCand and drops what is out of range. */
  function plan(x, z) {
    fetchCand.length = 0; buildCand.length = 0; patchCand.length = 0;
    const now = performance.now();
    const rr = Math.ceil(dataDrop / TS) + 1;
    const ci = Math.floor(x / TS), cj = Math.floor(z / TS);
    for (let j = cj - rr; j <= cj + rr; j++) {
      for (let i = ci - rr; i <= ci + rr; i++) {
        if (!inGrid(i, j)) continue;
        const k = idx(i, j);
        const d = rectDist(x, z, i * TS, j * TS, TS);
        const t = Q.tileByIndex(i, j);
        if (covered(i, j) && !lidar.has(i, j) && !pFetching[k] && !pFailed[k] && now >= pRetryAt[k] && d <= pLoad) patchCand.push([d, i, j]);
        if (!t) {
          if (Q.tileExists(i, j) && !fetching[k] && now >= retryAt[k] && d <= dataLoad) fetchCand.push([d, i, j]);
          continue;
        }
        if (!near[k] && (d <= R.near || keep[k]) && neighboursReady(i, j) && patchesReady(i, j)) buildCand.push([keep[k] ? Math.min(d, R.near) : d, 0, k, t]);
        if (!bld[k] && d <= R.bld) buildCand.push([d + 1, 1, k, t]);
      }
    }
    // tiles that keep their near meshes, wherever the camera is
    for (const [i, j] of keepNear) {
      if (!inGrid(i, j)) continue;
      const k = idx(i, j), t = Q.tileByIndex(i, j);
      const d = rectDist(x, z, i * TS, j * TS, TS);
      if (t && !near[k] && d > dataDrop + TS && neighboursReady(i, j)) buildCand.push([R.near, 0, k, t]);
    }
    // pinned tiles anywhere (fetched after everything in range: the list is sorted by distance)
    for (const [i, j] of pinList) {
      const k = idx(i, j);
      if (Q.tileByIndex(i, j) || fetching[k] || now < retryAt[k]) continue;
      const d = rectDist(x, z, i * TS, j * TS, TS);
      if (d > dataLoad) fetchCand.push([d, i, j]);   // nearer ones were queued by the window scan
    }
    // pinned patches anywhere (corridor rivals), and patches out of range
    for (const [i, j] of pPinList) {
      const k = idx(i, j);
      if (lidar.has(i, j) || pFetching[k] || pFailed[k] || now < pRetryAt[k]) continue;
      const d = rectDist(x, z, i * TS, j * TS, TS);
      if (d > pLoad) patchCand.push([d, i, j]);
    }
    for (const k of pLoaded) {
      if (pPinned[k] || near[k] || jobs.has(k)) continue;
      const i = (k % TNI) + TI0, j = Math.floor(k / TNI) + TJ0;
      if (rectDist(x, z, i * TS, j * TS, TS) > pDrop) { lidar.remove(i, j); pLoaded.delete(k); }
    }
    // half-built near meshes whose tile went out of range
    for (const [k, job] of jobs) {
      const i = (k % TNI) + TI0, j = Math.floor(k / TNI) + TJ0;
      if (rectDist(x, z, i * TS, j * TS, TS) > R.near + HYST || !Q.tileByIndex(i, j)) { job.cancel(); jobs.delete(k); }
    }
    // finest ground levels due near the camera, and dropped where it has gone
    for (const k of meshed) {
      if (!near[k] || !near[k].fine) continue;
      near[k].coarsen(x, z);
      fineQ.push(...near[k].fine(x, z));
    }
    fineQ.sort((a, b) => a.d - b.d);
    // anything loaded or meshed outside the window (the camera jumped)
    for (const k of meshed) {
      const i = (k % TNI) + TI0, j = Math.floor(k / TNI) + TJ0;
      const d = rectDist(x, z, i * TS, j * TS, TS);
      if (near[k] && d > R.near + HYST && !keep[k]) { near[k].dispose(); setNear(k, null); }
      if (bld[k] && d > R.bld + HYST) { bld[k].dispose(); setBld(k, null); }
    }
    for (const k of loaded) {
      if (pinned[k] || near[k] || bld[k]) continue;
      const i = (k % TNI) + TI0, j = Math.floor(k / TNI) + TJ0;
      if (rectDist(x, z, i * TS, j * TS, TS) > dataDrop) setData(k, null);
    }
    fetchCand.sort((a, b) => a[0] - b[0]);
    buildCand.sort((a, b) => a[0] - b[0]);
    patchCand.sort((a, b) => a[0] - b[0]);
  }

  /**
   * Per frame: plan when the camera moved or work is pending, start fetches, and build meshes
   * nearest first within `budgetMs` (the tile under the camera and its neighbours are always
   * built at once, so a teleport never shows the coarse ground under the car).
   */
  function update(camera, budgetMs = 6) {
    const x = camera.position.x, z = camera.position.z;
    frame++;
    if (work || Math.hypot(x - lastX, z - lastZ) > 24 || frame % 30 === 0) {
      plan(x, z);
      lastX = x; lastZ = z;
    }
    for (const [, i, j] of fetchCand) {
      if (inflight >= MAX_FETCH) break;
      const k = idx(i, j);
      if (!fetching[k] && !Q.tileByIndex(i, j)) startFetch(i, j);
    }
    for (const [, i, j] of patchCand) {
      if (pInflight >= MAX_FETCH) break;
      if (!pFetching[idx(i, j)] && !lidar.has(i, j)) startPatchFetch(i, j);
    }
    const t0 = performance.now(), deadline = t0 + budgetMs;
    let built = 0;
    while (buildCand.length) {
      const [d, kind, k, t] = buildCand[0];
      const urgent = d < TS * 0.75;
      if (built > 0 && !urgent && performance.now() > deadline) break;
      if (Q.tileByIndex(t.i, t.j) !== t) { buildCand.shift(); continue; }   // dropped meanwhile
      if (kind === 0 && !near[k]) {
        let job = jobs.get(k);
        if (!job) jobs.set(k, (job = nearJob(t)));
        built++;
        if (!job.step(urgent ? Infinity : deadline)) break;   // out of time: the rest next frame
        jobs.delete(k);
        setNear(k, job.result);
      } else if (kind === 1 && !bld[k]) { setBld(k, timed('buildings', () => buildBld(t))); built++; }
      buildCand.shift();
    }
    while (fineQ.length && performance.now() < deadline) {
      const u = fineQ.shift();
      if (u.due(x, z)) u.run(); else u.cancel();   // the camera moved on since it was queued
    }
    work = buildCand.length > 0 || fetchCand.length > 0 || inflight > 0 || patchCand.length > 0 || pInflight > 0 || fineQ.length > 0;
    for (const k of meshed) {
      if (near[k]) near[k].update(camera);
      if (bld[k]) bld[k].update(camera);
    }
  }

  /** Build everything due around (x, z) right now (load screen). */
  function buildAll(x, z, onProgress) {
    plan(x, z);
    const n = buildCand.length;
    let done = 0;
    for (const [, kind, k, t] of buildCand) {
      if (kind === 0 && !near[k]) {
        const job = jobs.get(k) || nearJob(t);
        jobs.delete(k);
        job.step(Infinity);
        setNear(k, job.result);
      } else if (kind === 1 && !bld[k]) setBld(k, buildBld(t));
      if (onProgress) onProgress(++done / n);
    }
    buildCand.length = 0;
    for (const k of meshed) if (near[k] && near[k].fine) fineQ.push(...near[k].fine(x, z));
    while (fineQ.length) fineQ.shift().run();
    lastX = x; lastZ = z;
  }

  /** Tiles whose data a ring around (x, z) needs: [[i, j], ...] nearest first. */
  function tilesAround(x, z, radius) {
    const out = [];
    const rr = Math.ceil(radius / TS) + 1, ci = Math.floor(x / TS), cj = Math.floor(z / TS);
    for (let j = cj - rr; j <= cj + rr; j++) {
      for (let i = ci - rr; i <= ci + rr; i++) {
        if (!inGrid(i, j) || !Q.tileExists(i, j)) continue;
        const d = rectDist(x, z, i * TS, j * TS, TS);
        if (d <= radius) out.push([d, i, j]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]).map(([, i, j]) => [i, j]);
  }

  function dispose() {
    for (const job of jobs.values()) job.cancel();
    jobs.clear();
    for (const k of [...meshed]) {
      if (near[k]) { near[k].dispose(); setNear(k, null); }
      if (bld[k]) { bld[k].dispose(); setBld(k, null); }
    }
    parent.remove(group);
    maskTex.dispose();
  }

  function stats() {
    let n = 0, b = 0, farNear = 0, farBld = 0, farData = 0;
    const dist = (k) => rectDist(lastX, lastZ, ((k % TNI) + TI0) * TS, (Math.floor(k / TNI) + TJ0) * TS, TS);
    for (const k of meshed) {
      if (near[k]) { n++; farNear = Math.max(farNear, dist(k)); }
      if (bld[k]) { b++; farBld = Math.max(farBld, dist(k)); }
    }
    for (const k of loaded) if (!pinned[k]) farData = Math.max(farData, dist(k));
    return {
      dataTiles: loaded.size, nearTiles: n, buildingTiles: b, fetching: inflight, pinned: pinList.length,
      lidar: lidar ? { patches: pLoaded.size, pinned: pPinList.length, fetching: pInflight, building: jobs.size, fineDue: fineQ.length } : null,
      cost: Object.fromEntries(Object.entries(cost).map(([k, c]) => [k, { n: c.n, meanMs: Math.round((c.total / c.n) * 10) / 10, maxMs: Math.round(c.max * 10) / 10 }])),
      farthest: { near: Math.round(farNear), buildings: Math.round(farBld), unpinnedData: Math.round(farData) },
    };
  }

  return {
    group, update, preload, preloadPatches, buildAll, tilesAround, pin, pinPatch, dispose, stats,
    tileMask: { tex: maskTex, rect: maskRect }, radii: { ...R, dataLoad, dataDrop },
  };
}

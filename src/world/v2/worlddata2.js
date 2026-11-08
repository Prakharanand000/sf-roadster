// SF Roadster Rush - v2 world data: a global `net` plus 512 m tiles (tools/bake_v2.py), behind the
// same query API as worlddata.js (CONTRACTS.md "MAP agent"). No DOM; runs in Node for tests.
//
// - net: roads, graph, junctions, tracks, landmarks, lakes, the Golden Gate deck, coarse 16 m terrain,
//   8 m landcover and skyline buildings. Always loaded.
// - tiles: 8 m terrain, 4 m landcover, buildings and trees for one 512 m square. Registered with
//   addTile() when loaded, removed with removeTile(). Queries inside a loaded tile use its data;
//   elsewhere they fall back to the net (coarse terrain, no building walls), and never throw or
//   return NaN inside bounds.
// - Positions are the v2 transverse Mercator (x east, z = -north); heights have sea at y = 0.
import * as THREE from 'three';
import { buildLandmarkSolids, makeDeckProfile, ccw } from '../landmarkdefs.js';
import { LC } from '../worlddata.js';
import { createPilotQueries } from '../pilot.js';
import { createLidar, buildingsHash } from './lidar2.js';

const LC_SURFACE = ['water', 'sidewalk', 'grass', 'grass', 'sand', 'water', 'sidewalk', 'grass', 'grass', 'sidewalk', 'sidewalk'];
const TYPED = { int16: Int16Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array, uint8: Uint8Array, float32: Float32Array, int8: Int8Array };
const DEFAULT_ROOF = [100, 98, 96];

function arrAt(arrays, buffer, base, name, required = true) {
  const a = arrays[name];
  if (!a) {
    if (required) throw new Error('v2 world: missing array ' + name);
    return null;
  }
  return new TYPED[a.type](buffer, base + a.offset, a.length);
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

function startsFrom(counts) {
  const s = new Uint32Array(counts.length);
  let o = 0;
  for (let k = 0; k < counts.length; k++) { s[k] = o; o += counts[k]; }
  return s;
}

const EMPTY_B = { count: 0, xz: new Float32Array(0), start: new Uint32Array(0), n: new Uint8Array(0), gmin: new Float32Array(0), gmax: new Float32Array(0), top: new Float32Array(0), style: new Uint8Array(0), wall: new Uint8Array(0), roof: new Uint8Array(0) };

/** Decode net.json + net.bin.wasm into plain arrays (the v1 `D` shape where it makes sense). */
export function decodeNet(index, buffer) {
  const A = (n, req) => arrAt(index.arrays, buffer, 0, n, req);
  const g = index.grid, lc = index.landcover;
  const h16 = A('height16');
  const H = new Float32Array(h16.length);
  for (let i = 0; i < h16.length; i++) H[i] = h16[i] * 0.1;
  const landcover = unrle(A('landcover8_rle'), lc.nx * lc.nz);
  // roads (float32 world coordinates)
  const rxz = A('road_xz'), rstart = A('road_start'), rcount = A('road_count');
  const rwidth = A('road_width'), rtype = A('road_type'), rflags = A('road_flags'), rlanes = A('road_lanes'), rname = A('road_name');
  const F = index.road_flags;
  const roads = [];
  for (let i = 0; i < rstart.length; i++) {
    const pts = [];
    for (let k = 0; k < rcount[i]; k++) { const o = (rstart[i] + k) * 2; pts.push([rxz[o], rxz[o + 1]]); }
    const fl = rflags[i];
    roads.push({
      points: pts, width: rwidth[i] * 0.1, type: index.road_types[rtype[i]], name: index.names[rname[i]],
      oneway: !!(fl & F.oneway), lanes: rlanes[i], flags: fl,
      // on a deck (Golden Gate, Bay Bridge): drawn at groundHeight, no sidewalks or street lights
      bridge: !!(fl & (F.ggbridge | (F.baybridge || 0))), cableCar: !!(fl & F.cablecar), sidewalk: !!(fl & F.sidewalk),
    });
  }
  const gxz = A('graph_xz'), ge = A('graph_edges'), gl = A('graph_len'), gr = A('graph_road');
  const nodes = [];
  for (let i = 0; i < gxz.length; i += 2) nodes.push([gxz[i], gxz[i + 1]]);
  const edges = [];
  for (let i = 0; i < gl.length; i++) edges.push([ge[i * 2], ge[i * 2 + 1], Math.round(gl[i] * 10) / 10, gr[i]]);
  const jxz = A('junction_xz'), jr = A('junction_r');
  const junctions = { xz: Float32Array.from(jxz), r: new Float32Array(jr.length) };
  for (let i = 0; i < jr.length; i++) junctions.r[i] = jr[i] * 0.25;
  // skyline buildings (absolute coordinates)
  const sc = A('sky_count'), sgmin = A('sky_gmin'), stop = A('sky_top');
  const sroof = A('sky_roof', false), stile = A('sky_tile', false);
  const sky = {
    count: sc.length, xz: Float32Array.from(A('sky_xz')), n: sc, start: startsFrom(sc),
    gmin: Float32Array.from(sgmin, (v) => v * 0.1), top: Float32Array.from(stop, (v) => v * 0.1), style: A('sky_style'),
    wall: A('sky_wall'), roof: sroof || new Uint8Array(sc.length * 3).map((_, i) => DEFAULT_ROOF[i % 3]),
    tile: stile,   // [i, j] per building: the tile that stores it (absent in older bakes)
  };
  sky.gmax = sky.gmin;
  const manifest = A('tiles');
  // decks (tools/baybridge_v2.py): kind 0 = a bridge road at its deck height, kind 1 = a tunnel roof.
  // Optional deck_hlr gives each point's height at the left / right edge (roofs follow the hill).
  const decks = [];
  const dxzh = A('deck_xzh', false);
  if (dxzh) {
    const ds = A('deck_start'), dc = A('deck_count'), dhw = A('deck_hw'), dk = A('deck_kind'), dr = A('deck_road'), dlr = A('deck_hlr', false), dfl = A('deck_flags', false);
    for (let d = 0; d < ds.length; d++) {
      const n = dc[d], x = new Float32Array(n), z = new Float32Array(n), h = new Float32Array(n), hl = new Float32Array(n), hr = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = ds[d] + i;
        x[i] = dxzh[o * 3]; z[i] = dxzh[o * 3 + 1]; h[i] = dxzh[o * 3 + 2];
        hl[i] = dlr ? dlr[o * 2] : h[i]; hr[i] = dlr ? dlr[o * 2 + 1] : h[i];
      }
      // flags bit 0: on the ground (a road over a tunnel, a roof): nothing to hold up
      decks.push({ kind: dk[d], road: dr[d], hw: dhw[d] * 0.1, x, z, h, hl, hr, flags: dfl ? dfl[d] : 0 });
    }
  }
  // bridge railings and tunnel walls: quads with a base and top height
  const sxz = A('solid_xz', false);
  const bsolids = sxz ? { xz: sxz, base: A('solid_base'), top: A('solid_top'), hc: A('solid_hc', false) } : { xz: new Float32Array(0), base: new Float32Array(0), top: new Float32Array(0), hc: null };
  return {
    index, grid: g, H, lcInfo: lc, landcover, roads, graph: { nodes, edges }, junctions, sky, manifest, decks, bsolids,
    B: EMPTY_B, trees: { xz: new Float32Array(0), type: new Uint8Array(0), scale: new Uint8Array(0) },
  };
}

/** Decode one tile file: [u32 header length][header JSON][pad to 8][arrays]. */
export function decodeTile(buffer, tileSize = 512) {
  const dv = new DataView(buffer);
  const hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hl)));
  const base = 4 + hl + ((8 - ((4 + hl) % 8)) % 8);
  const A = (n, req = true) => arrAt(head.arrays, buffer, base, n, req);
  const x0 = head.x0, z0 = head.z0;
  const h8 = A('h8');
  const n8 = Math.round(Math.sqrt(h8.length));
  const H = Float32Array.from(h8, (v) => v * 0.1);
  const lc = A('lc');
  const nl = Math.round(Math.sqrt(lc.length));
  let B = EMPTY_B;
  const bxz = A('bld_xz', false);
  if (bxz) {
    const cnt = A('bld_count');
    const xz = new Float32Array(bxz.length);
    for (let i = 0; i < bxz.length; i += 2) { xz[i] = x0 + bxz[i] / 32; xz[i + 1] = z0 + bxz[i + 1] / 32; }
    B = {
      count: cnt.length, xz, n: cnt, start: startsFrom(cnt),
      gmin: Float32Array.from(A('bld_gmin'), (v) => v * 0.1), gmax: Float32Array.from(A('bld_gmax'), (v) => v * 0.1),
      top: Float32Array.from(A('bld_top'), (v) => v * 0.1), style: A('bld_style'), wall: A('bld_wall'), roof: A('bld_roof'),
      src: A('bld_src', false),   // height source: 0 guessed, 1 OSM height / levels, 2 lidar (older bakes: absent)
    };
  }
  let trees = { xz: new Float32Array(0), type: new Uint8Array(0), scale: new Uint8Array(0) };
  const txz = A('tree_xz', false);
  if (txz) {
    const xz = new Float32Array(txz.length);
    for (let i = 0; i < txz.length; i += 2) { xz[i] = x0 + txz[i] / 32; xz[i + 1] = z0 + txz[i + 1] / 32; }
    trees = { xz, type: A('tree_type'), scale: A('tree_scale') };
  }
  const cell = tileSize / (n8 - 1);
  return {
    key: head.i + ',' + head.j, i: head.i, j: head.j, x0, z0, size: tileSize,
    grid: { x0, z0, cell, nx: n8, nz: n8 }, H,
    lcInfo: { x0, z0, res: tileSize / nl, nx: nl, nz: nl }, landcover: lc, B, trees,
  };
}

/**
 * Query API over the net plus whichever tiles are registered.
 * `tiles`: decoded tiles to register before anything samples the ground (landmark solids do).
 * `loadSync(i, j)` -> decoded tile or null: load tiles on first touch (Node tests and tools), so
 * every query sees full data, as if all tiles were loaded.
 */
export function createQueries2(D, { tiles = [], loadSync = null } = {}) {
  const { grid, H, lcInfo } = D;
  const NX = grid.nx, NZ = grid.nz, CELL = grid.cell, GX0 = grid.x0, GZ0 = grid.z0, INV = 1 / CELL;
  const bounds = { ...D.index.bounds };
  const T = D.index.tiles;
  const TS = T.size, TI0 = T.i0, TJ0 = T.j0, TNI = T.ni, TNJ = T.nj;
  const tileArr = new Array(TNI * TNJ).fill(null);
  // tiles that exist on disk (the bake skips all-water tiles); loadSync is tried once per tile
  const inManifest = new Uint8Array(TNI * TNJ);
  for (let k = 0; k + 4 < D.manifest.length; k += 5) {
    const i = D.manifest[k] - TI0, j = D.manifest[k + 1] - TJ0;
    if (i >= 0 && j >= 0 && i < TNI && j < TNJ) inManifest[j * TNI + i] = 1;
  }
  const tried = loadSync ? new Uint8Array(TNI * TNJ) : null;
  function slot(i, j) {
    if (i < 0 || j < 0 || i >= TNI || j >= TNJ) return null;
    const k = j * TNI + i;
    if (tried && !tileArr[k] && !tried[k] && inManifest[k]) {
      tried[k] = 1;
      const t = loadSync(i + TI0, j + TJ0);
      if (t) addTile(t);
    }
    return tileArr[k];
  }
  const tileAt = (x, z) => slot(Math.floor(x / TS) - TI0, Math.floor(z / TS) - TJ0);

  function gridHeight(Hg, nx, nz, x0, z0, inv, x, z) {
    let fx = (x - x0) * inv, fz = (z - z0) * inv;
    if (fx < 0) fx = 0; else if (fx > nx - 1.0001) fx = nx - 1.0001;
    if (fz < 0) fz = 0; else if (fz > nz - 1.0001) fz = nz - 1.0001;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const o = iz * nx + ix;
    if (tx + tz <= 1) {
      const h00 = Hg[o];
      return h00 + (Hg[o + 1] - h00) * tx + (Hg[o + nx] - h00) * tz;
    }
    const h11 = Hg[o + nx + 1];
    return h11 + (Hg[o + nx] - h11) * (1 - tx) + (Hg[o + 1] - h11) * (1 - tz);
  }
  const coarseHeight = (x, z) => gridHeight(H, NX, NZ, GX0, GZ0, INV, x, z);

  /** Terrain: the tile's 8 m grid where loaded, else the net's 16 m one. */
  function baseHeight(x, z) {
    const t = tileAt(x, z);
    if (t) return gridHeight(t.H, t.grid.nx, t.grid.nz, t.x0, t.z0, 1 / t.grid.cell, x, z);
    return coarseHeight(x, z);
  }
  // measured ground and road ribbons, blended into baseHeight at their edge: the lidar tile patches
  // (lidar2.js, data/v2/lidar/) where they exist, else the lidar pilot overlay (pilot.js, data/v2/pilot.*)
  const LQ = D.lidar ? createLidar(D.lidar.index, baseHeight, { net: D.lidar.net, loadSync: D.lidar.loadSync }) : null;
  const PQ = LQ || (D.pilot ? createPilotQueries(D.pilot, baseHeight) : null);
  const heightAt = PQ ? PQ.heightAt : baseHeight;
  // buildings' ground ranges on the lidar (tools/lidar_bground.mjs), per tile: { offset, count, hash }
  const bground = D.lidar && D.lidar.bground ? D.lidar.bground : null;

  // ---- landcover: tile 4 m if loaded, else net 8 m
  const LX0 = lcInfo.x0, LZ0 = lcInfo.z0, LRES = lcInfo.res, LNX = lcInfo.nx, LNZ = lcInfo.nz;
  function landcoverAt(x, z) {
    const t = tileAt(x, z);
    if (t) {
      const li = t.lcInfo;
      let i = Math.floor((x - li.x0) / li.res), j = Math.floor((z - li.z0) / li.res);
      if (i < 0) i = 0; else if (i >= li.nx) i = li.nx - 1;
      if (j < 0) j = 0; else if (j >= li.nz) j = li.nz - 1;
      return t.landcover[j * li.nx + i];
    }
    let i = Math.floor((x - LX0) / LRES), j = Math.floor((z - LZ0) / LRES);
    if (i < 0) i = 0; else if (i >= LNX) i = LNX - 1;
    if (j < 0) j = 0; else if (j >= LNZ) j = LNZ - 1;
    return D.landcover[j * LNX + i];
  }
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

  // ---- solids: a CSR spatial hash per set (each loaded tile's buildings, plus the landmarks)
  const HC = 24;
  function makeSolids(B, lmSolids, ox, oz, w, h) {
    const nSol = B.count + lmSolids.length;
    let nV = B.xz.length / 2;
    for (const s of lmSolids) nV += s.poly.length;
    const S = {
      x: new Float32Array(nV), z: new Float32Array(nV), start: new Uint32Array(nSol), n: new Uint16Array(nSol),
      base: new Float32Array(nSol), top: new Float32Array(nSol), roof: new Uint8Array(nSol),
      minx: new Float32Array(nSol), maxx: new Float32Array(nSol), minz: new Float32Array(nSol), maxz: new Float32Array(nSol),
      count: nSol,
    };
    let vo = 0;
    const put = (k, xs, zs, n, base, top, roof) => {
      S.start[k] = vo; S.n[k] = n;
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = xs(i), z = zs(i);
        S.x[vo] = x; S.z[vo] = z; vo++;
        if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z;
      }
      S.minx[k] = a; S.maxx[k] = b; S.minz[k] = c; S.maxz[k] = d; S.base[k] = base; S.top[k] = top; S.roof[k] = roof;
    };
    for (let k = 0; k < B.count; k++) {
      const s = B.start[k];
      put(k, (i) => B.xz[(s + i) * 2], (i) => B.xz[(s + i) * 2 + 1], B.n[k], B.gmin[k] - 3, B.top[k], 1);
    }
    lmSolids.forEach((sd, j) => put(B.count + j, (i) => sd.poly[i][0], (i) => sd.poly[i][1], sd.poly.length, sd.base, sd.top, sd.roof ? 1 : 0));
    // hash over the set's own box (buildings may overhang their tile)
    let bx0 = ox, bz0 = oz, bx1 = ox + w, bz1 = oz + h;
    for (let k = 0; k < nSol; k++) {
      if (S.minx[k] < bx0) bx0 = S.minx[k]; if (S.maxx[k] > bx1) bx1 = S.maxx[k];
      if (S.minz[k] < bz0) bz0 = S.minz[k]; if (S.maxz[k] > bz1) bz1 = S.maxz[k];
    }
    const hnx = Math.max(1, Math.ceil((bx1 - bx0) / HC)), hnz = Math.max(1, Math.ceil((bz1 - bz0) / HC));
    const cellOf = (v, o, n) => { let c = Math.floor((v - o) / HC); return c < 0 ? 0 : c >= n ? n - 1 : c; };
    const cnt = new Uint32Array(hnx * hnz + 1);
    const each = (k, fn) => {
      const i0 = cellOf(S.minx[k], bx0, hnx), i1 = cellOf(S.maxx[k], bx0, hnx);
      const j0 = cellOf(S.minz[k], bz0, hnz), j1 = cellOf(S.maxz[k], bz0, hnz);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * hnx + i);
    };
    for (let k = 0; k < nSol; k++) each(k, (c) => cnt[c + 1]++);
    for (let i = 1; i < cnt.length; i++) cnt[i] += cnt[i - 1];
    const items = new Uint32Array(cnt[cnt.length - 1]);
    const fill = cnt.slice(0, hnx * hnz);
    for (let k = 0; k < nSol; k++) each(k, (c) => { items[fill[c]++] = k; });
    S.hash = { x0: bx0, z0: bz0, x1: bx1, z1: bz1, nx: hnx, nz: hnz, cnt, items, cellOf };
    S.stamp = new Uint32Array(nSol);
    return S;
  }
  for (const t of tiles) addTile(t);
  // landmark solids stand on the ground under them: initLandmarks() rebuilds them once the tiles
  // there are loaded (the browser loader calls it after its first tiles arrive)
  let lmSolids = [], lmS = null;
  // bridge railings and tunnel walls go in the same set (they never move)
  const bridgeSolids = [];
  const BS = D.bsolids || { xz: [], base: [], top: [] };
  for (let q = 0; q < BS.base.length; q++) {
    const poly = [];
    for (let v = 0; v < 4; v++) poly.push([BS.xz[q * 8 + v * 2], BS.xz[q * 8 + v * 2 + 1]]);
    bridgeSolids.push({ id: 'bridge', poly: ccw(poly), base: BS.base[q], top: BS.top[q], roof: false });
  }
  function initLandmarks() {
    lmSolids = buildLandmarkSolids(D.index, heightAt);
    lmS = makeSolids(EMPTY_B, lmSolids.concat(bridgeSolids), bounds.minX, bounds.minZ, bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  }
  initLandmarks();

  function pointInSolid(S, k, x, z) {
    if (x < S.minx[k] || x > S.maxx[k] || z < S.minz[k] || z > S.maxz[k]) return false;
    const s = S.start[k], n = S.n[k];
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = S.x[s + i], zi = S.z[s + i], xj = S.x[s + j], zj = S.z[s + j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---- Golden Gate deck (as v1)
  const deck = makeDeckProfile(D.index.ggbridge);
  const lr = [0, 0];
  const DB = deck.bbox;
  function ggDeckAt(x, z) {
    if (x < DB.minx || x > DB.maxx || z < DB.minz || z > DB.maxz) return NaN;
    const dx = x - deck.cx, dz = z - deck.cz;
    const t = dx * deck.ax + dz * deck.az;
    if (t < deck.tmin || t > deck.tmax) return NaN;
    const l = -dx * deck.az + dz * deck.ax;
    deck.lateralRange(t, lr);
    if (l < lr[0] || l > lr[1]) return NaN;
    let hp = deck.heightAtT(t);
    const de = Math.min(t - deck.tmin, deck.tmax - t);
    if (de < 50) {
      const u = de / 50, sm = u * u * (3 - 2 * u);
      let hg = heightAt(x, z);
      if (hg < hp - 0.6) hg = hp - 0.6; else if (hg > hp + 0.6) hg = hp + 0.6;
      hp = hg + (hp - hg) * sm;
    }
    return hp;
  }

  // ---- other decks (tools/baybridge_v2.py): each segment is a capsule of its half width; kind 0 is a
  // bridge road (a deck, like the Golden Gate's), kind 1 a tunnel roof (ground for cars above the
  // tunnel, invisible to cars in it). Both slope across to their edge heights (hl / hr): roofs follow
  // the hill, decks near the ground follow its cross-slope.
  // segment record: x0 z0 x1 z1 h0 h1 hw kind hl0 hl1 hr0 hr1 deck ends (1: first segment, 2: last)
  const DSN = 14, DC = 32, END_SLACK = 0.5;
  const dsegs = [];
  (D.decks || []).forEach((d, di) => {
    const n = d.x.length;
    for (let i = 0; i + 1 < n; i++) {
      dsegs.push(d.x[i], d.z[i], d.x[i + 1], d.z[i + 1], d.h[i], d.h[i + 1], d.hw, d.kind, d.hl[i], d.hl[i + 1], d.hr[i], d.hr[i + 1], di,
        (i === 0 ? 1 : 0) | (i + 2 === n ? 2 : 0));
    }
  });
  const dA = new Float32Array(dsegs), nDs = dsegs.length / DSN;
  const DX0 = bounds.minX - 2000, DZ0 = bounds.minZ - 2000;
  const DNX = Math.ceil((bounds.maxX - bounds.minX + 4000) / DC) + 1, DNZ = Math.ceil((bounds.maxZ - bounds.minZ + 4000) / DC) + 1;
  const dcellOf = (v, o, n) => { let c = Math.floor((v - o) / DC); return c < 0 ? 0 : c >= n ? n - 1 : c; };
  const dcnt = new Uint32Array(nDs ? DNX * DNZ + 1 : 1);
  const dCells = (k, fn) => {
    const o = k * DSN, m = dA[o + 6] + 1;
    const i0 = dcellOf(Math.min(dA[o], dA[o + 2]) - m, DX0, DNX), i1 = dcellOf(Math.max(dA[o], dA[o + 2]) + m, DX0, DNX);
    const j0 = dcellOf(Math.min(dA[o + 1], dA[o + 3]) - m, DZ0, DNZ), j1 = dcellOf(Math.max(dA[o + 1], dA[o + 3]) + m, DZ0, DNZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * DNX + i);
  };
  let ditems = new Uint32Array(0);
  if (nDs) {
    for (let k = 0; k < nDs; k++) dCells(k, (c) => dcnt[c + 1]++);
    for (let i = 1; i < dcnt.length; i++) dcnt[i] += dcnt[i - 1];
    ditems = new Uint32Array(dcnt[dcnt.length - 1]);
    const fill = dcnt.slice(0, DNX * DNZ);
    for (let k = 0; k < nDs; k++) dCells(k, (c) => { ditems[fill[c]++] = k; });
  }
  /** 0: not past a square end of this segment's deck; 2: just past it (where a rounded end would
   *  reach: the point is off the deck); 1: past it but farther (other segments decide). */
  function beyondEnd(o, x, z) {
    const ends = dA[o + 13];
    if (!ends) return 0;
    const ax = dA[o], az = dA[o + 1], vx = dA[o + 2] - ax, vz = dA[o + 3] - az;
    const L = Math.sqrt(vx * vx + vz * vz);
    if (L <= 0) return 0;
    const along = ((x - ax) * vx + (z - az) * vz) / L, lat = Math.abs(((x - ax) * vz - (z - az) * vx) / L), r = dA[o + 6] + 0.3;
    const past = (ends & 1) && along < -END_SLACK ? -along : (ends & 2) && along > L + END_SLACK ? along - L : 0;
    if (!past) return 0;
    return past < r && lat < r ? 2 : 1;
  }

  /** Highest deck of `kind` at (x, z) no higher than `lim`; NaN if none. Each deck counts with its
   *  nearest segment only: the rounded end of the next segment also covers the last metres of this
   *  one, and reading the next joint's height there would turn every climb into steps. A deck's own
   *  ends are square (END_SLACK m of play): a rounded end would reach ahead over the road or deck
   *  it joins, at its end height. A cell lists a deck's segments one after another (they are
   *  hashed in order), so decks come in runs. */
  function deckSurf(x, z, kind, lim) {
    if (!nDs) return NaN;
    const c = dcellOf(z, DZ0, DNZ) * DNX + dcellOf(x, DX0, DNX);
    let best = NaN, cur = -1, curD = Infinity, curH = NaN, curOut = false, curCap = false;
    // just past a square end, the deck counts only if a segment covers the point square-on (a bend)
    const commit = () => { if (cur >= 0 && curD < Infinity && !(curOut && curCap) && curH <= lim && !(curH <= best)) best = curH; };
    for (let p = dcnt[c], e = dcnt[c + 1]; p < e; p++) {
      const o = ditems[p] * DSN;
      if (dA[o + 7] !== kind) continue;
      const di = dA[o + 12];
      if (di !== cur) { commit(); cur = di; curD = Infinity; curOut = false; curCap = false; }
      const out = beyondEnd(o, x, z);
      if (out) { if (out === 2) curOut = true; continue; }
      const ax = dA[o], az = dA[o + 1], vx = dA[o + 2] - ax, vz = dA[o + 3] - az;
      const L2 = vx * vx + vz * vz;
      let t = L2 > 0 ? ((x - ax) * vx + (z - az) * vz) / L2 : 0;
      const cap = t < 0 || t > 1;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t, hw = dA[o + 6];
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 > (hw + 0.3) * (hw + 0.3)) continue;
      if (d2 >= curD) continue;
      curCap = cap;
      let h = dA[o + 4] + (dA[o + 5] - dA[o + 4]) * t;
      if (L2 > 0 && (dA[o + 8] !== dA[o + 4] || dA[o + 9] !== dA[o + 5] || dA[o + 10] !== dA[o + 4] || dA[o + 11] !== dA[o + 5])) {   // across: towards the edge heights
        const l = ((x - ax) * -vz + (z - az) * vx) / Math.sqrt(L2);
        const u = Math.min(1, Math.abs(l) / hw);
        const he = l > 0 ? dA[o + 10] + (dA[o + 11] - dA[o + 10]) * t : dA[o + 8] + (dA[o + 9] - dA[o + 8]) * t;
        h += (he - h) * u;
      }
      curD = d2; curH = h;
    }
    commit();
    return best;
  }
  /** Lowest road surface whose roadway contains (x, z): a ground road there (the terrain) or any
   *  bridge road's deck; NaN if none. For queries with no height reference (spawns, resets), where
   *  roads cross at different levels: a street under the Bay Bridge, a tunnel bore under a hill road. */
  function lowestRoadSurface(x, z) {
    let lo = onGroundRoad(x, z) ? heightAt(x, z) : NaN;
    if (!nDs) return lo;
    const c = dcellOf(z, DZ0, DNZ) * DNX + dcellOf(x, DX0, DNX);
    let cur = -1, curD = Infinity, curH = NaN, curHw = 0, curOut = false, curCap = false;
    const commit = () => { if (cur >= 0 && !(curOut && curCap) && curD <= curHw * curHw && !(curH >= lo)) lo = curH; };
    for (let p = dcnt[c], e = dcnt[c + 1]; p < e; p++) {
      const o = ditems[p] * DSN;
      if (dA[o + 7] !== 0) continue;
      const di = dA[o + 12];
      if (di !== cur) { commit(); cur = di; curD = Infinity; curOut = false; curCap = false; }
      const out = beyondEnd(o, x, z);
      if (out) { if (out === 2) curOut = true; continue; }
      const ax = dA[o], az = dA[o + 1], vx = dA[o + 2] - ax, vz = dA[o + 3] - az;
      const L2 = vx * vx + vz * vz;
      let t = L2 > 0 ? ((x - ax) * vx + (z - az) * vz) / L2 : 0;
      const cap = t < 0 || t > 1;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d2 = (x - ax - vx * t) ** 2 + (z - az - vz * t) ** 2;
      if (d2 >= curD) continue;
      curCap = cap;
      curD = d2; curHw = dA[o + 6]; curH = dA[o + 4] + (dA[o + 5] - dA[o + 4]) * t;
    }
    commit();
    return lo;
  }

  /** Height of road `ri`'s own deck at (x, z) (its nearest segment, square ends); NaN if the road
   *  has no deck or (x, z) is off it. Unambiguous where decks stack or cross: the road builder
   *  draws each bridge road with this. */
  const decksOfRoad = new Map();
  (D.decks || []).forEach((d, di) => { if (d.kind === 0 && d.road >= 0) decksOfRoad.set(d.road, (decksOfRoad.get(d.road) || []).concat(di)); });
  function roadDeckAt(ri, x, z) {
    const list = decksOfRoad.get(ri);
    if (!list) return NaN;
    let best = NaN, bd = Infinity;
    for (const di of list) {
      const d = D.decks[di];
      for (let i = 0; i + 1 < d.x.length; i++) {
        const ax = d.x[i], az = d.z[i], vx = d.x[i + 1] - ax, vz = d.z[i + 1] - az;
        const L2 = vx * vx + vz * vz;
        if (L2 <= 0) continue;
        let t = ((x - ax) * vx + (z - az) * vz) / L2;
        const L = Math.sqrt(L2);
        if ((i === 0 && t * L < -END_SLACK) || (i + 2 === d.x.length && (t - 1) * L > END_SLACK)) continue;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dd = (x - ax - vx * t) ** 2 + (z - az - vz * t) ** 2;
        if (dd > (d.hw + 0.3) * (d.hw + 0.3) || dd >= bd) continue;
        bd = dd;
        let h = d.h[i] + (d.h[i + 1] - d.h[i]) * t;
        const l = ((x - ax) * -vz + (z - az) * vx) / L, u = Math.min(1, Math.abs(l) / d.hw);
        const he = l > 0 ? d.hr[i] + (d.hr[i + 1] - d.hr[i]) * t : d.hl[i] + (d.hl[i + 1] - d.hl[i]) * t;
        best = h + (he - h) * u;
      }
    }
    return best;
  }

  /** Highest bridge deck (Golden Gate or any other) at (x, z); NaN if none. */
  function deckAt(x, z) {
    const a = ggDeckAt(x, z), b = deckSurf(x, z, 0, Infinity);
    return a === a ? (b === b && b > a ? b : a) : b;
  }

  let _kind = 0, _lim = 1e4;
  function surfaceHeight(x, z, yRef = 1e4) {
    let best = heightAt(x, z);
    _kind = 0;
    const lim = yRef + 0.75;
    _lim = lim;
    const dh = ggDeckAt(x, z);
    if (dh === dh && dh <= lim && dh > best) { best = dh; _kind = 2; }
    const bh = deckSurf(x, z, 0, lim);
    if (bh === bh && bh > best) { best = bh; _kind = 2; }
    const rh = deckSurf(x, z, 1, lim);
    if (rh === rh && rh > best) { best = rh; _kind = 3; }
    // no height reference (spawns, resets): where roads cross at different levels, the lowest road
    // here, under a deck or a tunnel roof (traffic spawned under the Bay Bridge stays on the
    // Embarcadero, in the YBI tunnel it stays in the bore)
    if (yRef >= 1e4 && (_kind === 2 || _kind === 3)) {
      const lo = lowestRoadSurface(x, z);
      if (lo === lo && lo < best - 4) { best = lo; _kind = Math.abs(lo - heightAt(x, z)) < 1e-6 ? 0 : 2; }
    }
    for (const S of solidSetsAt(x, z)) {
      const hs = S.hash;
      if (x < hs.x0 || x > hs.x1 || z < hs.z0 || z > hs.z1) continue;
      const c = hs.cellOf(z, hs.z0, hs.nz) * hs.nx + hs.cellOf(x, hs.x0, hs.nx);
      for (let p = hs.cnt[c], e = hs.cnt[c + 1]; p < e; p++) {
        const k = hs.items[p];
        if (!S.roof[k]) continue;
        const t = S.top[k];
        if (t <= best || t > lim) continue;
        if (pointInSolid(S, k, x, z)) { best = t; _kind = 1; }
      }
    }
    return best;
  }

  // solid sets near a point: landmarks + the tile there + its 8 neighbours (buildings overhang tiles)
  const _sets = [];
  function solidSetsAt(x, z) {
    _sets.length = 0;
    _sets.push(lmS);
    const ti = Math.floor(x / TS) - TI0, tj = Math.floor(z / TS) - TJ0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const t = slot(ti + di, tj + dj);
        if (t && t.solids) _sets.push(t.solids);
      }
    }
    return _sets;
  }

  /**
   * Terrain or bridge deck (never roofs). Where a deck crosses over a road (the Bay Bridge approaches
   * over SF streets and the Embarcadero, overpasses) the 2D answer is ambiguous, and the AI builds
   * each track's height profile from these calls (src/physics/ai.js), hopping any step-up. So when
   * the previous call was within GH_NEAR m, this stays on a deck that is within GH_REACH of that
   * call's height (a 6% deck changes 0.7 m in 12 m), and is on the ground otherwise: a road under a
   * deck stays on the road, a deck stays on the deck, and a ramp that starts at ground level is
   * followed up. With no recent call it is the top surface, as in v1.
   */
  const GH_NEAR = 12, GH_REACH = 1.0;
  let ghX = NaN, ghZ = NaN, ghY = NaN;
  function groundHeight(x, z) {
    const h = heightAt(x, z);
    let y;
    if (Math.abs(x - ghX) < GH_NEAR && Math.abs(z - ghZ) < GH_NEAR && Math.hypot(x - ghX, z - ghZ) < GH_NEAR) {
      const g = ggDeckAt(x, z), d = deckSurf(x, z, 0, ghY + GH_REACH);
      y = h;
      if (d === d && d >= ghY - GH_REACH && d > y) y = d;
      if (g === g && Math.abs(g - ghY) <= GH_REACH && g > y) y = g;
    } else {
      const dh = deckAt(x, z);
      y = dh === dh && dh > h ? dh : h;
    }
    ghX = x; ghZ = z; ghY = y;
    return y;
  }

  function normalAt(x, z, yRef = 1e4, out = new THREE.Vector3()) {
    surfaceHeight(x, z, yRef);
    if (_kind === 1) return out.set(0, 1, 0);
    if (_kind === 2 || _kind === 3) {
      // the deck under the car (yRef-limited, so a side-by-side or crossing deck is not picked up)
      const lim = _lim + 0.5, kind = _kind;
      const f = kind === 3 ? (a, b) => deckSurf(a, b, 1, lim) : (a, b) => {
        const g = ggDeckAt(a, b), d = deckSurf(a, b, 0, lim);
        return g === g && g <= lim ? (d === d && d > g ? d : g) : d;
      };
      const e = 1.0;
      const h0 = f(x, z);
      let hx = f(x + e, z), hz = f(x, z + e);
      if (!(hx === hx)) hx = h0 - (f(x - e, z) - h0);
      if (!(hz === hz)) hz = h0 - (f(x, z - e) - h0);
      const gx = hx === hx ? (hx - h0) / e : 0, gz = hz === hz ? (hz - h0) / e : 0;
      return out.set(-gx, 1, -gz).normalize();
    }
    const e = 1.5;
    const hx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const hz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    return out.set(-hx, 1, -hz).normalize();
  }

  // ---- global road segment hash for 'road' / 'sidewalk' (as v1, over the whole net)
  const RC = 32;
  const RX0 = bounds.minX - 2000, RZ0 = bounds.minZ - 2000;
  const RNX = Math.ceil((bounds.maxX - bounds.minX + 4000) / RC) + 1, RNZ = Math.ceil((bounds.maxZ - bounds.minZ + 4000) / RC) + 1;
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
    const i0 = rcellOf(Math.min(segA[o], segA[o + 2]) - m, RX0, RNX), i1 = rcellOf(Math.max(segA[o], segA[o + 2]) + m, RX0, RNX);
    const j0 = rcellOf(Math.min(segA[o + 1], segA[o + 3]) - m, RZ0, RNZ), j1 = rcellOf(Math.max(segA[o + 1], segA[o + 3]) + m, RZ0, RNZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * RNX + i);
  };
  for (let k = 0; k < nSeg; k++) segCells(k, (c) => rcnt[c + 1]++);
  for (let i = 1; i < rcnt.length; i++) rcnt[i] += rcnt[i - 1];
  const ritems = new Uint32Array(rcnt[rcnt.length - 1]);
  const rfill = rcnt.slice(0, RNX * RNZ);
  for (let k = 0; k < nSeg; k++) segCells(k, (c) => { ritems[rfill[c]++] = k; });

  /** Inside the roadway of a road that is not on a deck? */
  function onGroundRoad(x, z) {
    const c = rcellOf(z, RZ0, RNZ) * RNX + rcellOf(x, RX0, RNX);
    for (let p = rcnt[c], e = rcnt[c + 1]; p < e; p++) {
      const o = ritems[p] * SEGN;
      if (D.roads[segA[o + 6]].bridge) continue;
      const ax = segA[o], az = segA[o + 1], vx = segA[o + 2] - ax, vz = segA[o + 3] - az;
      const L2 = vx * vx + vz * vz;
      let t = L2 > 0 ? ((x - ax) * vx + (z - az) * vz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - ax - vx * t, dz = z - az - vz * t, hw = segA[o + 4];
      if (dx * dx + dz * dz <= hw * hw) return true;
    }
    return false;
  }

  const roadHit = { road: -1, dist: 0, halfWidth: 0 };
  function roadAt(x, z) {
    const c = rcellOf(z, RZ0, RNZ) * RNX + rcellOf(x, RX0, RNX);
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
    if (landcoverAt(x, z) === LC.LAKE) {
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
    if (_kind === 3) return LC_SURFACE[landcoverAt(x, z)] || 'grass';   // the hill over a tunnel
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

  let stampId = 1;
  const tmpN = { nx: 0, nz: 0, depth: 0 };
  function collideCircle(x, z, r, y, out) {
    stampId = (stampId + 1) >>> 0;
    if (stampId === 0) stampId = 1;
    let best = 0, found = false;
    // a solid counts if its top is above the car's step-up height and its base below its roof line
    const yStep = y + 0.75, yHead = y + 3.0;
    for (const S of solidSetsAt(x, z)) {
      const hs = S.hash;
      if (x + r < hs.x0 || x - r > hs.x1 || z + r < hs.z0 || z - r > hs.z1) continue;
      const i0 = hs.cellOf(x - r, hs.x0, hs.nx), i1 = hs.cellOf(x + r, hs.x0, hs.nx);
      const j0 = hs.cellOf(z - r, hs.z0, hs.nz), j1 = hs.cellOf(z + r, hs.z0, hs.nz);
      for (let cj = j0; cj <= j1; cj++) {
        for (let ci = i0; ci <= i1; ci++) {
          const c = cj * hs.nx + ci;
          for (let p = hs.cnt[c], e = hs.cnt[c + 1]; p < e; p++) {
            const k = hs.items[p];
            if (S.stamp[k] === stampId) continue;
            S.stamp[k] = stampId;
            if (S.top[k] <= yStep || S.base[k] > yHead) continue;
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
    }
    if (!found) return null;
    const o = out || {};
    o.nx = tmpN.nx; o.nz = tmpN.nz; o.depth = tmpN.depth;
    return o;
  }

  /** Register a decoded tile (see decodeTile). */
  function addTile(t) {
    const i = t.i - TI0, j = t.j - TJ0;
    if (i < 0 || j < 0 || i >= TNI || j >= TNJ) return;
    tileArr[j * TNI + i] = t;
    if (LQ && bground && !t.regrounded) {
      // buildings near lidar coverage stand on the lidar ground: their ground range was measured at
      // bake time (the patch may load later than the tile), and applies if the footprints still match
      const e = bground.tiles.get(t.key);
      if (e && e.count === t.B.count && e.hash === buildingsHash(t.B)) {
        for (let k = 0; k < t.B.count; k++) {
          const lo = bground.data[(e.offset + k) * 2], hi = bground.data[(e.offset + k) * 2 + 1];
          if (lo === lo) { t.B.gmin[k] = lo; t.B.gmax[k] = hi; }
        }
      }
      t.regrounded = true;
    } else if (PQ && !LQ && !t.regrounded) {
      // buildings in the pilot box stand on the lidar ground: re-measure their ground range there
      // (as worlddata.js). The tile is registered first so heightAt reads its own grid.
      const B = t.B, b = PQ.bbox;
      if (t.x0 < b.x1 && t.x0 + t.size > b.x0 && t.z0 < b.z1 && t.z0 + t.size > b.z0) {
        for (let k = 0; k < B.count; k++) {
          const s0 = B.start[k], n = B.n[k];
          let lo = Infinity, hi = -Infinity, any = false;
          for (let v = 0; v < n; v++) {
            const x = B.xz[(s0 + v) * 2], z = B.xz[(s0 + v) * 2 + 1];
            if (PQ.contains(x, z)) any = true;
            const hv = heightAt(x, z);
            if (hv < lo) lo = hv; if (hv > hi) hi = hv;
          }
          if (any) { B.gmin[k] = lo; B.gmax[k] = hi; }
        }
      }
      t.regrounded = true;
    }
    t.solids = t.B.count ? makeSolids(t.B, [], t.x0, t.z0, t.size, t.size) : null;
  }
  function removeTile(ti, tj) {
    const i = ti - TI0, j = tj - TJ0;
    if (i < 0 || j < 0 || i >= TNI || j >= TNJ) return;
    tileArr[j * TNI + i] = null;
  }
  function isLoaded(x, z) { return !!tileAt(x, z); }
  /** Tile by global index (no loading), and whether the bake wrote that tile at all. */
  function tileByIndex(ti, tj) {
    const i = ti - TI0, j = tj - TJ0;
    return i < 0 || j < 0 || i >= TNI || j >= TNJ ? null : tileArr[j * TNI + i];
  }
  function tileExists(ti, tj) {
    const i = ti - TI0, j = tj - TJ0;
    return i >= 0 && j >= 0 && i < TNI && j < TNJ && inManifest[j * TNI + i] === 1;
  }

  return {
    bounds, heightAt, surfaceHeight, groundHeight, normalAt, surfaceAt, isWater, collideCircle,
    landcoverAt, roadAt, roadHit, deckAt, deck, deckSurf, roadDeckAt, lakes, get landmarkSolids() { return lmSolids; }, initLandmarks,
    addTile, removeTile, tileAt, tileByIndex, tileExists, isLoaded, coarseHeight, baseHeightAt: baseHeight, pilot: PQ, lidar: LQ,
    tiles: { size: TS, i0: TI0, j0: TJ0, ni: TNI, nj: TNJ },
  };
}

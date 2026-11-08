// SF Roadster Rush - v2 lidar tile patches (spike, tools/research/lidar-tiles-plan.md): the lidar
// pilot's 2 m ground and measured road ribbons as one patch per 512 m tile, all cut from one bake
// (tools/spike_lidar_tiles.py), so neighbouring patches agree exactly where they meet:
// - grids share their edge nodes (the same raw values and hBase in both files);
// - a ribbon segment is in every patch its quad touches, with the island run's station normals;
// - the blend into the 8 m ground runs only along the outer edge of coverage (`cover`), from the
//   distance to the nearest of the tile's 8 neighbours that is not covered. It depends only on
//   position, so it is the same in every patch. For a rectangle of tiles it is the pilot's box rule.
// A point is answered by its own tile's patch alone, so answers don't depend on which neighbours
// happen to be loaded.
import { decodePilot, createPilotQueries } from '../pilot.js';

// a tile's number as a map key (tile indices stay well inside +-4096): no string per lookup, as the
// road and query code asks per point
const key = (i, j) => (i + 4096) * 8192 + (j + 4096);
// edgeDist's neighbours, in the order it tests them, as bits of a tile's `open` mask
const NBR = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Per-road boxes of the net's roads (for tileHash). */
export function roadBoxes(roadXZ, start, count) {
  const n = start.length, lo = new Float32Array(n * 2), hi = new Float32Array(n * 2);
  for (let r = 0; r < n; r++) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let k = start[r], e = start[r] + count[r]; k < e; k++) {
      const x = roadXZ[k * 2], z = roadXZ[k * 2 + 1];
      if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z;
    }
    lo[r * 2] = a; lo[r * 2 + 1] = b; hi[r * 2] = c; hi[r * 2 + 1] = d;
  }
  return { roadXZ, start, count, lo, hi };
}

/** FNV-1a (32 bit) over uint16 words: for each net road meeting tile (i, j) +- pad, in index order,
 *  its index (two words, low first), then its float32 coordinates read as uint16
 *  (tools/spike_lidar_tiles.py tile_hash writes the same into each patch). */
export function tileHash(R, i, j, size = 512, pad = 32) {
  const x0 = i * size - pad, z0 = j * size - pad, x1 = (i + 1) * size + pad, z1 = (j + 1) * size + pad;
  const w = new Uint16Array(R.roadXZ.buffer, R.roadXZ.byteOffset, R.roadXZ.length * 2);
  let h = 0x811c9dc5;
  for (let r = 0; r < R.start.length; r++) {
    if (R.hi[r * 2] < x0 || R.lo[r * 2] > x1 || R.hi[r * 2 + 1] < z0 || R.lo[r * 2 + 1] > z1) continue;
    h = Math.imul(h ^ (r & 0xffff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (r >>> 16), 0x01000193) >>> 0;
    for (let k = R.start[r] * 4, e = (R.start[r] + R.count[r]) * 4; k < e; k++) h = Math.imul(h ^ w[k], 0x01000193) >>> 0;
  }
  return h;
}

/** FNV-1a (32 bit) over a decoded tile's building footprints (B.xz as uint16 words): the building
 *  ground heights tools/lidar_bground.mjs bakes for a tile apply only to the buildings they were
 *  measured for. */
export function buildingsHash(B) {
  const w = new Uint16Array(B.xz.buffer, B.xz.byteOffset, B.xz.length * 2);
  let h = 0x811c9dc5;
  for (let k = 0; k < w.length; k++) h = Math.imul(h ^ w[k], 0x01000193) >>> 0;
  return h;
}

/** The patches of one coverage. `cover`: [[i, j], ...] tiles with lidar; `baseHeight`: the 8 m ground. */
export function createPatchSet(cover, feather, baseHeight, size = 512) {
  const covered = new Set(cover.map(([i, j]) => key(i, j)));
  // per covered tile: which of its 8 neighbours are outside the coverage (fixed for the set)
  const open = new Map();
  for (const [i, j] of cover) {
    let m = 0;
    NBR.forEach(([di, dj], b) => { if (!covered.has(key(i + di, j + dj))) m |= 1 << b; });
    open.set(key(i, j), m);
  }
  const patches = new Map();
  const F = feather;

  function add(index, buffer) {
    const P = decodePilot(index, buffer);
    const PQ = createPilotQueries(P, baseHeight);
    patches.set(key(index.tile[0], index.tile[1]), { P, PQ });
    return { P, PQ };
  }
  function remove(i, j) { patches.delete(key(i, j)); }
  const patchAt = (x, z) => patches.get(key(Math.floor(x / size), Math.floor(z / size)));

  /** distance to the outside of the coverage (Infinity if none of the 8 neighbours is outside), -1 outside it */
  function edgeDist(x, z) {
    const i = Math.floor(x / size), j = Math.floor(z / size);
    const m = open.get(key(i, j));
    if (m === undefined) return -1;
    if (m === 0) return Infinity;
    const L = x - i * size, R = (i + 1) * size - x, T = z - j * size, B = (j + 1) * size - z;
    let d = Infinity;
    if (m & 1) d = Math.min(d, L);
    if (m & 2) d = Math.min(d, R);
    if (m & 4) d = Math.min(d, T);
    if (m & 8) d = Math.min(d, B);
    if (m & 16) d = Math.min(d, Math.hypot(L, T));
    if (m & 32) d = Math.min(d, Math.hypot(R, T));
    if (m & 64) d = Math.min(d, Math.hypot(L, B));
    if (m & 128) d = Math.min(d, Math.hypot(R, B));
    return d;
  }

  /** 0..1: 0 at the edge of coverage, 1 deeper than `feather` inside (pilot.js featherAt's ramp) */
  function featherAt(x, z) {
    const e = edgeDist(x, z);
    if (e >= F) return 1;
    if (e <= 0) return 0;
    const u = e / F;
    return u * u * (3 - 2 * u);
  }

  function heightAt(x, z) {
    const t = patchAt(x, z);
    if (!t || !(edgeDist(x, z) > 0)) return baseHeight(x, z);
    let v = t.PQ.ribbonAt(x, z);
    if (v !== v) v = t.PQ.gridHeight(x, z);
    const f = featherAt(x, z);
    if (f < 1) { const b = baseHeight(x, z); v = b + (v - b) * f; }
    return v;
  }

  function ribbonAt(x, z) {
    const t = patchAt(x, z);
    return t && edgeDist(x, z) > 0 ? t.PQ.ribbonAt(x, z) : NaN;
  }

  /** 0 = no ribbon here, 1 = roadway (or a curbless shoulder), 2 = curb or sidewalk (pilot.js surfaceKind) */
  function surfaceKind(x, z) {
    const t = patchAt(x, z);
    if (!t || !(edgeDist(x, z) > 0)) return 0;
    const v = t.PQ.ribbonAt(x, z);
    if (v !== v) return 0;
    const hit = t.PQ.hit;
    if (hit.band === 2 || hit.band === 3) return 1;
    const fl = t.P.runs.flags[t.P.runOf[hit.i]];
    return (hit.band < 2 ? fl & 2 : fl & 1) ? 2 : 1;
  }

  return { add, remove, patches, patch: (i, j) => patches.get(key(i, j)), patchAt, edgeDist, featherAt, heightAt, ribbonAt, surfaceKind };
}

/** A packed patch file (tools/bake_lidar_tiles.py: uint32 header length, JSON header, padding to 8
 *  bytes, arrays) -> { head, index, buffer }: `index` is the header with array offsets counted from
 *  the start of the buffer, as decodePilot reads them. */
export function parsePatchFile(buffer) {
  const hl = new DataView(buffer).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hl)));
  const base = 4 + hl + ((8 - ((4 + hl) % 8)) % 8);
  const arrays = {};
  for (const [k, a] of Object.entries(head.arrays)) arrays[k] = { ...a, offset: a.offset + base };
  return { head, index: { ...head, arrays }, buffer };
}

/**
 * The lidar tile patches of data/v2/lidar/ (index.json + one file per covered tile), behind the API
 * the pilot overlay offers (contains, heightAt, ribbonAt, surfaceKind, toSidewalk, coversRoad,
 * featherAt), so roads.js and the queries use either.
 * - `baseHeight`: the 8 m ground, used outside coverage, where a covered tile's patch isn't loaded,
 *   and in the blend at the edge of coverage.
 * - `net`: { xz, start, count } of the net's roads: a patch whose fingerprint doesn't match this net
 *   is refused, and its tile keeps the 8 m ground (coverage is fixed for the session).
 * - `loadSync(i, j)` -> ArrayBuffer | null: load a patch on first touch (Node), so every query sees
 *   all of them. In the browser the tile streamer adds and removes patches instead.
 */
export function createLidar(index, baseHeight, { net = null, loadSync = null } = {}) {
  const TS = index.tile;
  const R = net ? roadBoxes(net.xz, net.start, net.count) : null;
  const want = new Map(), refused = [], cover = [];
  for (const [i, j, h] of index.cover) {
    if (R && tileHash(R, i, j, TS) !== h) refused.push([i, j]);
    else { want.set(key(i, j), h); cover.push([i, j]); }
  }
  const set = createPatchSet(cover, index.feather, baseHeight, TS);
  const runS0 = new Map();
  const roadsCovered = new Set(index.coveredRoads || []);
  const tried = new Set();

  const isCovered = (i, j) => want.has(key(i, j));
  const has = (i, j) => set.patches.has(key(i, j));

  /** Register a patch file; false (and nothing changes) when it isn't the tile's current patch. */
  function add(buffer) {
    const { head, index: pi } = parsePatchFile(buffer);
    const [i, j] = head.tile;
    if (want.get(key(i, j)) !== head.tileHash) return false;
    const { P } = set.add(pi, buffer);
    const a = pi.arrays.run_s0;
    runS0.set(key(i, j), a ? new Float32Array(buffer, a.offset, a.length) : new Float32Array(P.runs.start.length));
    return true;
  }
  function remove(i, j) { set.remove(i, j); runS0.delete(key(i, j)); }
  function ensure(x, z) {
    if (!loadSync) return;
    const i = Math.floor(x / TS), j = Math.floor(z / TS), k = key(i, j);
    if (!want.has(k) || set.patches.has(k) || tried.has(k)) return;
    tried.add(k);
    const b = loadSync(i, j);
    if (b && !add(b)) console.warn(`lidar patch ${k} refused (not the one index.json lists)`);
  }

  function heightAt(x, z) { ensure(x, z); return set.heightAt(x, z); }
  function ribbonAt(x, z) { ensure(x, z); return set.ribbonAt(x, z); }
  function surfaceKind(x, z) { ensure(x, z); return set.surfaceKind(x, z); }
  /** inside coverage, with the tile's patch loaded */
  function contains(x, z) { ensure(x, z); return !!set.patchAt(x, z) && set.edgeDist(x, z) > 0; }
  function toSidewalk(x, z, out) {
    ensure(x, z);
    const t = set.patchAt(x, z);
    return t && set.edgeDist(x, z) > 0 ? t.PQ.toSidewalk(x, z, out) : null;
  }
  function coversRoad(ri) { return roadsCovered.has(ri); }

  /** Height at global 2 m node (gi, gj) as a patch mesh draws it: the patch grid blended into the
   *  8 m ground by the coverage feather; the 8 m ground where no patch holds the node. A node on a
   *  tile edge reads the same in both tiles (shared edge nodes). */
  function nodeHeight(gi, gj, cell = 2) {
    const x = gi * cell, z = gj * cell;
    const i = Math.floor(x / TS), j = Math.floor(z / TS);
    const t = set.patches.get(key(i, j));
    if (!t) return baseHeight(x, z);
    const g = t.P.grid, G = t.P.G;
    const li = Math.round((x - g.x0) / g.cell), lj = Math.round((z - g.z0) / g.cell);
    const v = G[lj * g.nx + li];
    const f = set.featherAt(x, z);
    if (f < 1) { const b = baseHeight(x, z); return b + (v - b) * f; }
    return v;
  }

  return {
    lidar: true, index, cover, refused, isCovered, has, add, remove, patch: set.patch,
    runS0: (i, j) => runS0.get(key(i, j)), edgeDist: set.edgeDist, featherAt: set.featherAt, nodeHeight,
    contains, heightAt, ribbonAt, surfaceKind, toSidewalk, coversRoad,
    get loaded() { return set.patches.size; },
    get segments() { let n = 0; for (const t of set.patches.values()) n += t.PQ.segments; return n; },
  };
}

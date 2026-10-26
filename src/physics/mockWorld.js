// Mock World for physics development and headless tests (PHYSICS agent).
// Implements the World API from CONTRACTS.md (heightAt, surfaceHeight, normalAt,
// surfaceAt, isWater, collideCircle, bounds, roads, tracks, spawn) with:
//   - rolling hills everywhere (+-8 m)
//   - a flat asphalt "plaza" (r < 250 m around the origin, y = 4) for handling tests,
//     with a few box buildings, a 4 m and a 2.5 m flat roof to hop onto, a 0.5 m thin
//     wall and a thick block for tunnelling tests
//   - "Mock Filbert": a steep SF-style street along z at x = -850, 15 % blocks with flat
//     intersections every 140 m (sharp crests -> jumps), 72 m summit plateau
//   - a 3.4 km flat runway at z = 1500 for top-speed runs
//   - a ring road (r = 420 m) and a twisty circuit around (800, -900), both as tracks
//   - a small downtown grid with blocks of buildings between the ring and the runway
//   - the bay: x > 1300 drops below water level, sand shoreline; a bridge deck at z = 0
// Not shipped to players; the real world is src/world/city.js (MAP agent).
import * as THREE from 'three';

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth01 = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

export const MOCK = {
  PLAZA_R: 250, PLAZA_H: 4,
  RUNWAY_Z: 1500, RUNWAY_H: 3, RUNWAY_X0: -1900, RUNWAY_X1: 1200,
  HILL_X: -850, HILL_Z0: -700, HILL_BLOCK: 140, HILL_FLAT: 20,
  HILL_H: [0, 18, 36, 54, 72, 72, 54, 36, 18, 0],
  RING_R: 420,
  TWISTY_C: [800, -900],
  SHORE_X: 1250,
};

function baseTerrain(x, z) {
  return 6 + 5 * Math.sin(x / 170) * Math.cos(z / 210) + 2.5 * Math.sin((x + z) / 90 + 1.3);
}

function hillRaw(z) {
  const u0 = z - MOCK.HILL_Z0;
  if (u0 <= 0) return 0;
  const k = Math.floor(u0 / MOCK.HILL_BLOCK);
  const H = MOCK.HILL_H;
  if (k >= H.length - 1) return 0;
  const u = u0 - k * MOCK.HILL_BLOCK;
  const h0 = H[k], h1 = H[k + 1];
  if (u < MOCK.HILL_FLAT) return h0;
  return h0 + (h1 - h0) * (u - MOCK.HILL_FLAT) / (MOCK.HILL_BLOCK - MOCK.HILL_FLAT);
}
// 6 m box-filtered piecewise-linear profile -> crests rounded over ~6 m (sharp enough to jump)
function hillProfile(z) {
  return (hillRaw(z - 3) + hillRaw(z - 1.5) + hillRaw(z) + hillRaw(z + 1.5) + hillRaw(z + 3)) / 5;
}

function terrain(x, z) {
  let h = baseTerrain(x, z);
  // steep street band
  const dxh = Math.abs(x - MOCK.HILL_X);
  if (dxh < 140) {
    const w = 1 - smooth01((dxh - 45) / 80);
    if (w > 0) h = lerp(h, 6 + hillProfile(z), w);
  }
  // plaza
  const r = Math.hypot(x, z);
  if (r < MOCK.PLAZA_R + 90) h = lerp(h, MOCK.PLAZA_H, 1 - smooth01((r - MOCK.PLAZA_R) / 80));
  // runway
  const dzr = Math.abs(z - MOCK.RUNWAY_Z);
  if (dzr < 120 && x > MOCK.RUNWAY_X0 - 100 && x < MOCK.RUNWAY_X1 + 60) {
    const wx = 1 - smooth01((x - MOCK.RUNWAY_X1) / 50) - smooth01((MOCK.RUNWAY_X0 - x) / 80);
    h = lerp(h, MOCK.RUNWAY_H, clamp01(wx) * (1 - smooth01((dzr - 40) / 60)));
  }
  // bay
  if (x > MOCK.SHORE_X) h = lerp(h, -6, smooth01((x - MOCK.SHORE_X) / 160));
  return h;
}

function circlePath(cx, cz, R, step) {
  const n = Math.max(12, Math.round((2 * Math.PI * R) / step));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + R * Math.cos(t), cz + R * Math.sin(t)]);
  }
  return pts;
}

function resample(pts, step, loop) {
  // resample polyline to ~step spacing
  const out = [];
  const N = pts.length;
  const segs = loop ? N : N - 1;
  let carry = 0;
  out.push(pts[0].slice());
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = step - carry;
    while (d <= L) {
      const t = d / L;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += step;
    }
    carry = L - (d - step);
  }
  if (loop) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < step * 0.5) out.pop();
  } else {
    const l = pts[N - 1];
    const o = out[out.length - 1];
    if (Math.hypot(o[0] - l[0], o[1] - l[1]) > 0.5) out.push(l.slice());
  }
  return out;
}

function twistyPath() {
  const [cx, cz] = MOCK.TWISTY_C;
  const raw = [];
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = 200 + 55 * Math.sin(3 * t) + 28 * Math.sin(5 * t + 0.7) + 9 * Math.sin(7 * t + 1.1);
    raw.push([cx + r * Math.cos(t), cz + r * Math.sin(t)]);
  }
  return resample(raw, 8, true);
}

function pathLength(path, loop) {
  let L = 0;
  for (let i = 0; i < path.length - (loop ? 0 : 1); i++) {
    const a = path[i], b = path[(i + 1) % path.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

function makeTrack(id, name, path, loop, laps, width, difficulty) {
  const L = pathLength(path, loop);
  const hd = (i) => {
    const a = path[i], b = path[(i + 1) % path.length];
    return Math.atan2(b[0] - a[0], b[1] - a[1]);
  };
  const checkpoints = [];
  const every = 25; // ~200 m
  for (let i = every; i < path.length; i += every) checkpoints.push({ x: path[i][0], z: path[i][1], heading: hd(i), width });
  checkpoints.push({ x: path[0][0], z: path[0][1], heading: hd(0), width }); // finish line = start
  // grid: 6 slots behind the start line, 2 columns
  const grid = [];
  const n = path.length;
  for (let k = 0; k < 6; k++) {
    const back = 2 + Math.floor(k / 2) * 1; // points behind (8 m each)
    const i = (n - back) % n;
    const h = hd(i);
    const side = (k % 2 === 0 ? 1 : -1) * 3; // left = +x local
    const lx = Math.cos(h), lz = -Math.sin(h); // left vector (fz, -fx)
    grid.push({ x: path[i][0] + lx * side, z: path[i][1] + lz * side, heading: h });
  }
  return { id, name, area: 'Mock', description: 'physics mock track', laps, loop, path, checkpoints, grid, lengthMeters: L, difficulty, width };
}

export function createMockWorld() {
  const buildings = [];
  const P = MOCK.PLAZA_H;
  const addB = (minX, maxX, minZ, maxZ, top, name) => buildings.push({ minX, maxX, minZ, maxZ, top, name });
  // plaza test props
  addB(60, 90, -15, 15, P + 4, 'lowRoof4m');
  addB(60, 90, 40, 70, P + 2.5, 'lowRoof2.5m');
  addB(-120, -60, 80, 140, 50, 'tower');
  addB(-150.5, -150, -60, 60, 30, 'thinWall');
  addB(150, 190, -100, -40, 30, 'thickBlock');
  addB(-40, 0, -200, -170, 22, 'plazaBlock');
  // hill street side buildings (flat tops above the local max terrain)
  for (let k = 0; k < 10; k++) {
    const z0 = MOCK.HILL_Z0 + k * MOCK.HILL_BLOCK + 28, z1 = z0 + 100;
    let mx = 0;
    for (let z = z0; z <= z1; z += 5) mx = Math.max(mx, 6 + hillProfile(z));
    addB(MOCK.HILL_X + 20, MOCK.HILL_X + 45, z0, z1, mx + 10 + (k % 3) * 4, 'hill');
    addB(MOCK.HILL_X - 45, MOCK.HILL_X - 20, z0, z1, mx + 8 + (k % 2) * 6, 'hill');
  }
  // downtown grid buildings
  const xs = [-600, -300, 0, 300, 600], zs = [600, 900, 1200];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i] + 16, x1 = xs[i + 1] - 16, z0 = zs[j] + 16, z1 = zs[j + 1] - 16;
      const mxx = (x0 + x1) / 2, mzz = (z0 + z1) / 2;
      const quads = [[x0, mxx - 8, z0, mzz - 8], [mxx + 8, x1, z0, mzz - 8], [x0, mxx - 8, mzz + 8, z1], [mxx + 8, x1, mzz + 8, z1]];
      quads.forEach((q, qi) => {
        let mx = -1e9;
        for (let x = q[0]; x <= q[1]; x += 20) for (let z = q[2]; z <= q[3]; z += 20) mx = Math.max(mx, terrain(x, z));
        mx = Math.max(mx, terrain(q[1], q[3]));
        addB(q[0], q[1], q[2], q[3], mx + 12 + ((i * 7 + j * 3 + qi * 5) % 9) * 6, 'downtown');
      });
    }
  }

  // bridge deck over the bay
  const deck = { minX: 1300, maxX: 1900, minZ: -7, maxZ: 7, top: Math.max(2, terrain(1300, 0)) };

  // spatial hash for buildings
  const CELL = 50;
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  for (const b of buildings) {
    for (let i = Math.floor(b.minX / CELL); i <= Math.floor(b.maxX / CELL); i++)
      for (let j = Math.floor(b.minZ / CELL); j <= Math.floor(b.maxZ / CELL); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(b);
      }
  }
  const EMPTY = [];
  const cellB = (x, z) => grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || EMPTY;

  // roads
  const roads = [];
  const ringPath = resample(circlePath(0, 0, MOCK.RING_R, 8), 8, true);
  roads.push({ points: ringPath.concat([ringPath[0]]), width: 16, type: 'primary', name: 'Ring Road', oneway: false });
  const tw = twistyPath();
  roads.push({ points: tw.concat([tw[0]]), width: 14, type: 'secondary', name: 'Twisty Loop', oneway: false });
  const hillPts = [];
  for (let z = -780; z <= 780; z += 8) hillPts.push([MOCK.HILL_X, z]);
  roads.push({ points: hillPts, width: 14, type: 'residential', name: 'Mock Filbert St', oneway: false });
  const rw = [];
  for (let x = MOCK.RUNWAY_X0; x <= MOCK.RUNWAY_X1; x += 20) rw.push([x, MOCK.RUNWAY_Z]);
  roads.push({ points: rw, width: 30, type: 'primary', name: 'Runway', oneway: false });
  for (const x of xs) { const p = []; for (let z = 500; z <= 1440; z += 20) p.push([x, z]); roads.push({ points: p, width: 14, type: 'secondary', name: `Ave ${x}`, oneway: false }); }
  for (const z of zs) { const p = []; for (let x = -700; x <= 700; x += 20) p.push([x, z]); roads.push({ points: p, width: 12, type: 'residential', name: `St ${z}`, oneway: false }); }
  // spokes connecting plaza to ring
  for (let a = 0; a < 4; a++) {
    const t = a * Math.PI / 2 + Math.PI / 4;
    const p = [];
    for (let d = 240; d <= MOCK.RING_R; d += 10) p.push([Math.cos(t) * d, Math.sin(t) * d]);
    roads.push({ points: p, width: 12, type: 'residential', name: `Spoke ${a}`, oneway: false });
  }
  // deck road
  const dk = []; for (let x = 1240; x <= 1900; x += 20) dk.push([x, 0]);
  roads.push({ points: dk, width: 14, type: 'primary', name: 'Mock Bridge', oneway: false });

  // road segment hash (for surfaceAt)
  const RCELL = 40;
  const rgrid = new Map();
  for (const r of roads) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const seg = { ax: a[0], az: a[1], bx: b[0], bz: b[1], hw: r.width / 2 };
      const pad = r.width / 2 + 4;
      for (let ci = Math.floor((Math.min(a[0], b[0]) - pad) / RCELL); ci <= Math.floor((Math.max(a[0], b[0]) + pad) / RCELL); ci++)
        for (let cj = Math.floor((Math.min(a[1], b[1]) - pad) / RCELL); cj <= Math.floor((Math.max(a[1], b[1]) + pad) / RCELL); cj++) {
          const k = key(ci, cj);
          if (!rgrid.has(k)) rgrid.set(k, []);
          rgrid.get(k).push(seg);
        }
    }
  }
  function roadEdgeDist(x, z) {
    const list = rgrid.get(key(Math.floor(x / RCELL), Math.floor(z / RCELL)));
    if (!list) return 1e9;
    let best = 1e9;
    for (const s of list) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const L2 = dx * dx + dz * dz;
      let t = L2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)) - s.hw;
      if (d < best) best = d;
    }
    return best;
  }

  const onDeck = (x, z) => x >= deck.minX && x <= deck.maxX && z >= deck.minZ && z <= deck.maxZ;

  // returns 0 terrain, 1 roof, 2 deck
  let _lastKind = 0;
  function surfaceHeight(x, z, yRef) {
    let best = terrain(x, z);
    _lastKind = 0;
    const lim = yRef + 0.75;
    const list = cellB(x, z);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.top <= lim && b.top > best) { best = b.top; _lastKind = 1; }
    }
    if (onDeck(x, z) && deck.top <= lim && deck.top > best) { best = deck.top; _lastKind = 2; }
    return best;
  }

  const ringTrack = makeTrack('mock-ring', 'Mock Ring', ringPath, true, 2, 16, 1);
  const twistyTrack = makeTrack('mock-twisty', 'Mock Twisty', tw, true, 2, 14, 4);
  const hillTrack = makeTrack('mock-hill', 'Mock Filbert Jumps', hillPts.slice(5, -5), false, 1, 14, 3);

  const world = {
    isMock: true,
    buildings, deck,
    heightAt: terrain,
    surfaceHeight,
    normalAt(x, z, yRef, out) {
      out = out || new THREE.Vector3();
      const e = 0.6;
      const hl = surfaceHeight(x - e, z, yRef), hr = surfaceHeight(x + e, z, yRef);
      const hd = surfaceHeight(x, z - e, yRef), hu = surfaceHeight(x, z + e, yRef);
      out.set(-(hr - hl) / (2 * e), 1, -(hu - hd) / (2 * e)).normalize();
      return out;
    },
    surfaceAt(x, z, yRef) {
      surfaceHeight(x, z, yRef);
      if (_lastKind === 1) return 'roof';
      if (_lastKind === 2) return 'bridge';
      const t = terrain(x, z);
      if (t < 0) return 'water';
      const rd = roadEdgeDist(x, z);
      if (rd < 0) return 'road';
      if (Math.hypot(x, z) < MOCK.PLAZA_R) return 'road';
      if (rd < 3) return 'sidewalk';
      if (x > MOCK.SHORE_X - 30 && t < 3) return 'sand';
      return 'grass';
    },
    isWater(x, z) { return terrain(x, z) < 0 && !onDeck(x, z); },
    collideCircle(x, z, r, y, out) {
      let found = false, bestDepth = 0;
      const lim = y + 0.75;
      // check the cells the circle overlaps
      const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
      const j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const list = grid.get(key(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const b = list[k];
          if (b.top <= lim) continue;
          if (x < b.minX - r || x > b.maxX + r || z < b.minZ - r || z > b.maxZ + r) continue;
          const cx = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
          const cz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;
          let dx = x - cx, dz = z - cz;
          const d2 = dx * dx + dz * dz;
          let nx, nz, depth;
          if (d2 === 0) {
            // centre inside the box: push out through nearest face
            const dl = x - b.minX, dr = b.maxX - x, db = z - b.minZ, df = b.maxZ - z;
            const m = Math.min(dl, dr, db, df);
            if (m === dl) { nx = -1; nz = 0; } else if (m === dr) { nx = 1; nz = 0; } else if (m === db) { nx = 0; nz = -1; } else { nx = 0; nz = 1; }
            depth = m + r;
          } else {
            if (d2 >= r * r) continue;
            const d = Math.sqrt(d2);
            nx = dx / d; nz = dz / d; depth = r - d;
          }
          if (depth > bestDepth) { bestDepth = depth; found = true; out.nx = nx; out.nz = nz; out.depth = depth; }
        }
      }
      return found ? out : null;
    },
    bounds: { minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000 },
    roads,
    roadGraph: null,
    buildings,
    tracks: [ringTrack, twistyTrack, hillTrack],
    spawn: { x: 0, z: 0, heading: 0 },
    landmarks: [],
    update() {}, setNight() {}, dispose() {},
  };
  return world;
}

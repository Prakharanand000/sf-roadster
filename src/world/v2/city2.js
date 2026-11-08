// SF Roadster Rush - v2 world loader (?world=v2): the same World API as src/world/city.js over the
// v2 map (all of San Francisco plus the East Bay, tools/bake_v2.py), streamed in 512 m tiles.
//
//   const world = await loadWorld2(scene, { quality, onProgress });
//
// What loads when:
// - net (data/v2/net.*): roads, graph, junctions, tracks, landmarks, lakes, coarse 16 m terrain,
//   skyline. Always resident; every query falls back to it where no tile is loaded.
// - pinned tiles: the landmarks' surroundings (their solids stand on tile ground) and every track
//   corridor (rivals far from the camera still drive on full data). Landmark tiles and the start
//   area are fetched before the promise resolves; corridors and the outer rings stream after.
// - everything else streams around the camera (tiles2.js).
// - lidar tile patches (data/v2/lidar/, lidar2.js): the measured 2 m ground and road ribbons, one per
//   covered tile, streamed in their own ring around the camera (tiles2.js); track corridors inside
//   coverage keep theirs. Without data/v2/lidar/ the lidar pilot overlay (data/v2/pilot.*) is used,
//   and ?pilot=0 turns both off.
// Node tests use createWorldData2() instead, which loads tiles (and patches) from disk on first touch.
import * as THREE from 'three';
import { decodeNet, decodeTile, createQueries2 } from './worlddata2.js';
import { createTileStreamer, subsetBuildings, mergeFootprints, RADII } from './tiles2.js';
import { buildStructures } from './structures2.js';
import { buildTracks, samplePath } from '../tracks.js';
import { landmarkList } from '../landmarkdefs.js';
import { buildTerrain, paintGroundCanvas } from '../terrain.js';
import { buildWater } from '../water.js';
import { buildRoads, createRoadMaterial, createStreetLightMaterials } from '../roads.js';
import { buildBuildings, createBuildingMaterial } from '../buildings.js';
import { createFacadeTexture } from '../facades.js';
import { createTreeMaterial, treeGeometries } from '../trees.js';
import { buildLandmarks } from '../landmarks.js';
import { drawMinimap } from '../minimap.js';
import { pickSpawn } from '../city.js';
import { fetchPilotFiles, decodePilot, buildPilot } from '../pilot.js';

export const ATTRIBUTION2 = '© OpenStreetMap contributors (ODbL); ground, building and bridge heights: USGS 3DEP lidar and 1 m DEM (public domain); bay floor and gaps: Mapzen Terrarium / AWS Terrain Tiles';
const CORRIDOR = 60;      // m either side of a track path whose tiles stay loaded
const LM_PIN = 300;       // m: minimum radius around a landmark whose tiles stay loaded

const tick = () => new Promise((r) => setTimeout(r, 0));

/** FNV-1a over the net's float32 road coordinates read as uint16 (tools/bake_pilot_v2.py writes the same). */
function netRoadsHash(index, buffer) {
  const a = index.arrays.road_xz;
  const u = new Uint16Array(buffer, a.offset, a.length * 2);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0;
  return h;
}

/** null when the v2 pilot (data/v2/pilot.*) was baked against this net, else why it can't be used. */
export function pilotMismatch2(pilotIndex, index, buffer) {
  if (pilotIndex.version !== 1) return 'unknown pilot version ' + pilotIndex.version;
  const w = pilotIndex.world;
  if (!w) return 'pilot.json has no world fingerprint';
  if (w.roads !== index.counts.roads) return `baked for a different net (roads ${w.roads}/${index.counts.roads})`;
  if (w.roadsHash !== netRoadsHash(index, buffer)) return 'baked for different road geometry';
  return null;
}

/** The net's road arrays with their declared types (the lidar patches' fingerprints read them). */
function netRoadArrays(index, buffer) {
  const T = { uint16: Uint16Array, uint32: Uint32Array, float32: Float32Array };
  const arr = (n) => { const s = index.arrays[n]; return new T[s.type](buffer, s.offset, s.length); };
  return { xz: arr('road_xz'), start: arr('road_start'), count: arr('road_count') };
}

/** data/v2/lidar/index.json and bground.bin -> { index, bground } (null without index.json). */
async function fetchLidarFiles(base) {
  try {
    const jr = await fetch(base + 'lidar/index.json');
    if (!jr.ok) return null;
    const index = await jr.json();
    const br = index.bground ? await fetch(base + 'lidar/bground.bin') : null;
    return { index, bground: br && br.ok ? await br.arrayBuffer() : null };
  } catch (e) {
    return null;
  }
}

/** D.lidar from data/v2/lidar/index.json (+ bground.bin): `loadSync` loads patches on first touch (Node). */
function attachLidar(D, index, buffer, lidar) {
  const L = lidar.index;
  if (L.version !== 2 || !L.world || L.world.roads !== index.counts.roads) {
    console.warn('v2 lidar patches skipped: index.json is for another net or format');
    return false;
  }
  let bground = null;
  if (L.bground && lidar.bground) {
    const tiles = new Map();
    for (const [i, j, offset, count, hash] of L.bground.tiles) tiles.set(i + ',' + j, { offset, count, hash });
    bground = { tiles, data: new Float32Array(lidar.bground) };
  }
  D.lidar = { index: L, net: netRoadArrays(index, buffer), bground, loadSync: lidar.readPatch || null };
  return true;
}

function attachPilot(D, index, buffer, pilot) {
  if (!pilot) return;
  const bad = pilotMismatch2(pilot.index, index, buffer);
  if (bad) { console.warn('v2 pilot overlay skipped: ' + bad); return; }
  try { D.pilot = decodePilot(pilot.index, pilot.buffer); } catch (e) { console.warn('v2 pilot overlay skipped: ' + e.message); }
}

/** Tiles under the pilot box (they keep their ground, sunk under the pilot patch, built everywhere). */
function pilotTiles(P, TS) {
  const out = [];
  if (!P) return out;
  const b = P.bbox;
  for (let j = Math.floor(b.z0 / TS); j <= Math.floor((b.z1 - 1e-6) / TS); j++) {
    for (let i = Math.floor(b.x0 / TS); i <= Math.floor((b.x1 - 1e-6) / TS); i++) out.push([i, j]);
  }
  return out;
}

/** Tiles to keep loaded: landmark surroundings and track corridors -> { landmarks: [[i,j]], corridors: [[i,j]] }. */
export function pinnedTiles(index) {
  const TS = index.tiles.size;
  const lmSet = new Map(), corSet = new Map();
  const addDisc = (set, x, z, r) => {
    for (let j = Math.floor((z - r) / TS); j <= Math.floor((z + r) / TS); j++) {
      for (let i = Math.floor((x - r) / TS); i <= Math.floor((x + r) / TS); i++) {
        const dx = Math.max(i * TS - x, 0, x - (i + 1) * TS), dz = Math.max(j * TS - z, 0, z - (j + 1) * TS);
        if (Math.hypot(dx, dz) <= r) set.set(i + ',' + j, [i, j]);
      }
    }
  };
  for (const l of landmarkList(index)) addDisc(lmSet, l.x, l.z, Math.max(l.radius, LM_PIN));
  for (const t of index.tracks || []) {
    const P = t.path;
    for (let k = 0; k < P.length; k++) {
      const [x, z] = P[k];
      addDisc(corSet, x, z, CORRIDOR);
      if (k + 1 < P.length) {   // fill long segments every 40 m
        const [x1, z1] = P[k + 1], L = Math.hypot(x1 - x, z1 - z);
        for (let s = 40; s < L; s += 40) addDisc(corSet, x + ((x1 - x) * s) / L, z + ((z1 - z) * s) / L, CORRIDOR);
      }
    }
  }
  return { landmarks: [...lmSet.values()], corridors: [...corSet.values()] };
}

/** Data-only v2 world for Node: `readTile(i, j)` -> ArrayBuffer | null, called on first touch.
 *  `pilot` = optional { index, buffer } of data/v2/pilot.* (the lidar overlay).
 *  `lidar` = optional { index, bground, readPatch(i, j) } of data/v2/lidar/ (replaces the pilot). */
export function createWorldData2(index, buffer, readTile, pilot = null, lidar = null) {
  const D = decodeNet(index, buffer);
  if (!(lidar && attachLidar(D, index, buffer, lidar))) attachPilot(D, index, buffer, pilot);
  const Q = createQueries2(D, {
    loadSync: (i, j) => {
      const b = readTile(i, j);
      return b ? decodeTile(b, index.tiles.size) : null;
    },
  });
  const tracks = buildTracks(index, Q);
  return { D, Q, tracks, spawn: pickSpawn(index, tracks) };
}

export async function loadWorld2(scene, { quality = 'high', onProgress, dataUrl } = {}) {
  const prog = (f, m) => { try { if (onProgress) onProgress(f, m); } catch (e) { /* ignore UI errors */ } };
  const t0 = performance.now();
  const stageMs = {};
  let tl = t0;
  const lap = (name) => { const n = performance.now(); stageMs[name] = Math.round(n - tl); tl = n; };
  if (!RADII[quality]) quality = 'high';
  prog(0.01, 'Downloading the Bay Area');
  const base = dataUrl ? dataUrl.replace(/\/?$/, '/') + 'v2/' : new URL('../../../data/v2/', import.meta.url).href;
  const [jr, br] = await Promise.all([fetch(base + 'net.json'), fetch(base + 'net.bin.wasm')]);
  if (!jr.ok || !br.ok) throw new Error('v2 world data missing (' + jr.status + '/' + br.status + ')');
  const index = await jr.json();
  const buffer = await br.arrayBuffer();
  lap('fetchNet');
  prog(0.12, 'Decoding the map');
  await tick();
  const D = decodeNet(index, buffer);
  const wantPilot = !(typeof location !== 'undefined' && /[?&]pilot=0(&|$)/.test(location.search));
  const lidarFiles = wantPilot ? await fetchLidarFiles(base) : null;
  if (!(lidarFiles && attachLidar(D, index, buffer, lidarFiles))) attachPilot(D, index, buffer, wantPilot ? await fetchPilotFiles(base) : null);
  const Q = createQueries2(D);
  const uniforms = { uNight: { value: 0 }, uTime: { value: 0 }, lampMaterials: [], animated: [] };
  const group = new THREE.Group();
  group.name = 'sf-world-v2';
  scene.add(group);
  const shared = {
    roadMaterial: createRoadMaterial(uniforms),
    lights: createStreetLightMaterials(uniforms),
    facadeTex: createFacadeTexture(quality === 'low' ? 128 : 256),
    treeMaterial: createTreeMaterial(uniforms),
    treeGeos: treeGeometries(),
  };
  shared.buildingMaterial = createBuildingMaterial(shared.facadeTex, uniforms);

  // skyline: towers drawn far out, one mesh per tile, hidden while the tile's own buildings show
  const skyline = new Map();
  const skyGroup = new THREE.Group();
  skyGroup.name = 'skyline';
  group.add(skyGroup);
  const keepNear = pilotTiles(D.pilot, index.tiles.size);
  const streamer = createTileStreamer({
    D, Q, base, quality, uniforms, shared, parent: group, keepNear, lidar: Q.lidar,
    onTileChange: (i, j, has) => { const m = skyline.get(i + ',' + j); if (m) m.group.visible = !has; },
  });

  lap('decode');
  const spawn0 = pickSpawn(index, index.tracks || []);
  const pins = pinnedTiles(index);
  for (const [i, j] of pins.landmarks) streamer.pin(i, j);
  for (const [i, j] of pins.corridors) streamer.pin(i, j);
  // rivals far from the camera drive on the patches too: track corridors keep theirs
  if (Q.lidar) for (const [i, j] of pins.corridors) if (Q.lidar.isCovered(i, j)) streamer.pinPatch(i, j);
  // the pilot's tiles and their neighbours stay loaded (their ground is always drawn)
  const pilotData = [];
  for (const [i, j] of keepNear) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) pilotData.push([i + di, j + dj]);
  for (const [i, j] of pilotData) streamer.pin(i, j);
  const startArea = streamer.tilesAround(spawn0.x, spawn0.z, streamer.radii.near + 725);
  prog(0.16, 'Fetching the streets around you');
  await streamer.preload([...startArea, ...pins.landmarks, ...pilotData], (f) => prog(0.16 + f * 0.3, 'Fetching the streets around you'));
  // the lidar patches around the start (its near tiles wait for them) and on the track corridors
  if (Q.lidar) await streamer.preloadPatches([...startArea, ...pins.corridors]);
  // landmark solids stand on their tiles' ground: a tile that failed to load gets one more try
  const missing = pins.landmarks.filter(([i, j]) => Q.tileExists(i, j) && !Q.tileByIndex(i, j));
  if (missing.length) {
    await new Promise((r) => setTimeout(r, 300));
    await streamer.preload(missing);
    const still = missing.filter(([i, j]) => !Q.tileByIndex(i, j)).length;
    if (still) console.warn('v2 world: ' + still + ' landmark tile(s) failed to load; their landmarks stand on the coarse terrain');
  }
  Q.initLandmarks();
  const tracks = buildTracks(index, Q);
  const spawn = pickSpawn(index, tracks);
  lap('fetchTiles');

  prog(0.48, 'Shaping the hills');
  await tick();
  // 2 km chunks of the 16 m net grid: the far ground in few draw calls (near ground is per tile)
  const terrain = buildTerrain(D, Q, { quality, uniforms, chunkCells: 128, tileMask: streamer.tileMask, lodPad: 512 });
  group.add(terrain.group);
  lap('terrain');

  prog(0.56, 'Filling the bay');
  await tick();
  const water = buildWater(D, Q, { quality, mergeLakes: true });
  group.add(water.group);
  // Golden Gate deck lamps (tile roads skip them)
  const deckLights = buildRoads({ roads: [], junctions: D.junctions, grid: D.grid }, Q, { quality, uniforms, material: shared.roadMaterial, lights: shared.lights });
  group.add(deckLights.group);
  lap('water');

  prog(0.6, 'Raising the skyline');
  await tick();
  const S = D.sky;
  const TS = index.tiles.size;
  const byTile = new Map();
  for (let k = 0; k < S.count; k++) {
    let i, j;
    if (S.tile) { i = S.tile[k * 2]; j = S.tile[k * 2 + 1]; } else {
      let cx = 0, cz = 0;
      for (let v = 0; v < S.n[k]; v++) { cx += S.xz[(S.start[k] + v) * 2]; cz += S.xz[(S.start[k] + v) * 2 + 1]; }
      i = Math.floor(cx / S.n[k] / TS); j = Math.floor(cz / S.n[k] / TS);
    }
    const key = i + ',' + j;
    if (!byTile.has(key)) byTile.set(key, { i, j, list: [] });
    byTile.get(key).list.push(k);
  }
  let skyTris = 0;
  for (const [key, { i, j, list }] of byTile) {
    const sub = { B: subsetBuildings(S, list), grid: { x0: i * TS, z0: j * TS, nx: 2, nz: 2, cell: TS } };
    const b = buildBuildings(sub, Q, { quality, uniforms, material: shared.buildingMaterial, facadeTex: shared.facadeTex, chunk: 1e9 });
    b.group.name = 'sky-' + key;
    skyGroup.add(b.group);
    skyline.set(key, b);
    skyTris += b.stats.triangles;
  }
  lap('skyline');

  prog(0.66, 'Painting the Golden Gate');
  await tick();
  const landmarks = buildLandmarks(D, Q, { quality, uniforms });
  group.add(landmarks.group);
  // the lidar pilot: its 2 m ground patch and measured road ribbons, with a ground texture painted
  // for its tiles from their landcover, buildings and roads
  let pilot = null;
  if (D.pilot) {
    const TS = index.tiles.size;
    const ti = keepNear.map(([i]) => i), tj = keepNear.map(([, j]) => j);
    const i0 = Math.min(...ti), i1 = Math.max(...ti), j0 = Math.min(...tj), j1 = Math.max(...tj);
    const res = index.tiles.lcRes, per = TS / res, nx = (i1 - i0 + 1) * per, nz = (j1 - j0 + 1) * per;
    const lcb = new Uint8Array(nx * nz).fill(1);
    const Bs = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const t = Q.tileByIndex(i, j);
        if (!t) continue;
        if (t.B.count) Bs.push(t.B);
        for (let r = 0; r < per; r++) lcb.set(t.landcover.subarray(r * per, (r + 1) * per), ((j - j0) * per + r) * nx + (i - i0) * per);
      }
    }
    const x0 = i0 * TS, z0 = j0 * TS, w = (i1 - i0 + 1) * TS, d = (j1 - j0 + 1) * TS;
    const near = D.roads.filter((r) => r.points.some(([x, z]) => x > x0 - 30 && x < x0 + w + 30 && z > z0 - 30 && z < z0 + d + 30));
    const Dbox = { lcInfo: { x0, z0, res, nx, nz }, landcover: lcb, B: mergeFootprints(Bs), roads: near };
    const canvas = paintGroundCanvas(Dbox, Q, quality === 'low' ? 1536 : quality === 'medium' ? 2048 : 4096);
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const texGrid = { x0, z0, cell: 8, nx: w / 8 + 1, nz: d / 8 + 1 };
    pilot = buildPilot({ ...D, grid: texGrid }, Q, { quality, groundTexture: tex, uniforms, roadMaterial: shared.roadMaterial });
    group.add(pilot.group);
  }
  // bridge girders, piers, barriers, tunnel walls and roofs (the Bay Bridge)
  const structures = buildStructures(D, Q);
  group.add(structures.group);
  lap('landmarks');

  prog(0.74, 'Paving the streets');
  await tick();
  streamer.buildAll(spawn.x, spawn.z, (f) => prog(0.74 + f * 0.16, 'Paving the streets'));
  lap('tiles');

  prog(0.92, 'Drawing the map');
  await tick();
  // the map is ~28 km across: 4096 px is ~7 m per pixel (v1's 2048 over 10 km: 5 m); the HUD shows 520 m
  const minimapImage = drawMinimap(D, { width: quality === 'low' ? 1024 : quality === 'medium' ? 2048 : 4096 });
  lap('minimap');

  let nightVal = -1;
  function setNight(n) {
    n = Math.max(0, Math.min(1, n || 0));
    if (Math.abs(n - nightVal) < 1e-3) return;
    nightVal = n;
    uniforms.uNight.value = n;
    water.material.uniforms.uNight.value = n;
    for (const m of uniforms.lampMaterials) m.emissiveIntensity = n * 2.2;
    landmarks.setNight(n);
  }
  setNight(0);

  function update(dt, camera, env = {}) {
    uniforms.uTime.value += dt;
    if (env && typeof env.night === 'number') setNight(env.night);
    water.update(dt, camera, { night: nightVal }, scene);
    streamer.update(camera);
    deckLights.update(camera);
    if (pilot) pilot.update(camera);
    for (const b of skyline.values()) if (b.group.visible) b.update(camera);
    for (const f of uniforms.animated) f(uniforms.uTime.value);
  }

  function dispose() {
    streamer.dispose();
    scene.remove(group);
    const seen = new Set();
    group.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (seen.has(m)) continue;
        seen.add(m);
        for (const k of ['map', 'emissiveMap']) if (m[k]) m[k].dispose();
        if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) u.value.dispose();
        m.dispose();
      }
    });
    for (const g of shared.treeGeos) g.dispose();
    for (const m of [shared.roadMaterial, shared.buildingMaterial, shared.treeMaterial, shared.lights.points, shared.lights.pole, shared.lights.head]) m.dispose();
    shared.facadeTex.dispose();
  }

  const stats = {
    loadMs: Math.round(performance.now() - t0), stageMs,
    get tiles() { return streamer.stats(); },
    skyline: { buildings: S.count, tiles: skyline.size, triangles: skyTris },
    structures: structures.stats,
    pilot: D.pilot ? { box: D.pilot.bbox, stations: D.pilot.N, segments: Q.pilot.segments, tiles: keepNear.length, ...pilot.stats } : null,
    get lidar() { return Q.lidar ? { cover: Q.lidar.cover.length, refused: Q.lidar.refused.length, loaded: Q.lidar.loaded, segments: Q.lidar.segments } : null; },
    triangles: { terrainLod0: terrain.stats.trianglesLod0 },
    net: index.counts,
  };
  prog(1, 'Welcome to the Bay Area');

  return {
    heightAt: Q.heightAt,
    surfaceHeight: Q.surfaceHeight,
    normalAt: Q.normalAt,
    surfaceAt: Q.surfaceAt,
    isWater: Q.isWater,
    collideCircle: Q.collideCircle,
    groundHeight: Q.groundHeight,
    roadAt: Q.roadAt,
    roadHit: Q.roadHit,
    deckAt: Q.deckAt,
    landcoverAt: Q.landcoverAt,
    bounds: Q.bounds,
    roads: D.roads,
    roadGraph: D.graph,
    tracks,
    spawn,
    landmarks: landmarkList(index),
    minimapImage,
    update,
    setNight,
    dispose,
    samplePath,
    group,
    quality,
    stats,
    attribution: D.lidar ? ATTRIBUTION2 + '; ' + D.lidar.index.attribution : D.pilot ? ATTRIBUTION2 + '; ' + D.pilot.index.attribution : ATTRIBUTION2,
    data: D,
    version: 2,
    streamer,
  };
}

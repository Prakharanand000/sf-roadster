// SF Roadster Rush - MAP entry point. See CONTRACTS.md ("MAP agent").
//
//   const world = await loadWorld(scene, { quality: 'high', onProgress: (f, msg) => ... });
//
// Data comes from data/world.json + data/world.bin (baked by tools/bake.py from OpenStreetMap + AWS Terrain
// Tiles). Everything is resolved relative to this module, so any page location works.
//
// Implementation notes / choices (beyond the contract):
// - Extra World members: groundHeight(x,z) (terrain or bridge deck, no roofs - handy for traffic/AI),
//   roadAt(x,z) (0 none / 1 road / 2 sidewalk; details in roadHit), deckAt(x,z), landcoverAt(x,z),
//   quality, stats, attribution, group (THREE.Group of all world meshes), data (decoded arrays).
// - collideCircle skips solids whose base is > 3 m above the car base (cars under the bridge deck).
// - Circuits: last checkpoint is on path[0] (start/finish). Point-to-point: start line 30 m along the
//   path, grid behind it, last checkpoint = finish (path end).
// - update() reads the first DirectionalLight in the scene for the water sun glint and scene.fog for the
//   water horizon colour; env.night (0..1) also drives setNight() automatically.
import * as THREE from 'three';
import { fetchWorldFiles, decodeWorld, createQueries } from './worlddata.js';
import { buildTracks, samplePath } from './tracks.js';
import { landmarkList } from './landmarkdefs.js';
import { buildTerrain } from './terrain.js';
import { buildWater } from './water.js';
import { buildRoads } from './roads.js';
import { buildBuildings } from './buildings.js';
import { buildTrees } from './trees.js';
import { buildLandmarks } from './landmarks.js';
import { drawMinimap } from './minimap.js';

export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL); elevation: Mapzen Terrarium / AWS Terrain Tiles';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Data-only world (no meshes, no DOM) - used by Node tests and tools. */
export function createWorldData(index, buffer) {
  const D = decodeWorld(index, buffer);
  const Q = createQueries(D);
  const tracks = buildTracks(index, Q);
  return { D, Q, tracks, spawn: pickSpawn(index, tracks) };
}

function pickSpawn(index, tracks) {
  // The Embarcadero next to the Ferry Building, facing north (Bay Bridge behind, Coit Tower ahead)
  const t = tracks.find((k) => k.id === 'embarcadero-sprint') || tracks[0];
  const ferry = (index.landmarks || []).find((l) => l.id === 'ferry');
  if (!t) return { x: 0, z: 0, heading: Math.PI };
  let best = 0, bd = Infinity;
  t.path.forEach(([x, z], i) => {
    const d = ferry ? Math.hypot(x - ferry.x, z - ferry.z) : i;
    if (d < bd) { bd = d; best = i; }
  });
  const i = Math.max(1, Math.min(t.path.length - 2, best + 12));
  const [x, z] = t.path[i], [px, pz] = t.path[i - 1];
  return { x, z, heading: Math.atan2(px - x, pz - z) };
}

export async function loadWorld(scene, { quality = 'high', onProgress, dataUrl } = {}) {
  const prog = (f, m) => { try { if (onProgress) onProgress(f, m); } catch (e) { /* ignore UI errors */ } };
  const t0 = performance.now();
  const stageMs = {};
  let tl = t0;
  const lap = (name) => { const n = performance.now(); stageMs[name] = Math.round(n - tl); tl = n; };
  prog(0.01, 'Downloading San Francisco');
  const base = dataUrl || new URL('../../data/', import.meta.url).href;
  const { index, buffer } = await fetchWorldFiles(base);
  lap('fetch');
  prog(0.2, 'Decoding map data');
  await tick();
  const { D, Q, tracks, spawn } = createWorldData(index, buffer);
  const uniforms = { uNight: { value: 0 }, uTime: { value: 0 }, lampMaterials: [], animated: [] };
  const group = new THREE.Group();
  group.name = 'sf-world';
  scene.add(group);

  lap('decode');
  prog(0.3, 'Shaping the hills');
  await tick();
  const terrain = buildTerrain(D, Q, { quality, uniforms });
  group.add(terrain.group);

  lap('terrain');
  prog(0.42, 'Filling the bay');
  await tick();
  const water = buildWater(D, Q, { quality });
  group.add(water.group);

  lap('water');
  prog(0.5, 'Paving the streets');
  await tick();
  const roads = buildRoads(D, Q, { quality, uniforms });
  group.add(roads.group);

  lap('roads');
  prog(0.62, 'Raising the skyline');
  await tick();
  const buildings = buildBuildings(D, Q, { quality, uniforms });
  group.add(buildings.group);

  lap('buildings');
  prog(0.8, 'Planting cypress and palms');
  await tick();
  const trees = buildTrees(D, Q, { quality, uniforms });
  group.add(trees.group);

  lap('trees');
  prog(0.88, 'Painting the Golden Gate');
  await tick();
  const landmarks = buildLandmarks(D, Q, { quality, uniforms });
  group.add(landmarks.group);

  lap('landmarks');
  prog(0.96, 'Drawing the map');
  await tick();
  const minimapImage = drawMinimap(D, { width: quality === 'low' ? 1024 : 2048 });
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
    buildings.update(camera);
    roads.update(camera);
    trees.update(camera);
    for (const f of uniforms.animated) f(uniforms.uTime.value);
  }

  function dispose() {
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
    if (buildings.facadeTex) buildings.facadeTex.dispose();
  }

  // triangle estimate (all LOD0, everything visible)
  const stats = {
    loadMs: Math.round(performance.now() - t0), stageMs,
    buildings: buildings.stats.buildings, trees: trees.stats.trees, lamps: roads.stats.lamps,
    triangles: {
      terrainLod0: terrain.stats.trianglesLod0, roads: roads.stats.triangles, buildings: buildings.stats.triangles,
      trees: trees.stats.triangles,
    },
  };
  prog(1, 'Welcome to San Francisco');

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
    attribution: ATTRIBUTION,
    data: D,
  };
}

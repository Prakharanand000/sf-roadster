// Trees: low-poly broadleaf / Monterey cypress / palm / eucalyptus as InstancedMesh per 1 km chunk,
// with manual distance + frustum culling and a little wind sway.
import * as THREE from 'three';

const CHUNK = 1000;

function colorize(geo, rgb) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = geo.attributes.position.getY(i);
    const shade = typeof rgb === 'function' ? rgb(y) : rgb;
    c[i * 3] = shade[0]; c[i * 3 + 1] = shade[1]; c[i * 3 + 2] = shade[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

function merge(list) {
  let nv = 0, ni = 0;
  for (const g of list) { const gi = g.index ? g : g; nv += gi.attributes.position.count; ni += gi.index ? gi.index.count : gi.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = [];
  let vo = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.array[i] + vo);
    else for (let i = 0; i < g.attributes.position.count; i++) idx.push(i + vo);
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}

const BARK = [0.16, 0.11, 0.08];

function jitter(geo, amt, seed) {
  const p = geo.attributes.position;
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + r() * amt, p.getY(i) + r() * amt, p.getZ(i) + r() * amt);
  geo.computeVertexNormals();
  return geo;
}

export function treeGeometries() {
  const leafGrad = (lo, hi, y0, y1) => (y) => {
    const t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    return [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t];
  };
  // 0 broadleaf
  const t0 = colorize(new THREE.CylinderGeometry(0.16, 0.26, 3.2, 5, 1, true).translate(0, 1.6, 0), BARK);
  const c0 = colorize(jitter(new THREE.IcosahedronGeometry(2.5, 0).toNonIndexed().scale(1, 0.85, 1).translate(0, 4.4, 0), 0.35, 7), leafGrad([0.07, 0.13, 0.04], [0.18, 0.29, 0.09], 2.4, 6.5));
  // 1 Monterey cypress (wide, layered, flat top)
  const t1 = colorize(new THREE.CylinderGeometry(0.22, 0.38, 3, 5, 1, true).translate(0, 1.5, 0), BARK);
  const c1a = colorize(jitter(new THREE.CylinderGeometry(2.4, 3.6, 2.6, 7).toNonIndexed().translate(0, 4.4, 0), 0.3, 11), leafGrad([0.04, 0.09, 0.05], [0.09, 0.17, 0.08], 3, 6));
  const c1b = colorize(jitter(new THREE.CylinderGeometry(1.2, 2.6, 2.4, 7).toNonIndexed().translate(0.4, 6.6, 0.2), 0.3, 13), leafGrad([0.05, 0.11, 0.06], [0.11, 0.2, 0.09], 5.4, 7.8));
  // 2 palm
  const t2 = colorize(new THREE.CylinderGeometry(0.2, 0.32, 10, 5, 1, true).translate(0, 5, 0), [0.45, 0.38, 0.3]);
  const fronds = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const g = new THREE.BufferGeometry();
    const L = 3.6;
    const tip = [Math.cos(a) * L, -1.4, Math.sin(a) * L];
    const s = [-Math.sin(a) * 0.55, 0.1, Math.cos(a) * 0.55];
    const mid = [Math.cos(a) * L * 0.5, 0.4, Math.sin(a) * L * 0.5];
    const v = [0, 0, 0, mid[0] + s[0], mid[1] + s[1], mid[2] + s[2], tip[0], tip[1], tip[2], 0, 0, 0, tip[0], tip[1], tip[2], mid[0] - s[0], mid[1] - s[1], mid[2] - s[2]];
    const both = v.concat([v[0], v[1], v[2], v[6], v[7], v[8], v[3], v[4], v[5], v[9], v[10], v[11], v[15], v[16], v[17], v[12], v[13], v[14]]);
    g.setAttribute('position', new THREE.Float32BufferAttribute(both, 3));
    g.computeVertexNormals();
    g.translate(0, 10, 0);
    fronds.push(colorize(g, [0.1, 0.2, 0.06]));
  }
  // 3 eucalyptus (tall, thin, airy crown)
  const t3 = colorize(new THREE.CylinderGeometry(0.22, 0.42, 11, 5, 1, true).translate(0, 5.5, 0), [0.62, 0.58, 0.52]);
  const c3 = colorize(jitter(new THREE.IcosahedronGeometry(3.0, 0).toNonIndexed().scale(1, 1.5, 1).translate(0, 13, 0), 0.6, 17), leafGrad([0.08, 0.12, 0.08], [0.18, 0.24, 0.16], 9, 17));
  return [merge([t0, c0]), merge([t1, c1a, c1b]), merge([t2, ...fronds]), merge([t3, c3])];
}

/** Tree material (instanced, wind sway from uniforms.uTime). */
export function createTreeMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.FrontSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
{ float ph = instanceMatrix[3].x * 0.05 + instanceMatrix[3].z * 0.07;
  float k = max(0.0, position.y - 2.5) * 0.025;
  transformed.x += sin(uTime * 1.3 + ph) * k; transformed.z += cos(uTime * 1.1 + ph) * k * 0.7; }
#endif`);
  };
  mat.customProgramCacheKey = () => 'sf-tree-v1';
  return mat;
}

/** `material` / `geos` reuse a shared tree material and geometries (the v2 world builds one set per tile). */
export function buildTrees(D, Q, { quality = 'high', uniforms, material, geos: sharedGeos } = {}) {
  const T = D.trees;
  const n = T.type.length;
  const frac = quality === 'high' ? 1 : quality === 'medium' ? 0.6 : 0.3;
  const geos = sharedGeos || treeGeometries();
  const mat = material || createTreeMaterial(uniforms);
  // bucket by chunk & type
  const buckets = new Map();
  let used = 0;
  for (let i = 0; i < n; i++) {
    // deterministic thinning (palms always kept)
    if (T.type[i] !== 2 && ((i * 2654435761) >>> 0) / 4294967296 > frac) continue;
    const x = T.xz[i * 2], z = T.xz[i * 2 + 1];
    const key = Math.floor(x / CHUNK) * 100 + Math.floor(z / CHUNK) + '_' + T.type[i];
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { type: T.type[i], list: [] }));
    b.list.push(i);
    used++;
  }
  const group = new THREE.Group();
  group.name = 'trees';
  const chunks = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  let tris = 0;
  for (const [, b] of buckets) {
    const im = new THREE.InstancedMesh(geos[b.type], mat, b.list.length);
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity, miny = Infinity, maxy = -Infinity;
    b.list.forEach((i, k) => {
      const x = T.xz[i * 2], z = T.xz[i * 2 + 1];
      const sc = T.scale[i] / 100;
      const h = Q.heightAt(x, z) - 0.15;
      const r = ((i * 7919) % 1000) / 1000;
      q.setFromAxisAngle(up, r * Math.PI * 2);
      s.set(sc, sc * (0.9 + r * 0.25), sc);
      m4.compose(p.set(x, h, z), q, s);
      im.setMatrixAt(k, m4);
      const v = 0.82 + r * 0.3;
      col.setRGB(v * (0.95 + r * 0.1), v, v * (1.0 - r * 0.12));
      im.setColorAt(k, col);
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z);
      miny = Math.min(miny, h); maxy = Math.max(maxy, h + 20);
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = true;
    im.receiveShadow = false;
    im.frustumCulled = false;   // we cull per chunk ourselves
    im.matrixAutoUpdate = false;
    group.add(im);
    const box = new THREE.Box3(new THREE.Vector3(minx - 8, miny, minz - 8), new THREE.Vector3(maxx + 8, maxy, maxz + 8));
    chunks.push({ mesh: im, box, cx: (minx + maxx) / 2, cz: (minz + maxz) / 2 });
    tris += (geos[b.type].index.count / 3) * b.list.length;
  }
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4();
  const dist = quality === 'high' ? 1900 : quality === 'medium' ? 1300 : 800;
  function update(camera) {
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);
    const px = camera.position.x, pz = camera.position.z;
    for (const c of chunks) {
      const dx = Math.max(c.box.min.x - px, 0, px - c.box.max.x), dz = Math.max(c.box.min.z - pz, 0, pz - c.box.max.z);
      c.mesh.visible = Math.hypot(dx, dz) < dist && frustum.intersectsBox(c.box);
    }
  }
  return { group, update, stats: { trees: used, triangles: tris, meshes: chunks.length } };
}

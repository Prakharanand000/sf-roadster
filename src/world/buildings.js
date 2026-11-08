// OSM buildings: merged per 500 m chunk (separate "big" and "small" meshes so small houses can be
// distance-culled), procedural facades from a texture array, night window glow.
import * as THREE from 'three';
import { createFacadeTexture, STYLE_PARAMS } from './facades.js';

const CHUNK = 500;
// sRGB byte -> linear byte (vertex colours are interpreted as linear by three.js); slight saturation boost
const LIN = new Uint8Array(256).map((_, i) => Math.round(Math.pow(i / 255, 2.2) * 255));

export function createBuildingMaterial(facadeTex, uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.facadeTex = { value: facadeTex };
    sh.uniforms.uNight = uniforms.uNight;
    sh.uniforms.uStyleTint = { value: STYLE_PARAMS.map((s) => s.tint) };
    sh.uniforms.uStyleLit = { value: STYLE_PARAMS.map((s) => s.lit) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 fuv;\nattribute vec4 finfo;\nvarying vec2 vFuv;\nvarying vec4 vFinfo;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFuv = fuv; vFinfo = finfo;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform highp sampler2DArray facadeTex;
uniform float uNight;
uniform float uStyleTint[8];
uniform float uStyleLit[8];
varying vec2 vFuv;
varying vec4 vFinfo;
float bh21(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float facWin = 0.0; float facLit = 0.0; vec3 litCol = vec3(1.0, 0.8, 0.5);
if (vFinfo.x < 100.0) {
  int st = int(vFinfo.x + 0.5);
  float fl = floor(vFuv.y);
  float isGround = (vFinfo.z > 1.5 && fl >= vFinfo.z - 1.0) ? 1.0 : 0.0;
  vec2 tuv = fract(vFuv);
  vec4 fac = textureGrad(facadeTex, vec3(tuv, float(st * 2) + isGround), dFdx(vFuv), dFdy(vFuv));
  float tint = uStyleTint[st];
  vec3 wallCol = diffuseColor.rgb;
  diffuseColor.rgb = mix(wallCol * fac.rgb, fac.rgb * mix(vec3(1.0), wallCol * 1.25, tint), fac.a);
  facWin = fac.a;
  vec2 cell = floor(vFuv) + vec2(vFinfo.y * 0.731, vFinfo.y * 0.377);
  float h = bh21(cell);
  float lit = step(h, uStyleLit[st] + isGround * 0.35);
  facLit = lit * fac.a;
  float h2 = bh21(cell + 17.0);
  litCol = h2 < 0.6 ? vec3(1.0, 0.76, 0.42) : (h2 < 0.85 ? vec3(1.0, 0.9, 0.7) : vec3(0.75, 0.85, 1.0));
  litCol *= 0.7 + 0.6 * bh21(cell + 3.0);
} else {
  // roofs: subtle gravel noise
  float n = bh21(floor(vFuv * 4.0));
  diffuseColor.rgb *= 0.9 + 0.12 * n;
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.08, facWin);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.55, facWin * (1.0 - uNight * 0.7));')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += litCol * facLit * uNight * 0.75;
diffuseColor.rgb *= 1.0 - facWin * uNight * 0.6;`);
  };
  mat.customProgramCacheKey = () => 'sf-building-v1';
  return mat;
}

/**
 * Build building chunk meshes. D = decoded data, Q = queries.
 * Returns { group, update(camera), material, stats }.
 * `material` / `facadeTex` reuse a shared material (the v2 world builds one set per tile);
 * `chunk` is the chunk size in metres.
 */
export function buildBuildings(D, Q, { quality = 'high', uniforms, extraSkip, material: sharedMaterial, facadeTex: sharedTex, chunk = CHUNK } = {}) {
  const B = D.B;
  const facadeTex = sharedMaterial ? sharedTex || null : createFacadeTexture(quality === 'low' ? 128 : 256);
  const material = sharedMaterial || createBuildingMaterial(facadeTex, uniforms);
  const g = D.grid;
  const CX0 = g.x0, CZ0 = g.z0;
  const NCX = Math.ceil((g.nx * g.cell) / chunk), NCZ = Math.ceil((g.nz * g.cell) / chunk);

  // classify + chunk assignment
  const isSmall = new Uint8Array(B.count);
  const chunkOf = new Int32Array(B.count);
  const keep = new Uint8Array(B.count);
  let kept = 0;
  for (let k = 0; k < B.count; k++) {
    const s = B.start[k], n = B.n[k];
    let a = 0, cx = 0, cz = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = B.xz[(s + i) * 2], zi = B.xz[(s + i) * 2 + 1], xj = B.xz[(s + j) * 2], zj = B.xz[(s + j) * 2 + 1];
      a += xj * zi - xi * zj;
      cx += xi; cz += zi;
    }
    a = Math.abs(a) * 0.5; cx /= n; cz /= n;
    const h = B.top[k] - B.gmin[k];
    isSmall[k] = a < 230 && h < 15 ? 1 : 0;
    if (quality === 'low' && (a < 160 && h < 12)) continue;
    if (extraSkip && extraSkip(cx, cz)) continue;
    const ci = Math.min(NCX - 1, Math.max(0, Math.floor((cx - CX0) / chunk)));
    const cj = Math.min(NCZ - 1, Math.max(0, Math.floor((cz - CZ0) / chunk)));
    chunkOf[k] = cj * NCX + ci;
    keep[k] = 1; kept++;
  }
  // bucket
  const buckets = new Map();
  for (let k = 0; k < B.count; k++) {
    if (!keep[k]) continue;
    const key = chunkOf[k] * 2 + isSmall[k];
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(k);
  }

  const group = new THREE.Group();
  group.name = 'buildings';
  const chunks = [];
  let tris = 0;
  const contour = [];
  for (const [key, list] of buckets) {
    // count
    let nv = 0, ni = 0;
    for (const k of list) {
      const n = B.n[k];
      nv += n * 4 + n;
      ni += n * 6 + (n - 2) * 3;
    }
    const pos = new Float32Array(nv * 3), nor = new Int8Array(nv * 3), col = new Uint8Array(nv * 3);
    const fuv = new Float32Array(nv * 2), finfo = new Uint8Array(nv * 4);
    const idx = new Uint32Array(ni);
    let v = 0, ii = 0;
    for (const k of list) {
      const s = B.start[k], n = B.n[k];
      const st = B.style[k];
      // a style past the facade styles (8, the v2 bake's towers and bridge pylons): walls without
      // windows, shaded like roofs
      const plain = st >= STYLE_PARAMS.length;
      const P = STYLE_PARAMS[plain ? 0 : st];
      const top = B.top[k], gmin = B.gmin[k], base = gmin - 3;
      const Heff = Math.max(2.5, top - gmin);
      const nf = Math.max(1, Math.round(Heff / P.floor));
      const fh = Heff / nf;
      const seed = (k * 37) & 255;
      const wr = LIN[B.wall[k * 3]], wg = LIN[B.wall[k * 3 + 1]], wb = LIN[B.wall[k * 3 + 2]];
      const rr = LIN[B.roof[k * 3]], rg = LIN[B.roof[k * 3 + 1]], rb = LIN[B.roof[k * 3 + 2]];
      const vBase = (top - base) / fh;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = B.xz[(s + i) * 2], z0 = B.xz[(s + i) * 2 + 1], x1 = B.xz[(s + j) * 2], z1 = B.xz[(s + j) * 2 + 1];
        const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz) || 1;
        const nx = dz / L, nz = -dx / L;
        const bays = Math.max(1, Math.round(L / P.bay));
        // A(base,i) B(base,j) C(top,j) D(top,i)
        const quad = [[x0, base, z0, 0, vBase], [x1, base, z1, bays, vBase], [x1, top, z1, bays, 0], [x0, top, z0, 0, 0]];
        for (let q = 0; q < 4; q++) {
          const o = v + q;
          pos[o * 3] = quad[q][0]; pos[o * 3 + 1] = quad[q][1]; pos[o * 3 + 2] = quad[q][2];
          nor[o * 3] = nx * 127; nor[o * 3 + 1] = 0; nor[o * 3 + 2] = nz * 127;
          col[o * 3] = wr; col[o * 3 + 1] = wg; col[o * 3 + 2] = wb;
          fuv[o * 2] = quad[q][3]; fuv[o * 2 + 1] = quad[q][4];
          finfo[o * 4] = plain ? 254 : st; finfo[o * 4 + 1] = seed; finfo[o * 4 + 2] = Math.min(255, nf); finfo[o * 4 + 3] = 0;
        }
        idx[ii++] = v; idx[ii++] = v + 2; idx[ii++] = v + 1;
        idx[ii++] = v; idx[ii++] = v + 3; idx[ii++] = v + 2;
        v += 4;
      }
      // roof
      const r0 = v;
      contour.length = 0;
      for (let i = 0; i < n; i++) {
        const x = B.xz[(s + i) * 2], z = B.xz[(s + i) * 2 + 1];
        const o = v++;
        pos[o * 3] = x; pos[o * 3 + 1] = top; pos[o * 3 + 2] = z;
        nor[o * 3] = 0; nor[o * 3 + 1] = 127; nor[o * 3 + 2] = 0;
        col[o * 3] = rr; col[o * 3 + 1] = rg; col[o * 3 + 2] = rb;
        fuv[o * 2] = x * 0.5; fuv[o * 2 + 1] = z * 0.5;
        finfo[o * 4] = 255; finfo[o * 4 + 1] = seed; finfo[o * 4 + 2] = 0; finfo[o * 4 + 3] = 0;
        contour.push(new THREE.Vector2(x, z));
      }
      let faces;
      if (n <= 4) {
        faces = n === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
        // concave quad guard
        if (n === 4 && !convexQuad(contour)) faces = THREE.ShapeUtils.triangulateShape(contour, []);
      } else {
        faces = THREE.ShapeUtils.triangulateShape(contour, []);
      }
      let used = 0;
      for (const f of faces) {
        if (used >= n - 2) break;
        const a = contour[f[0]], b = contour[f[1]], c = contour[f[2]];
        const cr = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y);
        if (cr >= 0) { idx[ii++] = r0 + f[0]; idx[ii++] = r0 + f[1]; idx[ii++] = r0 + f[2]; }
        else { idx[ii++] = r0 + f[0]; idx[ii++] = r0 + f[2]; idx[ii++] = r0 + f[1]; }
        used++;
      }
      // pad unused roof triangles with degenerate ones
      for (; used < n - 2; used++) { idx[ii++] = r0; idx[ii++] = r0; idx[ii++] = r0; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setAttribute('fuv', new THREE.BufferAttribute(fuv, 2));
    geo.setAttribute('finfo', new THREE.BufferAttribute(finfo, 4, false));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'bld-' + key;
    const small = key & 1;
    group.add(mesh);
    const c = new THREE.Vector3();
    geo.boundingBox.getCenter(c);
    chunks.push({ mesh, small, cx: c.x, cz: c.z, r: geo.boundingSphere.radius });
    tris += ii / 3;
  }

  const smallDist = quality === 'high' ? 1500 : quality === 'medium' ? 900 : 600;
  const bigDist = quality === 'high' ? 9000 : quality === 'medium' ? 6000 : 4000;
  function update(camera) {
    const px = camera.position.x, pz = camera.position.z;
    for (const ch of chunks) {
      const d = Math.hypot(ch.cx - px, ch.cz - pz) - ch.r * 0.5;
      ch.mesh.visible = d < (ch.small ? smallDist : bigDist);
    }
  }
  return { group, update, material, facadeTex, chunks, stats: { buildings: kept, triangles: tris, meshes: chunks.length } };
}

function convexQuad(c) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
    const cr = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
    if (cr !== 0) {
      if (sign === 0) sign = Math.sign(cr);
      else if (Math.sign(cr) !== sign) return false;
    }
  }
  return true;
}

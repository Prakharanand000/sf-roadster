// Terrain: 1 km chunks with 3 LODs (8/16/32 m) + skirts, coloured by a canvas "ground texture" painted
// from the landcover raster, roads and building footprints (AO halo), with shader detail noise and
// slope/shore tinting.
import * as THREE from 'three';

const CHUNK_CELLS = 125;   // 1000 m
// landcover palette (day): water, urban, park, wood, sand, lake, pier, pitch, scrub, rock, paved
const LC_COL = [[50, 64, 64], [104, 102, 97], [84, 116, 54], [52, 78, 40], [206, 190, 150], [56, 72, 64], [104, 96, 86],
  [78, 124, 52], [108, 112, 70], [112, 104, 92], [122, 120, 116]];

export function paintGroundCanvas(D, Q, width) {
  const lc = D.lcInfo;
  const W = width, Hh = Math.round((width * lc.nz) / lc.nx);
  // 1) class colours at landcover resolution
  const src = document.createElement('canvas');
  src.width = lc.nx; src.height = lc.nz;
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(lc.nx, lc.nz);
  const L = D.landcover;
  for (let i = 0; i < L.length; i++) {
    const c = LC_COL[L[i]] || LC_COL[1];
    // tiny dither so large areas are not flat
    const d = ((i * 2654435761) >>> 24) / 255 * 8 - 4;
    img.data[i * 4] = c[0] + d; img.data[i * 4 + 1] = c[1] + d; img.data[i * 4 + 2] = c[2] + d; img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = Hh;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, W, Hh);
  const sx = W / (lc.nx * lc.res), sz = Hh / (lc.nz * lc.res);
  const px = (x) => (x - lc.x0) * sx, pz = (z) => (z - lc.z0) * sz;
  // 2) building AO halo (JS-rasterised footprints, blurred, drawn scaled)
  {
    const mask = buildingMask(D);
    const blurred = boxBlur(mask, lc.nx, lc.nz, 1);
    const mc = document.createElement('canvas');
    mc.width = lc.nx; mc.height = lc.nz;
    const mctx = mc.getContext('2d');
    const mi = mctx.createImageData(lc.nx, lc.nz);
    for (let i = 0; i < blurred.length; i++) { mi.data[i * 4] = 28; mi.data[i * 4 + 1] = 28; mi.data[i * 4 + 2] = 30; mi.data[i * 4 + 3] = blurred[i] * 0.6; }
    mctx.putImageData(mi, 0, 0);
    ctx.drawImage(mc, 0, 0, W, Hh);
  }
  // 3) sidewalks then asphalt (batched by width)
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const pass of [0, 1]) {
    const buckets = new Map();
    for (const r of D.roads) {
      if (r.bridge) continue;
      const w = Math.max(1, Math.round((pass === 0 ? (r.sidewalk ? r.width + 6 : r.width + 1) : r.width) * sx * 2) / 2);
      if (!buckets.has(w)) buckets.set(w, []);
      buckets.get(w).push(r);
    }
    ctx.strokeStyle = pass === 0 ? 'rgb(140,138,132)' : 'rgb(58,59,62)';
    for (const [w, list] of buckets) {
      ctx.lineWidth = w;
      ctx.beginPath();
      for (const r of list) r.points.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))));
      ctx.stroke();
    }
  }
  return cv;
}

/** Rasterise building footprints onto the landcover grid (Uint8 0/255), even-odd scanline fill. */
export function buildingMask(D) {
  const lc = D.lcInfo, B = D.B;
  const NX = lc.nx, NZ = lc.nz, R = lc.res;
  const m = new Uint8Array(NX * NZ);
  const xs = [];
  for (let k = 0; k < B.count; k++) {
    const s = B.start[k], n = B.n[k];
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) { const z = B.xz[(s + i) * 2 + 1]; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    const j0 = Math.max(0, Math.ceil((z0 - lc.z0) / R - 0.5)), j1 = Math.min(NZ - 1, Math.floor((z1 - lc.z0) / R - 0.5));
    for (let j = j0; j <= j1; j++) {
      const zc = lc.z0 + (j + 0.5) * R;
      xs.length = 0;
      for (let i = 0, p = n - 1; i < n; p = i++) {
        const xi = B.xz[(s + i) * 2], zi = B.xz[(s + i) * 2 + 1], xp = B.xz[(s + p) * 2], zp = B.xz[(s + p) * 2 + 1];
        if ((zi > zc) !== (zp > zc)) xs.push(xi + ((zc - zi) * (xp - xi)) / (zp - zi));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - lc.x0) / R - 0.5)), i1 = Math.min(NX - 1, Math.floor((xs[q + 1] - lc.x0) / R - 0.5));
        if (i1 >= i0) m.fill(255, j * NX + i0, j * NX + i1 + 1);
      }
    }
  }
  return m;
}

/** separable box blur (radius r) of a Uint8 raster */
export function boxBlur(src, nx, nz, r) {
  const tmp = new Float32Array(nx * nz), out = new Uint8Array(nx * nz);
  const k = 2 * r + 1;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let a = 0;
      for (let d = -r; d <= r; d++) a += src[j * nx + Math.min(nx - 1, Math.max(0, i + d))];
      tmp[j * nx + i] = a / k;
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let a = 0;
      for (let d = -r; d <= r; d++) a += tmp[Math.min(nz - 1, Math.max(0, j + d)) * nx + i];
      out[j * nx + i] = a / k;
    }
  }
  return out;
}

function terrainMaterial(groundTex, uniforms) {
  const mat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.96, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uniforms.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying float vSlope;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(position, 1.0)).xyz;\nvSlope = 1.0 - normal.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWp; varying float vSlope;
float th(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float tn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(th(i), th(i+vec2(1,0)), f.x), mix(th(i+vec2(0,1)), th(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float n = tn(vWp.xz * 0.45) * 0.5 + tn(vWp.xz * 1.9) * 0.3 + tn(vWp.xz * 0.05) * 0.2;
  diffuseColor.rgb *= 0.84 + 0.32 * n;
  vec3 g = diffuseColor.rgb;
  float greenness = clamp((g.g - max(g.r, g.b)) * 6.0, 0.0, 1.0);
  // steep vegetated slopes -> dry grass / earth
  float st = smoothstep(0.18, 0.45, vSlope) * greenness;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.33, 0.29, 0.20) * (0.8 + 0.4 * n), st * 0.75);
  // wet shore band
  float wet = 1.0 - smoothstep(0.2, 1.4, vWp.y);
  diffuseColor.rgb *= 1.0 - wet * 0.35;
}`);
  };
  mat.customProgramCacheKey = () => 'sf-terrain-v1';
  return mat;
}

export function buildTerrain(D, Q, { quality = 'high', uniforms } = {}) {
  const g = D.grid;
  const NX = g.nx, NZ = g.nz, CELL = g.cell, H = D.H;
  const texW = quality === 'high' ? 4096 : quality === 'medium' ? 2700 : 2048;
  const canvas = paintGroundCanvas(D, Q, texW);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const material = terrainMaterial(tex, uniforms);
  const W = (NX - 1) * CELL, Dz = (NZ - 1) * CELL;
  const hAt = (i, j) => H[Math.min(NZ - 1, Math.max(0, j)) * NX + Math.min(NX - 1, Math.max(0, i))];

  function chunkGeometry(i0, i1, j0, j1, s, skirt) {
    const xs = [], zs = [];
    for (let i = i0; i < i1; i += s) xs.push(i);
    xs.push(i1);
    for (let j = j0; j < j1; j += s) zs.push(j);
    zs.push(j1);
    const nx = xs.length, nz = zs.length;
    const nv = nx * nz + 2 * (nx + nz);
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const idx = [];
    let v = 0;
    const put = (i, j, dy) => {
      const x = g.x0 + i * CELL, z = g.z0 + j * CELL, h = hAt(i, j);
      pos[v * 3] = x; pos[v * 3 + 1] = h - dy; pos[v * 3 + 2] = z;
      const hx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * CELL), hz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * CELL);
      const l = Math.hypot(hx, 1, hz);
      nor[v * 3] = -hx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = -hz / l;
      uv[v * 2] = (x - g.x0) / W; uv[v * 2 + 1] = (z - g.z0) / Dz;
      return v++;
    };
    for (let b = 0; b < nz; b++) for (let a = 0; a < nx; a++) put(xs[a], zs[b], 0);
    for (let b = 0; b < nz - 1; b++) {
      for (let a = 0; a < nx - 1; a++) {
        const p00 = b * nx + a, p10 = p00 + 1, p01 = p00 + nx, p11 = p01 + 1;
        // same split as Q.heightAt: (00,01,10) and (01,11,10); up-facing winding
        idx.push(p00, p01, p10, p01, p11, p10);
      }
    }
    if (skirt > 0) {
      const edge = (list) => {
        // list of [vertexIndex, i, j] along a border, in order
        const sk = list.map(([, i, j]) => put(i, j, skirt));
        for (let k = 0; k < list.length - 1; k++) {
          const a = list[k][0], b = list[k + 1][0], c = sk[k], d = sk[k + 1];
          idx.push(a, c, b, b, c, d, a, b, c, b, d, c); // both windings (cheap, avoids orientation bugs)
        }
      };
      edge(xs.map((i, a) => [a, i, zs[0]]));
      edge(xs.map((i, a) => [(nz - 1) * nx + a, i, zs[nz - 1]]));
      edge(zs.map((j, b) => [b * nx, xs[0], j]));
      edge(zs.map((j, b) => [b * nx + nx - 1, xs[nx - 1], j]));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, v * 2), 2));
    geo.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  const group = new THREE.Group();
  group.name = 'terrain';
  const lods = [];
  let tris0 = 0;
  const levels = quality === 'low' ? [[2, 0], [4, 1400]] : [[1, 0], [2, quality === 'high' ? 1500 : 1100], [4, 3000]];
  for (let j0 = 0; j0 < NZ - 1; j0 += CHUNK_CELLS) {
    for (let i0 = 0; i0 < NX - 1; i0 += CHUNK_CELLS) {
      const i1 = Math.min(i0 + CHUNK_CELLS, NX - 1), j1 = Math.min(j0 + CHUNK_CELLS, NZ - 1);
      let mx = -1e9;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mx = Math.max(mx, H[j * NX + i]);
      if (mx < -2.5) continue;   // fully under the (opaque) water
      const lod = new THREE.LOD();
      lod.position.set(0, 0, 0);
      for (const [s, dist] of levels) {
        const geo = chunkGeometry(i0, i1, j0, j1, s, s === 1 ? 3 : 8);
        const m = new THREE.Mesh(geo, material);
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        lod.addLevel(m, dist);
        if (s === levels[0][0]) tris0 += geo.index.count / 3;
      }
      // LOD distance is measured from the LOD object's position: put it at the chunk centre
      const cx = g.x0 + ((i0 + i1) / 2) * CELL, cz = g.z0 + ((j0 + j1) / 2) * CELL;
      lod.position.set(cx, 0, cz);
      for (const l of lod.levels) { l.object.position.set(-cx, 0, -cz); l.object.updateMatrix(); }
      group.add(lod);
      lods.push(lod);
    }
  }
  return { group, material, texture: tex, canvas, lods, stats: { chunks: lods.length, trianglesLod0: tris0 } };
}

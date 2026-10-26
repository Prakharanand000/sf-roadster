// CARS agent — shared helpers: monotone curves, procedural DataTextures (work in Node too),
// shared material library, geometry helpers.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Monotone cubic (Fritsch–Carlson / PCHIP) interpolation through [[x,y],...]. Clamped outside. */
export function curve(keys) {
  if (typeof keys === 'number') { const c = keys; return () => c; }
  if (typeof keys === 'function') return keys;
  const k = keys.slice().sort((a, b) => a[0] - b[0]);
  const n = k.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = k[i][0]; ys[i] = k[i][1]; }
  if (n === 1) return () => ys[0];
  const d = new Float64Array(n - 1), m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
      const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] > x) hi = mid; else lo = mid; }
    const h = xs[hi] - xs[lo], t = (x - xs[lo]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi];
  };
}

/** Seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- textures (DataTexture, Node-safe)
function dataTex(size, fn, { srgb = true, repeat = false, mip = true, h = size } = {}) {
  const data = new Uint8Array(size * h * 4);
  const c = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) for (let x = 0; x < size; x++) {
    c[0] = c[1] = c[2] = 0; c[3] = 255;
    fn((x + 0.5) / size, (y + 0.5) / h, c);
    const i = (y * size + x) * 4;
    data[i] = clamp(c[0], 0, 255); data[i + 1] = clamp(c[1], 0, 255); data[i + 2] = clamp(c[2], 0, 255); data[i + 3] = clamp(c[3], 0, 255);
  }
  const t = new THREE.DataTexture(data, size, h, THREE.RGBAFormat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  if (mip) { t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const texCache = new Map();
function cached(key, make) { let t = texCache.get(key); if (!t) { t = make(); texCache.set(key, t); } return t; }

/** Soft rounded-rect contact shadow (alpha in A, black RGB). */
export function shadowTexture() {
  return cached('shadow', () => dataTex(128, (u, v, c) => {
    const x = Math.abs(u * 2 - 1), y = Math.abs(v * 2 - 1);
    const p = 4, d = Math.pow(Math.pow(x, p) + Math.pow(y, p), 1 / p);
    const a = 1 - smoothstep(0.35, 1.0, d);
    c[0] = c[1] = c[2] = 0; c[3] = 255 * Math.pow(a, 1.6);
  }, { srgb: false }));
}

/** 2x2 twill carbon weave (color) — use with repeat. */
export function carbonTexture() {
  return cached('carbon', () => dataTex(128, (u, v, c) => {
    const n = 8; // tows per tile
    const fx = u * n, fy = v * n;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const over = ((ix + iy) >> 1) % 2 === 0; // 2x2 twill
    const t = over ? fx - ix : fy - iy;
    const shade = over ? 0.55 + 0.45 * Math.sin(t * Math.PI) : 0.25 + 0.35 * Math.sin(t * Math.PI);
    const g = 14 + 30 * shade;
    c[0] = g; c[1] = g; c[2] = g + 4;
  }, { repeat: true }));
}

/** Hex/diamond intake mesh: dark with slightly lighter webs. */
export function meshTexture(kind = 'hex') {
  return cached('mesh-' + kind, () => dataTex(64, (u, v, c) => {
    let web;
    if (kind === 'hex') {
      const sx = u * 4, sy = v * 4 * 0.866;
      const gx = sx - Math.floor(sx) - 0.5, gy = sy - Math.floor(sy) - 0.5;
      web = Math.max(Math.abs(gx) * 1.0 + Math.abs(gy) * 0.58, Math.abs(gy) * 1.15);
    } else if (kind === 'slats') {
      const t = (v * 6) % 1; web = t < 0.25 ? 1 : 0;
    } else { // diamond
      const a = ((u + v) * 4) % 1, b = ((u - v + 4) * 4) % 1;
      web = Math.max(Math.abs(a - 0.5), Math.abs(b - 0.5)) * 2;
    }
    const w = smoothstep(0.38, 0.47, web);
    const g = 6 + 34 * w;
    c[0] = g; c[1] = g; c[2] = g;
  }, { repeat: true }));
}

/** Brake disc: radial gradient metal with cross-drilled holes, alpha outside ring. */
export function discTexture() {
  return cached('disc', () => dataTex(256, (u, v, c) => {
    const x = u * 2 - 1, y = v * 2 - 1, r = Math.hypot(x, y), a = Math.atan2(y, x);
    if (r > 1 || r < 0.42) { c[3] = 0; c[0] = c[1] = c[2] = 30; return; }
    let g = 120 + 25 * Math.sin(r * 60);
    if (r < 0.58) g = 70; // hat
    // drilled holes in 3 staggered rings
    for (let k = 0; k < 3; k++) {
      const rr = 0.66 + k * 0.1, na = 24;
      const off = k * Math.PI / na * 0.66;
      const sa = ((a + off) % (2 * Math.PI / na) + 2 * Math.PI / na) % (2 * Math.PI / na) - Math.PI / na;
      const d = Math.hypot(sa * rr, r - rr);
      if (d < 0.022) g = 15;
    }
    c[0] = g; c[1] = g; c[2] = g + 3; c[3] = 255;
  }));
}

/** Additive jet gradient along v (v=0 at nozzle), radial falloff along u. */
export function jetTexture() {
  return cached('jet', () => dataTex(64, (u, v, c) => {
    const core = Math.pow(1 - v, 1.4);
    const e = Math.sin(u * Math.PI);
    const shock = 0.75 + 0.25 * Math.cos(v * 28);
    const k = core * Math.pow(e, 1.3) * shock;
    c[0] = 160 * k + 90 * k * k; c[1] = 200 * k + 55 * k * k; c[2] = 255 * k; c[3] = 255 * k;
  }, { srgb: false, mip: false }));
}

/** Soft round sprite (for particles). */
export function spriteTexture() {
  return cached('sprite', () => dataTex(64, (u, v, c) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = Math.pow(clamp(1 - r, 0, 1), 1.5);
    c[0] = c[1] = c[2] = 255; c[3] = 255 * a;
  }, { srgb: false }));
}

/** Smoke sprite with some noise lumps. */
export function smokeTexture() {
  return cached('smoke', () => {
    const r = rng(7); const blobs = [];
    for (let i = 0; i < 14; i++) blobs.push([0.25 + r() * 0.5, 0.25 + r() * 0.5, 0.12 + r() * 0.16]);
    return dataTex(64, (u, v, c) => {
      let a = 0;
      for (const b of blobs) { const d = Math.hypot(u - b[0], v - b[1]) / b[2]; a += Math.max(0, 1 - d * d) * 0.35; }
      const fall = clamp(1 - Math.hypot(u - 0.5, v - 0.5) * 2, 0, 1);
      c[0] = c[1] = c[2] = 255; c[3] = 255 * clamp(a * fall * 1.6, 0, 1);
    }, { srgb: false });
  });
}

/** Tyre sidewall/tread bump-ish color map (subtle). u around, v across profile. */
export function tireTexture() {
  return cached('tire', () => dataTex(256, (u, v, c) => {
    let g = 24;
    // tread blocks on the tread band (v in 0.3..0.7)
    if (v > 0.33 && v < 0.67) {
      const s = (u * 90) % 1; g = s < 0.08 ? 14 : 27;
    } else {
      // sidewall: fine ring lines + slightly lighter raised ring
      const rr = Math.abs(v - 0.5);
      if (rr > 0.38 && rr < 0.41) g = 34;
    }
    c[0] = c[1] = c[2] = g;
  }, { repeat: true }));
}

// ---------------------------------------------------------------- shared material library
const matCache = new Map();
export function sharedMat(key, make) { let m = matCache.get(key); if (!m) { m = make(); m.userData.shared = true; matCache.set(key, m); } return m; }

export const M = {
  black: () => sharedMat('black', () => new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.55, metalness: 0.2 })),
  gloss: () => sharedMat('gloss', () => new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.18, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 })),
  under: () => sharedMat('under', () => new THREE.MeshStandardMaterial({ color: 0x070708, roughness: 0.9, metalness: 0 })),
  carbon: () => sharedMat('carbon', () => {
    const t = carbonTexture().clone(); t.needsUpdate = true; t.repeat.set(6, 6);
    return new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: t, roughness: 0.32, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 });
  }),
  glass: () => sharedMat('glass', () => new THREE.MeshPhysicalMaterial({ color: 0x020305, roughness: 0.05, metalness: 0.0, ior: 1.5, specularIntensity: 0.6, envMapIntensity: 0.9 })),
  chrome: () => sharedMat('chrome', () => new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.08, metalness: 1 })),
  alu: () => sharedMat('alu', () => new THREE.MeshStandardMaterial({ color: 0xc8cacc, roughness: 0.22, metalness: 1 })),
  darkChrome: () => sharedMat('darkChrome', () => new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.15, metalness: 1 })),
  tire: () => sharedMat('tire', () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: tireTexture(), roughness: 0.88, metalness: 0 })),
  disc: () => sharedMat('disc', () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: discTexture(), roughness: 0.38, metalness: 0.85, alphaTest: 0.5, side: THREE.DoubleSide })),
  exhaust: () => sharedMat('exhaust', () => new THREE.MeshStandardMaterial({ color: 0x9a8f86, roughness: 0.3, metalness: 1 })),
  exhaustIn: () => sharedMat('exhaustIn', () => new THREE.MeshBasicMaterial({ color: 0x020202 })),
  meshHex: () => sharedMat('meshHex', () => { const t = meshTexture('hex').clone(); t.needsUpdate = true; t.repeat.set(10, 4); return new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.6, metalness: 0.3 }); }),
  meshDiamond: () => sharedMat('meshDiamond', () => { const t = meshTexture('diamond').clone(); t.needsUpdate = true; t.repeat.set(12, 4); return new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.6, metalness: 0.3 }); }),
  lensInner: () => sharedMat('lensInner', () => new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.12, metalness: 1 })),
  nozzle: () => sharedMat('nozzle', () => new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.25, metalness: 1 })),
  nozzleIn: () => sharedMat('nozzleIn', () => new THREE.MeshStandardMaterial({ color: 0x0d1a2a, roughness: 0.4, metalness: 0.5, emissive: 0x2a5cff, emissiveIntensity: 0.0 })),
  interior: () => sharedMat('interior', () => new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.8 })),
};

/** Ensure geometry has position/normal/uv (non-indexed safe) so groups can be merged. */
export function normalizeGeo(g) {
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (g.index === null) {
    const n = g.attributes.position.count, idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.clearGroups();
  return g;
}

/** Bucket of geometries keyed by material slot; merged at the end. */
export class GeoBucket {
  constructor() { this.map = new Map(); }
  add(slot, geo, matrix) {
    if (!geo) return;
    const g = normalizeGeo(geo.index ? geo : geo);
    if (matrix) g.applyMatrix4(matrix);
    let arr = this.map.get(slot); if (!arr) { arr = []; this.map.set(slot, arr); }
    arr.push(g);
  }
  /** Mirror (x -> -x) every geometry added since `fromCounts` snapshot. */
  merged() {
    const out = new Map();
    for (const [slot, arr] of this.map) {
      const g = arr.length === 1 ? arr[0] : mergeGeometries(arr, false);
      g.computeBoundingSphere(); g.computeBoundingBox();
      out.set(slot, g);
    }
    return out;
  }
}

/** Mirror a geometry across the YZ plane (x -> -x), fixing winding. Returns a new geometry. */
export function mirrorX(geo) {
  const g = geo.clone();
  g.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.index.needsUpdate = true;
  return g;
}

export function triCount(obj) {
  let n = 0;
  obj.traverse((o) => {
    if (!o.isMesh || !o.visible && o.userData.fx) return;
    if (!o.isMesh) return;
    const g = o.geometry; const c = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    n += o.isInstancedMesh ? c * o.count : c;
  });
  return Math.round(n);
}

export const tmpV = new THREE.Vector3();

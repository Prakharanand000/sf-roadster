// CARS agent — cheap traffic vehicles (< 3k triangles): sedan, hatch, SUV, pickup, van, SF taxi,
// Muni-style shuttle bus. Same CarModel interface as hero cars; setThruster is a no-op.
// Geometry is cached per variant (shared across instances); paint materials are cached per colour.
import * as THREE from 'three';
import { Body } from './body.js';
import { M, sharedMat, rng, shadowTexture, GeoBucket } from './util.js';
import { revolve, plateXY, roundRect } from './parts.js';

const VARIANTS = {
  sedan: {
    dims: { length: 4.75, width: 1.83, height: 1.45, wheelBase: 2.80, track: 1.58, wheelRadius: 0.33, rideHeight: 0.15, tireWidth: 0.22 },
    w: 0.3, colors: ['#e9e9e9', '#1d1f22', '#8c9196', '#5b0f14', '#20344f', '#c9c3b5', '#3c4a3e', '#7a7f85'],
    body: (L) => ({
      zF: L.f, zR: L.r, bevelF: 0.08, bevelR: 0.07,
      top: [[L.f, 0.62], [L.f - 0.15, 0.80], [L.f - 0.9, 0.92], [0.75, 0.97], [0.15, 1.42], [-0.6, 1.44], [-1.2, 1.1], [L.r + 0.3, 1.02], [L.r, 0.95]],
      halfW: [[L.f, 0.80], [L.f - 0.3, 0.9], [0, 0.915], [L.r + 0.3, 0.9], [L.r, 0.82]],
      sideY: [[L.f, 0.55], [0, 0.66], [L.r, 0.7]], shY: [[L.f, 0.76], [L.f - 0.4, 0.88], [0, 0.94], [L.r, 0.98]], shX: 0.93,
      upDrop: [[0.9, 0.01], [0.6, 0.06], [-1.0, 0.06], [-1.3, 0.01]], upX: [[1, 0.6], [0.5, 0.72], [-1, 0.72], [-1.4, 0.65]],
      sillY: 0.26, floorY: 0.18,
    }),
    greenhouse: [0.78, -1.25],
  },
  hatch: {
    dims: { length: 4.05, width: 1.78, height: 1.48, wheelBase: 2.55, track: 1.54, wheelRadius: 0.31, rideHeight: 0.15, tireWidth: 0.2 },
    w: 0.25, colors: ['#d63a2f', '#f0f0f0', '#2b6cb0', '#222', '#f2c14e', '#6b8f71', '#9aa0a6'],
    body: (L) => ({
      zF: L.f, zR: L.r, bevelF: 0.08, bevelR: 0.08,
      top: [[L.f, 0.65], [L.f - 0.15, 0.82], [0.95, 0.93], [0.6, 1.0], [0.0, 1.46], [-1.3, 1.44], [L.r + 0.1, 1.2], [L.r, 1.0]],
      halfW: [[L.f, 0.78], [L.f - 0.3, 0.88], [0, 0.89], [L.r, 0.84]],
      sideY: 0.66, shY: [[L.f, 0.78], [0, 0.95], [L.r, 0.98]], shX: 0.93,
      upDrop: [[0.7, 0.01], [0.4, 0.06], [-1.2, 0.06]], upX: [[1, 0.6], [0.4, 0.74], [-1.3, 0.76]],
      sillY: 0.26, floorY: 0.18,
    }),
    greenhouse: [0.62, -1.6],
  },
  suv: {
    dims: { length: 4.85, width: 1.93, height: 1.75, wheelBase: 2.85, track: 1.66, wheelRadius: 0.37, rideHeight: 0.21, tireWidth: 0.25 },
    w: 0.35, colors: ['#111', '#f5f5f5', '#6e7378', '#2c3e50', '#7b2d26', '#4b5d3a', '#b8a888'],
    body: (L) => ({
      zF: L.f, zR: L.r, bevelF: 0.1, bevelR: 0.08,
      top: [[L.f, 0.85], [L.f - 0.2, 1.0], [0.95, 1.1], [0.65, 1.18], [0.2, 1.72], [-1.6, 1.72], [L.r + 0.1, 1.6], [L.r, 1.3]],
      halfW: [[L.f, 0.86], [L.f - 0.3, 0.95], [0, 0.965], [L.r, 0.94]],
      sideY: 0.78, shY: [[L.f, 0.95], [0, 1.12], [L.r, 1.14]], shX: 0.94,
      upDrop: [[0.7, 0.01], [0.5, 0.06], [-1.8, 0.06]], upX: [[1, 0.62], [0.4, 0.8], [-1.8, 0.82]],
      sillY: 0.36, floorY: 0.25,
    }),
    greenhouse: [0.62, -1.95],
  },
  pickup: {
    dims: { length: 5.3, width: 1.98, height: 1.85, wheelBase: 3.4, track: 1.7, wheelRadius: 0.39, rideHeight: 0.24, tireWidth: 0.26 },
    w: 0.4, colors: ['#1b1b1b', '#e8e8e8', '#8b0000', '#3b4a5a', '#a0a4a8', '#2f4f2f'],
    body: (L) => ({
      zF: L.f, zR: L.r, bevelF: 0.08, bevelR: 0.04,
      top: [[L.f, 1.0], [L.f - 0.15, 1.15], [1.0, 1.22], [0.65, 1.3], [0.25, 1.85], [-0.8, 1.85], [-0.85, 1.25], [L.r, 1.25]],
      halfW: [[L.f, 0.92], [L.f - 0.3, 0.98], [0, 0.99], [L.r, 0.98]],
      sideY: 0.9, shY: [[L.f, 1.08], [0, 1.2], [L.r, 1.22]], shX: 0.96,
      upDrop: [[0.7, 0.01], [0.5, 0.06], [-0.75, 0.06], [-0.9, 0.0]], upX: [[1, 0.62], [0.4, 0.8], [-0.8, 0.82], [-0.9, 0.93]],
      sillY: 0.42, floorY: 0.3,
    }),
    greenhouse: [0.6, -0.78],
  },
  van: {
    dims: { length: 5.4, width: 2.0, height: 2.25, wheelBase: 3.4, track: 1.72, wheelRadius: 0.36, rideHeight: 0.2, tireWidth: 0.24 },
    w: 0.4, colors: ['#f4f4f4', '#e8e8e8', '#cfd3d6', '#1f3b70', '#2d2d2d', '#a31d1d'],
    body: (L) => ({
      zF: L.f, zR: L.r, bevelF: 0.12, bevelR: 0.06,
      top: [[L.f, 1.0], [L.f - 0.2, 1.15], [L.f - 0.65, 1.3], [L.f - 1.2, 2.2], [L.r + 0.1, 2.25], [L.r, 2.1]],
      halfW: [[L.f, 0.9], [L.f - 0.4, 0.99], [0, 1.0], [L.r, 0.99]],
      sideY: 0.95, shY: [[L.f, 1.05], [L.f - 0.8, 1.2], [L.r, 1.25]], shX: 0.97,
      upDrop: [[L.f - 0.6, 0.02], [L.f - 1.0, 0.05], [L.r, 0.05]], upX: [[L.f, 0.7], [L.f - 1.0, 0.92], [L.r, 0.94]],
      sillY: 0.38, floorY: 0.27,
    }),
    greenhouse: [1.75, 1.1],
  },
  taxi: null, // sedan + yellow livery + roof sign
  muni: {
    dims: { length: 7.6, width: 2.35, height: 2.9, wheelBase: 4.6, track: 2.0, wheelRadius: 0.48, rideHeight: 0.25, tireWidth: 0.3 },
    w: 0.6, colors: ['#e9e4d6'],
    body: (L) => ({
      zF: L.f, zR: L.r, bevelF: 0.15, bevelR: 0.12,
      top: [[L.f, 2.6], [L.f - 0.3, 2.85], [L.r + 0.3, 2.85], [L.r, 2.6]],
      halfW: [[L.f, 1.05], [L.f - 0.3, 1.17], [L.r + 0.3, 1.17], [L.r, 1.08]],
      sideY: 1.2, shY: [[L.f, 2.5], [0, 2.6], [L.r, 2.5]], shX: 0.98,
      upDrop: 0.08, upX: 0.88, sillY: 0.38, floorY: 0.3,
    }),
    greenhouse: null,
  },
};
VARIANTS.taxi = { ...VARIANTS.sedan, colors: ['#f6c200'], taxi: true };

const ORDER = ['sedan', 'sedan', 'hatch', 'suv', 'suv', 'pickup', 'van', 'taxi', 'sedan', 'hatch', 'muni', 'taxi'];
const geoCache = new Map();

function buildVariant(name) {
  if (geoCache.has(name)) return geoCache.get(name);
  const V = VARIANTS[name];
  const d = V.dims;
  const ovF = (d.length - d.wheelBase) * 0.5 + (name === 'muni' ? 0.4 : 0.05), ovR = d.length - d.wheelBase - ovF;
  const L = { f: d.wheelBase / 2 + ovF, r: -d.wheelBase / 2 - ovR };
  const def = { ...V.body(L), seg: [1, 1, 1, 1, 2, 2, 2], stationStep: name === 'muni' ? 0.5 : 0.32, archGap: 0.04, cheap: true };
  const body = new Body(def, d, { quality: 'high' });
  const bucket = new GeoBucket();
  for (const [slot, g] of body.build()) bucket.add(slot === 'black' || slot === 'under' ? 'black' : slot, g);
  // greenhouse glass
  if (V.greenhouse) {
    const [z0, z1] = V.greenhouse;
    if (name === 'van') {
      bucket.add('glass', body.patch({ proj: 's', z: [L.f - 1.15, L.f - 0.7], a0: 6.1, a1: 7.9, nz: 2, na: 4, mirror: false }));
      bucket.add('glass', body.patch({ proj: 's', z: [L.f - 1.4, L.f - 0.75], a0: 5.15, a1: 5.85, nz: 2, na: 1 }));
    } else {
      bucket.add('glass', body.patch({ proj: 's', z: [z1, z0], a0: 6.1, a1: 7.9, nz: 6, na: 4, mirror: false, off: 0.006 }));
      bucket.add('glass', body.patch({ proj: 's', z: [z1 + 0.05, z0 - 0.05], a0: 5.12, a1: 5.88, nz: 4, na: 1, off: 0.006 }));
    }
  } else if (name === 'muni') {
    // long window band + windshield
    bucket.add('glass', body.patch({ proj: 'side', z: [L.r + 0.5, L.f - 0.5], a0: 1.45, a1: 2.35, nz: 3, na: 1, off: 0.01, range: [2, 5.5] }));
    bucket.add('glass', plateXY(roundRect(0, 1.75, 2.0, 1.2, 0.12, 2), 0.02, L.f + 0.005));
    bucket.add('accent', body.patch({ proj: 'side', z: [L.r + 0.1, L.f - 0.1], a0: 0.95, a1: 1.25, nz: 3, na: 1, off: 0.008, range: [2, 5.5] }));
    bucket.add('accent', plateXY(roundRect(0, 0.95, 2.1, 0.25, 0.05, 2), 0.02, L.f + 0.005));
  }
  // lights
  const hy = name === 'muni' ? 0.75 : d.rideHeight + 0.5 + (name === 'suv' || name === 'pickup' || name === 'van' ? 0.25 : 0);
  for (const sx of [1, -1]) {
    bucket.add('head', plateXY(roundRect(sx * (d.width / 2 - 0.28), hy, 0.3, 0.09, 0.03, 2), 0.02, L.f + 0.002));
    bucket.add('tail', plateXY(roundRect(sx * (d.width / 2 - 0.22), hy + 0.1, 0.24, 0.12, 0.03, 2), 0.02, L.r - 0.002));
  }
  bucket.add('black', plateXY(roundRect(0, hy - 0.12, d.width * 0.5, 0.14, 0.04, 2), 0.02, L.f + 0.004));
  if (V.taxi) {
    const sign = plateXY(roundRect(0, 0, 0.6, 0.18, 0.05, 2), 0.16, 0);
    sign.translate(0, body.topY(-0.2) + 0.1, -0.2);
    bucket.add('signLit', sign);
    bucket.add('black', body.patch({ proj: 'side', z: [-1.2, 1.0], a0: 0.62, a1: 0.7, nz: 2, na: 1, off: 0.006, range: [2, 5.2] }));
  }
  const geos = bucket.merged();
  // simple wheel: low-poly tyre + hub disc
  const R = d.wheelRadius, W = d.tireWidth;
  const tire = revolve([[R - 0.1, -W / 2], [R - 0.02, -W / 2], [R, -W / 2 + 0.03], [R, W / 2 - 0.03], [R - 0.02, W / 2], [R - 0.1, W / 2]], 12);
  const hub = revolve([[0, W / 2 - 0.005], [R - 0.1, W / 2 - 0.005], [R - 0.1, W / 2 - 0.02]], 10);
  const res = { geos, tire, hub, L, d };
  geoCache.set(name, res);
  return res;
}

function paintMat(hex) {
  return sharedMat('tpaint-' + hex, () => new THREE.MeshPhysicalMaterial({ color: hex, metalness: 0.45, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.08 }));
}

export function createTrafficCarModel(seed = 0) {
  const r = rng((seed * 2654435761) >>> 0 || 1);
  const name = ORDER[Math.floor(r() * ORDER.length)];
  const V = VARIANTS[name];
  const built = buildVariant(name);
  const d = built.d;
  const color = V.colors[Math.floor(r() * V.colors.length)];
  const group = new THREE.Group(); group.name = 'traffic-' + name;
  const body = new THREE.Group(); group.add(body);
  const head = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xfff4e0, emissiveIntensity: 0.3, roughness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1a10, emissiveIntensity: 0.6, roughness: 0.2 });
  const mats = {
    paint: paintMat(color), glass: M.glass(), black: M.black(), head, tail,
    accent: sharedMat('muniRed', () => new THREE.MeshStandardMaterial({ color: 0xb3202a, roughness: 0.5 })),
    signLit: sharedMat('taxiSign', () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe9a0, emissiveIntensity: 1.2 })),
  };
  const paintMeshes = [];
  for (const [slot, g] of built.geos) {
    const m = new THREE.Mesh(g, mats[slot] || M.black()); m.castShadow = true; body.add(m);
    if (slot === 'paint') paintMeshes.push(m);
  }
  const wheelPivots = [], wheels = [];
  const corners = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (const [sx, sz] of corners) {
    const p = new THREE.Group(); p.position.set(sx * d.track / 2, d.wheelRadius, sz * d.wheelBase / 2);
    const w = new THREE.Group(); const inner = new THREE.Group(); if (sx < 0) inner.scale.x = -1;
    inner.add(new THREE.Mesh(built.tire, M.tire()), new THREE.Mesh(built.hub, M.alu()));
    w.add(inner); p.add(w); group.add(p); wheelPivots.push(p); wheels.push(w);
  }
  const shMat = sharedMat('tshadow', () => new THREE.MeshBasicMaterial({ map: shadowTexture(), color: 0, transparent: true, opacity: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  if (!built.shadowGeo) { built.shadowGeo = new THREE.PlaneGeometry(d.width + 0.5, d.length + 0.6); built.shadowGeo.rotateX(-Math.PI / 2); }
  const shGeo = built.shadowGeo;
  const contactShadow = new THREE.Mesh(shGeo, shMat); contactShadow.name = 'contactShadow'; contactShadow.position.set(0, 0.012, (built.L.f + built.L.r) / 2); contactShadow.renderOrder = -1;
  group.add(contactShadow);
  let brake = false;
  return {
    id: 'traffic-' + name, variant: name, group, body, wheelPivots, wheels, wheelBaseY: d.wheelRadius, wheelRadius: d.wheelRadius,
    thrusterNozzles: [], contactShadow, dims: d,
    setColor(hex) { const pm = paintMat(new THREE.Color(hex).getHex()); for (const m of paintMeshes) m.material = pm; },
    setBrake(on) { brake = !!on; tail.emissiveIntensity = brake ? 3.5 : 0.6; },
    setHeadlights(on) { head.emissiveIntensity = on ? 2.5 : 0.3; if (!brake) tail.emissiveIntensity = on ? 1.0 : 0.6; },
    setReverse() {}, setThruster() {}, update() {},
    dispose() { group.removeFromParent(); head.dispose(); tail.dispose(); },
  };
}

export const TRAFFIC_VARIANTS = Object.keys(VARIANTS);

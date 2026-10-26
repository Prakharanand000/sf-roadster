// CARS agent — entry: CARS specs, createCarModel(id, opts), createTrafficCarModel(seed).
//
// Car local frame (CONTRACTS.md): forward +Z, up +Y, left +X; origin on the ground between the
// axles; wheel order [FL, FR, RL, RR] = [(+x,+z), (-x,+z), (+x,-z), (-x,-z)].
// Everything is procedural (no downloaded models / logos): bodies are lofted parametric surfaces
// (src/cars/body.js) dressed with conforming patches (glass, lights, vents), plates and parts.
//
// Additions beyond the contract (all optional for callers):
//   createCarModel(id, { color, quality, headlightSpot })   headlightSpot:true adds a SpotLight
//   model.id, model.spec, model.contactShadow (Mesh, child of group at y≈0.01)
//   model.headlightSpot (SpotLight|null), model.update(dt) (optional; animates flicker/flaps even if
//   setThruster is not called every frame), model.setAccentColor(hex) (calipers), model.wheelRadius
//   thrusterNozzles[i].userData = { mode: 'boost'|'hover'|'side', radius }
//   CARS[i].dims.track = front track, dims.rearTrack, dims.tireWidth, dims.rearTireWidth
//   CARS[i].physics.downforce = coefficient k in F = k * v^2 (N per (m/s)^2)
//   Units: dims m, mass kg, maxSpeed m/s, forces N, thrusterCapacity s, jumpImpulse m/s.
import * as THREE from 'three';
import { Body } from './body.js';
import { M, sharedMat, GeoBucket, normalizeGeo, shadowTexture, jetTexture, spriteTexture, lerp } from './util.js';
import { wheelGeometry, nozzleGeometry, jetGeometry, mirrorGeometry, exhaustGeometry, plateXY, wingGeometry } from './parts.js';
import { DESIGNS } from './designs.js';
import { createTrafficCarModel as _traffic } from './traffic.js';

// ------------------------------------------------------------------------------------ specs
const P = (o) => Object.assign({ gears: 7 }, o);
export const CARS = [
  {
    id: 'roadster', name: 'Roadster', make: 'Tesla', tagline: 'SpaceX package: cold-gas thrusters, zero excuses.',
    engine: 'electric', colors: ['#b01020', '#f2f2f2', '#101114', '#1b3f8f', '#9aa3ab', '#d8c27a'],
    stats: { speed: 9.3, accel: 9.8, handling: 7.2, thrusters: 10 },
    dims: { length: 4.40, width: 2.00, height: 1.16, wheelBase: 2.65, track: 1.70, rearTrack: 1.68, wheelRadius: 0.35, rideHeight: 0.11, tireWidth: 0.265, rearTireWidth: 0.31 },
    physics: P({ mass: 1900, maxSpeed: 111, engineForce: 29000, brakeForce: 24000, gripFront: 1.30, gripRear: 1.34, steerMax: 0.56, driftFactor: 0.5, downforce: 0.45, thrusterCapacity: 6.0, thrusterForce: 19000, jumpImpulse: 9.0 }),
  },
  {
    id: 'gt3rs', name: '911 GT3 RS', make: 'Porsche', tagline: 'Swan-neck wing, 9,000 rpm flat-six, track scalpel.',
    engine: 'flat6', colors: ['#a9c63f', '#f4f4f2', '#1d1e20', '#c41e1e', '#2b5fa8', '#8b8f94'],
    stats: { speed: 6.9, accel: 6.8, handling: 10, thrusters: 5.5 },
    dims: { length: 4.57, width: 1.90, height: 1.30, wheelBase: 2.46, track: 1.62, rearTrack: 1.59, wheelRadius: 0.345, rideHeight: 0.10, tireWidth: 0.275, rearTireWidth: 0.325 },
    physics: P({ mass: 1450, maxSpeed: 82, engineForce: 13300, brakeForce: 21500, gripFront: 1.58, gripRear: 1.62, steerMax: 0.60, driftFactor: 0.45, downforce: 1.35, thrusterCapacity: 3.0, thrusterForce: 8500, jumpImpulse: 6.5 }),
  },
  {
    id: 'amgone', name: 'AMG ONE', make: 'Mercedes-AMG', tagline: 'A Formula 1 power unit with number plates.',
    engine: 'hybrid-v8', colors: ['#b9bdc2', '#111214', '#e6e6e6', '#0d6f6b', '#c0002a', '#2f3a4a'],
    stats: { speed: 8.4, accel: 7.6, handling: 9.2, thrusters: 6 },
    dims: { length: 4.756, width: 2.01, height: 1.26, wheelBase: 2.72, track: 1.70, rearTrack: 1.66, wheelRadius: 0.345, rideHeight: 0.095, tireWidth: 0.285, rearTireWidth: 0.335 },
    physics: P({ mass: 1695, maxSpeed: 98, engineForce: 17200, brakeForce: 24500, gripFront: 1.52, gripRear: 1.56, steerMax: 0.55, driftFactor: 0.42, downforce: 1.3, thrusterCapacity: 3.4, thrusterForce: 10500, jumpImpulse: 6.8 }),
  },
  {
    id: '720s', name: '720S', make: 'McLaren', tagline: 'Eye-socket stare, dihedral doors, telepathic steering.',
    engine: 'v8', colors: ['#f26b0f', '#e9e9e7', '#0f1012', '#2e6fb5', '#5a6a2e', '#a8acb0'],
    stats: { speed: 8.1, accel: 7.7, handling: 9.5, thrusters: 6 },
    dims: { length: 4.543, width: 1.93, height: 1.196, wheelBase: 2.67, track: 1.67, rearTrack: 1.62, wheelRadius: 0.34, rideHeight: 0.10, tireWidth: 0.245, rearTireWidth: 0.305 },
    physics: P({ mass: 1420, maxSpeed: 95, engineForce: 14400, brakeForce: 20500, gripFront: 1.50, gripRear: 1.54, steerMax: 0.58, driftFactor: 0.62, downforce: 0.65, thrusterCapacity: 3.4, thrusterForce: 8800, jumpImpulse: 7.0 }),
  },
  {
    id: 'revuelto', name: 'Revuelto', make: 'Lamborghini', tagline: 'V12 hybrid wedge with hexagons for eyes.',
    engine: 'v12', colors: ['#7fc241', '#f2b600', '#e8e8e8', '#141516', '#3557c4', '#c2410c'],
    stats: { speed: 8.3, accel: 8.2, handling: 8.1, thrusters: 6 },
    dims: { length: 4.75, width: 2.03, height: 1.16, wheelBase: 2.78, track: 1.72, rearTrack: 1.70, wheelRadius: 0.35, rideHeight: 0.105, tireWidth: 0.265, rearTireWidth: 0.335 },
    physics: P({ mass: 1772, maxSpeed: 97, engineForce: 20700, brakeForce: 25000, gripFront: 1.42, gripRear: 1.46, steerMax: 0.55, driftFactor: 0.56, downforce: 0.72, thrusterCapacity: 3.4, thrusterForce: 11000, jumpImpulse: 6.8 }),
  },
  {
    id: 'sf90', name: 'SF90 Stradale', make: 'Ferrari', tagline: 'Plug-in prancing horse with a shut-off Gurney.',
    engine: 'hybrid-v8', colors: ['#c4111a', '#f2c200', '#eeeeec', '#16181b', '#1f3d73', '#8f9499'],
    stats: { speed: 8.1, accel: 8.4, handling: 8.7, thrusters: 6 },
    dims: { length: 4.71, width: 1.97, height: 1.186, wheelBase: 2.65, track: 1.68, rearTrack: 1.65, wheelRadius: 0.345, rideHeight: 0.10, tireWidth: 0.255, rearTireWidth: 0.315 },
    physics: P({ mass: 1570, maxSpeed: 95, engineForce: 18300, brakeForce: 23000, gripFront: 1.46, gripRear: 1.50, steerMax: 0.56, driftFactor: 0.42, downforce: 0.79, thrusterCapacity: 3.4, thrusterForce: 9800, jumpImpulse: 6.8 }),
  },
  {
    id: 'chiron', name: 'Chiron', make: 'Bugatti', tagline: 'Sixteen cylinders, four turbos, 420 km/h.',
    engine: 'w16', colors: ['#1c4fa0', '#0d0f14', '#c9ccd1', '#7a0e14', '#e6e3dc', '#d36b00'],
    stats: { speed: 10, accel: 8.6, handling: 6.8, thrusters: 5.5 },
    dims: { length: 4.544, width: 2.038, height: 1.212, wheelBase: 2.711, track: 1.74, rearTrack: 1.70, wheelRadius: 0.355, rideHeight: 0.11, tireWidth: 0.285, rearTireWidth: 0.355 },
    physics: P({ mass: 1995, maxSpeed: 117, engineForce: 24300, brakeForce: 27000, gripFront: 1.30, gripRear: 1.34, steerMax: 0.52, driftFactor: 0.3, downforce: 0.5, thrusterCapacity: 3.0, thrusterForce: 11500, jumpImpulse: 6.2 }),
  },
  {
    id: 'nevera', name: 'Nevera', make: 'Rimac', tagline: '1,914 hp of silent Croatian violence.',
    engine: 'electric', colors: ['#2f6f8f', '#e8e9eb', '#141618', '#a7b0b8', '#c25a1c', '#4a2d6b'],
    stats: { speed: 9.7, accel: 10, handling: 7.9, thrusters: 7 },
    dims: { length: 4.75, width: 1.986, height: 1.208, wheelBase: 2.745, track: 1.69, rearTrack: 1.68, wheelRadius: 0.35, rideHeight: 0.10, tireWidth: 0.275, rearTireWidth: 0.315 },
    physics: P({ mass: 2300, maxSpeed: 114, engineForce: 36000, brakeForce: 30000, gripFront: 1.40, gripRear: 1.44, steerMax: 0.54, driftFactor: 0.4, downforce: 0.55, thrusterCapacity: 4.0, thrusterForce: 15000, jumpImpulse: 7.2 }),
  },
];
const SPEC = Object.fromEntries(CARS.map((c) => [c.id, c]));

// ------------------------------------------------------------------------------------ build cache
const buildCache = new Map();

function buildCar(id, quality) {
  const key = id + '|' + quality;
  let b = buildCache.get(key);
  if (b) { b.refs++; return b; }
  const spec = SPEC[id], design = DESIGNS[id];
  const dims = spec.dims;
  const body = new Body(design.body, dims, { quality });
  const bucket = new GeoBucket();
  const shell = body.build();
  for (const [slot, g] of shell) bucket.add(slot, g);
  const nozzles = [];
  const extras = []; // { name, slot, geo, pivot:[x,y,z] } for animated parts (flaps / active wings)
  const ctx = makeCtx(body, dims, bucket, nozzles, extras, quality);
  design.details(ctx);
  // nose / tail plan-view bulge warp (applied to everything except wheels)
  const geos = bucket.merged();
  if (design.body.noseBulge || design.body.tailBulge) for (const g of geos.values()) warp(g, body, design.body);
  for (const e of extras) if (design.body.noseBulge || design.body.tailBulge) warp(e.geo, body, design.body);
  const w = design.wheel || {};
  const fw = wheelGeometry(dims.wheelRadius, dims.tireWidth, w, quality);
  const rw = wheelGeometry(dims.wheelRadius, dims.rearTireWidth ?? dims.tireWidth, w, quality);
  b = { id, quality, geos, nozzles, extras, fw, rw, refs: 1, body };
  buildCache.set(key, b);
  return b;
}

function warp(g, body, D) {
  const p = g.attributes.position, n = g.attributes.normal;
  const zF = body.zF, zR = body.zR;
  const nb = D.noseBulge || 0, tb = D.tailBulge || 0;
  const nl = D.noseBulgeLen ?? 0.7, tl = D.tailBulgeLen ?? 0.6;
  const hwF = body.f.halfW(zF - nl * 0.3) + 0.05, hwR = body.f.halfW(zR + tl * 0.3) + 0.05;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    let f = 0, fx = 0, fz = 0;
    if (nb && z > zF - nl) {
      const t = Math.min(1, (z - (zF - nl)) / nl), s = t * t * (3 - 2 * t), ds = 6 * t * (1 - t) / nl;
      const u = Math.min(1, Math.abs(x) / hwF), q = 1 - u * u;
      f += nb * q * s; fz += nb * q * ds; fx += nb * s * (-2 * u * Math.sign(x) / hwF) * (Math.abs(x) < hwF ? 1 : 0);
    }
    if (tb && z < zR + tl) {
      const t = Math.min(1, ((zR + tl) - z) / tl), s = t * t * (3 - 2 * t), ds = -6 * t * (1 - t) / tl;
      const u = Math.min(1, Math.abs(x) / hwR), q = 1 - u * u;
      f -= tb * q * s; fz -= tb * q * ds; fx -= tb * s * (-2 * u * Math.sign(x) / hwR) * (Math.abs(x) < hwR ? 1 : 0);
    }
    if (f === 0) continue;
    p.setZ(i, z + f);
    if (n) {
      const k = 1 + fz;
      let nx = n.getX(i) - fx * n.getZ(i) / k, ny = n.getY(i), nz2 = n.getZ(i) / k;
      const l = Math.hypot(nx, ny, nz2) || 1; n.setXYZ(i, nx / l, ny / l, nz2 / l);
    }
  }
  p.needsUpdate = true; if (n) n.needsUpdate = true;
  g.computeBoundingBox(); g.computeBoundingSphere();
}

function makeCtx(B, dims, bucket, nozzles, extras, quality) {
  const ctx = {
    B, dims, quality, hi: quality === 'high',
    add(slot, geo) { if (geo) bucket.add(slot, geo); return geo; },
    addBoth(slot, geo) { if (!geo) return geo; const m = mirrorX(geo); bucket.add(slot, geo); bucket.add(slot, m); return geo; },
    patch(slot, spec) { return ctx.add(slot, B.patch(spec)); },
    plateFront(slot, pts, thick = 0.012, dz = 0.0) { return ctx.add(slot, plateXY(pts, thick, B.zF + dz)); },
    plateRear(slot, pts, thick = 0.012, dz = 0.0) { return ctx.add(slot, plateXY(pts, thick, B.zR - dz)); },
    mirrors(base, opts, slots = { housing: 'paint', glass: 'darkChrome', stalk: 'black' }) {
      const m = mirrorGeometry(base, opts);
      for (const k of ['housing', 'glass', 'stalk']) { ctx.add(slots[k], m[k].clone()); ctx.add(slots[k], mirrorX(m[k])); }
    },
    exhaust(x, y, z, r, shape = 'round', len = 0.14, sy = 1, both = false) {
      const e = exhaustGeometry(x, y, z + len, r, len, shape, sy); // z = tip position
      ctx.add('exhaust', e.metal); ctx.add('exhaustIn', e.dark);
      if (both) { ctx.add('exhaust', mirrorX(e.metal)); ctx.add('exhaustIn', mirrorX(e.dark)); }
    },
    /** dir: 'back' | 'down' | 'left' | 'right'. mode: 'boost' | 'hover' | 'side' */
    nozzle(x, y, z, dir, mode, r = 0.035, both = true) {
      const make = (xx) => {
        const o = new THREE.Object3D();
        o.position.set(xx, y, z);
        if (dir === 'back') o.rotation.y = Math.PI;
        else if (dir === 'down') o.rotation.x = Math.PI / 2;
        else if (dir === 'left') o.rotation.y = Math.PI / 2;
        else if (dir === 'right') o.rotation.y = -Math.PI / 2;
        if (dir === 'left' && xx < 0) o.rotation.y = -Math.PI / 2;
        o.updateMatrix();
        const g = nozzleGeometry(r);
        const gm = g.metal.clone().applyMatrix4(o.matrix), gi = g.inner.clone().applyMatrix4(o.matrix);
        ctx.add('nozzle', gm); ctx.add('nozzleIn', gi);
        nozzles.push({ pos: o.position.clone(), quat: o.quaternion.clone(), mode, r });
      };
      make(x); if (both && Math.abs(x) > 1e-3) make(-x);
    },
    wing(span, chord, { x = 0, y, z, aoa = 8, thick = 0.12, camber = -0.05, curveDown = 0, slot = 'carbon' }) {
      const g = wingGeometry(span, chord, thick, aoa, camber, curveDown); g.translate(x, y, z); return ctx.add(slot, g);
    },
    extra(name, slot, geo, pivot) { extras.push({ name, slot, geo, pivot }); },
  };
  return ctx;
}

function mirrorX(geo) {
  const g = normalizeGeo(geo.clone());
  g.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  if (g.index) { const idx = g.index.array; for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } }
  return g;
}

// ------------------------------------------------------------------------------------ materials
function paintMaterial(hex) {
  return new THREE.MeshPhysicalMaterial({ color: new THREE.Color(hex), metalness: 0.5, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 0.9 });
}
function rimMat(w) {
  const c = w.rimColor ?? 0x2b2d30, metal = w.rimMetal ?? 0.9, rough = w.rimRough ?? 0.28;
  return sharedMat('rim-' + c + '-' + metal + '-' + rough, () => new THREE.MeshPhysicalMaterial({ color: c, metalness: metal, roughness: rough, clearcoat: w.rimClear ?? 0.6, clearcoatRoughness: 0.1 }));
}
function rimDarkMat() { return sharedMat('rimDark', () => new THREE.MeshStandardMaterial({ color: 0x1b1c1e, metalness: 0.8, roughness: 0.5 })); }
function accentMat(hex) { return sharedMat('accent-' + hex, () => new THREE.MeshPhysicalMaterial({ color: hex, metalness: 0.2, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 })); }

function slotMaterial(slot, inst, design) {
  switch (slot) {
    case 'paint': return inst.paint;
    case 'paint2': return inst.paint2;
    case 'head': return inst.head;
    case 'drl': return inst.drl;
    case 'tail': return inst.tail;
    case 'reverse': return inst.reverse;
    case 'nozzleIn': return inst.nozzleIn;
    case 'accent': return accentMat(design.accent ?? 0xd01818);
    case 'accent2': return accentMat(design.accent2 ?? 0xc0c0c0);
    case 'tailDark': return sharedMat('tailDark', () => new THREE.MeshPhysicalMaterial({ color: 0x3a0306, roughness: 0.08, metalness: 0.2, clearcoat: 1, transparent: false }));
    case 'redGlow': return sharedMat('redGlow', () => new THREE.MeshStandardMaterial({ color: 0x200000, emissive: 0xff2020, emissiveIntensity: 1.2 }));
    default: return (M[slot] || M.black)();
  }
}

// ------------------------------------------------------------------------------------ model
const _tmpQ = new THREE.Quaternion();

export function createCarModel(id, { color, quality = 'high', headlightSpot = false } = {}) {
  const spec = SPEC[id];
  if (!spec) throw new Error('Unknown car id ' + id);
  const design = DESIGNS[id];
  const built = buildCar(id, quality);
  const dims = spec.dims;
  const group = new THREE.Group(); group.name = 'car-' + id;
  const body = new THREE.Group(); body.name = 'body'; group.add(body);

  const inst = {
    paint: paintMaterial(color || spec.colors[0]),
    paint2: paintMaterial(design.paint2 ?? 0x111111),
    head: new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.08, metalness: 0.9, emissive: new THREE.Color(design.headColor ?? 0xf2f6ff), emissiveIntensity: 0.0 }),
    drl: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0, emissive: new THREE.Color(design.drlColor ?? 0xeaf2ff), emissiveIntensity: 2.2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x2a0000, roughness: 0.15, metalness: 0.1, emissive: new THREE.Color(0xff1a12), emissiveIntensity: 1.0 }),
    reverse: new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.15, metalness: 0.2, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.0 }),
    nozzleIn: M.nozzleIn().clone(),
  };
  if (design.paint2Metal !== undefined) { inst.paint2.metalness = design.paint2Metal; inst.paint2.roughness = design.paint2Rough ?? 0.3; }
  const meshes = [];
  for (const [slot, geo] of built.geos) {
    const m = new THREE.Mesh(geo, slotMaterial(slot, inst, design));
    m.name = slot;
    m.castShadow = slot !== 'glass' || true;
    m.receiveShadow = false;
    body.add(m); meshes.push(m);
  }
  // animated extras (flaps / active wings)
  const extras = {};
  for (const e of built.extras) {
    const pivot = new THREE.Group(); pivot.position.fromArray(e.pivot);
    const geo = e.geo.clone(); geo.translate(-e.pivot[0], -e.pivot[1], -e.pivot[2]);
    const m = new THREE.Mesh(geo, slotMaterial(e.slot, inst, design)); m.castShadow = true;
    pivot.add(m); body.add(pivot);
    (extras[e.name] || (extras[e.name] = [])).push(pivot);
  }

  // wheels
  const w = design.wheel || {};
  const rimM = rimMat(w), calM = accentMat(w.caliper ?? 0xc81e1e);
  const coverM = w.coverSlot ? slotMaterial(w.coverSlot, inst, design) : rimM;
  const wheelPivots = [], wheels = [];
  const R = dims.wheelRadius;
  const corners = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (let i = 0; i < 4; i++) {
    const [sx, sz] = corners[i];
    const tr = sz > 0 ? dims.track : (dims.rearTrack ?? dims.track);
    const gs = sz > 0 ? built.fw : built.rw;
    const pivot = new THREE.Group(); pivot.name = ['FL', 'FR', 'RL', 'RR'][i];
    pivot.position.set(sx * tr / 2, R, sz * dims.wheelBase / 2);
    const wheel = new THREE.Group(); wheel.name = 'wheel';
    const inner = new THREE.Group(); if (sx < 0) inner.scale.x = -1;
    const tire = new THREE.Mesh(gs.tire, M.tire()); tire.castShadow = true;
    const rim = new THREE.Mesh(gs.rim, w.type === 'aero' ? coverM : rimM); rim.castShadow = true;
    const barrel = new THREE.Mesh(gs.barrel, rimDarkMat());
    const disc = new THREE.Mesh(gs.disc, M.disc());
    inner.add(tire, rim, barrel, disc);
    wheel.add(inner);
    const calHolder = new THREE.Group(); if (sx < 0) calHolder.scale.x = -1;
    const cal = new THREE.Mesh(gs.caliper, calM); calHolder.add(cal);
    pivot.add(wheel, calHolder);
    group.add(pivot);
    wheelPivots.push(pivot); wheels.push(wheel);
  }

  // thruster nozzles + jets
  const jetTex = jetTexture(), glowTex = spriteTexture();
  const jetMats = [];
  const mkJetMat = (op, col) => {
    const m = new THREE.MeshBasicMaterial({ map: jetTex, color: col, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    jetMats.push(m); return m;
  };
  const coreMat = mkJetMat(1, new THREE.Color(1.6, 1.9, 2.4));
  const outerMat = mkJetMat(0.55, new THREE.Color(0.35, 0.6, 1.6));
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(0.8, 1.1, 2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  jetMats.push(glowMat);
  const thrusterNozzles = [];
  const jets = [];
  for (const nz of built.nozzles) {
    const a = new THREE.Object3D(); a.position.copy(nz.pos); a.quaternion.copy(nz.quat);
    a.userData = { mode: nz.mode, radius: nz.r };
    const jg = new THREE.Group(); jg.visible = false;
    const core = new THREE.Mesh(jetGeometry(), coreMat); core.scale.set(nz.r * 0.7, nz.r * 0.7, 1);
    const outer = new THREE.Mesh(jetGeometry(), outerMat); outer.scale.set(nz.r * 1.6, nz.r * 1.6, 1);
    core.renderOrder = outer.renderOrder = 10;
    const glow = new THREE.Sprite(glowMat); glow.scale.setScalar(nz.r * 6); glow.position.z = 0.02; glow.renderOrder = 11;
    jg.add(core, outer, glow);
    a.add(jg); body.add(a);
    thrusterNozzles.push(a);
    jets.push({ anchor: a, group: jg, core, outer, glow, mode: nz.mode, r: nz.r, seed: Math.random() * 10 });
  }

  // contact shadow
  const shMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), color: 0x000000, transparent: true, opacity: 0.82, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const shGeo = new THREE.PlaneGeometry(dims.width + 0.55, dims.length + 0.7); shGeo.rotateX(-Math.PI / 2);
  const contactShadow = new THREE.Mesh(shGeo, shMat); contactShadow.position.y = 0.012; contactShadow.renderOrder = -1; contactShadow.name = 'contactShadow';
  contactShadow.position.z = (built.body.zF + built.body.zR) / 2;
  group.add(contactShadow);

  // optional headlight spot
  let spot = null;
  if (headlightSpot) {
    spot = new THREE.SpotLight(0xf4f7ff, 0, 90, 0.55, 0.65, 1.4);
    spot.position.set(0, 0.62, built.body.zF - 0.25);
    spot.target.position.set(0, 0.0, built.body.zF + 22);
    spot.castShadow = false;
    body.add(spot, spot.target);
  }

  // state
  let thrLevel = 0, thrMode = 'boost', brake = false, rev = false, heads = false;
  let flap = 0;
  const flaps = extras.flap || [];
  const activeWings = extras.wing || [];
  let wingAngle = 0;

  const applyThruster = (now) => {
    const t = now * 0.001;
    const lvl = thrLevel;
    for (const j of jets) {
      const on = lvl > 0.01 && (j.mode === thrMode || (thrMode === 'boost' && j.mode === 'side' && lvl > 0.5));
      j.group.visible = on;
      if (!on) continue;
      const fl = 0.82 + 0.12 * Math.sin(t * 61 + j.seed * 7) + 0.08 * Math.sin(t * 143 + j.seed * 3) + 0.06 * Math.random();
      const L = (j.mode === 'hover' ? 0.7 : j.mode === 'side' ? 0.45 : 1.5) * (0.35 + 0.65 * lvl) * fl * (j.r / 0.035) ** 0.6;
      j.core.scale.z = L * 0.75; j.outer.scale.z = L;
      const wv = 1 + 0.08 * Math.sin(t * 90 + j.seed);
      j.outer.scale.x = j.outer.scale.y = j.r * 1.6 * wv;
      j.glow.scale.setScalar(j.r * (5 + 3 * lvl) * fl);
    }
    coreMat.opacity = Math.min(1, 0.4 + 0.6 * lvl);
    outerMat.opacity = 0.25 + 0.35 * lvl;
    inst.nozzleIn.emissiveIntensity = lvl > 0.01 ? 0.5 + 2.5 * lvl : 0;
  };

  let lastTick = -1;
  const tick = () => {
    const now = performance.now();
    const dt = lastTick < 0 ? 0.016 : Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    applyThruster(now);
    const target = thrLevel > 0.02 && thrMode === 'boost' ? 1 : 0;   // license-plate flap opens with boost
    flap += (target - flap) * Math.min(1, dt * 12);
    for (const f of flaps) f.rotation.x = flap * 1.9;
    const wt = brake ? 1 : 0; wingAngle += (wt - wingAngle) * Math.min(1, dt * 6);  // active wing / airbrake
    for (const wg of activeWings) wg.rotation.x = wingAngle * 0.45;
  };
  const model = {
    id, spec, group, body, wheelPivots, wheels, wheelBaseY: R, wheelRadius: R, thrusterNozzles, contactShadow, headlightSpot: spot,
    setColor(hex) { inst.paint.color.set(hex); },
    setAccentColor(hex) { calM.color?.set(hex); },
    setBrake(on) { brake = !!on; inst.tail.emissiveIntensity = brake ? 4.5 : (heads ? 1.4 : 1.0); },
    setHeadlights(on) {
      heads = !!on; inst.head.emissiveIntensity = heads ? 3.2 : 0.0;
      inst.drl.emissiveIntensity = heads ? 3.0 : 2.2;
      if (!brake) inst.tail.emissiveIntensity = heads ? 1.4 : 1.0;
      if (spot) spot.intensity = heads ? 220 : 0;
    },
    setReverse(on) { rev = !!on; inst.reverse.emissiveIntensity = rev ? 2.5 : 0; },
    setThruster(level, mode = 'boost') {
      thrLevel = Math.max(0, Math.min(1, level || 0)); thrMode = mode || 'boost';
      tick();
    },
    /** Optional per-frame call; animations also advance from setThruster() (wall-clock based). */
    update() { tick(); },
    dispose() {
      group.removeFromParent();
      for (const k of ['paint', 'paint2', 'head', 'drl', 'tail', 'reverse', 'nozzleIn']) inst[k].dispose();
      for (const m of jetMats) m.dispose();
      shMat.dispose(); shGeo.dispose();
      for (const p of Object.values(extras).flat()) p.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      built.refs--;
      if (built.refs <= 0) { for (const g of built.geos.values()) g.dispose(); buildCache.delete(built.id + '|' + built.quality); }
    },
  };
  model.setHeadlights(false); model.setBrake(false);
  return model;
}

export function createTrafficCarModel(seed) { return _traffic(seed); }
export { DESIGNS };
void _tmpQ; void lerp; void M;

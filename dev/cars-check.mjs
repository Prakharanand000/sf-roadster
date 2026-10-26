// CARS agent — Node verification: builds every car + traffic variant, prints triangle counts,
// bounding boxes vs dims, tyre contact with y=0, forward axis and wheel pivots.
// Run from sf-roadster/:  node dev/cars-check.mjs
import * as THREE from 'three';
import { CARS, createCarModel, createTrafficCarModel } from '../src/cars/models.js';
import { triCount } from '../src/cars/util.js';
import { CarFX } from '../src/cars/fx.js';
import { createShowroom } from '../src/cars/showroom.js';

const f = (v) => v.toFixed(3);
let bad = 0;
const warn = (m) => { bad++; console.log('   !! ' + m); };

function boxOf(obj, filter) {
  const box = new THREE.Box3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!o.isMesh || o.name === 'contactShadow') return;
    if (filter && !filter(o)) return;
    let p = o; let vis = true; while (p) { if (p.visible === false) vis = false; p = p.parent; }
    if (!vis) return;
    o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
  });
  return box;
}

for (const quality of process.argv.includes('--all') ? ['high', 'medium', 'low'] : ['high']) {
  console.log(`\n=== quality: ${quality} ===`);
  for (const spec of CARS) {
    const t0 = performance.now();
    const m = createCarModel(spec.id, { quality });
    const ms = performance.now() - t0;
    const tris = triCount(m.group);
    const d = spec.dims;
    const bodyBox = boxOf(m.body);
    const wheelBox = boxOf(m.group, (o) => { let p = o; while (p) { if (m.wheelPivots.includes(p)) return true; p = p.parent; } return false; });
    const all = boxOf(m.group);
    const size = all.getSize(new THREE.Vector3());
    let calls = 0; m.group.traverse((o) => { if (o.isMesh) calls++; });
    console.log(`${spec.id.padEnd(9)} tris=${String(tris).padStart(6)} meshes=${calls} build=${ms.toFixed(0)}ms`);
    console.log(`   size L=${f(size.z)} (dims ${d.length}) W=${f(size.x)} (dims ${d.width}) H=${f(size.y)} (dims ${d.height})`);
    console.log(`   body z ${f(bodyBox.min.z)}..${f(bodyBox.max.z)}  x ${f(bodyBox.min.x)}..${f(bodyBox.max.x)}  y ${f(bodyBox.min.y)}..${f(bodyBox.max.y)}`);
    console.log(`   wheels minY=${f(wheelBox.min.y)} (tyre contact)  x ${f(wheelBox.min.x)}..${f(wheelBox.max.x)}`);
    console.log('   pivots ' + m.wheelPivots.map((p) => `${p.name}(${f(p.position.x)},${f(p.position.y)},${f(p.position.z)})`).join(' ') + `  wheelBaseY=${m.wheelBaseY}`);
    console.log(`   nozzles ${m.thrusterNozzles.length}: ` + m.thrusterNozzles.map((n) => n.userData.mode[0]).join(''));
    if (Math.abs(wheelBox.min.y) > 0.006) warn('tyres do not touch y=0');
    if (Math.abs(size.z - d.length) > 0.12) warn('length mismatch');
    if (Math.abs(bodyBox.max.x - bodyBox.min.x - d.width) > 0.12 && Math.abs(size.x - d.width) > 0.3) warn('width mismatch');
    if (Math.abs(bodyBox.max.y - d.height) > 0.1) warn('height mismatch ' + f(bodyBox.max.y));
    if (bodyBox.max.z < -bodyBox.min.z - 0.6) warn('forward not +Z?');
    const [FL, FR, RL, RR] = m.wheelPivots.map((p) => p.position);
    if (!(FL.x > 0 && FL.z > 0 && FR.x < 0 && FR.z > 0 && RL.x > 0 && RL.z < 0 && RR.x < 0 && RR.z < 0)) warn('wheel order wrong');
    if (Math.abs(FL.z - RL.z - d.wheelBase) > 1e-6) warn('wheelbase mismatch');
    if (tris > 60000) warn('over 60k triangles');
    // API smoke
    m.setColor('#123456'); m.setBrake(true); m.setHeadlights(true); m.setReverse(true); m.setThruster(1, 'boost'); m.setThruster(0.5, 'hover'); m.setThruster(0, 'boost'); m.update?.(0.016);
    m.dispose();
  }
}

console.log('\n=== traffic ===');
const seen = new Map();
for (let s = 0; s < 60; s++) {
  const m = createTrafficCarModel(s);
  if (seen.has(m.variant)) { m.dispose(); continue; }
  const tris = triCount(m.group);
  const b = boxOf(m.group); const size = b.getSize(new THREE.Vector3());
  seen.set(m.variant, tris);
  console.log(`${m.variant.padEnd(8)} tris=${String(tris).padStart(5)} L=${f(size.z)} W=${f(size.x)} H=${f(size.y)} minY=${f(b.min.y)}`);
  if (tris > 3000) warn('traffic over 3k tris');
  if (Math.abs(b.min.y) > 0.006) warn('traffic tyres not at y=0');
  m.setBrake(true); m.setHeadlights(true); m.setThruster(1, 'boost');
}

// FX smoke test
const scene = new THREE.Scene();
const fx = new CarFX(scene);
const car = createCarModel('roadster'); scene.add(car.group);
const h = fx.add(car);
const state = {
  position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(0, 0, 20), heading: 0, speed: 20,
  onGround: true, airTime: 0, drifting: true, driftAngle: 0.4, slip: 0.9, boosting: true, hovering: false, thrusterFuel: 1,
  wheelContacts: [0, 1, 2, 3].map((i) => ({ x: (i % 2 ? -0.8 : 0.8), y: 0, z: i < 2 ? 1.3 : -1.3, onGround: true, slip: 0.9 })), surface: 'road', inWater: false, lastImpact: 0,
};
for (let i = 0; i < 300; i++) { state.position.z += 0.3; for (const c of state.wheelContacts) c.z += 0.3; fx.update(1 / 60, h, state); }
fx.burst('collision', new THREE.Vector3()); fx.burst('land', new THREE.Vector3()); fx.burst('splash', new THREE.Vector3()); fx.burst('checkpoint', new THREE.Vector3());
for (let i = 0; i < 60; i++) fx.update(1 / 60, h, state);
fx.clear();
console.log('\nfx ok');
const sr = createShowroom({ reflector: false });
sr.carAnchor.add(createCarModel('chiron').group); sr.update(0.5); sr.setVisible(false);
let lights = 0;
sr.group.traverse((o) => { if (o.isLight) { lights++; if ((o.isSpotLight || o.isPointLight) && !(o.distance > 0 && o.distance < 100)) warn('showroom light without short distance: ' + o.type); } });
console.log(`showroom ok: y=${sr.group.position.y}, lights=${lights}, cameraPos=${sr.cameraPos.toArray().map((v) => v.toFixed(2)).join(',')}`);
console.log(bad ? `\n${bad} warning(s)` : '\nall checks passed');

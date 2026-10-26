// Mock car specs + box CarModels for physics tests (PHYSICS agent; not shipped).
// The real specs/models come from src/cars/models.js (CARS agent). The SAMPLE_SPECS
// physics blocks show the value ranges this physics module is tuned for.
import * as THREE from 'three';

export const SAMPLE_SPECS = [
  {
    id: 'roadster', name: 'Mock Roadster', engine: 'electric', colors: ['#c8102e'],
    dims: { length: 4.3, width: 1.95, height: 1.2, wheelBase: 2.6, track: 1.65, wheelRadius: 0.35, rideHeight: 0.12 },
    physics: { mass: 1900, maxSpeed: 111, engineForce: 20000, brakeForce: 23000, gripFront: 1.35, gripRear: 1.38,
      steerMax: 0.6, driftFactor: 0.55, downforce: 0.15, thrusterCapacity: 6, thrusterForce: 15000, jumpImpulse: 11, gears: 7 },
  },
  {
    id: 'gt3rs', name: 'Mock GT3 RS', engine: 'flat6', colors: ['#2a6f3a'],
    dims: { length: 4.57, width: 1.9, height: 1.3, wheelBase: 2.46, track: 1.6, wheelRadius: 0.34, rideHeight: 0.1 },
    physics: { mass: 1450, maxSpeed: 82, engineForce: 12000, brakeForce: 21000, gripFront: 1.5, gripRear: 1.55,
      steerMax: 0.62, driftFactor: 0.4, downforce: 0.5, thrusterCapacity: 4, thrusterForce: 9500, jumpImpulse: 10.5, gears: 7, drive: 'rwd' },
  },
  {
    id: 'chiron', name: 'Mock Chiron', engine: 'w16', colors: ['#1d3b8f'],
    dims: { length: 4.54, width: 2.04, height: 1.21, wheelBase: 2.71, track: 1.7, wheelRadius: 0.36, rideHeight: 0.11 },
    physics: { mass: 1995, maxSpeed: 117, engineForce: 21000, brakeForce: 26000, gripFront: 1.3, gripRear: 1.35,
      steerMax: 0.55, driftFactor: 0.3, downforce: 0.3, thrusterCapacity: 4, thrusterForce: 13000, jumpImpulse: 10.5, gears: 7 },
  },
];

function box(w, h, l, mat) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat); }

// Box car honoring the CarModel contract.
export function createMockCarModel(spec, { color } = {}) {
  const d = spec.dims;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const paint = new THREE.MeshStandardMaterial({ color: color || (spec.colors && spec.colors[0]) || '#cc2222', roughness: 0.4, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: '#15171c', roughness: 0.6 });
  const lower = box(d.width, 0.5, d.length, paint);
  lower.position.y = d.rideHeight + 0.25 + 0.05;
  body.add(lower);
  const cabin = box(d.width * 0.8, d.height - 0.6, d.length * 0.45, dark);
  cabin.position.set(0, d.rideHeight + 0.55 + (d.height - 0.6) / 2, -d.length * 0.05);
  body.add(cabin);
  // nose marker so forward is readable
  const nose = box(d.width * 0.6, 0.08, 0.3, new THREE.MeshStandardMaterial({ color: '#ffffff' }));
  nose.position.set(0, d.rideHeight + 0.56, d.length / 2 - 0.3);
  body.add(nose);
  const brakeMat = new THREE.MeshStandardMaterial({ color: '#400', emissive: '#ff0000', emissiveIntensity: 0.2 });
  const revMat = new THREE.MeshStandardMaterial({ color: '#333', emissive: '#ffffff', emissiveIntensity: 0 });
  for (const s of [1, -1]) {
    const bl = box(0.4, 0.12, 0.05, brakeMat); bl.position.set(s * d.width * 0.32, d.rideHeight + 0.45, -d.length / 2 - 0.02); body.add(bl);
    const rl = box(0.15, 0.1, 0.05, revMat); rl.position.set(s * d.width * 0.12, d.rideHeight + 0.45, -d.length / 2 - 0.02); body.add(rl);
  }
  const flameMat = new THREE.MeshBasicMaterial({ color: '#66ccff', transparent: true, opacity: 0.85 });
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.6, 10), flameMat);
  flame.rotation.x = -Math.PI / 2;
  flame.position.set(0, d.rideHeight + 0.35, -d.length / 2 - 0.8);
  flame.visible = false;
  body.add(flame);
  const nozzle = new THREE.Object3D(); nozzle.position.set(0, d.rideHeight + 0.35, -d.length / 2); body.add(nozzle);

  const wheelPivots = [], wheels = [];
  const tyre = new THREE.MeshStandardMaterial({ color: '#222', roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: '#bbb', metalness: 0.8, roughness: 0.3 });
  const wgeo = new THREE.CylinderGeometry(d.wheelRadius, d.wheelRadius, 0.3, 16);
  for (let i = 0; i < 4; i++) {
    const piv = new THREE.Object3D();
    piv.position.set((i % 2 === 0 ? 1 : -1) * d.track / 2, d.wheelRadius, (i < 2 ? 1 : -1) * d.wheelBase / 2);
    const wheel = new THREE.Object3D();
    const m = new THREE.Mesh(wgeo, tyre); m.rotation.z = Math.PI / 2; wheel.add(m);
    const spoke = box(0.32, d.wheelRadius * 1.5, 0.08, rimMat); wheel.add(spoke); // makes spin visible
    piv.add(wheel);
    group.add(piv);
    wheelPivots.push(piv); wheels.push(wheel);
  }
  return {
    group, body, wheelPivots, wheels, wheelBaseY: d.wheelRadius, thrusterNozzles: [nozzle],
    setColor(hex) { paint.color.set(hex); },
    setBrake(on) { brakeMat.emissiveIntensity = on ? 2.5 : 0.2; },
    setHeadlights() {},
    setReverse(on) { revMat.emissiveIntensity = on ? 2 : 0; },
    setThruster(level, mode) {
      flame.visible = level > 0.02;
      flame.scale.set(1, 0.3 + level, 1);
      flameMat.color.set(mode === 'hover' ? '#ffaa44' : '#66ccff');
      flame.rotation.x = mode === 'hover' ? Math.PI : -Math.PI / 2;
      flame.position.set(0, mode === 'hover' ? d.rideHeight - 0.4 : d.rideHeight + 0.35, mode === 'hover' ? 0 : -d.length / 2 - 0.8);
    },
    dispose() { group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); },
  };
}

export function createMockTrafficCarModel(seed = 0) {
  const spec = { dims: { length: 4.4, width: 1.85, height: 1.5, wheelBase: 2.7, track: 1.6, wheelRadius: 0.33, rideHeight: 0.15 }, colors: [] };
  const hue = ((seed * 0.618034) % 1 + 1) % 1;
  const col = new THREE.Color().setHSL(hue, 0.5, 0.5);
  const m = createMockCarModel(spec, { color: '#' + col.getHexString() });
  return m;
}

// Stand-in for src/world/city.js: the physics mock world with a quick render, for integration tests.
import * as THREE from 'three';
import { createMockWorld } from '../src/physics/mockWorld.js';

export async function loadWorld(root, { onProgress } = {}) {
  const w = createMockWorld();
  const b = w.bounds;
  const W = b.maxX - b.minX, D = b.maxZ - b.minZ;
  const seg = 300;
  const geo = new THREE.PlaneGeometry(W, D, seg, seg);
  geo.rotateX(-Math.PI / 2);
  geo.translate((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), y = w.heightAt(x, z);
    pos.setY(i, y);
    const s = w.surfaceAt(x, z, y + 1);
    const c = s === 'water' ? [0.1, 0.3, 0.5] : s === 'road' ? [0.25, 0.25, 0.27] : s === 'sand' ? [0.8, 0.7, 0.5] : [0.3, 0.5, 0.25];
    col.set(c, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  ground.receiveShadow = true;
  root.add(ground);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0x1a4a70, roughness: 0.2, metalness: 0.3, transparent: true, opacity: 0.8 }));
  water.rotation.x = -Math.PI / 2; water.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  root.add(water);
  for (const bx of w.boxes || w.buildings || []) {
    if (bx.minX === undefined) continue;
    const h = (bx.top ?? bx.height ?? 10) - (bx.base ?? 0);
    const m = new THREE.Mesh(new THREE.BoxGeometry(bx.maxX - bx.minX, h, bx.maxZ - bx.minZ), new THREE.MeshStandardMaterial({ color: 0x8a8f99 }));
    m.position.set((bx.minX + bx.maxX) / 2, (bx.base ?? 0) + h / 2, (bx.minZ + bx.maxZ) / 2);
    m.castShadow = m.receiveShadow = true;
    root.add(m);
  }
  onProgress?.(1, 'mock');
  w.landmarks = w.landmarks?.length ? w.landmarks : [{ id: 'ring', name: 'Ring Road', x: 420, z: 0, radius: 60, blurb: 'test' }];
  w.update = w.update || (() => {});
  w.setNight = w.setNight || (() => {});
  return w;
}

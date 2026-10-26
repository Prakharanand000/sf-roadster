// CARS agent — premium dark showroom, placed at world (0, -2000, 0).
//   createShowroom({ reflector = true, quality = 'high' }) -> { group, carAnchor, cameraPos, cameraTarget, update(dt), setVisible(bool), dispose() }
// Enclosed cylindrical room (nothing from the city is visible inside), mirror-polished floor
// (three/addons Reflector, darkened + radial falloff overlay), slowly rotating turntable, one
// RectAreaLight softbox + local SpotLights (all with short `distance`), SF skyline backdrop and a
// neon "SF ROADSTER RUSH" sign. The integrator toggles group.visible (lights in an invisible
// group are off). cameraPos / cameraTarget are WORLD coordinates.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

const ORIGIN = new THREE.Vector3(0, -2000, 0);
const hasDOM = typeof document !== 'undefined';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function skylineTexture() {
  const W = 2048, H = 512, c = canvas(W, H), g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#04050b'); sky.addColorStop(0.45, '#0b0d22'); sky.addColorStop(0.75, '#3a1638'); sky.addColorStop(0.9, '#a2412e'); sky.addColorStop(1, '#f08a3c');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  // stars
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 160; i++) g.fillRect(rnd() * W, rnd() * H * 0.45, 1.2, 1.2);
  const base = H * 0.93;
  const windows = [];
  const bld = (x, w, h, top) => {
    g.fillStyle = '#05060a';
    g.beginPath(); g.moveTo(x, base);
    if (top === 'pyramid') { g.lineTo(x, base - h * 0.15); g.lineTo(x + w / 2, base - h); g.lineTo(x + w, base - h * 0.15); }
    else if (top === 'round') { g.lineTo(x, base - h * 0.88); g.quadraticCurveTo(x + w / 2, base - h * 1.04, x + w, base - h * 0.88); }
    else { g.lineTo(x, base - h); g.lineTo(x + w, base - h); }
    g.lineTo(x + w, base); g.closePath(); g.fill();
    for (let wy = base - h * 0.82; wy < base - 6; wy += 9) for (let wx = x + 4; wx < x + w - 4; wx += 7) if (rnd() < 0.22) windows.push([wx, wy]);
  };
  // left: Golden Gate bridge silhouette
  g.strokeStyle = '#7a1d14'; g.fillStyle = '#5c160f'; g.lineWidth = 3;
  const t1 = 180, t2 = 520, ty = base - 150;
  for (const tx of [t1, t2]) { g.fillRect(tx - 7, ty, 14, base - ty); g.fillRect(tx - 12, ty + 30, 24, 6); g.fillRect(tx - 12, ty + 70, 24, 6); }
  g.beginPath(); g.moveTo(0, base - 40); g.quadraticCurveTo((0 + t1) / 2, base - 40, t1, ty); g.quadraticCurveTo((t1 + t2) / 2, base - 10, t2, ty); g.quadraticCurveTo(t2 + 120, base - 50, 720, base - 30); g.stroke();
  g.fillRect(0, base - 30, 720, 6);
  g.lineWidth = 1; for (let x = 10; x < 720; x += 14) { const yy = x < t1 ? base - 40 + (ty - base + 40) * Math.pow(x / t1, 2) : x < t2 ? ty + (base - 10 - ty) * (1 - Math.pow((x - (t1 + t2) / 2) / ((t2 - t1) / 2), 2)) : ty + 60; g.beginPath(); g.moveTo(x, Math.min(base - 30, yy)); g.lineTo(x, base - 30); g.stroke(); }
  // city
  const city = [[760, 40, 120], [805, 55, 170], [865, 34, 140], [905, 60, 230], [970, 46, 300, 'pyramid'], [1022, 70, 210], [1095, 48, 260], [1150, 64, 380, 'round'], [1222, 58, 240], [1285, 40, 190], [1330, 70, 270], [1405, 44, 160], [1455, 80, 200], [1540, 50, 150], [1595, 46, 120], [1645, 70, 100], [1720, 60, 90]];
  for (const b of city) bld(...b);
  // Sutro tower on the right hill
  g.fillStyle = '#06070c'; g.beginPath(); g.moveTo(1760, base); g.quadraticCurveTo(1900, base - 120, 2048, base - 60); g.lineTo(2048, base); g.fill();
  g.strokeStyle = '#08090f'; g.lineWidth = 4; g.beginPath(); g.moveTo(1880, base - 95); g.lineTo(1905, base - 300); g.lineTo(1930, base - 95); g.stroke();
  g.lineWidth = 3; g.beginPath(); g.moveTo(1890, base - 230); g.lineTo(1920, base - 230); g.moveTo(1884, base - 170); g.lineTo(1926, base - 170); g.stroke();
  g.fillStyle = '#ff3030'; g.fillRect(1902, base - 306, 6, 6); g.fillRect(984, base - 304, 5, 5);
  // windows
  for (const [x, y] of windows) { g.fillStyle = rnd() < 0.7 ? 'rgba(255,214,150,0.85)' : 'rgba(170,210,255,0.8)'; g.fillRect(x, y, 3, 4); }
  // ground haze
  const hz = g.createLinearGradient(0, base - 30, 0, H); hz.addColorStop(0, 'rgba(240,138,60,0)'); hz.addColorStop(1, 'rgba(20,10,20,1)');
  g.fillStyle = hz; g.fillRect(0, base - 30, W, H - base + 30);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function neonTexture(text) {
  const W = 2048, H = 256, c = canvas(W, H), g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.font = 'italic 900 150px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [blur, col, lw] of [[40, 'rgba(255,40,160,0.9)', 14], [16, 'rgba(255,90,200,1)', 8], [0, 'rgba(255,230,250,1)', 3]]) {
    g.shadowColor = col; g.shadowBlur = blur; g.strokeStyle = col; g.lineWidth = lw; g.strokeText(text, W / 2, H / 2 + 6);
  }
  g.shadowBlur = 0; g.fillStyle = 'rgba(255,245,252,0.95)'; g.fillText(text, W / 2, H / 2 + 6);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function radialAlpha(inner = 0.25, outer = 1) {
  const S = 256, data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const r = Math.hypot((x + 0.5) / S * 2 - 1, (y + 0.5) / S * 2 - 1);
    const a = Math.min(1, Math.max(0, (r - inner) / (outer - inner)));
    const i = (y * S + x) * 4; data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = 255 * (0.35 + 0.65 * a * a);
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat); t.needsUpdate = true; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  return t;
}

export function createShowroom({ reflector = true, quality = 'high' } = {}) {
  const group = new THREE.Group(); group.name = 'showroom';
  group.position.copy(ORIGIN);
  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };
  const R = 15, HGT = 8.5;

  // --- floor: mirror + dark glossy overlay with radial falloff
  if (reflector && hasDOM) {
    const fg = keep(new THREE.CircleGeometry(R, 64));
    const res = quality === 'high' ? 1024 : 512;
    const mirror = new Reflector(fg, { textureWidth: res, textureHeight: res, color: 0x5a5a60, clipBias: 0.003 });
    mirror.rotation.x = -Math.PI / 2; mirror.position.y = 0.0;
    group.add(mirror); disposables.push(mirror);
  }
  const overlay = new THREE.Mesh(keep(new THREE.CircleGeometry(R, 64)), keep(new THREE.MeshPhysicalMaterial({
    color: 0x0b0c0f, roughness: 0.22, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.12,
    transparent: true, opacity: reflector ? 0.72 : 1, alphaMap: keep(radialAlpha(0.18, 0.95)), depthWrite: false,
  })));
  overlay.rotation.x = -Math.PI / 2; overlay.position.y = 0.004; overlay.receiveShadow = true; overlay.renderOrder = 1;
  group.add(overlay);
  // shadow catcher (only darkens)
  const catcher = new THREE.Mesh(keep(new THREE.CircleGeometry(6, 48)), keep(new THREE.ShadowMaterial({ opacity: 0.5 })));
  catcher.rotation.x = -Math.PI / 2; catcher.position.y = 0.09; catcher.receiveShadow = true;
  group.add(catcher);

  // --- walls / ceiling (enclosed, inner faces)
  const wallMat = keep(new THREE.MeshStandardMaterial({ color: 0x0c0d11, roughness: 0.85, metalness: 0.1, side: THREE.BackSide }));
  const wall = new THREE.Mesh(keep(new THREE.CylinderGeometry(R, R, HGT, 64, 1, true)), wallMat);
  wall.position.y = HGT / 2; group.add(wall);
  const ceil = new THREE.Mesh(keep(new THREE.CircleGeometry(R, 64)), keep(new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.9 })));
  ceil.rotation.x = Math.PI / 2; ceil.position.y = HGT; group.add(ceil);
  // vertical LED fins on the wall
  const finMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.7, 1.0), toneMapped: false }));
  const finGeo = keep(new THREE.BoxGeometry(0.05, HGT * 0.62, 0.05));
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    if (Math.abs(Math.sin(a / 2)) < 0.42) continue; // leave the backdrop (towards -z) free
    const f = new THREE.Mesh(finGeo, finMat); f.position.set(Math.sin(a) * (R - 0.08), HGT * 0.42, Math.cos(a) * (R - 0.08)); group.add(f);
  }
  // ceiling light ring + softbox panel
  const ringMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.6, 1.7), toneMapped: false }));
  const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(4.6, 0.035, 8, 96)), ringMat); ring.rotation.x = Math.PI / 2; ring.position.y = HGT - 0.6; group.add(ring);
  const panel = new THREE.Mesh(keep(new THREE.PlaneGeometry(5.5, 2.2)), keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 1.3, 1.35), toneMapped: false })));
  panel.rotation.x = Math.PI / 2; panel.position.set(0, 5.2, 0); group.add(panel);

  // --- backdrop skyline + neon sign (toward -z, behind the car in the default camera view)
  const backA = Math.PI * 0.62;
  const bdGeo = keep(new THREE.CylinderGeometry(R - 0.3, R - 0.3, 5.6, 48, 1, true, Math.PI - backA / 2, backA));
  const bdMat = keep(new THREE.MeshBasicMaterial({ color: 0xbfbfbf, side: THREE.BackSide, map: hasDOM ? keep(skylineTexture()) : null }));
  const backdrop = new THREE.Mesh(bdGeo, bdMat); backdrop.position.y = 2.6; group.add(backdrop);
  if (hasDOM) {
    const neon = new THREE.Mesh(keep(new THREE.PlaneGeometry(8.4, 1.05)), keep(new THREE.MeshBasicMaterial({ map: keep(neonTexture('SF ROADSTER RUSH')), transparent: true, color: new THREE.Color(2.2, 1.7, 2.1), toneMapped: false, depthWrite: false })));
    neon.position.set(0, 4.55, -(R - 0.7)); group.add(neon);
    var neonMat = neon.material;
  }

  // --- turntable
  const turntable = new THREE.Group(); turntable.name = 'turntable'; group.add(turntable);
  const ttMat = keep(new THREE.MeshPhysicalMaterial({ color: 0x15161a, metalness: 0.8, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.2 }));
  const tt = new THREE.Mesh(keep(new THREE.CylinderGeometry(3.3, 3.38, 0.08, 96)), ttMat); tt.position.y = 0.04; tt.receiveShadow = true; turntable.add(tt);
  const ttTop = new THREE.Mesh(keep(new THREE.CircleGeometry(3.25, 96)), keep(new THREE.MeshStandardMaterial({ color: 0x0b0c0e, metalness: 0.1, roughness: 0.7 })));
  ttTop.rotation.x = -Math.PI / 2; ttTop.position.y = 0.0805; ttTop.receiveShadow = true; turntable.add(ttTop);
  const glowRing = new THREE.Mesh(keep(new THREE.TorusGeometry(3.36, 0.018, 8, 160)), keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.4, 2.6), toneMapped: false })));
  glowRing.rotation.x = Math.PI / 2; glowRing.position.y = 0.075; group.add(glowRing);
  const floorRing = new THREE.Mesh(keep(new THREE.RingGeometry(4.2, 4.24, 128)), keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.5, 0.9), toneMapped: false })));
  floorRing.rotation.x = -Math.PI / 2; floorRing.position.y = 0.006; group.add(floorRing);
  const carAnchor = new THREE.Group(); carAnchor.name = 'carAnchor'; carAnchor.position.y = 0.081; turntable.add(carAnchor);

  // --- lights (all local: short distance, or area light)
  if (hasDOM) { try { RectAreaLightUniformsLib.init(); } catch (e) { /* ignore */ } }
  const area = new THREE.RectAreaLight(0xffffff, 2.6, 5.5, 2.2); area.position.set(0, 5.18, 0); area.lookAt(0, 0, 0); group.add(area);
  const key = new THREE.SpotLight(0xfff3e6, 38, 26, 0.5, 0.75, 1.6);
  key.position.set(5.5, 6.5, 6.0); key.target.position.set(0, 0.4, 0);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.camera.near = 2; key.shadow.camera.far = 20;
  group.add(key, key.target);
  const fill = new THREE.SpotLight(0xdfe8ff, 12, 24, 0.6, 0.9, 1.6); fill.position.set(-6.5, 4.0, 4.5); fill.target.position.set(0, 0.5, 0); group.add(fill, fill.target);
  const rimL = new THREE.SpotLight(0x5aa8ff, 26, 22, 0.45, 0.6, 1.6); rimL.position.set(-5.5, 3.2, -6.5); rimL.target.position.set(0, 0.7, 0); group.add(rimL, rimL.target);
  const rimR = new THREE.SpotLight(0xff6ac0, 14, 22, 0.45, 0.6, 1.6); rimR.position.set(6.0, 3.0, -6.0); rimR.target.position.set(0, 0.7, 0); group.add(rimR, rimR.target);
  const low = new THREE.PointLight(0x9fc3ff, 1.2, 7, 2); low.position.set(0, 0.25, 4.2); group.add(low);
  const wash = new THREE.SpotLight(0xff8a50, 14, 22, 0.9, 1.0, 1.4); wash.position.set(0, 1.0, -9); wash.target.position.set(0, 3, -15); group.add(wash, wash.target);

  const cameraTarget = new THREE.Vector3(0, 0.62, 0).add(ORIGIN);
  const cameraPos = new THREE.Vector3(5.4, 1.55, 6.4).add(ORIGIN);
  let t = 0;
  const api = {
    group, carAnchor, turntable, cameraPos, cameraTarget, lights: { area, key, fill, rimL, rimR, low, wash },
    spin: 0.22,
    update(dt) {
      t += dt;
      turntable.rotation.y += dt * api.spin;
      glowRing.material.color.setRGB(0.5, 1.4 + 0.15 * Math.sin(t * 1.3), 2.6);
      if (neonMat) { const fl = Math.random() < 0.004 ? 0.35 : 1; neonMat.color.setRGB(2.2 * fl, 1.7 * fl, 2.1 * fl); }
    },
    setVisible(v) { group.visible = !!v; },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose?.();
    },
  };
  return api;
}

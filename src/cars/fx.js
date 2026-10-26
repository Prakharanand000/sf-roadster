// CARS agent — CarFX: pooled, allocation-free particle effects for cars.
//   tyre smoke (slip / drifting), surface dust, skid-mark ribbons (ring buffer, shader fade),
//   boost thruster trail + heat haze, hover down-wash, landing dust, water splash/spray,
//   collision sparks (velocity streaks), checkpoint glow ring burst.
//
// Usage (CONTRACTS.md):  fx = new CarFX(scene); h = fx.add(carModel); fx.update(dt, h, vehicle); fx.burst(type, pos)
// Simulation is stepped once per frame automatically (first update() call of a frame), so calling
// update() for several cars per frame is fine. Optional additions: fx.step(dt) to step explicitly
// (disables auto-step), fx.remove(handle), fx.setQuality('low'|'medium'|'high'), fx.dispose().
// state.wheelContacts are assumed to be WORLD positions of the tyre contact points.
import * as THREE from 'three';
import { smokeTexture, spriteTexture } from './util.js';

const SOFT_MAX = 1400, GLOW_MAX = 1200, SPARK_MAX = 260, SKID_MAX = 3200, RING_MAX = 4;
const SKID_LIFE = 28;

const pointVS = /* glsl */`
  attribute float size; attribute vec4 pcolor;
  varying vec4 vColor;
  uniform float scale;
  #include <fog_pars_vertex>
  void main() {
    vColor = pcolor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / max(0.1, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const pointFS = /* glsl */`
  uniform sampler2D map;
  varying vec4 vColor;
  #include <fog_pars_fragment>
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vColor.rgb, vColor.a * t.a);
    if (gl_FragColor.a < 0.003) discard;
    #include <fog_fragment>
  }`;

class PointPool {
  constructor(max, tex, additive) {
    this.max = max; this.head = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max).fill(-1);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.c = new Float32Array(max * 3); this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max); this.grav = new Float32Array(max); this.floor = new Float32Array(max).fill(-1e9);
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr); this.geo.setAttribute('pcolor', this.colAttr); this.geo.setAttribute('size', this.sizeAttr);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, scale: { value: 800 } }]),
      vertexShader: pointVS, fragmentShader: pointFS, transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mat.uniforms.map.value = tex;
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 8;
    const tmp = new THREE.Vector2();
    this.points.onBeforeRender = (renderer, scene, camera) => {
      renderer.getDrawingBufferSize(tmp);
      const fov = camera.isPerspectiveCamera ? camera.fov : 50;
      this.mat.uniforms.scale.value = tmp.y / (2 * Math.tan((fov * Math.PI) / 360));
    };
    this.alive = 0;
  }
  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag = 0.5, grav = 0, floor = -1e9) {
    const i = this.head; this.head = (this.head + 1) % this.max;
    const k = i * 3;
    this.p[k] = x; this.p[k + 1] = y; this.p[k + 2] = z;
    this.v[k] = vx; this.v[k + 1] = vy; this.v[k + 2] = vz;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.c[k] = r; this.c[k + 1] = g; this.c[k + 2] = b; this.a0[i] = a; this.drag[i] = drag; this.grav[i] = grav; this.floor[i] = floor;
  }
  step(dt) {
    const P = this.posAttr.array, C = this.colAttr.array, S = this.sizeAttr.array;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const L = this.life[i];
      const k = i * 3, k4 = i * 4;
      if (L <= 0) { if (S[i] !== 0) { S[i] = 0; C[k4 + 3] = 0; } continue; }
      const a = (this.age[i] += dt);
      if (a >= L) { this.life[i] = -1; S[i] = 0; C[k4 + 3] = 0; continue; }
      alive++;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.v[k] *= d; this.v[k + 1] = this.v[k + 1] * d - this.grav[i] * dt; this.v[k + 2] *= d;
      this.p[k] += this.v[k] * dt; this.p[k + 1] += this.v[k + 1] * dt; this.p[k + 2] += this.v[k + 2] * dt;
      if (this.p[k + 1] < this.floor[i]) { this.p[k + 1] = this.floor[i]; this.v[k + 1] *= -0.3; }
      const t = a / L;
      P[k] = this.p[k]; P[k + 1] = this.p[k + 1]; P[k + 2] = this.p[k + 2];
      S[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      C[k4] = this.c[k]; C[k4 + 1] = this.c[k + 1]; C[k4 + 2] = this.c[k + 2]; C[k4 + 3] = this.a0[i] * fade * fade;
    }
    this.alive = alive;
    this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true; this.sizeAttr.needsUpdate = true;
  }
  clear() { this.life.fill(-1); this.sizeAttr.array.fill(0); this.sizeAttr.needsUpdate = true; }
}

class SparkPool {
  constructor(max) {
    this.max = max; this.head = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.age = new Float32Array(max); this.life = new Float32Array(max).fill(-1); this.floor = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(max * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(max * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.pos); this.geo.setAttribute('color', this.col);
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.lines = new THREE.LineSegments(this.geo, this.mat); this.lines.frustumCulled = false; this.lines.renderOrder = 13;
  }
  emit(x, y, z, vx, vy, vz, life, floor) {
    const i = this.head; this.head = (this.head + 1) % this.max; const k = i * 3;
    this.p[k] = x; this.p[k + 1] = y; this.p[k + 2] = z; this.v[k] = vx; this.v[k + 1] = vy; this.v[k + 2] = vz; this.age[i] = 0; this.life[i] = life; this.floor[i] = floor;
  }
  step(dt) {
    const P = this.pos.array, C = this.col.array;
    for (let i = 0; i < this.max; i++) {
      const k = i * 3, k6 = i * 6;
      if (this.life[i] <= 0) { if (C[k6] !== 0 || C[k6 + 3] !== 0) for (let j = 0; j < 6; j++) C[k6 + j] = 0; continue; }
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) { this.life[i] = -1; for (let j = 0; j < 6; j++) C[k6 + j] = 0; continue; }
      this.v[k + 1] -= 9.81 * dt;
      this.v[k] *= 1 - 0.8 * dt; this.v[k + 2] *= 1 - 0.8 * dt;
      this.p[k] += this.v[k] * dt; this.p[k + 1] += this.v[k + 1] * dt; this.p[k + 2] += this.v[k + 2] * dt;
      if (this.p[k + 1] < this.floor[i]) { this.p[k + 1] = this.floor[i]; this.v[k + 1] = Math.abs(this.v[k + 1]) * 0.35; }
      const st = 0.028;
      P[k6] = this.p[k]; P[k6 + 1] = this.p[k + 1]; P[k6 + 2] = this.p[k + 2];
      P[k6 + 3] = this.p[k] - this.v[k] * st; P[k6 + 4] = this.p[k + 1] - this.v[k + 1] * st; P[k6 + 5] = this.p[k + 2] - this.v[k + 2] * st;
      const t = 1 - a / this.life[i];
      const hot = t * t;
      C[k6] = 3.0 * hot + 0.4 * t; C[k6 + 1] = 1.8 * hot + 0.12 * t; C[k6 + 2] = 0.7 * hot;
      C[k6 + 3] = C[k6] * 0.25; C[k6 + 4] = C[k6 + 1] * 0.2; C[k6 + 5] = 0;
    }
    this.pos.needsUpdate = true; this.col.needsUpdate = true;
  }
  clear() { this.life.fill(-1); this.col.array.fill(0); this.col.needsUpdate = true; }
}

const skidVS = /* glsl */`
  attribute float birth; attribute float edge; attribute float strength;
  uniform float time;
  varying float vA; varying float vEdge;
  #include <fog_pars_vertex>
  void main() {
    float age = time - birth;
    vA = strength * (1.0 - smoothstep(${(SKID_LIFE * 0.45).toFixed(1)}, ${SKID_LIFE.toFixed(1)}, age));
    vEdge = edge;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const skidFS = /* glsl */`
  varying float vA; varying float vEdge;
  uniform vec3 color;
  #include <fog_pars_fragment>
  void main() {
    float e = 1.0 - pow(abs(vEdge), 3.0);
    gl_FragColor = vec4(color, vA * e * 0.75);
    if (gl_FragColor.a < 0.004) discard;
    #include <fog_fragment>
  }`;

class SkidRibbons {
  constructor(max) {
    this.max = max; this.head = 0;
    const nv = max * 4;
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.birth = new THREE.BufferAttribute(new Float32Array(nv).fill(-1e6), 1).setUsage(THREE.DynamicDrawUsage);
    this.strength = new THREE.BufferAttribute(new Float32Array(nv), 1).setUsage(THREE.DynamicDrawUsage);
    const edge = new Float32Array(nv); for (let i = 0; i < max; i++) { edge[i * 4] = -1; edge[i * 4 + 1] = 1; edge[i * 4 + 2] = -1; edge[i * 4 + 3] = 1; }
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) { const v = i * 4, k = i * 6; idx[k] = v; idx[k + 1] = v + 2; idx[k + 2] = v + 1; idx[k + 3] = v + 1; idx[k + 4] = v + 2; idx[k + 5] = v + 3; }
    this.geo.setAttribute('position', this.pos); this.geo.setAttribute('birth', this.birth); this.geo.setAttribute('strength', this.strength);
    this.geo.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: { value: 0 }, color: { value: new THREE.Color(0.018, 0.018, 0.02) } }]),
      vertexShader: skidVS, fragmentShader: skidFS, transparent: true, depthWrite: false, fog: true,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 1;
    this.lo = Infinity; this.hi = -1;
  }
  /** quad from (ax,ay,az)±side to (bx,by,bz)±side; edges given explicitly to keep ribbons continuous */
  quad(l0, r0, l1, r1, time, s0, s1) {
    const i = this.head; this.head = (this.head + 1) % this.max;
    const P = this.pos.array, k = i * 12;
    P[k] = l0.x; P[k + 1] = l0.y; P[k + 2] = l0.z; P[k + 3] = r0.x; P[k + 4] = r0.y; P[k + 5] = r0.z;
    P[k + 6] = l1.x; P[k + 7] = l1.y; P[k + 8] = l1.z; P[k + 9] = r1.x; P[k + 10] = r1.y; P[k + 11] = r1.z;
    const B = this.birth.array, S = this.strength.array, v = i * 4;
    B[v] = B[v + 1] = B[v + 2] = B[v + 3] = time;
    S[v] = S[v + 1] = s0; S[v + 2] = S[v + 3] = s1;
    if (i < this.lo) this.lo = i; if (i > this.hi) this.hi = i;
  }
  flush() {
    if (this.hi < 0) return;
    const lo = this.lo, n = this.hi - lo + 1;
    // ranges accumulate until three uploads them (it clears them after upload)
    if (this.pos.addUpdateRange) {
      this.pos.addUpdateRange(lo * 12, n * 12); this.birth.addUpdateRange(lo * 4, n * 4); this.strength.addUpdateRange(lo * 4, n * 4);
    }
    this.pos.needsUpdate = this.birth.needsUpdate = this.strength.needsUpdate = true;
    this.lo = Infinity; this.hi = -1;
  }
  clear() { this.birth.array.fill(-1e6); this.birth.clearUpdateRanges?.(); this.birth.needsUpdate = true; }
}

class RingPool {
  constructor(n) {
    this.items = [];
    const geo = new THREE.RingGeometry(0.82, 1.0, 64, 1); geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 1.6, 2.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const m = new THREE.Mesh(geo, mat); m.visible = false; m.frustumCulled = false; m.renderOrder = 12;
      this.items.push({ mesh: m, age: 0, life: 0 });
    }
    this.geo = geo; this.head = 0;
  }
  spawn(p, color) {
    const it = this.items[this.head]; this.head = (this.head + 1) % this.items.length;
    it.mesh.position.copy(p); it.age = 0; it.life = 0.9; it.mesh.visible = true;
    if (color) it.mesh.material.color.copy(color);
  }
  step(dt) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.age += dt; const t = it.age / it.life;
      if (t >= 1) { it.mesh.visible = false; continue; }
      const s = 1.5 + 11 * (1 - Math.pow(1 - t, 3));
      it.mesh.scale.set(s, 1, s); it.mesh.position.y += dt * 1.5;
      it.mesh.material.opacity = (1 - t) * (1 - t);
    }
  }
  clear() { for (const it of this.items) it.mesh.visible = false; }
}

const SURF_DUST = { grass: [0.36, 0.33, 0.22], sand: [0.78, 0.7, 0.54], sidewalk: [0.75, 0.75, 0.73] };

export class CarFX {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group(); this.group.name = 'CarFX';
    this.soft = new PointPool(SOFT_MAX, smokeTexture(), false);
    this.glow = new PointPool(GLOW_MAX, spriteTexture(), true);
    this.sparks = new SparkPool(SPARK_MAX);
    this.skids = new SkidRibbons(SKID_MAX);
    this.rings = new RingPool(RING_MAX);
    this.group.add(this.skids.mesh, this.soft.points, this.glow.points, this.sparks.lines);
    for (const it of this.rings.items) this.group.add(it.mesh);
    scene.add(this.group);
    this.handles = [];
    this.time = 0; this._lastStep = -1; this._manual = false;
    this.quality = 1;
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3(); this._d = new THREE.Vector3(); this._q = new THREE.Quaternion();
    this._l1 = new THREE.Vector3(); this._r1 = new THREE.Vector3(); this._fwd = new THREE.Vector3(); this._side = new THREE.Vector3();
    this._c = new THREE.Color();
  }
  setQuality(q) { this.quality = q === 'low' ? 0.4 : q === 'medium' ? 0.7 : 1; }

  add(carModel) {
    const h = {
      model: carModel, wheels: [0, 1, 2, 3].map(() => ({ active: false, l: new THREE.Vector3(), r: new THREE.Vector3(), p: new THREE.Vector3(), s: 0 })),
      wasGround: true, air: 0, wasWater: false, smokeAcc: 0, trailAcc: 0, hoverAcc: 0, sprayAcc: 0,
    };
    this.handles.push(h);
    return h;
  }
  remove(h) { const i = this.handles.indexOf(h); if (i >= 0) this.handles.splice(i, 1); }

  /** Steps the simulation (called automatically once per frame from update()). */
  step(dt, manual = true) {
    if (manual) this._manual = true;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.soft.step(dt); this.glow.step(dt); this.sparks.step(dt); this.rings.step(dt);
    this.skids.mat.uniforms.time.value = this.time;
    this.skids.flush();
  }

  update(dt, h, s) {
    if (!h || !s) return;
    if (!this._manual) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - this._lastStep > 2 || this._lastStep < 0 || this._stepCount === undefined) { this.step(dt, false); this._lastStep = now; this._stepCount = 1; }
    }
    dt = Math.min(dt, 0.1);
    const Q = this.quality;
    const vel = s.velocity, spd = vel ? Math.hypot(vel.x, vel.z) : Math.abs(s.speed || 0);
    const surf = s.surface || 'road';
    const contacts = s.wheelContacts || [];
    // ---- skids + smoke per wheel
    for (let i = 0; i < 4 && i < contacts.length; i++) {
      const c = contacts[i], W = h.wheels[i];
      const slip = Math.max(c.slip ?? 0, (s.drifting && i >= 2) ? Math.max(0.5, s.slip || 0) : 0);
      const marking = c.onGround && slip > 0.42 && spd > 2 && surf !== 'water' && !s.inWater;
      if (marking) {
        // lateral direction = perpendicular to travel (fallback: car side axis)
        this._fwd.set(vel ? vel.x : 0, 0, vel ? vel.z : 1);
        if (this._fwd.lengthSq() < 1e-4) this._fwd.set(0, 0, 1);
        this._fwd.normalize();
        this._side.set(this._fwd.z, 0, -this._fwd.x).multiplyScalar(0.13);
        const y = c.y + 0.02;
        this._l1.set(c.x + this._side.x, y, c.z + this._side.z);
        this._r1.set(c.x - this._side.x, y, c.z - this._side.z);
        const str = Math.min(1, (slip - 0.35) * 1.8) * (surf === 'grass' || surf === 'sand' ? 0.6 : 1);
        if (W.active) {
          const dx = c.x - W.p.x, dz = c.z - W.p.z, d2 = dx * dx + dz * dz;
          if (d2 > 0.09) {
            if (d2 < 9) this.skids.quad(W.l, W.r, this._l1, this._r1, this.time, W.s, str);
            W.l.copy(this._l1); W.r.copy(this._r1); W.p.set(c.x, y, c.z); W.s = str;
          }
        } else { W.active = true; W.l.copy(this._l1); W.r.copy(this._r1); W.p.set(c.x, y, c.z); W.s = str; }
      } else W.active = false;
      // smoke / dust
      if (c.onGround && slip > 0.38 && spd > 1.5 && !s.inWater) {
        const dust = SURF_DUST[surf];
        const rate = (dust ? 30 : 42) * Q * Math.min(1.5, slip) * (i >= 2 ? 1 : 0.45);
        h.smokeAcc += rate * dt;
        while (h.smokeAcc >= 1) {
          h.smokeAcc -= 1;
          const rx = (Math.random() - 0.5), rz = (Math.random() - 0.5);
          const vx = (vel ? vel.x : 0) * 0.15 + rx * 1.6, vz = (vel ? vel.z : 0) * 0.15 + rz * 1.6;
          if (dust) this.soft.emit(c.x + rx * 0.3, c.y + 0.15, c.z + rz * 0.3, vx, 0.6 + Math.random() * 0.8, vz, 1.3 + Math.random() * 0.8, 0.5, 2.6, dust[0], dust[1], dust[2], 0.4, 1.2, -0.3);
          else this.soft.emit(c.x + rx * 0.3, c.y + 0.18, c.z + rz * 0.3, vx, 0.5 + Math.random() * 0.9, vz, 1.6 + Math.random() * 1.2, 0.6, 3.6, 0.86, 0.86, 0.88, 0.32, 1.1, -0.2);
        }
      }
    }
    // ---- boost trail + hover downwash from nozzles
    const nozzles = h.model?.thrusterNozzles || [];
    if ((s.boosting || s.hovering) && nozzles.length) {
      const mode = s.boosting ? 'boost' : 'hover';
      const rate = (s.boosting ? 90 : 70) * Q;
      h.trailAcc += rate * dt;
      let n = 0;
      for (const nz of nozzles) if (nz.userData.mode === mode) n++;
      while (h.trailAcc >= 1 && n > 0) {
        h.trailAcc -= 1;
        // pick a random nozzle of this mode
        let pick = Math.floor(Math.random() * n), k = 0, chosen = null;
        for (const nz of nozzles) if (nz.userData.mode === mode) { if (k === pick) { chosen = nz; break; } k++; }
        chosen.getWorldPosition(this._w);
        chosen.getWorldQuaternion(this._q);
        this._d.set(0, 0, 1).applyQuaternion(this._q);
        const sp = s.boosting ? 9 : 6;
        const jx = (Math.random() - 0.5) * 0.8, jy = (Math.random() - 0.5) * 0.8, jz = (Math.random() - 0.5) * 0.8;
        const vx = this._d.x * sp + jx + (vel ? vel.x * 0.85 : 0), vy = this._d.y * sp + jy + (vel ? vel.y * 0.85 : 0), vz = this._d.z * sp + jz + (vel ? vel.z * 0.85 : 0);
        this.glow.emit(this._w.x, this._w.y, this._w.z, vx, vy, vz, 0.22 + Math.random() * 0.2, 0.22, 0.04, 0.45, 0.75, 1.6, 0.9, 2.5, 0);
        // heat haze / condensation puff
        if (Math.random() < 0.35) this.soft.emit(this._w.x + this._d.x * 0.3, this._w.y + this._d.y * 0.3, this._w.z + this._d.z * 0.3, vx * 0.6, vy * 0.6 + 0.3, vz * 0.6, 0.5 + Math.random() * 0.4, 0.3, 1.3, 0.72, 0.82, 0.95, 0.12, 2.0, -0.1);
      }
      if (s.hovering && contacts.length && contacts[0].y !== undefined) {
        // ground ring of dust under hovering car
        const gy = Math.min(contacts[0].y, contacts[3]?.y ?? contacts[0].y);
        const p = s.position;
        if (p && p.y - gy < 4) {
          h.hoverAcc += 40 * Q * dt;
          while (h.hoverAcc >= 1) {
            h.hoverAcc -= 1;
            const a = Math.random() * Math.PI * 2;
            this.soft.emit(p.x + Math.cos(a) * 1.2, gy + 0.1, p.z + Math.sin(a) * 1.2, Math.cos(a) * 5, 0.4, Math.sin(a) * 5, 0.9, 0.6, 2.4, 0.8, 0.82, 0.86, 0.22, 2.2, 0);
          }
        }
      }
    }
    // ---- landing dust
    const ground = !!s.onGround;
    if (!ground) h.air += dt;
    if (ground && !h.wasGround && h.air > 0.3 && s.position) {
      const str = Math.min(1, h.air / 1.5);
      this._burstLand(s.position, contacts, str, surf);
    }
    if (ground) h.air = 0;
    h.wasGround = ground;
    // ---- water
    if (s.inWater && !h.wasWater && s.position) this.burst('splash', s.position);
    if (s.inWater && spd > 3 && s.position) {
      h.sprayAcc += Math.min(60, spd * 2) * Q * dt;
      while (h.sprayAcc >= 1) {
        h.sprayAcc -= 1;
        const sd = Math.random() < 0.5 ? 1 : -1;
        const c = contacts[Math.random() < 0.5 ? 0 : 1] || { x: s.position.x, y: s.position.y, z: s.position.z };
        this.soft.emit(c.x, Math.max(0.05, c.y), c.z, (vel ? vel.x * 0.3 : 0) + sd * 2 * Math.random(), 2.5 + Math.random() * 3, (vel ? vel.z * 0.3 : 0) + sd * 2 * Math.random(), 0.9, 0.3, 1.6, 0.85, 0.92, 1.0, 0.45, 0.6, 9.81, 0.0);
      }
    }
    h.wasWater = !!s.inWater;
  }

  _burstLand(p, contacts, str, surf) {
    const dust = SURF_DUST[surf] || [0.7, 0.68, 0.64];
    const gy = contacts && contacts[0] ? contacts[0].y : p.y;
    const n = Math.round((20 + 40 * str) * this.quality);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5 * (0.5 + str);
      this.soft.emit(p.x + Math.cos(a) * 1.0, gy + 0.12, p.z + Math.sin(a) * 1.6, Math.cos(a) * sp, 0.3 + Math.random() * 1.2, Math.sin(a) * sp, 1.0 + Math.random() * 0.8, 0.5, 2.4 + str * 1.5, dust[0], dust[1], dust[2], 0.32 + 0.2 * str, 2.2, 0.3, gy);
    }
  }

  burst(type, position) {
    const p = position;
    if (!p) return;
    const Q = this.quality;
    if (type === 'collision') {
      const n = Math.round(46 * Q);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, e = Math.random() * 0.9 + 0.1, sp = 4 + Math.random() * 9;
        this.sparks.emit(p.x, p.y + 0.3, p.z, Math.cos(a) * sp * (1 - e * 0.5), e * sp * 0.8, Math.sin(a) * sp * (1 - e * 0.5), 0.35 + Math.random() * 0.5, p.y - 0.3);
      }
      for (let i = 0; i < 6; i++) this.glow.emit(p.x, p.y + 0.3, p.z, (Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2, 0.12, 0.9, 0.2, 2.5, 1.4, 0.5, 1, 3, 0);
      for (let i = 0; i < 6 * Q; i++) this.soft.emit(p.x, p.y + 0.3, p.z, (Math.random() - 0.5) * 2, 0.6, (Math.random() - 0.5) * 2, 1.2, 0.6, 2.2, 0.5, 0.5, 0.5, 0.25, 1.5, -0.2);
    } else if (type === 'land') {
      this._burstLand(p, null, 0.8, 'road');
    } else if (type === 'splash') {
      const n = Math.round(90 * Q);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random(), sp = 1.5 + r * 5;
        this.soft.emit(p.x + Math.cos(a) * 1.2, Math.max(0, p.y) + 0.1, p.z + Math.sin(a) * 1.8, Math.cos(a) * sp, 3 + Math.random() * 7, Math.sin(a) * sp, 1.2 + Math.random() * 0.6, 0.4, 2.0, 0.88, 0.94, 1.0, 0.55, 0.4, 9.81, -0.2);
      }
      for (let i = 0; i < 20 * Q; i++) { const a = Math.random() * Math.PI * 2; this.soft.emit(p.x, Math.max(0, p.y) + 0.2, p.z, Math.cos(a) * 3, 0.5, Math.sin(a) * 3, 2.2, 1.5, 5.0, 0.9, 0.95, 1.0, 0.25, 1.5, 0); }
    } else if (type === 'checkpoint') {
      this._v.copy(p); this._v.y += 0.2;
      this.rings.spawn(this._v);
      const n = Math.round(60 * Q);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 5;
        this.glow.emit(p.x + Math.cos(a) * r, p.y + 0.3 + Math.random() * 1.5, p.z + Math.sin(a) * r, Math.cos(a) * 1.5, 2 + Math.random() * 4, Math.sin(a) * 1.5, 0.8 + Math.random() * 0.6, 0.5, 0.08, 0.4, 1.4, 2.4, 0.9, 1.2, 1.5);
      }
    }
  }

  clear() {
    this.soft.clear(); this.glow.clear(); this.sparks.clear(); this.skids.clear(); this.rings.clear();
    for (const h of this.handles) { for (const w of h.wheels) w.active = false; h.air = 0; h.wasGround = true; h.wasWater = false; }
  }

  dispose() {
    this.group.removeFromParent();
    for (const o of [this.soft, this.glow]) { o.geo.dispose(); o.mat.dispose(); }
    this.sparks.geo.dispose(); this.sparks.mat.dispose(); this.skids.geo.dispose(); this.skids.mat.dispose();
    this.rings.geo.dispose(); for (const it of this.rings.items) it.mesh.material.dispose();
  }
}

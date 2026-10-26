// Sky, sun, fog ("Karl the Fog"), day/night cycle and post-processing.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const PRESET_TIMES = { dawn: 6.6, day: 13.0, golden: 17.35, night: 22.5 };
const DAY_LENGTH_SECONDS = 14 * 60; // one full in-game day in auto mode

// Golden Gate Bridge mid-span: Karl the Fog is thickest out here.
const FOG_CENTER = new THREE.Vector2(-6300, -3600);

const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

// Sky palettes (linear RGB) blended by sun height
const SKY = {
  night:  { zenith: [0.004, 0.007, 0.022], horizon: [0.018, 0.026, 0.055] },
  golden: { zenith: [0.16, 0.26, 0.52],    horizon: [1.0, 0.52, 0.26] },
  day:    { zenith: [0.10, 0.27, 0.68],    horizon: [0.62, 0.74, 0.88] },
};

/** Gradient sky dome with a soft sun glow; cheap and free of HDR blow-outs. */
function makeSky(radius) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(1, 1, 1) },
      glow: { value: 1 }, disk: { value: 1 },
    },
    vertexShader: `varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: `uniform vec3 zenith, horizon, ground, sunColor, sunDir; uniform float glow, disk;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.5)) : mix(horizon, ground, clamp(-h * 5.0, 0.0, 1.0));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * glow * (pow(s, 6.0) * 0.28 + pow(s, 48.0) * 0.5);
        col += sunColor * disk * smoothstep(0.99955, 0.9998, s) * 8.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

export class Environment {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.time = 17.35;            // hours, 0..24
    this.mode = 'auto';
    this.fogEnabled = true;
    this.night = 0;
    this.quality = 'high';
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.shadowTarget = new THREE.Vector3();

    // Sky dome (big box, shader only uses view direction)
    this.sky = makeSky(15000);
    scene.add(this.sky);

    // Small sky copy used only to bake reflection probes
    this.envScene = new THREE.Scene();
    this.envSky = makeSky(50);
    this.envSky.material = this.sky.material;
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.skyEnvRT = null;
    this.lastEnvTime = -99;
    this.roomEnv = this.pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

    // Stars for night
    const starGeo = new THREE.BufferGeometry();
    const n = 2500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2, y = Math.random() * 0.95 + 0.05;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(th) * r * 15000, y * 15000, Math.sin(th) * r * 15000], i * 3);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xdfe8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false,
    }));
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    // Lights
    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x3a3328, 0.6);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    const sc = this.sun.shadow.camera;
    sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 900;
    scene.add(this.sun, this.sun.target);

    scene.fog = new THREE.FogExp2(0xa9b8c8, 0.00035);

    // Post
    this.composer = null;
    this.bloom = null;
    this.setQuality('high');
  }

  setQuality(q) {
    this.quality = q;
    const r = this.renderer;
    const shadowSize = q === 'high' ? 2048 : q === 'medium' ? 1024 : 0;
    this.sun.castShadow = shadowSize > 0;
    r.shadowMap.enabled = shadowSize > 0;
    if (shadowSize && this.sun.shadow.mapSize.x !== shadowSize) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    if (q === 'low') {
      if (this.composer) { this.composer.dispose(); this.composer = null; this.bloom = null; }
      return;
    }
    if (!this.composer) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q === 'high' ? 4 : 0 });
      this.composer = new EffectComposer(r, rt);
      this.renderPass = new RenderPass(this.scene, this.camera);
      this.composer.addPass(this.renderPass);
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.5, 0.88);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    this.resize();
  }

  resize() {
    if (!this.composer) return;
    const r = this.renderer;
    const s = r.getSize(new THREE.Vector2());
    this.composer.setPixelRatio(r.getPixelRatio());
    this.composer.setSize(s.x, s.y);
  }

  setCamera(cam) {
    this.camera = cam;
    if (this.renderPass) this.renderPass.camera = cam;
  }

  setMode(mode) {
    this.mode = mode;
    if (PRESET_TIMES[mode] !== undefined) this.time = PRESET_TIMES[mode];
    this.lastEnvTime = -99;
  }

  /** Point the shadow frustum at the player. */
  follow(pos) { this.shadowTarget.copy(pos); }

  /** Use the indoor reflection probe (garage) or the sky probe (city). */
  useIndoor(indoor) {
    this.indoor = indoor;
    this.sky.visible = !indoor;
    this.stars.visible = !indoor;
    this.scene.environment = indoor ? this.roomEnv : (this.skyEnvRT ? this.skyEnvRT.texture : null);
    this.scene.fog.density = indoor ? 0 : this.scene.fog.density;
    this.hemi.visible = !indoor;
    this.sun.visible = !indoor;
  }

  update(dt, world) {
    if (this.mode === 'auto') this.time = (this.time + dt * 24 / DAY_LENGTH_SECONDS) % 24;
    const t = this.time;

    // Sun path: rises in the east (+x), arcs over the southern sky (+z), sets west.
    const th = (t - 6) / 12 * Math.PI;
    const el = Math.sin(th);
    this.sunDir.set(Math.cos(th), el * 0.9, 0.45 * Math.max(0.2, el + 0.3)).normalize();
    const elev = this.sunDir.y;

    const dayF = THREE.MathUtils.smoothstep(elev, -0.08, 0.12);
    const goldF = 1 - THREE.MathUtils.smoothstep(elev, 0.02, 0.35);
    this.night = 1 - THREE.MathUtils.smoothstep(elev, -0.16, 0.02);

    // Sky gradient: night -> golden -> day by sun height
    const u = this.sky.material.uniforms;
    const wDay = THREE.MathUtils.smoothstep(elev, 0.08, 0.45);
    const mixPal = (key, out) => {
      const g = SKY.golden[key], d = SKY.day[key], n = SKY.night[key];
      out.setRGB(g[0] + (d[0] - g[0]) * wDay, g[1] + (d[1] - g[1]) * wDay, g[2] + (d[2] - g[2]) * wDay);
      return out.lerp(_c2.setRGB(n[0], n[1], n[2]), this.night);
    };
    mixPal('zenith', u.zenith.value);
    mixPal('horizon', u.horizon.value);
    u.ground.value.copy(u.horizon.value).multiplyScalar(0.45);
    u.sunDir.value.copy(this.sunDir);
    u.sunColor.value.setRGB(1, 0.75 + 0.25 * wDay, 0.5 + 0.45 * wDay);
    u.glow.value = (0.6 + 0.8 * (1 - wDay)) * (1 - this.night);
    u.disk.value = THREE.MathUtils.smoothstep(elev, -0.03, 0.02);

    this.stars.material.opacity = this.night * 0.9;

    // Sun or moon
    if (elev > -0.05) {
      _c.setRGB(1, 0.78 + 0.22 * (1 - goldF), 0.55 + 0.45 * (1 - goldF));
      this.sun.color.copy(_c);
      this.sun.intensity = 3.0 * dayF;
      _v.copy(this.sunDir);
    } else {
      this.sun.color.setRGB(0.55, 0.65, 1.0);
      this.sun.intensity = 0.35;
      _v.set(-this.sunDir.x, -this.sunDir.y, 0.4).normalize(); // moon roughly opposite
    }
    this.hemi.intensity = 0.25 + 0.55 * dayF;
    this.hemi.color.setRGB(0.55 + 0.2 * dayF, 0.65 + 0.2 * dayF, 0.85 + 0.15 * dayF);
    this.hemi.groundColor.setRGB(0.18 + 0.12 * dayF, 0.16 + 0.1 * dayF, 0.14 + 0.08 * dayF);
    this.renderer.toneMappingExposure = 0.6 + 0.3 * dayF;

    // Shadow camera follows the player, snapped to texels to avoid shimmer.
    const tgt = this.shadowTarget;
    const texel = 220 / (this.sun.shadow.mapSize.x || 1024);
    const sx = Math.round(tgt.x / texel) * texel, sz = Math.round(tgt.z / texel) * texel;
    this.sun.target.position.set(sx, tgt.y, sz);
    this.sun.position.set(sx + _v.x * 400, tgt.y + Math.max(0.15, _v.y) * 400, sz + _v.z * 400);
    this.sun.target.updateMatrixWorld();

    // Fog: horizon-ish colour; Karl rolls in thick near the Golden Gate at dawn/morning.
    if (!this.indoor) {
      // Fog matches the horizon so the skyline fades into the sky; Karl adds a grey-white veil
      const fogBase = _c.copy(u.horizon.value).lerp(_c2.setRGB(0.7, 0.74, 0.78).multiplyScalar(0.2 + 0.8 * dayF), 0.35);
      this.scene.fog.color.copy(fogBase);
      let density = 0.00022 + 0.0002 * this.night;
      if (this.fogEnabled) {
        const morning = Math.max(0, 1 - Math.abs(t - 7.5) / 3.5) + (t > 19 || t < 5 ? 0.35 : 0);
        const dx = tgt.x - FOG_CENTER.x, dz = tgt.z - FOG_CENTER.y;
        const near = Math.exp(-(dx * dx + dz * dz) / (2 * 2600 * 2600));
        density += 0.0007 * near * (0.35 + morning) + 0.00022 * morning;
      }
      this.scene.fog.density = density;
    }

    if (this.bloom) {
      this.bloom.strength = 0.35 + 0.15 * this.night;
      this.bloom.threshold = 0.92;
    }

    if (world && world.setNight) world.setNight(this.night);

    // Rebake reflection probe when the light changes enough
    if (Math.abs(t - this.lastEnvTime) > 0.35 && !this.indoor) {
      this.lastEnvTime = t;
      const old = this.skyEnvRT;
      this.skyEnvRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
      this.scene.environment = this.skyEnvRT.texture;
      if (old) old.dispose();
    }

    // Keep sky + stars centred on the camera
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

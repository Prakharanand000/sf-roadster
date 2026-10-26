// SF Roadster Rush — game loop, state machine, camera, input and race logic.
// Module contracts: see CONTRACTS.md.
import * as THREE from 'three';
import { Environment } from './env.js';
import { loadWorld } from './world/city.js';
import { CARS, createCarModel, createTrafficCarModel } from './cars/models.js';
import { CarFX } from './cars/fx.js';
import { createShowroom } from './cars/showroom.js';
import { Vehicle, resolveVehicleCollisions } from './physics/vehicle.js';
import { AIDriver } from './physics/ai.js';
import { Traffic } from './physics/traffic.js';
import { AudioSystem } from './audio/audio.js';
import { UI } from './ui/ui.js';

const RIVAL_NAMES = ['Raj', 'Simran', 'Kabir', 'Veeru', 'Basanti', 'Rancho', 'Geet', 'Bunny', 'Jai', 'Naina'];
const MAX_DT = 1 / 20;
const TRAFFIC_FREE = { high: 40, medium: 26, low: 14 };
const TRAFFIC_RACE = { high: 18, medium: 12, low: 6 };

const store = {
  get(k, d) { try { const v = localStorage.getItem('sfrr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sfrr.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (k, dt) => 1 - Math.exp(-k * dt);

// ---------------------------------------------------------------- input

class Input {
  constructor() {
    this.keys = new Set();
    this.edges = new Set();
    this.steer = 0;
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, jump: false, jumpPressed: false };
    this.prevPad = [];
    this.padEdges = new Set();
    addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (!this.keys.has(e.code)) this.edges.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && game.isDriving()) e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }
  down(...codes) { return codes.some(c => this.keys.has(c)); }
  pressed(code) { return this.edges.has(code); }
  padPressed(i) { return this.padEdges.has(i); }

  poll(dt, touch) {
    const k = this;
    let throttle = k.down('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = k.down('KeyS', 'ArrowDown') ? 1 : 0;
    let steerTarget = (k.down('KeyD', 'ArrowRight') ? 1 : 0) - (k.down('KeyA', 'ArrowLeft') ? 1 : 0);
    let handbrake = k.down('Space');
    let boost = k.down('ShiftLeft', 'ShiftRight');
    let jump = k.down('KeyE');
    let jumpPressed = k.pressed('KeyE');

    // Keyboard steering ramps so taps don't jerk the car
    const rate = steerTarget === 0 ? 7 : (Math.sign(steerTarget) !== Math.sign(this.steer) ? 9 : 4.5);
    this.steer += THREE.MathUtils.clamp(steerTarget - this.steer, -rate * dt, rate * dt);
    let steer = this.steer;

    // Gamepad
    this.padEdges.clear();
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && Array.from(pads).find(p => p && p.connected);
    if (pad) {
      const b = i => pad.buttons[i] ? pad.buttons[i].value : 0;
      pad.buttons.forEach((btn, i) => { if (btn.pressed && !this.prevPad[i]) this.padEdges.add(i); this.prevPad[i] = btn.pressed; });
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > 0.12) steer = Math.sign(ax) * Math.pow((Math.abs(ax) - 0.12) / 0.88, 1.5);
      throttle = Math.max(throttle, b(7));
      brake = Math.max(brake, b(6));
      handbrake = handbrake || b(2) > 0.5;
      boost = boost || b(5) > 0.5 || b(1) > 0.5;
      jump = jump || b(0) > 0.5;
      jumpPressed = jumpPressed || this.padEdges.has(0);
    }

    if (touch) {
      throttle = Math.max(throttle, touch.throttle || 0);
      brake = Math.max(brake, touch.brake || 0);
      if (Math.abs(touch.steer || 0) > Math.abs(steer)) steer = touch.steer;
      handbrake = handbrake || !!touch.handbrake;
      boost = boost || !!touch.boost;
      jump = jump || !!touch.jump;
      jumpPressed = jumpPressed || !!touch.jumpPressed;
    }

    const s = this.state;
    s.throttle = throttle; s.brake = brake; s.steer = THREE.MathUtils.clamp(steer, -1, 1);
    s.handbrake = handbrake; s.boost = boost; s.jump = jump; s.jumpPressed = jumpPressed;
    return s;
  }
  endFrame() { this.edges.clear(); }
}

const IDLE_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: true, boost: false, jump: false, jumpPressed: false };

// ---------------------------------------------------------------- camera

class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.yaw = 0;
    this.fov = 62;
    this.shake = 0;
  }
  setMode(m) { this.mode = m; }
  cycle() { this.mode = this.mode === 'chase' ? 'far' : this.mode === 'far' ? 'hood' : 'chase'; return this.mode; }
  snap(v) {
    this.yaw = v.heading;
    this.update(1, v, null, true);
  }
  addShake(a) { this.shake = Math.min(1.2, this.shake + a); }

  update(dt, v, world, instant = false) {
    const cam = this.camera;
    const p = v.position;
    const speedKmh = Math.abs(v.speedKmh || 0);
    if (this.mode === 'hood') {
      _q.copy(v.quaternion);
      cam.position.set(0, 1.05, 0.35).applyQuaternion(_q).add(p);
      _v1.set(0, 0.95, 12).applyQuaternion(_q).add(p);
      cam.lookAt(_v1);
    } else {
      const far = this.mode === 'far';
      const dist = (far ? 9.5 : 6.4) + Math.min(speedKmh, 300) / 300 * (far ? 2.5 : 1.6);
      const height = (far ? 3.6 : 2.3) + (v.onGround ? 0 : 0.6);
      // Follow heading; while drifting, lean toward the velocity direction a little
      let target = v.heading;
      const hv = Math.hypot(v.velocity.x, v.velocity.z);
      if (hv > 4 && v.speed > 0) target = wrapPi(v.heading + wrapPi(Math.atan2(v.velocity.x, v.velocity.z) - v.heading) * 0.45);
      if (v.speed < -2) target = v.heading; // reversing: keep looking forward
      this.yaw += wrapPi(target - this.yaw) * (instant ? 1 : damp(v.onGround ? 5.5 : 2.2, dt));
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      _v1.set(p.x - fx * dist, p.y + height, p.z - fz * dist);
      if (world) {
        // Don't clip into buildings: pull the camera toward the car until it is clear
        const hit = world.collideCircle(_v1.x, _v1.z, 0.6, _v1.y - 1, {});
        if (hit) {
          let lo = 0, hi = 1;
          for (let i = 0; i < 5; i++) {
            const m = (lo + hi) / 2;
            const x = p.x - fx * dist * m, z = p.z - fz * dist * m;
            if (world.collideCircle(x, z, 0.6, _v1.y - 1, {})) hi = m; else lo = m;
          }
          const m = Math.max(0.25, lo);
          _v1.x = p.x - fx * dist * m; _v1.z = p.z - fz * dist * m;
        }
        const g = world.heightAt(_v1.x, _v1.z);
        if (_v1.y < g + 1.0) _v1.y = g + 1.0;
      }
      if (instant) this.pos.copy(_v1); else this.pos.lerp(_v1, damp(9, dt));
      _v2.set(p.x + fx * 3, p.y + 1.1, p.z + fz * 3);
      if (instant) this.look.copy(_v2); else this.look.lerp(_v2, damp(14, dt));
      cam.position.copy(this.pos);
      if (this.shake > 0.001) {
        const s = this.shake * 0.18;
        cam.position.x += (Math.random() - 0.5) * s;
        cam.position.y += (Math.random() - 0.5) * s;
        cam.position.z += (Math.random() - 0.5) * s;
      }
      cam.lookAt(this.look);
    }
    this.shake *= Math.exp(-dt * 6);
    const fovTarget = (this.mode === 'hood' ? 70 : 60) + Math.min(speedKmh, 320) / 320 * 16 + (v.boosting ? 7 : 0);
    this.fov += (fovTarget - this.fov) * (instant ? 1 : damp(3, dt));
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }
}

// ---------------------------------------------------------------- track helpers

class TrackPath {
  constructor(track) {
    this.track = track;
    this.loop = !!track.loop;
    const pts = track.path.slice();
    if (this.loop) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.5) pts.push([a[0], a[1]]);
    }
    this.pts = pts;
    this.cum = new Float32Array(pts.length);
    for (let i = 1; i < pts.length; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    this.length = this.cum[pts.length - 1];
    this.cpS = track.checkpoints.map(c => this.project(c.x, c.z, -1).s);
  }
  segCount() { return this.pts.length - 1; }
  /** Nearest point on the path. hint = previous segment index, or -1 for a global search. */
  project(x, z, hint = -1, out = { s: 0, seg: 0, dist: 0, tx: 0, tz: 1 }) {
    const n = this.segCount();
    let from = 0, to = n - 1;
    if (hint >= 0) { from = hint - 25; to = hint + 50; }
    let best = Infinity;
    for (let k = from; k <= to; k++) {
      let i = k;
      if (this.loop) i = ((k % n) + n) % n; else if (i < 0 || i >= n) continue;
      const a = this.pts[i], b = this.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a[0] + dx * t, pz = a[1] + dz * t;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < best) {
        best = d; out.seg = i; out.s = this.cum[i] + Math.sqrt(l2) * t;
        const l = Math.sqrt(l2); out.tx = dx / l; out.tz = dz / l;
      }
    }
    out.dist = Math.sqrt(best);
    return out;
  }
  pointAt(s, out = { x: 0, z: 0, heading: 0 }) {
    if (this.loop) s = ((s % this.length) + this.length) % this.length;
    else s = THREE.MathUtils.clamp(s, 0, this.length);
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const a = this.pts[lo], b = this.pts[hi];
    const l = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / l;
    out.x = a[0] + (b[0] - a[0]) * t; out.z = a[1] + (b[1] - a[1]) * t;
    out.heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
    return out;
  }
}

function makeGateMeshes(color) {
  const group = new THREE.Group();
  const glow = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, toneMapped: false });
  const sheet = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
  const pillarGeo = new THREE.CylinderGeometry(0.28, 0.28, 7, 10);
  const left = new THREE.Mesh(pillarGeo, glow), right = new THREE.Mesh(pillarGeo, glow);
  left.position.y = right.position.y = 3.5;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 0.35, 0.35), glow);
  bar.position.y = 7;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 7), sheet);
  plane.position.y = 3.5;
  group.add(left, right, bar, plane);
  group.userData = { left, right, bar, plane };
  return group;
}

function setGateWidth(g, w) {
  const u = g.userData;
  u.left.position.x = w / 2; u.right.position.x = -w / 2;
  u.bar.scale.x = w; u.plane.scale.x = w;
}

// ---------------------------------------------------------------- game

class Game {
  constructor() {
    this.state = 'loading';
    this.canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 26000);
    this.camera.position.set(0, 200, 400);
    this.worldRoot = new THREE.Group();
    this.scene.add(this.worldRoot);
    this.input = new Input();
    this.rig = new CameraRig(this.camera);
    this.audio = new AudioSystem();
    this.clock = new THREE.Clock();
    this.session = null;
    this.score = 0;
    this.attract = { t: 0, shot: 0 };
    this.garage = { yaw: 0.6, drag: null, model: null, carId: null, color: null };
    this.found = new Set(store.get('landmarks', []));
    this.settings = {
      quality: 'high', units: 'kmh', master: 0.9, music: 0.7, sfx: 0.9, camera: 'chase',
      traffic: true, timeOfDay: 'golden', fog: true, rivals: 5,
      ...store.get('settings', {}),
    };
    this.selected = store.get('car', { carId: 'roadster', color: null });
    this.ui = new UI(document.getElementById('ui'), this.callbacks());
    this.ui.setSettings?.(this.settings);
    this.ui.show('loading');
    this.env = new Environment(this.renderer, this.scene, this.camera);
    this.fx = new CarFX(this.scene);
    this.resize();
    addEventListener('resize', () => this.resize());
    const unlock = () => { this.audio.unlock(); };
    addEventListener('pointerdown', unlock, { capture: true });
    addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.isDriving()) this.pause(); });
    this.audio.onTrackChange = info => { this.ui.setNowPlaying(info); if (this.isDriving()) this.ui.toast(`${info.title} · ${info.artist}`, 'music', 3500); };
    this.bindGaragePointer();
  }

  isDriving() { return this.state === 'race' || this.state === 'free' || this.state === 'countdown'; }

  resize() {
    const q = this.settings.quality;
    const pr = Math.min(devicePixelRatio || 1, q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.env?.resize();
  }

  async load() {
    try {
      this.applySettings(this.settings, true);
      this.ui.setLoading(0.02, 'Reading the map of San Francisco');
      this.world = await loadWorld(this.worldRoot, {
        quality: this.settings.quality,
        onProgress: (f, m) => this.ui.setLoading(0.05 + f * 0.85, m),
      });
      this.ui.setLoading(0.92, 'Polishing the paint');
      this.showroom = createShowroom({ quality: this.settings.quality });
      this.scene.add(this.showroom.group);
      this.showroom.setVisible(false);
      this.traffic = new Traffic(this.scene, this.world, createTrafficCarModel, { count: TRAFFIC_FREE[this.settings.quality] });
      this.traffic.setEnabled(false);
      this.buildRoadIndex();
      this.ui.setCars(CARS);
      this.ui.setTracks(this.world.tracks);
      this.ui.setMinimap(this.world);
      this.ui.setSelectedCar(this.selected.carId, this.selected.color || this.carSpec(this.selected.carId).colors[0]);
      this.ui.setLoading(0.97, 'Warming up the thrusters');
      this.setupAttract();
      this.env.update(0, this.world);
      this.renderer.compile(this.scene, this.camera);
      this.ui.setLoading(1, 'Ready');
      this.toMenu();
    } catch (err) {
      console.error(err);
      this.ui.setLoading(0, 'Could not load the city: ' + (err && err.message ? err.message : err));
    }
    this.renderer.setAnimationLoop(() => this.frame());
  }

  carSpec(id) { return CARS.find(c => c.id === id) || CARS[0]; }

  // ----------------------------------------------------------- settings

  applySettings(s, initial = false) {
    const prevQ = this.settings.quality;
    this.settings = { ...this.settings, ...s };
    store.set('settings', this.settings);
    const st = this.settings;
    this.env.setQuality(st.quality);
    this.env.fogEnabled = !!st.fog;
    this.env.setMode(st.timeOfDay);
    this.rig.setMode(st.camera);
    this.audio.setVolumes({ master: st.master, music: st.music, sfx: st.sfx });
    if (!initial && prevQ !== st.quality) this.resize();
    if (!initial && this.traffic) {
      const wantTraffic = st.traffic && this.isDriving();
      this.traffic.setEnabled(wantTraffic);
    }
  }

  // ----------------------------------------------------------- UI callbacks

  callbacks() {
    return {
      onStartRace: o => this.startRace(o),
      onFreeRoam: o => this.startFree(o),
      onGarageOpen: () => this.openGarage(),
      onGarageCar: (id, color) => this.previewCar(id, color),
      onGarageClose: () => this.closeGarage(),
      onResume: () => this.resume(),
      onPause: () => this.pause(),
      onRestart: () => this.restart(),
      onQuit: () => this.toMenu(),
      onSettings: s => this.applySettings(s),
      onRadio: st => { this.audio.unlock(); this.audio.setRadio(st); },
      onNextTrack: () => this.audio.nextTrack(),
      onPrevTrack: () => this.audio.prevTrack(),
      onMusicFiles: files => { this.audio.unlock(); this.audio.addUserFiles(files); this.audio.setRadio('my-playlist'); },
      onUIClick: () => this.audio.play('ui-click'),
      onUIHover: () => this.audio.play('ui-hover'),
    };
  }

  // ----------------------------------------------------------- menu / attract

  setupAttract() {
    const lm = this.world.landmarks || [];
    const pick = ['golden', 'transamerica', 'coit', 'salesforce', 'ferry', 'palace', 'lombard', 'painted', 'alcatraz'];
    this.attract.shots = [];
    for (const key of pick) {
      const l = lm.find(m => (m.id + ' ' + m.name).toLowerCase().includes(key));
      if (l) this.attract.shots.push(l);
    }
    if (!this.attract.shots.length) this.attract.shots = lm.slice(0, 6);
    if (!this.attract.shots.length) this.attract.shots = [{ x: 0, z: 0, radius: 100 }];
  }

  updateAttract(dt) {
    const a = this.attract;
    a.t += dt;
    const shotLen = 14;
    if (a.t > shotLen) { a.t = 0; a.shot = (a.shot + 1) % a.shots.length; }
    const l = a.shots[a.shot];
    const r = Math.max(260, (l.radius || 100) * 2.8);
    const ang = a.shot * 1.7 + a.t * 0.045;
    const gy = this.world.heightAt(l.x, l.z);
    const cx = l.x + Math.sin(ang) * r, cz = l.z + Math.cos(ang) * r;
    const cy = Math.max(this.world.heightAt(cx, cz), gy, 0) + 70 + r * 0.25;
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(l.x, gy + Math.min(60, (l.radius || 60) * 0.5), l.z);
    if (this.camera.fov !== 55) { this.camera.fov = 55; this.camera.updateProjectionMatrix(); }
    this.env.follow(_v1.set(l.x, gy, l.z));
  }

  toMenu() {
    this.endSession();
    this.closeGarageScene();
    this.state = 'menu';
    this.audio.setPaused(false);
    this.audio.duck(0);
    this.ui.show('menu');
  }

  // ----------------------------------------------------------- garage

  bindGaragePointer() {
    this.canvas.addEventListener('pointerdown', e => { if (this.state === 'garage') this.garage.drag = { x: e.clientX, yaw: this.garage.yaw }; });
    addEventListener('pointermove', e => { const d = this.garage.drag; if (d) this.garage.yaw = d.yaw - (e.clientX - d.x) * 0.008; });
    addEventListener('pointerup', () => { this.garage.drag = null; });
  }

  openGarage() {
    this.state = 'garage';
    this.worldRoot.visible = false;
    this.traffic?.setEnabled(false);
    this.showroom.setVisible(true);
    this.env.useIndoor(true);
    this.previewCar(this.selected.carId, this.selected.color);
  }

  previewCar(id, color) {
    const spec = this.carSpec(id);
    color = color || spec.colors[0];
    this.selected = { carId: spec.id, color };
    store.set('car', this.selected);
    const g = this.garage;
    if (g.model && g.carId === spec.id) { g.model.setColor(color); return; }
    if (g.model) { this.showroom.carAnchor.remove(g.model.group); g.model.dispose(); }
    g.model = createCarModel(spec.id, { color, quality: this.settings.quality });
    g.carId = spec.id;
    g.model.setHeadlights(true);
    this.showroom.carAnchor.add(g.model.group);
    this.audio.setEngineProfile(spec.engine);
    this.audio.play('gear');
  }

  closeGarage() { this.closeGarageScene(); if (this.state === 'garage') { this.state = 'menu'; this.ui.show('menu'); } }

  closeGarageScene() {
    if (!this.showroom) return;
    this.showroom.setVisible(false);
    this.worldRoot.visible = true;
    this.env.useIndoor(false);
  }

  updateGarage(dt) {
    const sr = this.showroom;
    sr.update(dt);
    const t = sr.cameraTarget, p = sr.cameraPos;
    const dx = p.x - t.x, dz = p.z - t.z;
    const r = Math.hypot(dx, dz), base = Math.atan2(dx, dz);
    // Narrow screens: back the camera off so the whole car fits
    const fit = this.camera.aspect < 1 ? 1.5 / Math.max(0.45, this.camera.aspect) : 1;
    const ang = base + this.garage.yaw;
    this.camera.position.set(t.x + Math.sin(ang) * r * fit, p.y + (fit - 1) * 0.8, t.z + Math.cos(ang) * r * fit);
    // Portrait phones: the garage sheet covers the bottom half, so aim low to lift the car into the top half
    _v1.copy(t);
    if (this.camera.aspect < 1) _v1.y -= 1.1 * fit;
    this.camera.lookAt(_v1);
    if (this.camera.fov !== 42) { this.camera.fov = 42; this.camera.updateProjectionMatrix(); }
  }

  // ----------------------------------------------------------- sessions

  makeRacer(carId, color, name, isPlayer) {
    const spec = this.carSpec(carId);
    const model = createCarModel(spec.id, { color: color || spec.colors[0], quality: this.settings.quality, headlightSpot: isPlayer });
    this.scene.add(model.group);
    const vehicle = new Vehicle(spec, this.world);
    const fxh = this.fx.add(model);
    return { name, carId: spec.id, spec, model, vehicle, fxh, isPlayer, ai: null, s: 0, seg: -1, lap: 0, maxS: 0,
      finished: false, finishTime: 0, bestLap: Infinity, lapStart: 0, cpNext: 0, waterTime: 0, splashAt: -1 };
  }

  endSession() {
    const s = this.session;
    if (!s) return;
    for (const r of s.racers) { this.scene.remove(r.model.group); r.model.dispose(); }
    for (const g of s.gates || []) this.scene.remove(g);
    if (s.beacon) this.scene.remove(s.beacon);
    this.fx.clear();
    this.traffic?.setEnabled(false);
    this.session = null;
  }

  startCommon(mode, carId, color) {
    this.endSession();
    this.closeGarageScene();
    this.audio.unlock();
    const spec = this.carSpec(carId || this.selected.carId);
    this.selected = { carId: spec.id, color: color || this.selected.color || spec.colors[0] };
    store.set('car', this.selected);
    this.audio.setEngineProfile(spec.engine);
    this.score = 0;
    const player = this.makeRacer(spec.id, this.selected.color, 'You', true);
    player.vehicle.isPlayer = true;
    player.vehicle.thrusterFuel = 1;
    this.session = { mode, racers: [player], player, raceTime: 0, gates: [], drift: { combo: 0, idle: 0 }, msg: '', msgT: 0, wrongWay: 0 };
    player.vehicle.onCollision = (k, pt) => {
      this.audio.play('collision', { intensity: k });
      if (pt) this.fx.burst('collision', pt);
      this.rig.addShake(k * 0.8);
      this.session && (this.session.drift.combo *= 0.3);
    };
    player.vehicle.onLand = k => { this.audio.play('land', { intensity: k }); this.fx.burst('land', player.vehicle.position); this.rig.addShake(k * 0.5); };
    player.vehicle.onJump = () => this.audio.play('jump');
    player.vehicle.onSplash = () => { this.audio.play('splash'); this.fx.burst('splash', player.vehicle.position); };
    const night = this.env.night > 0.4;
    player.model.setHeadlights(night);
    player.headlights = night;
    this.ui.updateHUD({});
    return player;
  }

  startFree({ carId, color } = {}) {
    const p = this.startCommon('free', carId, color);
    const sp = this.world.spawn;
    p.vehicle.reset(sp.x, sp.z, sp.heading);
    p.vehicle.applyToModel(p.model);
    this.rig.snap(p.vehicle);
    this.traffic.setCount?.(TRAFFIC_FREE[this.settings.quality]);
    this.traffic.setEnabled(this.settings.traffic);
    this.state = 'free';
    this.ui.show('hud');
    this.ui.toast('Free roam · find all the landmarks of SF', 'info', 4000);
    this.audio.setRadio(this.audio.station && this.audio.station !== 'off' ? this.audio.station : 'bollywood-fm');
  }

  startRace({ trackId, mode = 'race', carId, color, rivals, laps } = {}) {
    const track = this.world.tracks.find(t => t.id === trackId) || this.world.tracks[0];
    this.lastRace = { trackId: track.id, mode, carId, color, rivals, laps };
    const player = this.startCommon(mode === 'trial' ? 'trial' : 'race', carId, color);
    const s = this.session;
    s.track = track;
    s.path = new TrackPath(track);
    s.laps = track.loop ? Math.max(1, laps || track.laps || 1) : 1;
    const grid = track.grid && track.grid.length ? track.grid : [{ ...s.path.pointAt(0) }];
    const nRivals = mode === 'trial' ? 0 : THREE.MathUtils.clamp(rivals ?? this.settings.rivals, 0, Math.max(0, grid.length - 1));

    // Rivals: different cars, Bollywood names
    const others = CARS.filter(c => c.id !== player.carId).sort(() => Math.random() - 0.5);
    const names = RIVAL_NAMES.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < nRivals; i++) {
      const spec = others[i % others.length];
      const r = this.makeRacer(spec.id, spec.colors[(i + 1) % spec.colors.length], names[i], false);
      const slot = grid[i];
      r.vehicle.reset(slot.x, slot.z, slot.heading);
      r.ai = new AIDriver(r.vehicle, track, { skill: 0.55 + Math.random() * 0.4, aggression: Math.random(), name: r.name, player: player.vehicle });
      r.vehicle.onCollision = (k, pt) => { if (pt && k > 0.3) this.fx.burst('collision', pt); };
      s.racers.push(r);
    }
    const ps = grid[Math.min(nRivals, grid.length - 1)];
    player.vehicle.reset(ps.x, ps.z, ps.heading);
    for (const r of s.racers) r.vehicle.thrusterFuel = 1;

    // Progress bookkeeping
    for (const r of s.racers) {
      const pr = s.path.project(r.vehicle.position.x, r.vehicle.position.z, -1);
      r.s = pr.s; r.seg = pr.seg; r.startS = pr.s;
      r.prog = s.path.loop && pr.s > s.path.length * 0.5 ? pr.s - s.path.length : pr.s;
      r.lap = Math.floor(r.prog / s.path.length);
      r.vehicle.applyToModel(r.model);
    }
    // First gate ahead of the player
    const cps = track.checkpoints;
    player.cpNext = 0;
    if (player.lap === 0) { while (player.cpNext < cps.length - 1 && s.path.cpS[player.cpNext] < player.s + 5) player.cpNext++; }
    else { let m = 0; s.path.cpS.forEach((v, i) => { if (v < s.path.cpS[m]) m = i; }); player.cpNext = m; }

    // Gates
    for (let i = 0; i < cps.length; i++) {
      const last = i === cps.length - 1 && !s.path.loop;
      const g = makeGateMeshes(last ? 0xffb21a : 0x35e0ff);
      const c = cps[i];
      setGateWidth(g, c.width || 18);
      g.position.set(c.x, this.world.surfaceHeight(c.x, c.z, 1e4), c.z);
      g.rotation.y = c.heading ?? s.path.pointAt(s.path.cpS[i]).heading;
      g.visible = false;
      this.scene.add(g);
      s.gates.push(g);
    }
    s.beacon = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 400, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }));
    this.scene.add(s.beacon);

    this.traffic.setCount?.(TRAFFIC_RACE[this.settings.quality]);
    this.traffic.setEnabled(this.settings.traffic && mode !== 'trial');
    s.bestKey = `best.${track.id}.${player.carId}`;
    s.bestLapStored = store.get(s.bestKey, null);
    this.rig.snap(player.vehicle);
    this.state = 'countdown';
    s.countdown = 3.999;
    s.lastCount = 4;
    this.ui.show('hud');
    this.audio.duck(0.5);
    if (!this.audio.station || this.audio.station === 'off') this.audio.setRadio('bollywood-fm');
  }

  restart() {
    if (!this.session) return;
    if (this.session.mode === 'free') this.startFree(this.selected);
    else this.startRace(this.lastRace);
  }

  pause() {
    if (!this.isDriving()) return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.audio.setPaused(true);
    this.ui.show('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = this.pausedFrom || 'free';
    this.audio.setPaused(false);
    this.ui.show('hud');
    this.clock.getDelta();
  }

  respawn(r) {
    const v = r.vehicle;
    const s = this.session;
    if (s && s.path) {
      const p = s.path.pointAt(r.s);
      v.reset(p.x, p.z, p.heading);
    } else {
      const p = this.nearestRoadPoint(v.position.x, v.position.z);
      v.reset(p.x, p.z, p.heading);
    }
    r.waterTime = 0;
    if (r.isPlayer) { this.rig.snap(v); this.fx.burst('checkpoint', v.position); }
  }

  buildRoadIndex() {
    // Coarse grid of road sample points for "reset to road"
    const cell = 60, idx = new Map();
    for (const road of this.world.roads || []) {
      const pts = road.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const h = Math.atan2(b[0] - a[0], b[1] - a[1]);
        for (let d = 0; d < l; d += 12) {
          const x = a[0] + (b[0] - a[0]) * d / l, z = a[1] + (b[1] - a[1]) * d / l;
          if (this.world.isWater(x, z)) continue;
          const k = Math.floor(x / cell) + ',' + Math.floor(z / cell);
          let arr = idx.get(k); if (!arr) idx.set(k, arr = []);
          arr.push(x, z, h);
        }
      }
    }
    this.roadIndex = { cell, idx };
  }

  nearestRoadPoint(x, z) {
    const { cell, idx } = this.roadIndex;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let r = 0; r < 30; r++) {
      let best = null, bd = Infinity;
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const arr = idx.get((cx + i) + ',' + (cz + j));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 3) {
          const d = (arr[k] - x) ** 2 + (arr[k + 1] - z) ** 2;
          if (d < bd) { bd = d; best = { x: arr[k], z: arr[k + 1], heading: arr[k + 2] }; }
        }
      }
      if (best) return best;
    }
    return this.world.spawn;
  }

  // ----------------------------------------------------------- per-frame

  frame() {
    const dt = Math.min(this.clock.getDelta(), MAX_DT);
    const inp = this.input;
    this.handleGlobalKeys();

    switch (this.state) {
      case 'menu':
      case 'loading':
        if (this.world) this.updateAttract(dt);
        break;
      case 'garage':
        this.updateGarage(dt);
        break;
      case 'countdown':
      case 'race':
      case 'free':
        this.updateDriving(dt);
        break;
      case 'results':
        if (this.session) this.updateDriving(dt, true);
        break;
      case 'paused':
        break;
    }

    if (this.world && this.state !== 'paused') {
      this.env.update(this.state === 'garage' ? 0 : dt, this.world);
      this.world.update(dt, this.camera, { night: this.env.night, time: this.env.time });
    }
    this.env.render();
    inp.endFrame();
  }

  handleGlobalKeys() {
    const inp = this.input;
    const padPause = inp.padPressed(9);
    if (inp.pressed('Escape') || inp.pressed('KeyP') || padPause) {
      if (this.isDriving()) this.pause();
      else if (this.state === 'paused' && (inp.pressed('KeyP') || padPause)) this.resume();
    }
    if (inp.pressed('KeyM')) this.audio.nextTrack();
    if (inp.pressed('KeyN')) {
      const order = ['bollywood-fm', 'my-playlist', 'off'];
      const next = order[(order.indexOf(this.audio.station || 'off') + 1) % order.length];
      this.audio.setRadio(next);
      this.ui.toast(next === 'off' ? 'Radio off' : next === 'my-playlist' ? 'My Playlist' : 'Bollywood FM', 'music', 1800);
    }
    // Gamepad menu navigation
    if (!this.isDriving() && this.ui.navigate) {
      if (inp.padPressed(12)) this.ui.navigate('up');
      if (inp.padPressed(13)) this.ui.navigate('down');
      if (inp.padPressed(14)) this.ui.navigate('left');
      if (inp.padPressed(15)) this.ui.navigate('right');
      if (inp.padPressed(0)) this.ui.select?.();
      if (inp.padPressed(1)) this.ui.back?.();
    }
  }

  updateDriving(dt, finished = false) {
    const s = this.session;
    const P = s.player;
    const pv = P.vehicle;
    const inp = this.input;

    // Countdown
    if (this.state === 'countdown') {
      s.countdown -= dt;
      const n = Math.ceil(s.countdown);
      if (n !== s.lastCount) {
        s.lastCount = n;
        this.ui.countdown(Math.max(0, n));
        this.audio.play(n > 0 ? 'countdown' : 'go');
        if (n <= 0) { this.state = 'race'; this.audio.duck(0); s.raceTime = 0; for (const r of s.racers) r.lapStart = 0; }
      }
    }
    const racing = this.state === 'race';
    const live = racing || this.state === 'free';

    // Player controls
    let input = IDLE_INPUT;
    if (live && !finished && !P.finished) {
      input = inp.poll(dt, this.ui.getTouchInput ? this.ui.getTouchInput() : null);
      if (inp.pressed('KeyC') || inp.padPressed(3)) { const m = this.rig.cycle(); this.ui.toast(`Camera: ${m}`, 'info', 1000); }
      if (inp.pressed('KeyR')) this.respawn(P);
      if (inp.pressed('KeyH')) { P.headlights = !P.headlights; P.model.setHeadlights(P.headlights); }
    } else if (this.state === 'countdown') {
      // Let the player rev on the grid
      const i = inp.poll(dt, this.ui.getTouchInput ? this.ui.getTouchInput() : null);
      input = { ...IDLE_INPUT, throttle: i.throttle };
    } else if (P.finished) {
      input = { ...IDLE_INPUT, handbrake: false, brake: 0.4 };
    }
    const prevBoost = pv.boosting, prevGear = pv.gear;
    pv.update(dt, input);
    if (pv.boosting && !prevBoost) this.audio.play('boost');
    if (pv.gear !== prevGear && pv.onGround) this.audio.play('gear');

    // AI
    const vehicles = [];
    for (const r of s.racers) {
      if (!r.isPlayer) {
        const others = s.racers.map(o => o.vehicle);
        const ai = (racing || r.finished) ? r.ai.getInput(dt, this.world, others) : IDLE_INPUT;
        r.vehicle.update(dt, r.finished ? { ...ai, throttle: Math.min(ai.throttle, 0.3) } : ai);
        if (r.ai.needsReset) { if (r.ai.resetToTrack) r.ai.resetToTrack(); else this.respawn(r); r.ai.needsReset = false; }
      }
      vehicles.push(r.vehicle);
    }
    if (this.traffic && this.traffic.enabled !== false) {
      this.traffic.update(dt, pv, s.racers.filter(r => !r.isPlayer).map(r => r.vehicle));
      if (this.traffic.proxies) vehicles.push(...this.traffic.proxies);
      if (live) {
        const nm = this.traffic.nearMissCheck(pv);
        if (nm > 0) {
          this.score += 250 * nm;
          pv.addFuel?.(0.08 * nm);
          this.audio.play('nearmiss');
          this.flash(`+${250 * nm} NEAR MISS`);
        }
      }
    }
    resolveVehicleCollisions(vehicles);

    // Visuals + water + FX
    for (const r of s.racers) {
      const v = r.vehicle;
      v.applyToModel(r.model);
      r.model.update?.(dt);
      this.fx.update(dt, r.fxh, v);
      if (v.inWater) {
        r.waterTime += dt;
        if (r.waterTime > 1.4) this.respawn(r);
      } else r.waterTime = 0;
    }

    if (s.path) this.updateRace(dt, racing);
    if (live) this.updateScoring(dt);
    if (s.mode === 'free') this.updateDiscovery();

    // Audio + camera
    this.audio.updateEngine({ rpm: pv.rpm, throttle: input.throttle, speed: pv.speed, gear: pv.gear, boosting: pv.boosting,
      hovering: pv.hovering, onGround: pv.onGround, slip: pv.slip, inWater: pv.inWater, maxSpeed: P.spec.physics.maxSpeed });
    this.rig.update(dt, pv, this.world);
    this.env.follow(pv.position);
    if (pv.boosting) this.rig.addShake(dt * 0.6);
    this.updateHUD(dt);
  }

  updateRace(dt, racing) {
    const s = this.session;
    const path = s.path, L = path.length;
    if (racing) s.raceTime += dt;
    for (const r of s.racers) {
      const v = r.vehicle;
      const prevS = r.s;
      const pr = path.project(v.position.x, v.position.z, r.seg);
      if (pr.dist > 80) Object.assign(pr, path.project(v.position.x, v.position.z, -1));
      r.seg = pr.seg; r.s = pr.s; r.pathDist = pr.dist;
      r.tx = pr.tx; r.tz = pr.tz;
      if (r.finished || !racing) continue;
      if (path.loop) {
        // Unwrapped distance along the loop; big jumps (respawns, projection snaps) don't count
        let d = r.s - prevS;
        if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
        if (Math.abs(d) < 60) r.prog += d;
        const lapNow = Math.floor(r.prog / L);
        while (lapNow > r.lap) this.completeLap(r);
      } else if (r.s >= L - 6 && pr.dist < 40 && r.s - r.startS > L * 0.3) {
        this.finishRacer(r);
      }
    }

    // Player gates
    const P = s.player;
    const cps = s.track.checkpoints;
    if (!P.finished && cps.length) {
      const c = cps[P.cpNext];
      const pv = P.vehicle;
      const dx = pv.position.x - c.x, dz = pv.position.z - c.z;
      const gy = s.gates[P.cpNext].position.y;
      if (dx * dx + dz * dz < Math.pow(Math.max(12, (c.width || 18) * 0.7), 2) && Math.abs(pv.position.y - gy) < 30) {
        this.fx.burst('checkpoint', s.gates[P.cpNext].position);
        const isFinal = !path.loop && P.cpNext === cps.length - 1;
        if (isFinal) this.finishRacer(P);
        else {
          this.audio.play('checkpoint');
          P.cpNext = (P.cpNext + 1) % cps.length;
        }
      }
      // Show next two gates, beacon on the next
      s.gates.forEach((g, i) => { g.visible = i === P.cpNext || i === (P.cpNext + 1) % cps.length; });
      const ng = s.gates[P.cpNext];
      s.beacon.position.set(ng.position.x, ng.position.y + 200, ng.position.z);
      s.beacon.visible = !P.finished;
    }

    // Wrong way
    const pv = P.vehicle;
    if (racing && pv.speedKmh > 25 && P.tx !== undefined) {
      const fx = Math.sin(pv.heading), fz = Math.cos(pv.heading);
      const dot = fx * P.tx + fz * P.tz;
      s.wrongWay = dot < -0.5 ? s.wrongWay + dt : 0;
    } else s.wrongWay = 0;
  }

  completeLap(r) {
    const s = this.session;
    if (r.lap >= 0) {
      const lapTime = s.raceTime - r.lapStart;
      if (r.isPlayer) {
        const prevBest = Math.min(r.bestLap, s.bestLapStored ?? Infinity);
        if (lapTime < prevBest) {
          if (r.lap > 0 || s.raceTime > 5) this.flash('NEW BEST LAP');
          store.set(s.bestKey, lapTime);
          s.bestLapStored = lapTime;
        }
        this.audio.play('lap');
      }
      r.bestLap = Math.min(r.bestLap, lapTime);
    }
    r.lap += 1;
    r.lapStart = s.raceTime;
    if (r.lap >= s.laps) this.finishRacer(r);
    else if (r.isPlayer && r.lap === s.laps - 1) this.flash('FINAL LAP');
  }

  finishRacer(r) {
    if (r.finished) return;
    const s = this.session;
    r.finished = true;
    r.finishTime = s.raceTime;
    if (!s.track.loop) r.bestLap = r.finishTime;
    if (r.isPlayer) {
      this.audio.play('finish');
      if (!s.track.loop) {
        const prev = s.bestLapStored ?? Infinity;
        if (r.finishTime < prev) { store.set(s.bestKey, r.finishTime); s.bestLapStored = r.finishTime; }
      }
      setTimeout(() => this.showResults(), 2600);
    }
  }

  standings() {
    const s = this.session;
    const L = s.path.length;
    const prog = r => r.finished ? 1e9 - r.finishTime : (s.path.loop ? r.prog : r.s);
    return s.racers.slice().sort((a, b) => prog(b) - prog(a));
  }

  showResults() {
    const s = this.session;
    if (!s || this.state === 'results') return;
    this.state = 'results';
    const L = s.path.length * s.laps;
    const list = this.standings().map(r => {
      let time = r.finishTime;
      if (!r.finished) {
        // Estimate from remaining distance at a typical pace
        const done = s.path.loop ? Math.max(0, r.prog) : r.s;
        const pace = Math.max(15, done / Math.max(1, s.raceTime));
        time = s.raceTime + (L - done) / pace;
      }
      return { name: r.name, car: r.spec.name, time, isPlayer: r.isPlayer };
    }).sort((a, b) => a.time - b.time);
    const pos = list.findIndex(x => x.isPlayer) + 1;
    this.ui.showResults({ trackName: s.track.name, position: pos, time: s.player.finishTime, bestLap: isFinite(s.player.bestLap) ? s.player.bestLap : s.player.finishTime,
      standings: list, score: Math.round(this.score), racers: list.length, mode: s.mode });
    this.ui.show('results');
    this.audio.duck(0.25);
  }

  updateScoring(dt) {
    const s = this.session;
    const v = s.player.vehicle;
    const d = s.drift;
    if (v.drifting && v.onGround && v.speedKmh > 35 && Math.abs(v.driftAngle || 0) > 0.18) {
      d.combo += Math.abs(v.driftAngle || 0.3) * v.speedKmh * dt * 4;
      d.idle = 0;
    } else if (d.combo > 0) {
      d.idle += dt;
      if (d.idle > 0.8) {
        const pts = Math.round(d.combo);
        if (pts > 150) { this.score += pts; this.flash(`+${pts} DRIFT`); }
        d.combo = 0;
      }
    }
  }

  updateDiscovery() {
    const v = this.session.player.vehicle;
    for (const l of this.world.landmarks || []) {
      if (this.found.has(l.id)) continue;
      const r = Math.max(60, (l.radius || 40) + 40);
      if ((v.position.x - l.x) ** 2 + (v.position.z - l.z) ** 2 < r * r) {
        this.found.add(l.id);
        store.set('landmarks', [...this.found]);
        this.audio.play('discover');
        this.score += 1000;
        this.ui.toast(`Discovered ${l.name}${l.blurb ? ' · ' + l.blurb : ''}`, 'discover', 5000);
      }
    }
  }

  flash(text) { const s = this.session; if (s) { s.msg = text; s.msgT = 1.8; } }

  updateHUD(dt) {
    const s = this.session;
    const P = s.player;
    const v = P.vehicle;
    const units = this.settings.units;
    const speed = Math.abs(v.speedKmh) * (units === 'mph' ? 0.621371 : 1);
    s.msgT -= dt;
    let message = s.msgT > 0 ? s.msg : '';
    if (s.wrongWay > 0.8) message = 'WRONG WAY';
    // Stuck or lost: remind the player about the reset key
    const live = this.state === 'race' || this.state === 'free';
    s.stuckT = live && !P.finished && ((Math.abs(v.speedKmh) < 4 && (this.input.state.throttle > 0.3 || this.input.state.brake > 0.3)) || (s.path && P.pathDist > 70)) ? (s.stuckT || 0) + dt : 0;
    if (s.stuckT > 3 && !message) message = s.path && P.pathDist > 70 ? 'OFF ROUTE · PRESS R TO RESET' : 'STUCK? PRESS R TO RESET';
    if (v.inWater) message = 'SPLASH! Respawning';

    const h = {
      mode: s.mode, speed, units, gear: v.gear, rpm: v.rpm, boost: v.thrusterFuel, boosting: v.boosting, hovering: v.hovering,
      drift: Math.round(s.drift.combo), score: Math.round(this.score), message,
    };
    const mm = { player: { x: v.position.x, z: v.position.z, heading: v.heading }, rivals: [], checkpoints: [], next: 0, landmarks: [] };
    if (s.path) {
      const st = this.standings();
      h.lap = Math.min(s.laps, Math.max(1, P.lap + 1));
      h.laps = s.laps;
      h.position = st.indexOf(P) + 1;
      h.racers = s.racers.length;
      h.raceTime = s.raceTime;
      h.lapTime = s.raceTime - P.lapStart;
      h.bestLap = isFinite(P.bestLap) ? P.bestLap : (s.bestLapStored ?? null);
      h.checkpoint = P.cpNext;
      h.checkpoints = s.track.checkpoints.length;
      const c = s.track.checkpoints[P.cpNext];
      const camDir = this.camera.getWorldDirection(_v3);
      const camYaw = Math.atan2(camDir.x, camDir.z);
      const tYaw = Math.atan2(c.x - v.position.x, c.z - v.position.z);
      h.nextDir = -wrapPi(tYaw - camYaw); // positive = clockwise on screen (to the right)
      h.nextDist = Math.hypot(c.x - v.position.x, c.z - v.position.z);
      for (const r of s.racers) if (!r.isPlayer) mm.rivals.push({ x: r.vehicle.position.x, z: r.vehicle.position.z, heading: r.vehicle.heading });
      mm.checkpoints = s.track.checkpoints;
      mm.next = P.cpNext;
    } else {
      h.landmarksFound = (this.world.landmarks || []).filter(l => this.found.has(l.id)).length;
      h.landmarksTotal = (this.world.landmarks || []).length;
      mm.landmarks = (this.world.landmarks || []).map(l => ({ x: l.x, z: l.z, found: this.found.has(l.id) }));
    }
    this.ui.updateHUD(h);
    this.ui.updateMinimap(mm);
  }
}

const game = new Game();
window.__game = game; // handy for debugging in the console
game.load();

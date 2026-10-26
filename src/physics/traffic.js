// SF Roadster Rush — ambient traffic (PHYSICS agent). Entry: src/physics/traffic.js
//
//   const traffic = new Traffic(scene, world, createTrafficCarModel, { count: 40 });
//   per frame (after player/AI update):  traffic.update(dt, player, aiVehicles?);
//   resolveVehicleCollisions([player, ...ais, ...traffic.proxies]);
//   const n = traffic.nearMissCheck(player); if (n) { player.addFuel(0.08 * n); ... }
//
// Kinematic cars follow world.roads polylines in lanes (right-hand traffic: lane centre
// offset to the right of the centreline), slow for bends, follow the car ahead, stop when
// the player (or any vehicle passed in `others`) is right in front, continue onto a
// connected road at polyline ends (or U-turn), and despawn/respawn in a ring of
// 80..600 m around the player. When hit hard they become "knocked" free bodies that slide
// and spin, then respawn once out of sight range.
// proxies: active collision stand-ins (position, velocity, heading, mass, halfLength, ...).
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const EXCLUDE = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'bridleway', 'service', 'corridor', 'construction', 'proposed']);
const BASE_SPEED = { motorway: 24, trunk: 20, primary: 15, secondary: 13.5, tertiary: 12, residential: 10, unclassified: 10, living_street: 6 };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// all live Traffic instances (AIDriver reads their proxies so rivals avoid ambient traffic
// even when the integrator only passes the racers as `others`)
export const TRAFFIC_INSTANCES = new Set();

class TrafficProxy {
  constructor(car) {
    this.car = car;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.heading = 0;
    this.mass = 1700;
    this.halfLength = 2.2;
    this.halfWidth = 0.92;
    this.Iy = (this.mass / 12) * (4.4 * 4.4 + 1.84 * 1.84);
    this.kinematic = true;
    this.knocked = false;
    this.isTraffic = true;
    this.disabled = false;
    this.speed = 0;
    this.lastImpact = 0;
    this.lastImpactStrength = 0;
    this._prevPos = new THREE.Vector3();
    this.onCollision = null;
  }
  _shift(dx, dz) { this.position.x += dx; this.position.z += dz; }
  _applyImpulse(jx, jz, px, pz) {
    const im = 1 / this.mass;
    this.velocity.x += jx * im; this.velocity.z += jz * im;
    const rx = px - this.position.x, rz = pz - this.position.z;
    this.angularVelocity.y += ((rz * jx - rx * jz) / this.Iy) * 1.5;
  }
  knock(dv) { this.car._hitT = this.car._owner._time; if (dv > 1.5) this.car._knockReq = true; }
}

export class Traffic {
  constructor(scene, world, createTrafficCarModel, { count = 40, minDist = 80, maxDist = 600, seed = 1337 } = {}) {
    this.scene = scene;
    this.world = world;
    this.count = count;
    this.minDist = minDist; this.maxDist = maxDist;
    this.enabled = true;
    this.rand = mulberry32(seed);
    this._time = 0;
    this._respawns = 0; this._knocks = 0;
    this._prepRoads(world.roads || []);
    this.cars = [];
    this.proxies = [];
    this._factory = createTrafficCarModel;
    TRAFFIC_INSTANCES.add(this);
    this._seed = seed;
    for (let i = 0; i < count; i++) this._addCar(i);
    this._needInit = true;
  }

  _addCar(i) {
    {
      const scene = this.scene, seed = this._seed, createTrafficCarModel = this._factory;
      const model = createTrafficCarModel ? createTrafficCarModel(seed + i * 7919) : null;
      if (model && scene) scene.add(model.group);
      const car = {
        id: i, model, road: -1, dir: 1, s: 0, speed: 0, target: 12, base: 12, lane: 1.8, laneCur: 1.8,
        state: 'idle', knockT: 0, y: 0, wheelSpin: 0, braking: false, targetSpeedOverride: null,
        _hitT: -99, _knockReq: false, _owner: this, nm: { armed: false, touched: false, cooldown: 0 },
      };
      car.proxy = new TrafficProxy(car);
      if (model && model.dims) { car.proxy.halfLength = model.dims.length / 2; car.proxy.halfWidth = model.dims.width / 2; }
      if (model) model.group.visible = false;
      this.cars.push(car);
    }
  }

  // Change the number of traffic cars at runtime (e.g. quality setting). New cars spawn
  // around the player on the next update; removed cars are disposed.
  setCount(n) {
    n = Math.max(0, Math.floor(n));
    while (this.cars.length < n) {
      this._addCar(this.cars.length);
      const c = this.cars[this.cars.length - 1];
      c.state = 'idle';
    }
    while (this.cars.length > n) {
      const c = this.cars.pop();
      if (c.model) { if (this.scene) this.scene.remove(c.model.group); if (c.model.dispose) c.model.dispose(); }
    }
    this.count = n;
    const keep = new Set(this.cars.map(c => c.proxy));
    for (let i = this.proxies.length - 1; i >= 0; i--) if (!keep.has(this.proxies[i])) this.proxies.splice(i, 1);
  }

  _prepRoads(roads) {
    this.roads = [];
    let total = 0;
    for (const r of roads) {
      if (!r.points || r.points.length < 2) continue;
      if (r.type && EXCLUDE.has(r.type)) continue;
      const n = r.points.length;
      const x = new Float64Array(n), z = new Float64Array(n), s = new Float64Array(n);
      for (let i = 0; i < n; i++) { x[i] = r.points[i][0]; z[i] = r.points[i][1]; if (i) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]); }
      const len = s[n - 1];
      if (len < 40) continue;
      const width = r.width || 8;
      this.roads.push({ x, z, s, n, len, width, oneway: !!r.oneway, type: r.type, base: BASE_SPEED[r.type] || 12, cum0: total, links: [[], []] });
      total += len;
    }
    this.totalLen = total;
    // endpoint links via hash (12 m)
    const C = 12, map = new Map();
    const key = (x, z) => Math.floor(x / C) * 73856093 ^ Math.floor(z / C) * 19349663;
    this.roads.forEach((r, ri) => {
      for (const end of [0, 1]) {
        const i = end ? r.n - 1 : 0;
        const k = key(r.x[i], r.z[i]);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ ri, end, x: r.x[i], z: r.z[i] });
      }
    });
    this.roads.forEach((r, ri) => {
      for (const end of [0, 1]) {
        const i = end ? r.n - 1 : 0;
        const px = r.x[i], pz = r.z[i];
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const list = map.get(key(px + dx * C, pz + dz * C));
          if (!list) continue;
          for (const e of list) {
            if (e.ri === ri) continue;
            if (Math.hypot(e.x - px, e.z - pz) > 12) continue;
            const o = this.roads[e.ri];
            if (o.oneway && e.end === 1) continue; // can only enter one-way at its start
            if (!r.links[end].some(l => l.ri === e.ri && l.end === e.end)) r.links[end].push({ ri: e.ri, end: e.end });
          }
        }
      }
    });
    // also: points in the middle of other roads (T-junction) are ignored for simplicity
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      for (const c of this.cars) { c.state = 'idle'; if (c.model) c.model.group.visible = false; }
      this.proxies.length = 0;
    } else this._needInit = true;
  }

  stats() {
    return { count: this.count, active: this.cars.filter(c => c.state !== 'idle').length, respawns: this._respawns, knocked: this._knocks };
  }

  // place a car explicitly: road index, direction (+1/-1), fraction along the road
  placeCar(car, ri, dir, frac) {
    const r = this.roads[ri];
    car.road = ri; car.dir = r.oneway ? 1 : dir; car.s = clamp(frac, 0, 1) * r.len;
    car.base = r.base * (0.85 + 0.3 * this.rand());
    const lanes = r.oneway ? 0 : Math.min(r.width / 4, 2.4);
    car.lane = r.oneway ? (r.width > 9 ? (this.rand() < 0.5 ? -1 : 1) * r.width / 4 : 0) : lanes;
    car.laneCur = car.lane;
    car.speed = car.base * 0.8;
    car.state = 'drive';
    car.y = NaN;
    car.proxy.knocked = false;
    car.proxy.angularVelocity.set(0, 0, 0);
    car.proxy.disabled = false;
    car.nm.armed = false; car.nm.touched = false;
    this._pose(car, 0);
    car.proxy._prevPos.copy(car.proxy.position);
    if (car.model) car.model.group.visible = true;
  }

  _spawn(car, px, pz, near, others) {
    if (!this.roads.length) return false;
    const minD = near ? this.minDist : Math.max(this.minDist, 160), maxD = this.maxDist * 0.95;
    for (let tries = 0; tries < 24; tries++) {
      const u = this.rand() * this.totalLen;
      let lo = 0, hi = this.roads.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.roads[m].cum0 <= u) lo = m; else hi = m - 1; }
      const r = this.roads[lo];
      const s = u - r.cum0;
      const i = this._segAt(r, s);
      const x = r.x[i], z = r.z[i];
      const d = Math.hypot(x - px, z - pz);
      if (d < minD || d > maxD) continue;
      // never pop in right next to a racer (AI rivals can be far from the player)
      let clear = true;
      if (others) for (let k = 0; k < others.length; k++) {
        const o = others[k];
        if (o && Math.abs(o.position.x - x) < 90 && Math.abs(o.position.z - z) < 90 && Math.hypot(o.position.x - x, o.position.z - z) < 90) { clear = false; break; }
      }
      if (!clear) continue;
      // keep spacing from other traffic
      let ok = true;
      for (const c of this.cars) {
        if (c === car || c.state === 'idle') continue;
        const q = c.proxy.position;
        if (Math.abs(q.x - x) < 12 && Math.abs(q.z - z) < 12) { ok = false; break; }
      }
      if (!ok) continue;
      this.placeCar(car, lo, this.rand() < 0.5 ? 1 : -1, s / r.len);
      return true;
    }
    return false;
  }

  _segAt(r, s) {
    let lo = 0, hi = r.n - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (r.s[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  }
  _pointAt(r, s, out) {
    s = clamp(s, 0, r.len);
    const i = this._segAt(r, s);
    const L = r.s[i + 1] - r.s[i] || 1e-3;
    const t = (s - r.s[i]) / L;
    out.x = r.x[i] + (r.x[i + 1] - r.x[i]) * t;
    out.z = r.z[i] + (r.z[i + 1] - r.z[i]) * t;
    return out;
  }

  _pose(car, dt) {
    const r = this.roads[car.road], p = car.proxy;
    const a = this._pointAt(r, car.s - 3 * car.dir, _a), b = this._pointAt(r, car.s + 3 * car.dir, _b);
    let fx = b.x - a.x, fz = b.z - a.z;
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const c = this._pointAt(r, car.s, _c);
    car.laneCur += clamp(car.lane - car.laneCur, -1.2 * dt, 1.2 * dt);
    // right = (-fz, fx)
    const x = c.x - fz * car.laneCur, z = c.z + fx * car.laneCur;
    const w = this.world;
    const yRef = Number.isFinite(car.y) ? car.y + 1.5 : 1e4;
    const y = w.surfaceHeight(x, z, yRef);
    const yf = w.surfaceHeight(x + fx * 2, z + fz * 2, y + 1.5), yb = w.surfaceHeight(x - fx * 2, z - fz * 2, y + 1.5);
    car.y = y;
    p.heading = Math.atan2(fx, fz);
    _e.set(-Math.atan2(yf - yb, 4), p.heading, 0, 'YXZ');
    p.quaternion.setFromEuler(_e);
    p.position.set(x, y, z);
    p.velocity.set(fx * car.speed, 0, fz * car.speed);
    p.speed = car.speed;
  }

  _advanceRoad(car) {
    const r = this.roads[car.road];
    if (car.s >= 0 && car.s <= r.len) return true;
    const end = car.s > r.len ? 1 : 0;
    const over = end ? car.s - r.len : -car.s;
    const links = r.links[end];
    if (links.length) {
      const l = links[Math.floor(this.rand() * links.length)];
      const o = this.roads[l.ri];
      car.road = l.ri;
      if (l.end === 0) { car.dir = 1; car.s = over; } else { car.dir = -1; car.s = o.len - over; }
      if (!o.oneway) car.lane = Math.min(o.width / 4, 2.4);
      else car.lane = 0;
      car.base = o.base * (0.85 + 0.3 * this.rand());
      return true;
    }
    if (r.oneway) return false;
    // U-turn
    car.dir = -car.dir;
    car.s = end ? r.len - over : over;
    car.laneCur = -car.laneCur; // lane swaps sides relative to the new direction, glide back
    return true;
  }

  update(dt, player, others) {
    if (!this.enabled || !dt) return;
    dt = Math.min(dt, 0.1);
    this._time += dt;
    const px = player ? player.position.x : 0, pz = player ? player.position.z : 0;
    if (this._needInit) {
      this._needInit = false;
      for (const c of this.cars) { c.state = 'idle'; this._spawn(c, px, pz, true, others); }
    }
    const pfx = player ? Math.sin(player.heading) : 0, pfz = player ? Math.cos(player.heading) : 1;
    this.proxies.length = 0;
    for (const car of this.cars) {
      const p = car.proxy;
      p._prevPos.copy(p.position);
      p.lastImpact = 0; p.lastImpactStrength = 0;
      if (car.state === 'idle') {
        if (!this._spawn(car, px, pz, false, others)) continue;
        this._respawns++;
      }
      const d = Math.hypot(p.position.x - px, p.position.z - pz);
      if (car._knockReq && car.state === 'drive') {
        car.state = 'knocked'; car.knockT = 0; p.knocked = true; this._knocks++;
      }
      car._knockReq = false;
      if (car.state === 'drive') {
        if (d > this.maxDist) { car.state = 'idle'; if (car.model) car.model.group.visible = false; continue; }
        this._driveCar(car, dt, player, others, pfx, pfz);
      } else if (car.state === 'knocked') {
        car.knockT += dt;
        this._knockedCar(car, dt);
        if ((d > 140 && car.knockT > 3) || (car.knockT > 25 && d > 40) || d > this.maxDist) {
          car.state = 'idle'; p.knocked = false; if (car.model) car.model.group.visible = false; continue;
        }
      }
      this._applyModel(car, dt);
      this.proxies.push(p);
    }
  }

  _driveCar(car, dt, player, others, pfx, pfz) {
    const r = this.roads[car.road], p = car.proxy;
    // bend ahead: heading change over the next 25 m
    const a = this._pointAt(r, car.s, _a), b = this._pointAt(r, car.s + 12 * car.dir, _b), c = this._pointAt(r, car.s + 25 * car.dir, _c);
    const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
    let dh = Math.abs(h2 - h1); if (dh > Math.PI) dh = 2 * Math.PI - dh;
    const k = dh / 14;
    let target = Math.min(car.base, Math.sqrt(2.6 / Math.max(k, 1e-4)));
    // near polyline ends with no link: slow for the U-turn
    const toEnd = car.dir > 0 ? r.len - car.s : car.s;
    if (toEnd < 20 && !r.links[car.dir > 0 ? 1 : 0].length) target = Math.min(target, 5);
    // obstacles ahead: player / others / traffic in lane
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const lx = fz, lz = -fx;
    const look = 10 + car.speed * 1.2;
    const check = (o, isTraffic) => {
      const dx = o.position.x - p.position.x, dz = o.position.z - p.position.z;
      if (Math.abs(dx) > look + 5 || Math.abs(dz) > look + 5) return;
      const lon = dx * fx + dz * fz, lat = dx * lx + dz * lz;
      if (lon < 1 || lon > look) return;
      if (Math.abs(lat) > (isTraffic ? 1.6 : 2.6)) return;
      if (Math.abs(o.position.y - p.position.y) > 3) return;
      const gap = lon - 5.5;
      const ov = o.velocity ? Math.max(0, o.velocity.x * fx + o.velocity.z * fz) : 0;
      const tgt = gap <= 0 ? 0 : Math.min(ov + gap * 0.5, Math.sqrt(2 * 5 * gap) + ov * 0.5);
      if (tgt < target) target = tgt;
    };
    // yield to fast vehicles on a collision course (cross traffic at junctions): closest approach
    const yieldTo = (o) => {
      if (!o || !o.velocity) return;
      const px = p.position.x - o.position.x, pz = p.position.z - o.position.z;
      if (Math.abs(px) > 160 || Math.abs(pz) > 160) return;
      const wx = car.speed * fx - o.velocity.x, wz = car.speed * fz - o.velocity.z;
      const w2 = wx * wx + wz * wz;
      if (w2 < 25) return;
      const tca = -(px * wx + pz * wz) / w2;
      if (tca < 0 || tca > 3) return;
      const mx = px + wx * tca, mz = pz + wz * tca;
      if (mx * mx + mz * mz < 4.5 * 4.5) target = 0;
    };
    if (player) { check(player, false); yieldTo(player); }
    if (others) for (let i = 0; i < others.length; i++) if (others[i] && others[i] !== player) { check(others[i], false); yieldTo(others[i]); }
    for (let i = 0; i < this.cars.length; i++) {
      const o = this.cars[i];
      if (o === car || o.state === 'idle') continue;
      check(o.proxy, true);
    }
    if (car.targetSpeedOverride !== null && car.targetSpeedOverride !== undefined) target = car.targetSpeedOverride;
    car.target = target;
    const dv = target - car.speed;
    car.braking = dv < -0.3 || (target < 0.5 && car.speed < 0.5);
    car.speed = Math.max(0, car.speed + clamp(dv, -(target === 0 ? 10 : 7) * dt, 2.6 * dt));
    car.s += car.dir * car.speed * dt;
    if (!this._advanceRoad(car)) { car.state = 'idle'; if (car.model) car.model.group.visible = false; return; }
    this._pose(car, dt);
  }

  _knockedCar(car, dt) {
    const p = car.proxy, w = this.world;
    const v = p.velocity;
    const sp = Math.hypot(v.x, v.z);
    if (sp > 0) { const ns = Math.max(0, sp - 7 * dt); v.x *= ns / sp; v.z *= ns / sp; }
    v.y = 0;
    const wy = p.angularVelocity.y;
    p.angularVelocity.y = Math.sign(wy) * Math.max(0, Math.abs(wy) - 2.5 * dt);
    p.heading += p.angularVelocity.y * dt;
    p.position.x += v.x * dt; p.position.z += v.z * dt;
    // world walls
    if (w.collideCircle(p.position.x, p.position.z, p.halfWidth + 0.3, p.position.y, _hit)) {
      p.position.x += _hit.nx * _hit.depth; p.position.z += _hit.nz * _hit.depth;
      const vn = v.x * _hit.nx + v.z * _hit.nz;
      if (vn < 0) { v.x -= 1.3 * vn * _hit.nx; v.z -= 1.3 * vn * _hit.nz; }
    }
    const y = w.surfaceHeight(p.position.x, p.position.z, (Number.isFinite(car.y) ? car.y : p.position.y) + 1.5);
    car.y = y; p.position.y = y;
    _e.set(0, p.heading, 0, 'YXZ');
    p.quaternion.setFromEuler(_e);
    car.speed = sp;
    car.braking = true;
  }

  _applyModel(car, dt) {
    const m = car.model;
    if (!m) return;
    const p = car.proxy;
    m.group.visible = true;
    m.group.position.copy(p.position);
    m.group.quaternion.copy(p.quaternion);
    car.wheelSpin = (car.wheelSpin + (car.speed / 0.33) * dt) % (Math.PI * 200);
    if (m.wheels) for (let i = 0; i < m.wheels.length; i++) if (m.wheels[i]) m.wheels[i].rotation.x = car.wheelSpin;
    if (car._lastBrake !== car.braking && m.setBrake) { m.setBrake(car.braking); car._lastBrake = car.braking; }
  }

  // Returns the number of NEW near misses this frame (player passes within ~1.5 m of a
  // traffic car at > 80 km/h without touching it). Counted when the player moves away.
  nearMissCheck(player) {
    if (!this.enabled || !player) return 0;
    let count = 0;
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
    const lx = fz, lz = -fx;
    const fast = Math.abs(player.speed) > 80 / 3.6;
    for (const car of this.cars) {
      const nm = car.nm;
      if (car.state === 'idle') { nm.armed = false; continue; }
      const p = car.proxy;
      const dx = p.position.x - player.position.x, dz = p.position.z - player.position.z;
      if (this._time - car._hitT < 1.0) nm.touched = true;
      if (Math.abs(dx) > 14 || Math.abs(dz) > 14) {
        if (nm.armed) { if (!nm.touched) { count++; nm.cooldown = this._time + 3; } nm.armed = false; }
        continue;
      }
      const lon = dx * fx + dz * fz, lat = dx * lx + dz * lz;
      const overlap = Math.abs(lon) < player.halfLength + p.halfLength + 0.5;
      const sideGap = Math.abs(lat) - player.halfWidth - p.halfWidth;
      if (overlap && fast && sideGap < 1.5 && sideGap > -0.1 && this._time >= nm.cooldown && !nm.armed && Math.abs(p.position.y - player.position.y) < 2.5) {
        nm.armed = true; nm.touched = this._time - car._hitT < 1.0;
      }
      if (nm.armed && Math.hypot(dx, dz) > 9) {
        if (!nm.touched) { count++; nm.cooldown = this._time + 3; }
        nm.armed = false;
      }
    }
    return count;
  }

  dispose() {
    TRAFFIC_INSTANCES.delete(this);
    for (const c of this.cars) if (c.model) { if (this.scene) this.scene.remove(c.model.group); if (c.model.dispose) c.model.dispose(); }
    this.cars.length = 0; this.proxies.length = 0;
  }
}

const _a = { x: 0, z: 0 }, _b = { x: 0, z: 0 }, _c = { x: 0, z: 0 };
const _e = new THREE.Euler();
const _hit = { nx: 0, nz: 0, depth: 0 };

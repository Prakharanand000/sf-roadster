// SF Roadster Rush — AI racing driver (PHYSICS agent). Entry: src/physics/ai.js
//
//   const ai = new AIDriver(vehicle, track, { skill, aggression, name, player, rubberBand })
//   per frame:  vehicle.update(dt, ai.getInput(dt, world, others));  if (ai.needsReset) ai.resetToTrack();
//
// - follows track.path with pure pursuit + yaw-rate damping, speed-dependent lookahead that
//   is shortened so the chord to the target point never cuts through a wall (the path has a
//   pre-computed "corridor": free space left/right of the centreline, probed with
//   world.collideCircle) -> no clipping of building corners at tight junctions / Lombard.
// - target speed from upcoming curvature, crests (strict if a bend or steep drop follows the
//   crest, loose on straights so jumps stay fun) and slope-aware braking distance (downhill
//   brakes are weaker, airborne cars can't brake).
// - overtakes / avoids other cars by a lateral offset clamped to the corridor; also sees the
//   active ambient Traffic proxies even if they are not passed in `others`.
// - boosts on long straights, rubber-bands relative to the player (others[i].isPlayer
//   or options.player), skill sets the base pace.
// - stuck > 3 s -> reverse & recover; wrong way -> turn around; far off the path,
//   flipped or in water -> needsReset (call resetToTrack() or reset the vehicle yourself).
//   Recoveries are not counted once the car has finished.
// - progress: metres along the path, lap-aware (progress = lap * length + s), lapsCompleted,
//   lapProgress (0..1), finished. Starting behind the line (grid) gives progress < 0.
// ProgressTracker and TrackPath are exported for the integrator (race positions of the player).

import { TRAFFIC_INSTANCES } from './traffic.js';

const G = 9.81;
const G_EFF = G * 1.3; // matches PHYS.gravityScale default
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapAngle = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

const _pathCache = new WeakMap();
const CORRIDOR_MAX = 12;   // metres probed each side
const H_STEP = 2;          // fine height sampling step (m)

export class TrackPath {
  static for(track, world) {
    let p = _pathCache.get(track);
    if (!p) { p = new TrackPath(track, world); _pathCache.set(track, p); }
    return p;
  }
  constructor(track, world) {
    this.track = track;
    this.loop = !!track.loop;
    const raw = track.path;
    let pts = raw;
    if (this.loop && raw.length > 2) {
      const a = raw[0], b = raw[raw.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5) pts = raw.slice(0, -1);
    }
    const n = pts.length;
    this.n = n;
    this.x = new Float64Array(n); this.z = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.x[i] = pts[i][0]; this.z[i] = pts[i][1]; }
    const segs = this.loop ? n : n - 1;
    this.segs = segs;
    this.s = new Float64Array(n + 1);
    this.tx = new Float64Array(n); this.tz = new Float64Array(n); this.segLen = new Float64Array(n);
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const dx = this.x[j] - this.x[i], dz = this.z[j] - this.z[i];
      const L = Math.hypot(dx, dz) || 1e-3;
      this.segLen[i] = L; this.tx[i] = dx / L; this.tz[i] = dz / L;
      this.s[i + 1] = this.s[i] + L;
    }
    if (!this.loop) { this.tx[n - 1] = this.tx[n - 2]; this.tz[n - 1] = this.tz[n - 2]; this.segLen[n - 1] = this.segLen[n - 2] || 8; }
    this.length = this.s[segs];
    let w = track.width;
    if (!w && track.checkpoints && track.checkpoints.length) {
      const ws = track.checkpoints.map(c => c.width || 10).sort((a, b) => a - b);
      w = ws[Math.floor(ws.length / 2)];
    }
    this.width = w || 10;

    // fine heights every 2 m (groundHeight = terrain or bridge deck, ignores roofs)
    const nh = Math.ceil(this.length / H_STEP) + 2;
    this.hs = new Float32Array(nh);
    const pt = { x: 0, z: 0, tx: 0, tz: 1, i: 0 };
    let y = 0;
    for (let k = 0; k < nh; k++) {
      this.pointAt(k * H_STEP, pt);
      if (!world) y = 0;
      else if (world.groundHeight) y = world.groundHeight(pt.x, pt.z);
      else y = k === 0 ? world.surfaceHeight(pt.x, pt.z, world.heightAt(pt.x, pt.z) + 1) : world.surfaceHeight(pt.x, pt.z, y + 2);
      this.hs[k] = y;
    }
    this.h = new Float64Array(n);
    for (let i = 0; i < n; i++) this.h[i] = this.heightAtS(this.s[i]);
    // abrupt step-ups along the road (e.g. a bridge deck that starts higher than its
    // approach): [s, rise] pairs; the AI hops over them
    this.steps = [];
    for (let k = 2; k + 1 < nh; k++) {
      // rise over the next 2 m beyond what the road's own grade (previous 4 m) explains
      const rise = (this.hs[k + 1] - this.hs[k]) - (this.hs[k] - this.hs[k - 2]) / 2;
      if (rise > 0.55) { this.steps.push([k * H_STEP, rise]); k += 3; }
    }

    // curvature (signed, + = left) over +-10 m; slope; vertical curvature at 6 m and 12 m scale
    this.k = new Float64Array(n); this.vk = new Float64Array(n); this.slope = new Float64Array(n);
    const wnd = 10;
    for (let i = 0; i < n; i++) {
      const s = this.s[i];
      this.k[i] = wrapAngle(this.headingAt(s + wnd) - this.headingAt(s - wnd)) / (2 * wnd);
      const y0 = this.heightAtS(s);
      const vk12 = (this.heightAtS(s - 12) - 2 * y0 + this.heightAtS(s + 12)) / 144;
      const vk6 = (this.heightAtS(s - 6) - 2 * y0 + this.heightAtS(s + 6)) / 36;
      this.vk[i] = Math.min(vk12, vk6 * 0.75);
      this.slope[i] = (this.heightAtS(s + 6) - this.heightAtS(s - 6)) / 12;
    }
    const k2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let m = this.k[i];
      for (let d = -1; d <= 1; d++) {
        const j = this._wrapIdx(i + d);
        if (j >= 0 && Math.abs(this.k[j]) > Math.abs(m)) m = this.k[j];
      }
      k2[i] = m;
    }
    this.k = k2;
    // camber: cross-fall of the road (+ = left side higher), from ground heights 3 m each side
    // kick: abrupt grade increase (DEM lumps / ramps that launch a fast car), max over 3 lanes
    this.camber = new Float32Array(n); this.kick = new Float32Array(n);
    if (world) {
      const gh = world.groundHeight ? world.groundHeight : (x, z) => world.heightAt(x, z);
      const q = { x: 0, z: 0, tx: 0, tz: 1, i: 0 };
      const hl = (ss, lat) => { this.pointAt(ss, q); return gh(q.x + q.tz * lat, q.z - q.tx * lat); };
      for (let i = 0; i < n; i++) {
        const lx = this.tz[i], lz = -this.tx[i];
        this.camber[i] = (gh(this.x[i] + lx * 3, this.z[i] + lz * 3) - gh(this.x[i] - lx * 3, this.z[i] - lz * 3)) / 6;
        let kmax = 0;
        for (const lat of [-1.5, 0, 1.5]) {
          for (let ds = -4; ds <= 4; ds += 2) {
            const s0 = this.s[i] + ds;
            const h0 = hl(s0, lat);
            const kk = (hl(s0 + 2, lat) - h0) / 2 - (h0 - hl(s0 - 4, lat)) / 4;
            if (kk > kmax) kmax = kk;
          }
        }
        this.kick[i] = kmax;
      }
    }

    // corridor: free space to the nearest wall each side of the driving line (at road height).
    // Where the centreline itself runs inside a wall (map data: a building footprint over the
    // road), the line is moved sideways ("detour" base offset) to the nearer free side, ramped
    // in/out at 1 m lateral per 3 m of path so the AI drives around it instead of into it.
    this.freeL = new Float32Array(n); this.freeR = new Float32Array(n); this.base = new Float32Array(n);
    const hit = { nx: 0, nz: 0, depth: 0 };
    const coll = world && world.collideCircle ? (x, z, y) => world.collideCircle(x, z, 0.4, y, hit) : () => null;
    const blocked = [];
    for (let i = 0; i < n; i++) {
      const yy = this.h[i] + 0.2;
      if (!coll(this.x[i], this.z[i], yy)) continue;
      const lx = this.tz[i], lz = -this.tx[i];
      let best = 0, bestD = 1e9;
      for (const side of [1, -1]) {
        for (let d = 0.5; d <= 30; d += 0.5) {
          if (!coll(this.x[i] + lx * d * side, this.z[i] + lz * d * side, yy)) { if (d < bestD) { bestD = d; best = side; } break; }
        }
      }
      if (best) blocked.push([i, best * (bestD + 1.6)]);
    }
    for (const [i, b] of blocked) {
      const si = this.s[i];
      for (let j = 0; j < n; j++) {
        let d = Math.abs(this.s[j] - si);
        if (this.loop) d = Math.min(d, this.length - d);
        const mag = Math.abs(b) - d / 3;
        if (mag > Math.abs(this.base[j])) this.base[j] = Math.sign(b) * mag;
      }
    }
    for (let i = 0; i < n; i++) {
      const lx = this.tz[i], lz = -this.tx[i], yy = this.h[i] + 0.2;
      const bx = this.x[i] + lx * this.base[i], bz = this.z[i] + lz * this.base[i];
      for (const side of [1, -1]) {
        let free = CORRIDOR_MAX;
        if (world && world.collideCircle) {
          for (let d = 0; d <= CORRIDOR_MAX; d += 0.5) {
            if (coll(bx + lx * d * side, bz + lz * d * side, yy)) { free = Math.max(0, d - 0.1); break; }
          }
        }
        if (side > 0) this.freeL[i] = free; else this.freeR[i] = free;
      }
    }
    this.hasDetour = blocked.length > 0;
  }
  baseAt(s) {
    const i = this.segAt(s), j = (i + 1) % this.n;
    const t = clamp((this.wrapS(s) - this.s[i]) / this.segLen[i], 0, 1);
    return this.base[i] + (this.base[j] - this.base[i]) * t;
  }
  _wrapIdx(i) {
    if (this.loop) return ((i % this.n) + this.n) % this.n;
    return i < 0 || i >= this.n ? -1 : i;
  }
  wrapS(s) {
    if (this.loop) { s %= this.length; if (s < 0) s += this.length; return s; }
    return clamp(s, 0, this.length);
  }
  segAt(s) {
    s = this.wrapS(s);
    let lo = 0, hi = this.segs - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.s[mid] <= s) lo = mid; else hi = mid - 1; }
    return lo;
  }
  headingAt(s) { const i = this.segAt(s); return Math.atan2(this.tx[i], this.tz[i]); }
  heightAtS(s) {
    s = this.wrapS(s);
    const f = s / H_STEP;
    const k = Math.min(this.hs.length - 2, Math.floor(f));
    const t = f - k;
    return this.hs[k] + (this.hs[k + 1] - this.hs[k]) * t;
  }
  pointAt(s, out) {
    s = this.wrapS(s);
    const i = this.segAt(s);
    const t = clamp((s - this.s[i]) / this.segLen[i], 0, 1);
    out.x = this.x[i] + this.tx[i] * this.segLen[i] * t;
    out.z = this.z[i] + this.tz[i] * this.segLen[i] * t;
    out.tx = this.tx[i]; out.tz = this.tz[i];
    out.i = i;
    return out;
  }
  // closest point search around the hint segment (+-60 m of path), global fallback
  project(x, z, hint, out, wMeters = 60) {
    let best = 1e18, bi = 0, bt = 0;
    const test = (i) => {
      const L = this.segLen[i];
      let t = ((x - this.x[i]) * this.tx[i] + (z - this.z[i]) * this.tz[i]) / L;
      t = clamp(t, 0, 1);
      const px = this.x[i] + this.tx[i] * L * t, pz = this.z[i] + this.tz[i] * L * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < best) { best = d2; bi = i; bt = t; }
    };
    if (hint >= 0) {
      test(hint);
      for (const dir of [1, -1]) {
        let i = hint, acc = 0;
        for (let c = 0; c < this.segs && acc < wMeters; c++) {
          i += dir;
          if (this.loop) i = ((i % this.segs) + this.segs) % this.segs;
          else if (i < 0 || i >= this.segs) break;
          acc += this.segLen[i];
          test(i);
        }
      }
    }
    if (hint < 0 || best > 30 * 30) {
      const b0 = best, i0 = bi, t0 = bt;
      best = 1e18;
      for (let i = 0; i < this.segs; i++) test(i);
      if (hint >= 0 && b0 < best * 4 && b0 < 60 * 60) { best = b0; bi = i0; bt = t0; }
    }
    out.i = bi;
    out.s = this.s[bi] + bt * this.segLen[bi];
    const px = this.x[bi] + this.tx[bi] * this.segLen[bi] * bt, pz = this.z[bi] + this.tz[bi] * this.segLen[bi] * bt;
    out.dist = Math.sqrt(best);
    out.lat = (x - px) * this.tz[bi] - (z - pz) * this.tx[bi]; // + = left of the path
    return out;
  }
}

// Lap-aware progress along a TrackPath for any object with position {x,z}.
export class ProgressTracker {
  constructor(path, x, z) {
    this.path = path;
    this._p = { i: 0, s: 0, dist: 0, lat: 0 };
    this.reset(x, z);
  }
  reset(x, z) {
    const p = this.path;
    p.project(x, z, -1, this._p);
    this.idx = this._p.i;
    this.s = this._p.s;
    this.lap = p.loop && this.s > p.length * 0.5 ? -1 : 0;
    this.dist = this._p.dist; this.lat = this._p.lat;
    this.progress = this.lap * p.length + this.s;
  }
  update(x, z) {
    const p = this.path;
    p.project(x, z, this.idx, this._p);
    const ns = this._p.s;
    if (p.loop) {
      const L = p.length;
      // only a genuine crossing of the start line (small actual movement) changes the lap
      if (this.s > L * 0.75 && ns < L * 0.25 && (L - this.s) + ns < 80) this.lap++;
      else if (this.s < L * 0.25 && ns > L * 0.75 && this.s + (L - ns) < 80) this.lap--;
    }
    this.s = ns; this.idx = this._p.i; this.dist = this._p.dist; this.lat = this._p.lat;
    this.progress = this.lap * p.length + this.s;
    return this.progress;
  }
}

const _pt = { x: 0, z: 0, tx: 0, tz: 1, i: 0 };
const _pt2 = { x: 0, z: 0, tx: 0, tz: 1, i: 0 };

export class AIDriver {
  constructor(vehicle, track, { skill = 0.7, aggression = 0.5, name = 'AI', player = null, rubberBand = 1, world = null } = {}) {
    this.vehicle = vehicle;
    this.track = track;
    this.skill = clamp(skill, 0, 1);
    this.aggression = clamp(aggression, 0, 1);
    this.name = name;
    this.player = player;
    this.rubberBand = rubberBand;
    this.path = TrackPath.for(track, world || vehicle.world);
    this.tracker = new ProgressTracker(this.path, vehicle.position.x, vehicle.position.z);
    this._playerTracker = null;
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, jump: false, jumpPressed: false };
    this.offset = 0; this._offTarget = 0; this._avoidT = 0; this._hopCd = 0; this._resetRepeat = 0;
    this.mode = 'race'; this._modeT = 0;
    this._stuckT = 0; this._offT = 0; this._flipT = 0;
    this.recoveries = 0; this._recentRecov = [];
    this.needsReset = false;
    this.resetReason = null;
    this.targetSpeed = 0;
    this._time = 0;
    this._seed = (Math.abs(hashStr(name)) % 1000) / 1000;
    const sp = vehicle.spec && vehicle.spec.physics ? vehicle.spec.physics : vehicle.p;
    this._mu = Math.min(sp.gripFront, sp.gripRear);
    this._buildSpeedProfile();
    this._wdBest = this.tracker.progress; this._wdT = 0;
  }

  _buildSpeedProfile() {
    const p = this.path, n = p.n;
    const mu = this._mu * (0.68 + 0.16 * this.skill);
    const hw = this.vehicle.halfWidth || 1;
    this.vCorner = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(p.k[i]);
      // off-camber corners (road falls away to the outside) need more margin
      const outsideDrop = p.k[i] < 0 ? -p.camber[i] : p.camber[i]; // left turn: outside = right
      const muEff = Math.max(mu * 0.45, mu - Math.max(0, outsideDrop) * 1.3);
      let vc = Math.sqrt((muEff * G) / Math.max(k, 1e-4));
      // tight corridor (walls close to the line): a little extra margin
      if (Math.min(p.freeL[i], p.freeR[i]) < hw + 1.5 && k > 0.01) vc *= 0.9;
      // crests: strict when a bend / steep drop follows within ~70 m, loose on straights (jumps!)
      const vk = p.vk[i];
      if (vk < -0.003) {
        let danger = 0, d = 0;
        for (let j = i, c = 0; c < n && d < 70; c++) {
          danger = Math.max(danger, Math.abs(p.k[j]));
          if (p.slope[j] < -0.14) danger = Math.max(danger, 0.02);
          d += p.segLen[j] || 8;
          j++; if (j >= n) { if (!p.loop) break; j = 0; }
        }
        const allow = danger > 0.012 ? 1.05 : 2.4 + this.aggression;
        vc = Math.min(vc, Math.sqrt((G_EFF * allow) / -vk));
      }
      // launch ramps / lumps: slower if a bend is near (being airborne there = off the road)
      let nearStep = false;
      for (let q = 0; q < p.steps.length; q++) { const ds = p.steps[q][0] - p.s[i]; if (ds > -10 && ds < 40) { nearStep = true; break; } }
      if (p.kick[i] > 0.12 && !nearStep) {
        let bend = 0, d = 0;
        for (let j = i, c = 0; c < n && d < 30; c++) {
          bend = Math.max(bend, Math.abs(p.k[j]));
          d += p.segLen[j] || 8; j++; if (j >= n) { if (!p.loop) break; j = 0; }
        }
        const lim = (bend > 0.02 ? 2.6 : bend > 0.008 ? 4.5 : 7) / p.kick[i];
        vc = Math.min(vc, Math.max(7, lim));
      }
      this.vCorner[i] = Math.min(vc, 200);
    }
    this._aBrake = mu * G * 0.62;
  }

  get progress() { return this.tracker.progress; }
  get lapsCompleted() { return Math.max(0, this.tracker.lap); }
  get lapProgress() { return this.tracker.s / this.path.length; }
  get finished() {
    if (!this.path.loop) return this.tracker.s >= this.path.length - 4;
    return this.lapsCompleted >= (this.track.laps || 1);
  }

  // Reset the car onto the path at its current progress (call when needsReset).
  resetToTrack(backMeters = 0) {
    const v = this.vehicle, path = this.path;
    let s0 = this.tracker.s - backMeters;
    // repeated resets at the same spot: put the car a bit further along each time
    if (this._lastResetS !== undefined && Math.abs(s0 - this._lastResetS) < 12 && this._time - this._lastResetT < 40) this._resetRepeat++;
    else this._resetRepeat = 0;
    this._lastResetS = s0; this._lastResetT = this._time;
    s0 += 15 * this._resetRepeat;
    // never right in front of a step-up we would have to hop from standstill
    for (let q = 0; q < path.steps.length; q++) { const ds = path.steps[q][0] - s0; if (ds > -3 && ds < 15) s0 = path.steps[q][0] + 8; }
    if (!path.loop) s0 = Math.min(s0, path.length - 1);
    const s = path.wrapS(s0);
    this.path.pointAt(s, _pt);
    const fuel = v.thrusterFuel;
    const b = path.baseAt(s); // detour offset where the centreline runs through a wall
    v.reset(_pt.x + _pt.tz * b, _pt.z - _pt.tx * b, Math.atan2(_pt.tx, _pt.tz));
    v.thrusterFuel = fuel;
    this.needsReset = false;
    this._stuckT = 0; this._offT = 0; this._flipT = 0; this.mode = 'race'; this.offset = 0; this._offTarget = 0;
    this._recentRecov.length = 0;
    this.tracker.update(v.position.x, v.position.z);
    this._wdBest = this.tracker.progress; this._wdT = 0;
  }
  // pose on the path at the current progress, for the integrator's own reset logic
  resetPose(out = {}) {
    this.path.pointAt(this.tracker.s, _pt);
    const b = this.path.baseAt(this.tracker.s);
    out.x = _pt.x + _pt.tz * b; out.z = _pt.z - _pt.tx * b; out.heading = Math.atan2(_pt.tx, _pt.tz);
    return out;
  }

  // corridor bounds (lateral offsets the car centre may use) at path index i
  _corr(i, hw, margin) {
    const p = this.path;
    const lim = p.base[i] !== 0 ? 99 : Math.max(0.5, p.width / 2 - hw - 0.4);
    let L = Math.min(lim, p.freeL[i] - hw - margin), R = Math.min(lim, p.freeR[i] - hw - margin);
    if (L + R < 0) { const m = (L - R) / 2; L = m; R = -m; } // too narrow: use the middle
    this._cL = L; this._cR = -R;
  }

  getInput(dt, world, others = []) {
    const v = this.vehicle, path = this.path, inp = this.input;
    this._time += dt;
    inp.jumpPressed = false; inp.jump = false; inp.handbrake = false; inp.boost = false;
    const tr = this.tracker;
    tr.update(v.position.x, v.position.z);
    const speed = v.speed, av = Math.abs(speed);
    const F = v._fwdV, Lv = v._leftV;
    let fx = F.x, fz = F.z; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const lx = fz, lz = -fx;
    const hw = v.halfWidth || 1;
    const finishedCool = this.finished;
    const p2pDone = finishedCool && !path.loop;

    // ---- rubber band
    let player = this.player;
    if (!player) for (let i = 0; i < others.length; i++) if (others[i] && others[i].isPlayer) { player = others[i]; break; }
    let rb = 0;
    if (player && player !== v && this.rubberBand > 0) {
      if (!this._playerTracker || this._playerTracker._who !== player) {
        this._playerTracker = new ProgressTracker(path, player.position.x, player.position.z);
        this._playerTracker._who = player;
      } else this._playerTracker.update(player.position.x, player.position.z);
      const gap = this._playerTracker.progress - tr.progress;
      rb = clamp(gap / 120, -1, 1) * this.rubberBand;
    }
    const base = 0.9 + 0.1 * this.skill;
    v.powerScale = base * (1 + 0.14 * Math.max(rb, 0) - 0.07 * Math.max(-rb, 0));
    const paceScale = 1 + 0.05 * rb;

    // ---- avoidance (racers in `others` + active ambient traffic)
    const maxOff = Math.max(0.5, path.width / 2 - 1.6);
    let follow = 1e9, nearest = 1e9;
    let want = 0, side = 0;
    const look = Math.min(160, 25 + av * 1.5);
    let nearestObj = null;
    const consider = (o) => {
      if (!o || o === v || o.disabled) return;
      const dx = o.position.x - v.position.x, dz = o.position.z - v.position.z;
      if (Math.abs(dx) > look + 10 || Math.abs(dz) > look + 10) return;
      if (Math.abs(o.position.y - v.position.y) > 3) return;
      const lon = dx * fx + dz * fz, lat = dx * lx + dz * lz;
      if (lon < -6 || lon > look) return;
      const wsum = (o.halfWidth || 1) + hw + 0.6;
      if (Math.abs(lat) > wsum + 2.5) return;
      const ov = o.velocity ? o.velocity.x * fx + o.velocity.z * fz : 0;
      if (Math.abs(lon) < v.halfLength + (o.halfLength || 2.2) && Math.abs(lat) < wsum + 0.8) {
        side += -Math.sign(lat || 1) * (wsum + 0.8 - Math.abs(lat));
      }
      const closing = av - ov;
      if (lon < -1) return;
      if (closing < -0.5 && lon > 6) return;
      if (lon < nearest) {
        nearest = lon;
        const theirOff = tr.lat - path.baseAt(tr.s) + lat;
        const gap = wsum + 0.4;
        const left = theirOff + gap, right = theirOff - gap;
        // corridor at their position
        this._corr(path.segAt(tr.s + lon), hw, 0.5);
        const canL = left <= Math.min(maxOff, this._cL), canR = right >= Math.max(-maxOff, this._cR);
        const cur = this.offset;
        if (Math.abs(lat) < wsum + 0.3) {
          // commit to one side per obstacle (flip-flopping at speed = crash)
          let sideSel = 0;
          if (this._avoidObj === o && this._avoidSide) sideSel = (this._avoidSide > 0 ? canL : canR) ? this._avoidSide : 0;
          if (!sideSel) {
            if (canL && canR) sideSel = Math.abs(left - cur) < Math.abs(right - cur) ? 1 : -1;
            else if (canL) sideSel = 1;
            else if (canR) sideSel = -1;
          }
          if (sideSel) want = sideSel > 0 ? left : right;
          else { want = cur; follow = Math.min(follow, ov + Math.max(0, lon - 8) * 0.6); }
          nearestObj = o; this._avoidSideNew = sideSel;
          this._avoidT = 1.2;
        }
      }
    };
    for (let i = 0; i < others.length; i++) consider(others[i]);
    for (const tf of TRAFFIC_INSTANCES) {
      if (!tf.enabled || !tf.proxies) continue;
      for (let i = 0; i < tf.proxies.length; i++) if (others.indexOf(tf.proxies[i]) < 0) consider(tf.proxies[i]);
    }
    if (nearestObj) { this._avoidObj = nearestObj; this._avoidSide = this._avoidSideNew; }
    if (this._avoidT > 0) { this._avoidT -= dt; if (nearest < 1e9) this._offTarget = want; }
    else this._offTarget *= Math.max(0, 1 - dt * 0.6);
    if (side !== 0) this._offTarget = this.offset + clamp(side, -2, 2);
    this._offTarget = clamp(this._offTarget, -maxOff, maxOff);
    const rate = 2.5 + av * 0.05;
    this.offset += clamp(this._offTarget - this.offset, -rate * dt, rate * dt);

    // ---- target point (pure pursuit), lookahead shortened until the chord stays in the corridor
    let Ld = clamp(5 + av * 0.42, 6, 42);
    const minLd = Math.max(4, av * 0.3); // never so short that steering gets twitchy at speed
    let tx = 0, tz = 0, off = this.offset;
    for (let tries = 0; tries < 5; tries++) {
      let sT = tr.s + Ld;
      if (!path.loop) sT = Math.min(sT, path.length);
      path.pointAt(sT, _pt);
      this._corr(_pt.i, hw, 0.6);
      off = clamp(this.offset, this._cR, this._cL) + path.baseAt(sT);
      tx = _pt.x + _pt.tz * off; tz = _pt.z - _pt.tx * off;
      if (Ld <= minLd) break;
      // check chord points against the corridor of the path point they lie beside
      let ok = true;
      for (const f of [0.35, 0.65]) {
        const cx = v.position.x + (tx - v.position.x) * f, cz = v.position.z + (tz - v.position.z) * f;
        path.pointAt(tr.s + Ld * f, _pt2);
        const lat = (cx - _pt2.x) * _pt2.tz - (cz - _pt2.z) * _pt2.tx - path.baseAt(tr.s + Ld * f);
        this._corr(_pt2.i, hw, 0.35);
        if (lat > this._cL + 0.4 || lat < this._cR - 0.4) { ok = false; break; }
      }
      if (ok) break;
      Ld = Math.max(minLd, Ld * 0.65);
    }
    const dx = tx - v.position.x, dz = tz - v.position.z;
    const lf = dx * F.x + dz * F.z, ll = dx * Lv.x + dz * Lv.z;
    let alpha = Math.atan2(ll, lf);
    const dist = Math.hypot(dx, dz) || 1;
    if (p2pDone) alpha = 0; // past the end of a point-to-point track: just roll straight and stop
    const kpp = (2 * Math.sin(alpha)) / dist;
    let steer = -Math.atan(v.wheelBase * kpp) / Math.max(0.03, v.steerLimit);
    steer += 0.12 * (v.angularVelocity.y - av * kpp); // yaw-rate damping
    const beta = v.driftAngle || 0;
    if (Math.abs(beta) > 0.12 && av > 6) steer += -(beta - Math.sign(beta) * 0.12) * 2.2 / Math.max(0.1, v.steerLimit) * 0.3;
    steer = clamp(steer, -1, 1);

    // ---- target speed (slope-aware braking, no braking while airborne)
    let target = v.maxSpeed * 1.05 * paceScale;
    const scan = (av * av) / (2 * Math.max(2, this._aBrake * 0.6)) + 40;
    {
      let j = tr.idx, d = -(tr.s - path.s[tr.idx]);
      const n = path.n;
      let aRun = this._aBrake;
      const late = av * (0.12 + (v.onGround ? 0 : Math.min(0.6, 0.25 + v.airTime)));
      for (let c = 0; c < n && d < scan; c++) {
        const aEff = Math.max(1.5, this._aBrake - G_EFF * Math.max(0, -path.slope[j]) * 0.9);
        if (aEff < aRun) aRun = aEff;
        const vc = this.vCorner[j] * paceScale;
        const va = Math.sqrt(vc * vc + 2 * aRun * Math.max(0, d - 3 - late));
        if (va < target) target = va;
        d += path.segLen[j] || 8;
        j++;
        if (j >= n) { if (!path.loop) break; j = 0; }
      }
    }
    if (finishedCool) target = path.loop ? Math.min(target, 25) : 0;
    if (follow < 1e9) target = Math.min(target, Math.max(4, follow));
    // off the line: rejoin carefully (slow enough to actually turn back)
    const lineDist = path.hasDetour ? Math.abs(tr.lat - path.baseAt(tr.s)) : tr.dist;
    const offLine = lineDist > Math.max(5, path.width * 0.5);
    if (offLine) target = Math.min(target, Math.abs(alpha) > 0.5 ? 10 + 6 * this.skill : Math.max(18, av - 1));
    this.targetSpeed = target;

    // ---- pedal control
    let thr = 0, brk = 0;
    const err = target - av;
    if (err > 0) thr = clamp(0.35 + err * 0.4, 0, 1);
    else if (err > -1.5) thr = 0.15;
    else brk = clamp(-err * 0.4, 0.2, 1);
    if (v.slip > 0.55 && v.onGround) thr *= 0.6;
    if (Math.abs(beta) > 0.25 && v.onGround) { thr = Math.min(thr, 0.3); brk = Math.min(brk, 0.3); }

    // ---- boost on straights
    if (v.onGround && !finishedCool && thr > 0.9 && av > 18 && Math.abs(steer) < 0.25 && rb > -0.6) {
      const aheadMin = this._minVcAhead(tr, av * 2.5 + 40) * paceScale;
      const fuelGate = 0.15 + 0.35 * (1 - this.aggression) - 0.15 * Math.max(rb, 0);
      if (aheadMin > av * 1.25 && v.thrusterFuel > fuelGate && av < v.maxSpeed * 1.1) inp.boost = true;
    }

    // ---- hop over abrupt step-ups (thruster hop + the vehicle's ledge assist)
    if (path.steps.length && v.onGround && this._hopCd <= 0 && av > 3 && v.thrusterFuel > 0.08) {
      const J = (v.p && v.p.jumpImpulse) || 8;
      for (let k = 0; k < path.steps.length; k++) {
        let ds = path.steps[k][0] - tr.s;
        if (path.loop && ds < -path.length / 2) ds += path.length;
        if (ds < 0 || ds > 60) continue;
        const need = Math.max(0.2, path.steps[k][1] - 0.55);
        const disc = J * J - 2 * G_EFF * need;
        const tRise = disc > 0 ? (J - Math.sqrt(disc)) / G_EFF : J / G_EFF;
        const lead = av * tRise + v.halfLength;
        if (ds <= lead && ds > lead - Math.max(2, av * dt * 3)) { inp.jumpPressed = true; this._hopCd = 1.5; break; }
      }
    }
    if (this._hopCd > 0) this._hopCd -= dt;

    // ---- stuck / wrong-way / reset logic
    if (this.mode === 'race' && !p2pDone) {
      if (thr > 0.3 && av < 1.5 && v.onGround) this._stuckT += dt;
      else this._stuckT = Math.max(0, this._stuckT - dt * 2);
      const wrongWay = Math.abs(alpha) > 2.0 && av < 6 && v.onGround;
      if (this._stuckT > 3 || wrongWay) {
        this.mode = 'reverse'; this._modeT = wrongWay ? 1.3 : 1.6;
        this._revSteer = alpha > 0 ? 1 : -1;
        if (!wrongWay && !finishedCool) {
          this.recoveries++;
          this._recentRecov.push(this._time);
        }
        this._stuckT = 0;
      }
    }
    if (this.mode === 'reverse') {
      this._modeT -= dt;
      thr = 0; brk = 1; inp.boost = false;
      steer = this._revSteer;
      if (this._modeT <= 0 || (Math.abs(alpha) < 0.6 && this._modeT < 0.8)) this.mode = 'race';
    }
    // watchdog: no forward progress for 12 s (e.g. wedged, or endless turn-around manoeuvres)
    if (!finishedCool) {
      if (tr.progress > this._wdBest + 8 || this._wdBest === undefined) { this._wdBest = tr.progress; this._wdT = 0; }
      else { this._wdT += dt; if (this._wdT > 12) { this.needsReset = true; this.resetReason = 'no-progress'; this._wdT = 0; } }
    }
    while (this._recentRecov.length && this._time - this._recentRecov[0] > 20) this._recentRecov.shift();
    if (this._recentRecov.length >= 3) { this.needsReset = true; this.resetReason = 'stuck'; }
    // fell off a bridge / ramp: far below (or above) the road at this point
    const dy = v.position.y - path.heightAtS(tr.s);
    const vertOff = (dy < -5 || dy > 12) && v.onGround;
    if (!p2pDone && (lineDist > Math.max(25, path.width * 2) || vertOff)) this._offT += dt * (vertOff ? 2 : 1); else this._offT = 0;
    if (this._offT > 2.5) { this.needsReset = true; this.resetReason = 'off-path'; }
    if (v.flipped) this._flipT += dt; else this._flipT = 0;
    if (this._flipT > 2.5 || v.inWater) { this.needsReset = true; this.resetReason = v.inWater ? 'water' : 'flipped'; }

    inp.throttle = thr; inp.brake = brk; inp.steer = steer;
    return inp;
  }

  _minVcAhead(tr, dist) {
    const path = this.path;
    let j = tr.idx, d = 0, m = 1e9;
    for (let c = 0; c < path.n && d < dist; c++) {
      if (this.vCorner[j] < m) m = this.vCorner[j];
      d += path.segLen[j] || 8;
      j++;
      if (j >= path.n) { if (!path.loop) break; j = 0; }
    }
    return m;
  }
}

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

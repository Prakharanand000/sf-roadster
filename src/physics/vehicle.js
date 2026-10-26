// SF Roadster Rush — vehicle physics (PHYSICS agent). Entry: src/physics/vehicle.js
//
// Arcade-sim raycast car:
//  - full 3D rigid body (CoM position, quaternion, linear + angular velocity), fixed
//    sub-steps of <= 1/120 s (update(dt) splits dt into N equal sub-steps, N = ceil(dt*120),
//    so any frame rate is smooth; dt is clamped to 0.1 s).
//  - 4 spring/damper wheels sampling world.surfaceHeight(x, z, yRef = wheel bottom y),
//    anti-roll bars, bump stops, chassis contact points for rough landings / roll-overs.
//  - slip-angle tyre model (peak then fall-off), friction circle, per-surface grip,
//    weight transfer (real, from suspension; scaled by PHYS.weightTransfer).
//  - engine: torque curve + power limit + N gears (auto), shift pause, reverse, rev limiter.
//  - thrusters: boost (hold), hop (jumpPressed on ground), hover (hold jump in air).
//  - world collisions: 3 circles along the car, swept per sub-step, impulse response
//    with restitution + friction + yaw spin.
//
// Choices where CONTRACTS.md is open (documented for the integrator / cars agent):
//  - gripFront/gripRear are "lateral g" at the friction peak (normal load is normalised
//    by the boosted gravity, so a grip of 1.3 gives ~1.3 g cornering).
//  - engineForce = peak tractive force (N) at the wheels in 1st gear; power is derived so
//    the car reaches physics.maxSpeed on the flat; the rev limiter caps it there
//    (boost can exceed it by ~10-15 %).
//  - downforce = extra normal load as a fraction of the car's weight at 200 km/h
//    (typical 0.1 .. 0.6; values are clamped to 0..1.5). Scales with v^2.
//  - jumpImpulse = vertical m/s added by a hop. With PHYS.gravityScale 1.3 the hop
//    height is jumpImpulse^2 / 25.5 m (10.5 -> 4.3 m, 11 -> 4.7 m).
//  - thrusterCapacity = seconds of full boost on a full tank. Fuel 0..1.
//  - Optional extra spec.physics fields: drive ('awd'|'rwd'|'fwd', default 'awd'),
//    frontDriveBias (awd split, default 0.35), cdA (m^2, default 0.72).
//  - gear: -1 = reverse, 1..N forward. speedKmh = |speed| * 3.6.
//  - driftAngle: signed body slip angle in radians (+ = velocity points left of the nose).

import * as THREE from 'three';

const G = 9.81;

// Global tuning knobs (shared by all vehicles; tweak live in dev/physics-test.html).
export const PHYS = {
  gravityScale: 1.3,       // snappier jumps/landings
  substepHz: 120,
  suspSag: 0.085,          // static compression (m)  -> ~1.9 Hz ride
  // suspension travel per car = suspSag + dims.rideHeight (bump stop ~ chassis touching)
  suspZeta: 0.55,          // damping ratio
  damperVelClamp: 3,       // m/s: damper ignores faster compression (kerbs/steps don't launch the car)
  suspMaxForce: 5,         // x static wheel load: spring+damper force cap (rest handled as hard contact)
  antiRoll: 0.55,          // anti-roll bar stiffness as fraction of spring rate
  weightTransfer: 0.6,     // 0..1 lateral (roll) load transfer: fraction of the real torque arm used
  pitchTransfer: 0.35,     // 0..1 longitudinal (pitch) load transfer; lower = stabler under braking
  cgHeight: 0.46,          // CoM height above ground (m) (scaled a bit with car height)
  inertiaScale: 1.15,
  steerRate: 4.5,          // normalised steer input / s
  steerReturn: 7,
  steerOverdrive: 1.3,     // how far beyond the grip-optimal angle full lock goes
  counterSteer: 0.45,      // light auto counter-steer (0 = off, 1 = full alignment)
  driftAssist: 1.0,        // spin-out prevention + speed keeping in drifts
  stability: 0.6,          // yaw stability control outside handbrake drifts (0 = off)
  lsd: 0.8,                // limited-slip strength 0..1 (drive split by wheel load)
  tractionControl: 0.8,    // 0..1 cut of drive beyond the friction circle
  lateralPriority: 0.8,    // 0..1 friction circle: 0 = proportional, 1 = cornering force first
  abs: true,               // brake force limited so steering keeps working (lateral priority)
  handbrakeGrip: 0.4,      // rear lateral grip multiplier with handbrake
  peakSlipFront: 0.15,     // rad (~8.6 deg)
  peakSlipRear: 0.13,
  tailGrip: 0.72,          // front grip fraction at large slip (understeer feel)
  tailGripRear: 0.82,      // rear: higher = slides are progressive, not snappy
  gripScale: 1.0,
  rearGripBias: 1.1,       // >1 = stable/understeery at the limit (handbrake still frees the rear)
  powerScale: 1.0,
  cdA: 0.72,
  rollResist: 0.012,
  powerMargin: 1.15,
  shiftTime: 0.14,
  reverseMaxSpeed: 14,
  // thrusters
  hopFuel: 0.06,
  hoverGravity: 0.15,      // fraction of gravity while hovering
  hoverMaxTime: 2.0,       // per airborne phase (s)
  hoverDrain: 0.16,        // fuel/s
  fuelRegen: 0.012,        // fuel/s idle regen
  driftFuel: 0.09,         // fuel/s at a full drift
  groundStick: 0.5,        // extra down-force (x weight) while only 1-3 wheels touch
  airLevel: 2.2,           // auto-level natural frequency in air (rad/s)
  airYawControl: 0.9,      // rad/s of yaw from full steer in air (x1.8 while hovering)
  // collisions
  restitution: 0.25,
  wallFriction: 0.35,
  wallSpin: 1.0,
  carSpin: 0.7,            // yaw from car-car impulses (1 = physical)
  boundsMargin: 25,
};

export const SURFACE_GRIP = { road: 1.0, sidewalk: 0.95, grass: 0.7, sand: 0.55, roof: 1.0, bridge: 1.0, water: 0.35 };
const SURFACE_DRAG = { road: 0, sidewalk: 0.005, grass: 0.03, sand: 0.07, roof: 0, bridge: 0, water: 0.2 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// tyre grip curve: x = |slip| / peakSlip
function gripCurve(x, tail) {
  if (x <= 1) return 1.5 * x - 0.5 * x * x * x;
  return 1 - (1 - tail) * smoothstep(1, 4, x);
}

const DEFAULT_PHYSICS = {
  mass: 1600, maxSpeed: 90, engineForce: 13000, brakeForce: 20000, gripFront: 1.3, gripRear: 1.35,
  steerMax: 0.6, driftFactor: 0.5, downforce: 0.25, thrusterCapacity: 5, thrusterForce: 11000, jumpImpulse: 10.5, gears: 7,
};
const DEFAULT_DIMS = { length: 4.5, width: 1.95, height: 1.2, wheelBase: 2.65, track: 1.65, wheelRadius: 0.34, rideHeight: 0.12 };

export class Vehicle {
  constructor(spec, world) {
    this.spec = spec || {};
    this.world = world;
    const p = Object.assign({}, DEFAULT_PHYSICS, this.spec.physics || {});
    const d = Object.assign({}, DEFAULT_DIMS, this.spec.dims || {});
    this.p = p; this.dims = d;
    this.mass = p.mass;
    this.invMass = 1 / p.mass;
    this.maxSpeed = p.maxSpeed;
    this.wheelBase = d.wheelBase;
    this.trackWidth = d.track;
    this.wheelRadius = d.wheelRadius;
    this.halfLength = d.length / 2;
    this.halfWidth = d.width / 2;
    this.height = d.height;
    this.cgH = PHYS.cgHeight * clamp(d.height / 1.2, 0.85, 1.25);
    const m = p.mass, L = d.length, W = d.width, H = d.height;
    const k = PHYS.inertiaScale;
    this.Ix = (m / 12) * (L * L + H * H) * k * 1.1; // pitch (about left axis)
    this.Iy = (m / 12) * (L * L + W * W) * k;       // yaw
    this.Iz = (m / 12) * (W * W + H * H) * k * 1.3; // roll
    this.drive = p.drive || 'awd';
    this.frontBias = this.drive === 'rwd' ? 0 : this.drive === 'fwd' ? 1 : (p.frontDriveBias ?? 0.35);
    this.downforceK = clamp(p.downforce ?? 0.25, 0, 1.5);
    this.dragK = 0.5 * 1.225 * (p.cdA ?? PHYS.cdA);
    this.power = PHYS.powerMargin * p.maxSpeed * (this.dragK * p.maxSpeed * p.maxSpeed + PHYS.rollResist * m * G);
    this.nGears = Math.max(1, Math.round(p.gears || 7));
    this.gearRatios = [];
    for (let i = 0; i < this.nGears; i++) {
      const t = this.nGears === 1 ? 1 : i / (this.nGears - 1);
      this.gearRatios.push(1 - 0.7 * Math.pow(1 - t, 1.25));
    }
    this.gearTopSpeed = this.gearRatios.map(r => r * p.maxSpeed * 1.03);
    this.electric = this.spec.engine === 'electric';
    // per-instance scales (AI rubber banding etc.)
    this.powerScale = 1;
    this.gripScale = 1;
    this.isPlayer = false;

    // wheels
    this._wheels = [];
    for (let i = 0; i < 4; i++) {
      this._wheels.push({
        lx: (i % 2 === 0 ? 1 : -1) * d.track / 2,
        lz: (i < 2 ? 1 : -1) * d.wheelBase / 2,
        front: i < 2,
        c: 0, contact: false, bottomY: 0, load: 0, slip: 0, spin: 0, vLong: 0, grip: 1, drag: 0,
        nx: 0, ny: 1, nz: 0, cx: 0, cy: 0, cz: 0, surface: 'road', lockT: 0,
      });
    }
    // suspension travel: full compression ~= chassis touching the ground (rideHeight above static)
    this.suspTravel = PHYS.suspSag + clamp(d.rideHeight, 0.08, 0.25);
    this.anchorY = d.wheelRadius + this.suspTravel - PHYS.suspSag; // local anchor height
    this._setupSprings();

    // public state
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0; this.speedKmh = 0;
    this.rpm = 0.1; this.gear = 1; this.throttle = 0; this.brake = 0;
    this.braking = false; this.reversing = false; this.handbrake = false;
    this.steerAngle = 0; this.steerLimit = p.steerMax;
    this.onGround = true; this.airTime = 0; this.wheelsOnGround = 4;
    this.drifting = false; this.driftAngle = 0; this.slip = 0;
    this.boosting = false; this.hovering = false;
    this.thrusterFuel = 1; this.thrusterLevel = 0; this.thrusterMode = 'boost';
    this.wheelContacts = this._wheels.map(() => ({ x: 0, y: 0, z: 0, onGround: false, slip: 0, compression: 0, load: 0, surface: 'road' }));
    this.surface = 'road';
    this.inWater = false;
    this.lastImpact = 0; this.lastImpactStrength = 0;
    this.lateralG = 0; this.longitudinalG = 0;
    this.flipped = false;
    this.shifting = false;
    // hooks
    this.onCollision = null; this.onLand = null; this.onJump = null; this.onSplash = null;
    this.onShift = null; // (gear) addition

    // private
    this._com = new THREE.Vector3();
    this._prevPos = new THREE.Vector3(); // frame-start position (for car-car swept tests)
    this._steerIn = 0;
    this._shiftT = 0; this._shiftLock = 0; this._revT = 0;
    this._hoverUsed = 0; this._sinceGround = 0; this._minVyAir = 0; this._hardHit = 0;
    this._boostLock = false; this._hopFlash = 0;
    this._splashed = false; this._impactCooldown = 0; this._flipT = 0;
    this._accF = 0; this._accL = 0; this._leanRoll = 0; this._leanPitch = 0;
    this._lastV = new THREE.Vector3();
    this._impactPoint = new THREE.Vector3();
    this._hopReq = false;
    this._jumpHeld = false;
    this._sinceHop = 10;
    this._modelCache = new WeakMap();
    this._frameDt = 1 / 60;

    const sp = world && world.spawn ? world.spawn : { x: 0, z: 0, heading: 0 };
    this.reset(sp.x, sp.z, sp.heading);
  }

  _setupSprings() {
    const gEff = G * PHYS.gravityScale;
    const mw = this.mass / 4;
    this.kSpring = (mw * gEff) / PHYS.suspSag;
    this.cSpring = 2 * PHYS.suspZeta * Math.sqrt(this.kSpring * mw);
    this.kBump = this.kSpring * 6;
    this.kArb = this.kSpring * PHYS.antiRoll;
    this.staticLoad = mw * gEff;
  }

  // Add thruster fuel (0..1 scale), e.g. from near misses: vehicle.addFuel(0.1)
  addFuel(amount) { this.thrusterFuel = clamp(this.thrusterFuel + amount, 0, 1); }

  reset(x, z, heading = 0, y) {
    const w = this.world;
    if (y === undefined || y === null) y = w ? w.surfaceHeight(x, z, 1e4) : 0;
    this.quaternion.setFromAxisAngle(_Y, heading);
    this.position.set(x, y, z);
    this._com.set(x, y + this.cgH, z);
    this._prevPos.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this._lastV.set(0, 0, 0);
    this.heading = heading;
    this.speed = 0; this.speedKmh = 0; this.gear = 1; this.rpm = 0.1;
    this._steerIn = 0; this.steerAngle = 0; this._shiftT = 0; this._shiftLock = 0; this._revT = 0;
    this._hoverUsed = 0; this._sinceGround = 0; this.airTime = 0;
    this.onGround = true; this.inWater = false; this._splashed = false; this.flipped = false; this._flipT = 0;
    this.boosting = false; this.hovering = false; this.drifting = false; this.driftAngle = 0; this.slip = 0;
    this.lastImpact = 0; this.lastImpactStrength = 0; this._accF = 0; this._accL = 0;
    for (const wh of this._wheels) {
      wh.c = PHYS.suspSag; wh.contact = true; wh.bottomY = y; wh.load = this.staticLoad; wh.slip = 0; wh.lockT = 0;
    }
    this._updateDerived();
  }

  // ---------------------------------------------------------------------------------
  update(dt, input) {
    input = input || NO_INPUT;
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    this._frameDt = dt;
    this._prevPos.copy(this.position);
    this.lastImpact = 0; this.lastImpactStrength = 0; this._hardHit = 0;
    if (this._impactCooldown > 0) this._impactCooldown -= dt;

    const world = this.world;
    // surfaces under each wheel (once per frame)
    for (let i = 0; i < 4; i++) {
      const wh = this._wheels[i];
      const s = world.surfaceAt(wh.cx || this.position.x, wh.cz || this.position.z, wh.bottomY);
      wh.surface = s;
      wh.grip = SURFACE_GRIP[s] ?? 1;
      wh.drag = SURFACE_DRAG[s] ?? 0;
    }
    this.surface = world.surfaceAt(this.position.x, this.position.z, this.position.y);
    const wasInWater = this.inWater;
    // in water: open water, or below sea level under a bridge deck (isWater is false there)
    this.inWater = this.position.y < 0.3 && (world.isWater(this.position.x, this.position.z) || (this.position.y < -0.5 && world.heightAt(this.position.x, this.position.z) < -0.2));
    if (this.inWater && !wasInWater && !this._splashed) {
      this._splashed = true;
      if (this.onSplash) this.onSplash();
    }

    this._controls(dt, input);

    const n = Math.max(1, Math.ceil(dt * PHYS.substepHz - 1e-6));
    const h = dt / n;
    this._lastV.copy(this.velocity);
    for (let i = 0; i < n; i++) this._step(h, input);

    this._postFrame(dt, input);
  }

  _controls(dt, input) {
    const p = this.p;
    const F = this._fwdV, Lv = this._leftV;
    const v = this.velocity;
    const vf = v.x * F.x + v.y * F.y + v.z * F.z;
    const vl = v.x * Lv.x + v.y * Lv.y + v.z * Lv.z;
    const av = Math.abs(vf);
    let thr = clamp(input.throttle || 0, 0, 1);
    let brk = clamp(input.brake || 0, 0, 1);

    // reverse logic
    if (this.gear > 0) {
      if (brk > 0.1 && thr < 0.1 && vf < 0.8 && this.onGround) {
        this._revT += dt;
        if (this._revT > 0.18) { this.gear = -1; this._revT = 0; if (this.onShift) this.onShift(-1); }
      } else this._revT = 0;
    } else if (thr > 0.1 && vf > -0.8) {
      this.gear = 1; if (this.onShift) this.onShift(1);
    }
    if (this.gear < 0) { const t = thr; thr = brk; brk = t; }
    this.throttle = thr;
    this.brake = brk;
    this.reversing = this.gear < 0;
    this.braking = brk > 0.05;
    this.handbrake = !!input.handbrake;
    // drift mode: started by the handbrake at speed, lasts while the car keeps sliding
    if (this.handbrake && av > 8) this._driftMode = true;
    else if (this._driftMode && (Math.abs(this.driftAngle) < 0.1 || av < 5)) this._driftMode = false;

    // automatic gearbox
    if (this._shiftT > 0) { this._shiftT -= dt; this.shifting = this._shiftT > 0; }
    if (this._shiftLock > 0) this._shiftLock -= dt;
    if (this.gear > 0 && this.onGround && this._shiftLock <= 0) {
      const g = this.gear;
      const r = av / this.gearTopSpeed[g - 1];
      let ng = g;
      if (r > 0.93 && g < this.nGears && thr > 0.05) ng = g + 1;
      else if (g > 1) {
        const rDown = av / this.gearTopSpeed[g - 2];
        if (r < 0.42 && rDown < 0.85) ng = g - 1;
        else if (thr > 0.9 && r < 0.55 && rDown < 0.8) ng = g - 1; // kick-down
        else if (brk > 0.3 && rDown < 0.75) ng = g - 1;
      }
      if (ng !== g) {
        this.gear = ng;
        this._shiftLock = 0.45;
        if (ng > g) { this._shiftT = this.electric ? 0.04 : PHYS.shiftTime; this.shifting = true; }
        if (this.onShift) this.onShift(ng);
      }
    }

    // steering: speed-sensitive limit around the grip-optimal angle
    const muF = p.gripFront * this.gripScale * PHYS.gripScale;
    const v2 = Math.max(vf * vf, 4);
    const optimal = PHYS.peakSlipFront + (this.wheelBase * muF * G) / v2;
    this.steerLimit = Math.min(p.steerMax, optimal * PHYS.steerOverdrive);
    const target = clamp(input.steer || 0, -1, 1);
    const rate = (Math.abs(target) < Math.abs(this._steerIn) || target * this._steerIn < 0) ? PHYS.steerReturn : PHYS.steerRate;
    const dS = target - this._steerIn;
    this._steerIn += clamp(dS, -rate * dt, rate * dt);
    let steer = this._steerIn * this.steerLimit;
    // counter-steer assist
    if (av > 5 && this.onGround && this.gear > 0) {
      const beta = Math.atan2(vl, Math.max(vf, 0.1));
      const ex = Math.abs(beta) - 0.1; // only real oversteer, not normal cornering slip
      if (ex > 0) {
        steer += clamp(-Math.sign(beta) * ex * PHYS.counterSteer, -p.steerMax * 0.6, p.steerMax * 0.6) * (1 - 0.5 * Math.abs(target));
      }
    }
    this.steerAngle = clamp(steer, -p.steerMax, p.steerMax);

    // hop
    if (input.jumpPressed && (this.wheelsOnGround > 0 || this._sinceGround < 0.15) && this.thrusterFuel >= PHYS.hopFuel * 0.5 && !this.inWater) {
      this._hopReq = true;
    }
    this._jumpHeld = !!input.jump;

    // boost
    if (this.thrusterFuel <= 0.001) this._boostLock = true;
    if (this._boostLock && (this.thrusterFuel > 0.08 || !input.boost)) this._boostLock = this.thrusterFuel <= 0.08 && !!input.boost;
    this.boosting = !!input.boost && !this._boostLock && this.thrusterFuel > 0 && !this.inWater;
  }

  _updateDerived() {
    const q = this.quaternion;
    const x = q.x, y = q.y, z = q.z, w = q.w;
    // columns of rotation matrix: local X (=left), Y (=up), Z (=forward)
    this._leftV.set(1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y));
    this._upV.set(2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x));
    this._fwdV.set(2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y));
    const U = this._upV, c = this._com;
    this.position.set(c.x - U.x * this.cgH, c.y - U.y * this.cgH, c.z - U.z * this.cgH);
  }

  _step(h, input) {
    const world = this.world, p = this.p;
    const gEff = G * PHYS.gravityScale;
    const gNorm = G / gEff;
    const m = this.mass;
    const v = this.velocity, w = this.angularVelocity, com = this._com;
    const Lv = this._leftV, U = this._upV, F = this._fwdV;

    let Fx = 0, Fy = -m * gEff, Fz = 0; // force accumulators
    let Tx = 0, Ty = 0, Tz = 0;          // torque accumulators (world)
    const addForceAt = (fx, fy, fz, rx, ry, rz) => {
      Fx += fx; Fy += fy; Fz += fz;
      Tx += ry * fz - rz * fy; Ty += rz * fx - rx * fz; Tz += rx * fy - ry * fx;
    };

    const vf = v.x * F.x + v.y * F.y + v.z * F.z;
    const av = Math.abs(vf);
    const thr = this.throttle, brk = this.brake;
    const hb = this.handbrake;

    // ---- engine force (total at the wheels)
    let drive = 0;
    if (!this.inWater) {
      if (this.gear > 0) {
        const g = this.gear;
        const rpmRaw = av / this.gearTopSpeed[g - 1];
        const tq = this.electric ? 1 : 0.84 + 0.16 * smoothstep(0.1, 0.6, rpmRaw) - 0.08 * smoothstep(0.8, 1.0, rpmRaw);
        const gearBoost = 1 - 0.12 * ((g - 1) / Math.max(1, this.nGears - 1));
        const ps = this.powerScale * PHYS.powerScale;
        const fEng = p.engineForce * ps * tq * gearBoost;
        const fPow = (this.power * ps) / Math.max(av, 1);
        drive = thr * Math.min(fEng, fPow);
        if (this._shiftT > 0) drive *= 0.15;
        // rev limiter / top speed
        if (g === this.nGears) drive *= clamp((p.maxSpeed * 1.005 - av) / (p.maxSpeed * 0.02), 0, 1);
        else if (rpmRaw > 1) drive *= 0.2;
        if (vf < -1) drive = thr * p.engineForce * ps; // rolling backwards in forward gear
      } else {
        drive = -thr * p.engineForce * 0.6 * clamp((PHYS.reverseMaxSpeed + vf) / 3, 0, 1);
      }
    }

    // ---- wheels: suspension
    const wheels = this._wheels;
    const ay = this.anchorY - this.cgH;
    const restLen = this.suspTravel;
    const R = this.wheelRadius;
    let contacts = 0;
    const kS = this.kSpring, cS = this.cSpring;
    const forces = _forces;
    for (let i = 0; i < 4; i++) {
      const wh = wheels[i];
      const rx = Lv.x * wh.lx + U.x * ay + F.x * wh.lz;
      const ry = Lv.y * wh.lx + U.y * ay + F.y * wh.lz;
      const rz = Lv.z * wh.lx + U.z * ay + F.z * wh.lz;
      const axw = com.x + rx, ayw = com.y + ry, azw = com.z + rz;
      wh.rx = rx; wh.ry = ry; wh.rz = rz;
      let contact = false, c = 0;
      if (U.y > 0.2) {
        const g = world.surfaceHeight(axw, azw, wh.bottomY);
        const s = (ayw - g) / U.y - R;
        if (s < restLen) {
          contact = true;
          c = restLen - s;
          wh.cx = axw; wh.cy = g; wh.cz = azw;
        }
      }
      const prevC = wh.contact ? wh.c : 0;
      wh.cDot = contact ? (c - prevC) / h : 0;
      wh.c = contact ? c : 0;
      wh.contact = contact;
      if (contact) {
        contacts++;
        wh.bottomY = wh.cy;
      } else {
        wh.bottomY = ayw - U.y * (restLen + R);
        wh.cx = axw - U.x * (restLen + R); wh.cy = wh.bottomY; wh.cz = azw - U.z * (restLen + R);
      }
    }
    // spring + damper + anti-roll + bump (force capped; beyond full travel -> hard contact)
    for (let i = 0; i < 4; i++) {
      const wh = wheels[i];
      if (!wh.contact) { forces[i] = 0; continue; }
      const cc = wh.c < restLen ? wh.c : restLen;
      const cdv = clamp(wh.cDot, -PHYS.damperVelClamp, PHYS.damperVelClamp);
      let f = kS * cc + cS * cdv;
      const bump = restLen - 0.05;
      if (cc > bump) f += this.kBump * (cc - bump) + cS * 1.5 * Math.max(0, cdv);
      const o = wheels[i ^ 1];
      f += this.kArb * (cc - (o.contact ? Math.min(o.c, restLen) : 0));
      forces[i] = clamp(f, 0, this.staticLoad * PHYS.suspMaxForce);
    }

    // ---- tyres
    let maxSlip = 0;
    const steer = this.steerAngle;
    const cs = Math.cos(steer), sn = Math.sin(steer);
    const lift = this.cgH * (1 - PHYS.weightTransfer);
    const liftLong = this.cgH * (1 - PHYS.pitchTransfer);
    const mEff = m * 0.25;
    const muBase = this.gripScale * PHYS.gripScale;
    const driftF = clamp(p.driftFactor ?? 0.5, 0, 1);
    let rearSlipSum = 0;
    for (let i = 0; i < 4; i++) {
      const wh = wheels[i];
      const fs = forces[i];
      wh.load = fs;
      if (!wh.contact) { wh.slip = 0; wh.vLong = vf; continue; }
      // suspension force along car up at the anchor
      addForceAt(U.x * fs, U.y * fs, U.z * fs, wh.rx, wh.ry, wh.rz);
      // contact normal
      const n = world.normalAt(wh.cx, wh.cz, wh.bottomY + 0.05, _n);
      if (n.y < 0.6) n.set(U.x, U.y, U.z); // edge of a step: use the car's up
      // wheel heading
      let dx, dy, dz;
      if (wh.front) { dx = F.x * cs - Lv.x * sn; dy = F.y * cs - Lv.y * sn; dz = F.z * cs - Lv.z * sn; }
      else { dx = F.x; dy = F.y; dz = F.z; }
      const dn = dx * n.x + dy * n.y + dz * n.z;
      dx -= n.x * dn; dy -= n.y * dn; dz -= n.z * dn;
      let dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      // side = n x d (points to the car's left)
      const sx = n.y * dz - n.z * dy, sy = n.z * dx - n.x * dz, sz = n.x * dy - n.y * dx;
      // contact point relative to com
      const crx = wh.cx - com.x, cry = wh.cy - com.y, crz = wh.cz - com.z;
      const vpx = v.x + (w.y * crz - w.z * cry);
      const vpy = v.y + (w.z * crx - w.x * crz);
      const vpz = v.z + (w.x * cry - w.y * crx);
      const vLong = vpx * dx + vpy * dy + vpz * dz;
      const vLat = vpx * sx + vpy * sy + vpz * sz;
      wh.vLong = vLong;
      const N = Math.min(fs, this.staticLoad * 4) * gNorm;
      const rearHb = hb && !wh.front;
      let mu = (wh.front ? p.gripFront : p.gripRear * PHYS.rearGripBias) * wh.grip * muBase;
      if (!wh.front) {
        // power oversteer: throttle while the rear is already sliding loosens it further
        if (thr > 0.5 && this.drifting) mu *= 1 - 0.18 * driftF * thr;
      }
      if (rearHb) { wh.lockT = Math.min(1, wh.lockT + h * 6); }
      else wh.lockT = Math.max(0, wh.lockT - h * 3.5);
      if (!wh.front && wh.lockT > 0) mu *= 1 - (1 - PHYS.handbrakeGrip * (1.15 - 0.3 * driftF)) * wh.lockT;
      const peak = wh.front ? PHYS.peakSlipFront : PHYS.peakSlipRear;
      const alpha = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), 1.5));
      const fLatMax = mu * N;
      let fy = -Math.sign(vLat) * fLatMax * gripCurve(alpha / peak, wh.front ? PHYS.tailGrip : PHYS.tailGripRear);
      const capY = (Math.abs(vLat) * mEff) / h * 0.5;
      if (fy > capY) fy = capY; else if (fy < -capY) fy = -capY;

      // longitudinal
      let fx = 0;
      // limited-slip: split each axle's drive by wheel load (open diff would spin the unloaded wheel)
      const axle = wh.front ? this.frontBias : 1 - this.frontBias;
      const fo = forces[i ^ 1], fsum = fs + (wheels[i ^ 1].contact ? fo : 0);
      const share = fsum > 0 ? 0.5 * (1 - PHYS.lsd) + (fs / fsum) * PHYS.lsd : 0.5;
      const bias = axle * share;
      let fDrive = drive * bias;
      // traction control (lighter for drift-happy cars, halved while sliding, off with handbrake)
      if (fDrive > 0 && !hb) {
        const limD = mu * N * 1.05;
        const room = Math.sqrt(Math.max(0, limD * limD - fy * fy));
        if (fDrive > room) {
          const tc = PHYS.tractionControl * (1 - 0.5 * driftF) * (this.drifting ? 0.5 : 1);
          fDrive = room + (fDrive - room) * (1 - tc);
        }
      }
      fx += fDrive;
      let fBrake = brk * p.brakeForce * (wh.front ? 0.34 : 0.16);
      // arcade ABS with lateral priority: keep at least what the tyre needs for cornering
      if (fBrake > 0 && PHYS.abs) {
        const limB = mu * N * 1.05;
        const room = Math.max(limB * 0.55, Math.sqrt(Math.max(0, limB * limB - fy * fy)));
        if (fBrake > room) fBrake = room;
      }
      if (rearHb) fBrake = Math.max(fBrake, 0.3 * mu * N);
      if (thr < 0.05 && this.gear > 0) fBrake += 0.012 * m * G * (bias > 0 ? 1 : 0.3); // engine braking
      fBrake += (PHYS.rollResist + wh.drag) * N;
      const capX = (Math.abs(vLong) * mEff) / h * 0.9;
      fBrake = Math.min(fBrake, capX);
      fx -= Math.sign(vLong) * fBrake;
      // friction circle
      const lim = mu * N * 1.05;
      const tot = Math.hypot(fx, fy);
      let longSlip = 0;
      if (tot > lim && tot > 0) {
        const sc = lim / tot;
        // blend proportional scaling with a lateral-priority solution (keeps cars catchable);
        // drift-happy cars keep more power-oversteer on the rear while sliding
        let lp = PHYS.lateralPriority;
        if (!wh.front && (rearHb || this.drifting)) lp *= rearHb ? 0.2 : 1 - 0.7 * driftF;
        const fyL = clamp(fy, -lim, lim);
        const avail = Math.sqrt(Math.max(0, lim * lim - fyL * fyL));
        const fxL = Math.sign(fx) * Math.min(Math.abs(fx), avail);
        const nfx = fx * sc * (1 - lp) + fxL * lp;
        longSlip = clamp((Math.abs(fx) - Math.abs(nfx)) / (lim + 1), 0, 1);
        fx = nfx; fy = fy * sc * (1 - lp) + fyL * lp;
      }
      wh.fx = fx; wh.fy = fy; wh.lim = lim; wh.alpha = alpha;
      const latSlip = av > 2 ? clamp((alpha - peak * 0.7) / (peak * 2), 0, 1) : 0;
      const lockSlip = rearHb && av > 3 ? 0.6 * wh.lockT : 0;
      wh.slip = Math.max(latSlip, longSlip * 1.5, lockSlip);
      if (wh.slip > maxSlip) maxSlip = wh.slip;
      if (!wh.front) rearSlipSum += alpha;
      // apply tyre force at the contact point raised toward the CoM
      const ox = crx + U.x * lift, oy = cry + U.y * lift, oz = crz + U.z * lift;
      addForceAt(sx * fy, sy * fy, sz * fy, ox, oy, oz);
      const qx = crx + U.x * liftLong, qy = cry + U.y * liftLong, qz = crz + U.z * liftLong;
      addForceAt(dx * fx, dy * fx, dz * fx, qx, qy, qz);
    }
    this._slipFrame = maxSlip;
    this._rearSlip = rearSlipSum * 0.5;

    // ---- hard contacts: wheels beyond full travel + chassis points (rough landings,
    // kerb/ledge steps, roll-overs). Impulse based (no stiff springs), solved Jacobi-style
    // so left/right stay symmetric.
    let nC = 0;
    const CT = _contacts;
    for (let i = 0; i < 4; i++) {
      const wh = wheels[i];
      if (!wh.contact || wh.c <= restLen) continue;
      const c = CT[nC++];
      c.rx = wh.rx; c.ry = wh.ry; c.rz = wh.rz; c.nx = U.x; c.ny = U.y; c.nz = U.z; c.pen = wh.c - restLen; c.fric = 0;
    }
    let maxC = 0;
    for (let i = 0; i < 4; i++) if (wheels[i].c > maxC) maxC = wheels[i].c;
    let bodyContact = false;
    if (maxC > restLen * 0.8 || U.y < 0.75 || contacts < 4) {
      const pts = CHASSIS_PTS;
      for (let i = 0; i < pts.length; i++) {
        const cp = pts[i];
        const lx = cp[0] * this.halfWidth, ly = (cp[1] < 0.5 ? this.dims.rideHeight + 0.02 : cp[1] * this.height) - this.cgH, lz = cp[2] * this.halfLength;
        const rx = Lv.x * lx + U.x * ly + F.x * lz;
        const ry = Lv.y * lx + U.y * ly + F.y * lz;
        const rz = Lv.z * lx + U.z * ly + F.z * lz;
        const px = com.x + rx, py = com.y + ry, pz = com.z + rz;
        const g = world.surfaceHeight(px, pz, py + 0.3);
        const pen = g - py;
        if (pen > 0) {
          bodyContact = true;
          const n = world.normalAt(px, pz, py + 0.3, _n2);
          if (n.y < 0.75) n.set(0, 1, 0); // step/roof edge: finite-difference normal is meaningless, push up
          const c = CT[nC++];
          c.rx = rx; c.ry = ry; c.rz = rz; c.nx = n.x; c.ny = n.y; c.nz = n.z; c.pen = pen * n.y;
          c.fric = cp[1] < 0.5 && U.y > 0.7 ? 0.25 : 0.55; // upright car scraping its floor slides on
          if (nC >= CT.length) break;
        }
      }
    }
    if (nC > 0) {
      for (let it = 0; it < 2; it++) {
        let act = 0;
        for (let k = 0; k < nC; k++) {
          const c = CT[k];
          const vpx = v.x + (w.y * c.rz - w.z * c.ry), vpy = v.y + (w.z * c.rx - w.x * c.rz), vpz = v.z + (w.x * c.ry - w.y * c.rx);
          const vn = vpx * c.nx + vpy * c.ny + vpz * c.nz;
          c.vn = vn; c.j = 0;
          if (vn < 0) {
            c.j = -vn / this._invEffMass(c.rx, c.ry, c.rz, c.nx, c.ny, c.nz);
            act++;
            if (-vn > this._hardHit) this._hardHit = -vn;
            c.tx = vpx - c.nx * vn; c.ty = vpy - c.ny * vn; c.tz = vpz - c.nz * vn;
          }
        }
        if (!act) break;
        const sc = 1 / act;
        for (let k = 0; k < nC; k++) {
          const c = CT[k];
          if (c.j <= 0) continue;
          const j = c.j * sc;
          let jx = c.nx * j, jy = c.ny * j, jz = c.nz * j;
          if (c.fric > 0) {
            const vt = Math.hypot(c.tx, c.ty, c.tz);
            if (vt > 1e-4) {
              const ux = c.tx / vt, uy = c.ty / vt, uz = c.tz / vt;
              const jt = Math.min(c.fric * j, (vt * sc) / this._invEffMass(c.rx, c.ry, c.rz, ux, uy, uz));
              jx -= ux * jt; jy -= uy * jt; jz -= uz * jt;
            }
          }
          this._impulseAt(jx, jy, jz, c.rx, c.ry, c.rz);
        }
      }
      // positional correction (lift out of the ground / onto the ledge)
      let px = 0, py = 0, pz = 0;
      for (let k = 0; k < nC; k++) {
        const c = CT[k];
        const push = Math.min(c.pen, 0.04) * 0.3;
        px += c.nx * push; py += c.ny * push; pz += c.nz * push;
      }
      const ps = 1 / Math.max(1, nC * 0.5);
      com.x += px * ps; com.y += py * ps; com.z += pz * ps;
    }
    this._bodyContact = bodyContact;

    // ---- aero
    const sp2 = v.x * v.x + v.y * v.y + v.z * v.z;
    const sp = Math.sqrt(sp2);
    const dragK = this.dragK * (this.inWater ? 30 : 1);
    Fx -= dragK * sp * v.x; Fy -= dragK * sp * v.y; Fz -= dragK * sp * v.z;
    if (contacts > 0) {
      const fd = Math.min(m * G, this.downforceK * m * G * (vf * vf) / (55.6 * 55.6));
      Fx -= U.x * fd; Fy -= U.y * fd; Fz -= U.z * fd;
    }
    if (this.inWater) {
      Fx -= v.x * m * 2.2; Fz -= v.z * m * 2.2; Fy -= v.y * m * 1.5;
      if (this.position.y < -0.4) Fy += m * gEff * 0.55;
    }

    // ---- arcade "road hugging": with only some wheels touching (DEM lumps, cross-slopes,
    // kerbs) pull the car back down so it keeps steering; never after a hop, never when
    // all four wheels are off (crest jumps stay jumps)
    if (contacts > 0 && contacts < 4 && this._sinceHop > 0.6 && PHYS.groundStick > 0) {
      const fsk = m * G * PHYS.groundStick;
      Fx -= U.x * fsk; Fy -= U.y * fsk; Fz -= U.z * fsk;
    }
    this._sinceHop += h;

    // ---- thrusters
    if (this.boosting) {
      const fb = (p.thrusterForce || 10000) * this.powerScale;
      Fx += F.x * fb; Fy += F.y * fb; Fz += F.z * fb;
      this.thrusterFuel = Math.max(0, this.thrusterFuel - h / Math.max(0.5, p.thrusterCapacity || 5));
    }
    if (this._hopReq) {
      this._hopReq = false;
      if (contacts > 0 || this._sinceGround < 0.15) {
        const vy = Math.max(v.y, 0) + (p.jumpImpulse || 10.5);
        v.y = vy;
        this.thrusterFuel = Math.max(0, this.thrusterFuel - PHYS.hopFuel);
        this._hopFlash = 0.35;
        this._sinceHop = 0;
        this._sinceGround = 1;
        if (this.onJump) this.onJump();
      }
    }
    const airborne = contacts === 0 && !bodyContact;
    this.hovering = false;
    if (airborne && this._jumpHeld && v.y < 3 && this._hoverUsed < PHYS.hoverMaxTime && this.thrusterFuel > 0 && !this.inWater) {
      this.hovering = true;
      this._hoverUsed += h;
      this.thrusterFuel = Math.max(0, this.thrusterFuel - PHYS.hoverDrain * h);
      Fy += m * gEff * (1 - PHYS.hoverGravity);
      if (v.y < -1) Fy += m * (-1 - v.y) * 3; // arrest the fall
    }

    // ---- air control / auto-level
    if (airborne) {
      const w0 = this.hovering ? PHYS.airLevel * 2 : PHYS.airLevel;
      const Iavg = (this.Ix + this.Iz) * 0.5;
      // torque toward upright: U x Y
      Tx += -U.z * Iavg * w0 * w0;
      Tz += U.x * Iavg * w0 * w0;
      // damp pitch/roll rates
      const dmp = Iavg * 2 * 0.7 * w0;
      Tx -= w.x * dmp; Tz -= w.z * dmp;
      const yawT = -clamp(input.steer || 0, -1, 1) * PHYS.airYawControl * (this.hovering ? 1.8 : 1);
      Ty += this.Iy * 3 * (yawT - w.y);
    } else if (contacts > 0) {
      // drift assist: prevent spin-outs, keep some speed while sliding
      const vl = v.x * Lv.x + v.y * Lv.y + v.z * Lv.z;
      if (av > 6 && this.gear > 0) {
        const beta = Math.atan2(vl, Math.max(vf, 0.5));
        const ab = Math.abs(beta);
        const soft = 0.55;
        if (ab > soft) Ty += Math.sign(beta) * this.Iy * 7 * (ab - soft) * PHYS.driftAssist;
        // stability control: outside a handbrake-initiated drift, gently stop the rear stepping out
        if (!this._driftMode && ab > 0.08) {
          const st = PHYS.stability * (1 - 0.5 * driftF) * smoothstep(5, 15, av);
          Ty += Math.sign(beta) * this.Iy * 14 * (ab - 0.08) * st;
        }
        if (ab > 0.12) {
          const keep = m * 2.2 * PHYS.driftAssist * smoothstep(0.12, 0.5, ab) * (0.4 + 0.6 * thr);
          Fx += (v.x / sp) * keep; Fy += (v.y / sp) * keep; Fz += (v.z / sp) * keep;
        }
      }
    }

    // ---- soft world bounds
    const b = world.bounds;
    if (b) {
      const M = PHYS.boundsMargin;
      if (com.x < b.minX + M) Fx += m * ((b.minX + M - com.x) * 1.5 - Math.min(0, v.x) * 1.5);
      if (com.x > b.maxX - M) Fx -= m * ((com.x - (b.maxX - M)) * 1.5 + Math.max(0, v.x) * 1.5);
      if (com.z < b.minZ + M) Fz += m * ((b.minZ + M - com.z) * 1.5 - Math.min(0, v.z) * 1.5);
      if (com.z > b.maxZ - M) Fz -= m * ((com.z - (b.maxZ - M)) * 1.5 + Math.max(0, v.z) * 1.5);
    }

    // ---- integrate
    v.x += Fx * this.invMass * h; v.y += Fy * this.invMass * h; v.z += Fz * this.invMass * h;
    // angular: world torque -> local -> /I -> world
    const tl = Tx * Lv.x + Ty * Lv.y + Tz * Lv.z;
    const tu = Tx * U.x + Ty * U.y + Tz * U.z;
    const tf = Tx * F.x + Ty * F.y + Tz * F.z;
    const al = tl / this.Ix, au = tu / this.Iy, af = tf / this.Iz;
    w.x += (Lv.x * al + U.x * au + F.x * af) * h;
    w.y += (Lv.y * al + U.y * au + F.y * af) * h;
    w.z += (Lv.z * al + U.z * au + F.z * af) * h;
    const wl = w.length();
    if (wl > 12) w.multiplyScalar(12 / wl);

    const pcx = com.x, pcz = com.z;
    com.x += v.x * h; com.y += v.y * h; com.z += v.z * h;

    // quaternion integration
    const q = this.quaternion;
    const hw = 0.5 * h;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    q.x = qx + hw * (w.x * qw + w.y * qz - w.z * qy);
    q.y = qy + hw * (w.y * qw + w.z * qx - w.x * qz);
    q.z = qz + hw * (w.z * qw + w.x * qy - w.y * qx);
    q.w = qw + hw * (-w.x * qx - w.y * qy - w.z * qz);
    q.normalize();
    this._updateDerived();

    // ---- world collisions (swept)
    this._collideWorld(pcx, pcz, h);

    // hard bounds
    if (b) {
      if (com.x < b.minX) { com.x = b.minX; if (v.x < 0) v.x = 0; }
      if (com.x > b.maxX) { com.x = b.maxX; if (v.x > 0) v.x = 0; }
      if (com.z < b.minZ) { com.z = b.minZ; if (v.z < 0) v.z = 0; }
      if (com.z > b.maxZ) { com.z = b.maxZ; if (v.z > 0) v.z = 0; }
    }
    // safety: never below terrain
    const tH = world.heightAt(com.x, com.z);
    if (com.y < tH - 1.5) { com.y = tH + this.cgH; if (v.y < 0) v.y = 0; }
    this._updateDerived();

    // ---- bookkeeping per sub-step
    this.wheelsOnGround = contacts;
    if (contacts > 0 || bodyContact) {
      if (this._wasAir && this.airTime > 0.25) {
        const strength = clamp(-this._minVyAir / 12, 0, 1);
        if (this.onLand) this.onLand(strength);
      }
      this._wasAir = false;
      this.airTime = 0; this._minVyAir = 0;
      if (contacts > 0) { this._sinceGround = 0; this._hoverUsed = 0; }
      else this._sinceGround += h;
    } else {
      this._wasAir = true;
      this._sinceGround += h;
      this.airTime += h;
      // approach speed along the surface normal below (landing on a downslope is softer)
      const pn = world.normalAt(this.position.x, this.position.z, this.position.y, _n2);
      const vn = v.x * pn.x + v.y * pn.y + v.z * pn.z;
      if (vn < this._minVyAir) this._minVyAir = vn;
    }
  }

  // 1 / effective mass of the body at offset r (from CoM) along unit direction n
  _invEffMass(rx, ry, rz, nx, ny, nz) {
    // c = r x n ; a = I^-1 c ; result = 1/m + n . (a x r)
    const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
    const L = this._leftV, U = this._upV, F = this._fwdV;
    const cl = (cx * L.x + cy * L.y + cz * L.z) / this.Ix, cu = (cx * U.x + cy * U.y + cz * U.z) / this.Iy, cf = (cx * F.x + cy * F.y + cz * F.z) / this.Iz;
    const ax = L.x * cl + U.x * cu + F.x * cf, ay = L.y * cl + U.y * cu + F.y * cf, az = L.z * cl + U.z * cu + F.z * cf;
    const bx = ay * rz - az * ry, by = az * rx - ax * rz, bz = ax * ry - ay * rx;
    return this.invMass + nx * bx + ny * by + nz * bz;
  }
  // apply world impulse J at offset r from the CoM
  _impulseAt(jx, jy, jz, rx, ry, rz) {
    const v = this.velocity, w = this.angularVelocity;
    v.x += jx * this.invMass; v.y += jy * this.invMass; v.z += jz * this.invMass;
    const tx = ry * jz - rz * jy, ty = rz * jx - rx * jz, tz = rx * jy - ry * jx;
    const L = this._leftV, U = this._upV, F = this._fwdV;
    const tl = (tx * L.x + ty * L.y + tz * L.z) / this.Ix, tu = (tx * U.x + ty * U.y + tz * U.z) / this.Iy, tf = (tx * F.x + ty * F.y + tz * F.z) / this.Iz;
    w.x += L.x * tl + U.x * tu + F.x * tf; w.y += L.y * tl + U.y * tu + F.y * tf; w.z += L.z * tl + U.z * tu + F.z * tf;
  }

  _collideWorld(pcx, pcz, h) {
    const world = this.world;
    const com = this._com, v = this.velocity, w = this.angularVelocity;
    const F = this._fwdV;
    // flat forward
    let fx = F.x, fz = F.z;
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const r = this.halfWidth * 0.98;
    const off = this.halfLength - r;
    let baseY = this.position.y;
    const dX = com.x - pcx, dZ = com.z - pcz;
    const dist = Math.hypot(dX, dZ);
    const rs = r * 0.6; // sweep with a smaller circle: only deep (tunnelling) hits count, scraping slides
    const steps = Math.min(24, Math.max(1, Math.ceil(dist / (r * 0.4))));
    const hit = _hit;
    // swept: find first sub-position that collides
    if (steps > 1) {
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const x = pcx + dX * t, z = pcz + dZ * t;
        let any = false;
        for (let k = -1; k <= 1; k++) {
          if (world.collideCircle(x + fx * off * k, z + fz * off * k, rs, baseY, hit)) { any = true; break; }
        }
        if (any) { com.x = x; com.z = z; break; }
      }
    }
    // resolve penetrations (iterate)
    for (let it = 0; it < 3; it++) {
      let any = false;
      for (let k = -1; k <= 1; k++) {
        const cx = com.x + fx * off * k, cz = com.z + fz * off * k;
        if (!world.collideCircle(cx, cz, r, baseY, hit)) continue;
        any = true;
        const nx = hit.nx, nz = hit.nz;
        // ledge assist: airborne and the wall top is only a little above the car base -> mantle on
        if (this.wheelsOnGround < 4 && this.velocity.y < 4 && this._upV.y > 0.7) {
          const qx = cx - nx * (r - hit.depth * 0.5), qz = cz - nz * (r - hit.depth * 0.5);
          const rise = world.surfaceHeight(qx, qz, baseY + 0.35) - baseY;
          if (rise > 0.7 && rise < 1.1) {
            com.y += rise + 0.02;
            this._updateDerived();
            baseY = this.position.y;
            if (v.y < 0) v.y = 0;
            continue;
          }
        }
        com.x += nx * (hit.depth + 0.002); com.z += nz * (hit.depth + 0.002);
        // contact point relative to com (XZ)
        const rx = cx - nx * r - com.x, rz = cz - nz * r - com.z;
        const vpx = v.x + w.y * rz, vpz = v.z - w.y * rx;
        const vn = vpx * nx + vpz * nz;
        if (vn < 0) {
          const cr = rz * nx - rx * nz;
          const denomN = this.invMass + (cr * cr) / this.Iy;
          const jn = (-(1 + PHYS.restitution) * vn) / denomN;
          const tx = -nz, tz = nx;
          const vt = vpx * tx + vpz * tz;
          const ct = rz * tx - rx * tz;
          let jt = -vt / (this.invMass + (ct * ct) / this.Iy);
          const jmax = PHYS.wallFriction * jn;
          if (jt > jmax) jt = jmax; else if (jt < -jmax) jt = -jmax;
          v.x += (jn * nx + jt * tx) * this.invMass;
          v.z += (jn * nz + jt * tz) * this.invMass;
          w.y += ((cr * jn + ct * jt) / this.Iy) * PHYS.wallSpin;
          // a little pitch/roll jolt for drama
          w.x *= 0.9; w.z *= 0.9;
          const dv = jn * this.invMass;
          this._reportImpact(dv, jn, cx - nx * r, baseY + 0.5, cz - nz * r);
        }
      }
      if (!any) break;
    }
  }

  _reportImpact(dv, impulse, x, y, z) {
    const strength = clamp(dv / 20, 0, 1);
    const fN = impulse / Math.max(this._frameDt, 1e-3);
    if (fN > this.lastImpact) this.lastImpact = fN;
    if (strength > this.lastImpactStrength) this.lastImpactStrength = strength;
    if (strength > 0.03 && (this._impactCooldown <= 0 || strength > 0.25)) {
      this._impactCooldown = 0.18;
      this._impactPoint.set(x, y, z);
      if (this.onCollision) this.onCollision(strength, this._impactPoint);
    }
  }

  _postFrame(dt, input) {
    const v = this.velocity, F = this._fwdV, Lv = this._leftV, U = this._upV;
    this.heading = Math.atan2(F.x, F.z);
    const vf = v.x * F.x + v.y * F.y + v.z * F.z;
    const vl = v.x * Lv.x + v.y * Lv.y + v.z * Lv.z;
    this.speed = vf;
    this.speedKmh = Math.abs(vf) * 3.6;
    this.onGround = this.wheelsOnGround > 0;
    // accelerations (for body lean + telemetry)
    const ax = (v.x - this._lastV.x) / dt, az = (v.z - this._lastV.z) / dt, ayy = (v.y - this._lastV.y) / dt;
    const aF = ax * F.x + ayy * F.y + az * F.z, aL = ax * Lv.x + ayy * Lv.y + az * Lv.z;
    const k = 1 - Math.exp(-dt * 8);
    this._accF += (aF - this._accF) * k;
    this._accL += (aL - this._accL) * k;
    this.longitudinalG = this._accF / G;
    this.lateralG = this._accL / G;

    // drift
    const av = Math.abs(vf);
    const beta = av > 1 ? Math.atan2(vl, Math.max(vf, 0.5)) : 0;
    this.driftAngle = this.onGround ? beta : this.driftAngle * 0.9;
    this.drifting = this.onGround && av > 8 && this.gear > 0 && (Math.abs(beta) > 0.17 || (this.handbrake && Math.abs(beta) > 0.08));
    this.slip = clamp(Math.max(this._slipFrame || 0, this.drifting ? Math.abs(beta) * 1.5 : 0), 0, 1);

    // fuel
    let regen = PHYS.fuelRegen;
    if (this.drifting) regen += PHYS.driftFuel * clamp(Math.abs(beta) / 0.5, 0, 1) * clamp(av / 20, 0, 1);
    if (!this.boosting && !this.hovering) this.thrusterFuel = clamp(this.thrusterFuel + regen * dt, 0, 1);

    // thruster visual level
    if (this._hopFlash > 0) this._hopFlash -= dt;
    let lvl = 0, mode = 'boost';
    if (this.boosting) { lvl = 1; mode = 'boost'; }
    else if (this.hovering) { lvl = 0.75; mode = 'hover'; }
    else if (this._hopFlash > 0) { lvl = this._hopFlash / 0.35; mode = 'hover'; }
    this.thrusterLevel += (lvl - this.thrusterLevel) * (1 - Math.exp(-dt * 14));
    if (lvl > 0) this.thrusterMode = mode;

    // rpm
    let target;
    if (this.gear > 0) {
      const r = av / this.gearTopSpeed[this.gear - 1];
      target = 0.12 + 0.88 * clamp(r, 0, 1);
      if (!this.onGround) target = Math.max(target, 0.15 + 0.8 * this.throttle);
      else if (this.gear === 1 && av < 6) target = Math.max(target, 0.12 + this.throttle * 0.45 * (1 - av / 6) + r);
    } else target = 0.12 + 0.6 * clamp(av / PHYS.reverseMaxSpeed, 0, 1);
    if (this._slipFrame > 0.5 && this.throttle > 0.5) target = Math.min(1, target + 0.15);
    if (this.inWater) target = 0.12;
    this.rpm += (clamp(target, 0, 1) - this.rpm) * (1 - Math.exp(-dt * (this.shifting ? 25 : 12)));

    // wheel spin + public wheel state
    for (let i = 0; i < 4; i++) {
      const wh = this._wheels[i];
      let spinV = wh.contact ? wh.vLong : vf;
      if (!wh.front && wh.lockT > 0.5) spinV *= 0.05;
      if (wh.contact && this.throttle > 0.6 && wh.slip > 0.4 && (wh.front ? this.frontBias > 0 : this.frontBias < 1) && this.gear > 0) spinV += 8 * this.throttle;
      wh.spin = (wh.spin + (spinV / this.wheelRadius) * dt) % (Math.PI * 2000);
      const wc = this.wheelContacts[i];
      wc.x = wh.cx; wc.y = wh.cy; wc.z = wh.cz;
      wc.onGround = wh.contact; wc.slip = wh.slip; wc.compression = wh.c; wc.load = wh.load; wc.surface = wh.surface;
    }

    // body lean (visual)
    const kl = 1 - Math.exp(-dt * 6);
    const tRoll = this.onGround ? clamp(this._accL * 0.0045, -0.05, 0.05) : 0;
    const tPitch = this.onGround ? clamp(-this._accF * 0.0035, -0.04, 0.04) : 0;
    this._leanRoll += (tRoll - this._leanRoll) * kl;
    this._leanPitch += (tPitch - this._leanPitch) * kl;

    // upside-down recovery
    if (U.y < 0.35 && this.wheelsOnGround < 2 && av < 4 && !this.inWater) {
      this._flipT += dt;
      if (this._flipT > 1.5) this._autoRight();
    } else this._flipT = 0;
    this.flipped = U.y < 0.35;
  }

  _autoRight() {
    const h = this.heading;
    const x = this.position.x, z = this.position.z;
    const y = this.world.surfaceHeight(x, z, this.position.y + 1) + 0.6;
    const fuel = this.thrusterFuel;
    const vel = this.velocity.clone();
    this.reset(x, z, h, y);
    this.velocity.set(vel.x * 0.3, 0, vel.z * 0.3);
    this.thrusterFuel = fuel;
  }

  // Sets everything visual on a CarModel (see CONTRACTS.md).
  applyToModel(model) {
    if (!model) return;
    model.group.position.copy(this.position);
    model.group.quaternion.copy(this.quaternion);
    const base = model.wheelBaseY ?? this.wheelRadius;
    const sag = PHYS.suspSag;
    for (let i = 0; i < 4; i++) {
      const wh = this._wheels[i];
      const piv = model.wheelPivots && model.wheelPivots[i];
      if (piv) {
        piv.position.y = base + clamp((wh.contact ? wh.c : 0) - sag, -0.16, 0.16);
        if (wh.front) piv.rotation.y = -this.steerAngle;
      }
      const wm = model.wheels && model.wheels[i];
      if (wm) wm.rotation.x = wh.spin;
    }
    if (model.body) {
      model.body.rotation.z = this._leanRoll;
      model.body.rotation.x = this._leanPitch;
    }
    let c = this._modelCache.get(model);
    if (!c) { c = { brake: null, rev: null, lvl: -1, mode: null }; this._modelCache.set(model, c); }
    const brakeOn = this.braking || (this.handbrake && this.onGround);
    if (c.brake !== brakeOn && model.setBrake) { model.setBrake(brakeOn); c.brake = brakeOn; }
    if (c.rev !== this.reversing && model.setReverse) { model.setReverse(this.reversing); c.rev = this.reversing; }
    const lvl = Math.round(this.thrusterLevel * 50) / 50;
    if ((c.lvl !== lvl || c.mode !== this.thrusterMode) && model.setThruster) { model.setThruster(lvl, this.thrusterMode); c.lvl = lvl; c.mode = this.thrusterMode; }
  }

  // ---- helpers for car-car collisions (used by resolveVehicleCollisions)
  _shift(dx, dz) { this._com.x += dx; this._com.z += dz; this.position.x += dx; this.position.z += dz; }
  _applyImpulse(jx, jz, px, pz) {
    this.velocity.x += jx * this.invMass;
    this.velocity.z += jz * this.invMass;
    const rx = px - this._com.x, rz = pz - this._com.z;
    this.angularVelocity.y += ((rz * jx - rx * jz) / this.Iy) * PHYS.carSpin;
  }
  get invIy() { return 1 / this.Iy; }
}

const _Y = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _hit = { nx: 0, nz: 0, depth: 0 };
const _n2 = new THREE.Vector3();
const _contacts = Array.from({ length: 16 }, () => ({ rx: 0, ry: 0, rz: 0, nx: 0, ny: 1, nz: 0, pen: 0, fric: 0, vn: 0, j: 0, tx: 0, ty: 0, tz: 0 }));
const _forces = [0, 0, 0, 0];
// chassis contact points: [x (x halfWidth), y (x height), z (x halfLength)]
const CHASSIS_PTS = [
  [0.9, 0.18, 0.92], [-0.9, 0.18, 0.92], [0.9, 0.18, -0.92], [-0.9, 0.18, -0.92],
  [0, 0.18, 0.45], [0, 0.18, 0], [0, 0.18, -0.45],
  [0.75, 1.0, 0.25], [-0.75, 1.0, 0.25], [0.75, 1.0, -0.4], [-0.75, 1.0, -0.4],
];
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, jump: false, jumpPressed: false };

// lazily attached shared vectors per instance
Object.defineProperty(Vehicle.prototype, '_fwdV', { get() { return this.__f || (this.__f = new THREE.Vector3(0, 0, 1)); } });
Object.defineProperty(Vehicle.prototype, '_leftV', { get() { return this.__l || (this.__l = new THREE.Vector3(1, 0, 0)); } });
Object.defineProperty(Vehicle.prototype, '_upV', { get() { return this.__u || (this.__u = new THREE.Vector3(0, 1, 0)); } });

// ======================================================================================
// Car-car collisions. vehicles: Vehicle[] and/or traffic proxies. Each body needs:
//   position, velocity, angularVelocity, heading, mass, halfLength, halfWidth,
//   _prevPos (frame start), _shift(dx,dz), _applyImpulse(jx,jz,px,pz), optional
//   kinematic (bool: skip kinematic-kinematic pairs), onCollision, lastImpact.
// Call once per frame after all vehicles/traffic have been updated.
const _ca = [0, 0, 0, 0, 0, 0], _cb = [0, 0, 0, 0, 0, 0];
function circlesOf(b, x, z, out) {
  const h = b.heading;
  const fx = Math.sin(h), fz = Math.cos(h);
  const r = b.halfWidth;
  const off = Math.max(0, b.halfLength - r);
  out[0] = x + fx * off; out[1] = z + fz * off;
  out[2] = x; out[3] = z;
  out[4] = x - fx * off; out[5] = z - fz * off;
  return r;
}
function deepest(a, ax, az, b, bx, bz, res) {
  const ra = circlesOf(a, ax, az, _ca), rb = circlesOf(b, bx, bz, _cb);
  const rs = ra + rb;
  let best = 0, found = false;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const dx = _cb[j * 2] - _ca[i * 2], dz = _cb[j * 2 + 1] - _ca[i * 2 + 1];
    const d2 = dx * dx + dz * dz;
    if (d2 >= rs * rs) continue;
    const d = Math.sqrt(d2) || 1e-4;
    const depth = rs - d;
    if (depth > best) {
      best = depth; found = true;
      res.nx = dx / d; res.nz = dz / d; res.depth = depth; // normal from a to b
      res.px = _ca[i * 2] + res.nx * ra; // contact point on a's surface
      res.pz = _ca[i * 2 + 1] + res.nz * ra;
    }
  }
  return found;
}
const _res = { nx: 0, nz: 0, depth: 0, px: 0, pz: 0 };
const _pt = new THREE.Vector3();

export function resolveVehicleCollisions(vehicles) {
  const n = vehicles.length;
  for (let i = 0; i < n; i++) {
    const a = vehicles[i];
    if (!a || a.disabled) continue;
    for (let j = i + 1; j < n; j++) {
      const b = vehicles[j];
      if (!b || b.disabled) continue;
      if (a.kinematic && b.kinematic && !a.knocked && !b.knocked) continue;
      const pa = a.position, pb = b.position;
      const reach = a.halfLength + b.halfLength + 2;
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      // relative frame motion for swept test
      const qa = a._prevPos || pa, qb = b._prevPos || pb;
      const rmx = (pb.x - qb.x) - (pa.x - qa.x), rmz = (pb.z - qb.z) - (pa.z - qa.z);
      const rm = Math.hypot(rmx, rmz);
      if (dx * dx + dz * dz > (reach + rm) * (reach + rm)) continue;
      if (Math.abs(pa.y - pb.y) > 1.5) continue;
      let hit = deepest(a, pa.x, pa.z, b, pb.x, pb.z, _res);
      if (!hit && rm > Math.min(a.halfWidth, b.halfWidth)) {
        // fast pass: test intermediate positions
        const steps = Math.min(10, Math.ceil(rm / (Math.min(a.halfWidth, b.halfWidth) * 0.8)));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const ax = qa.x + (pa.x - qa.x) * t, az = qa.z + (pa.z - qa.z) * t;
          const bx = qb.x + (pb.x - qb.x) * t, bz = qb.z + (pb.z - qb.z) * t;
          if (deepest(a, ax, az, b, bx, bz, _res)) {
            // move both back to the moment of contact
            a._shift(ax - pa.x, az - pa.z);
            b._shift(bx - pb.x, bz - pb.z);
            hit = true;
            break;
          }
        }
      }
      if (!hit) continue;
      const nx = _res.nx, nz = _res.nz;
      const ima = a.kinematic && !a.knocked ? 1 / (a.mass * 1.6) : 1 / a.mass;
      const imb = b.kinematic && !b.knocked ? 1 / (b.mass * 1.6) : 1 / b.mass;
      const sum = ima + imb;
      const corr = _res.depth + 0.01;
      a._shift(-nx * corr * (ima / sum), -nz * corr * (ima / sum));
      b._shift(nx * corr * (imb / sum), nz * corr * (imb / sum));
      // impulse
      const px = _res.px, pz = _res.pz;
      const wa = a.angularVelocity ? a.angularVelocity.y : 0, wb = b.angularVelocity ? b.angularVelocity.y : 0;
      const rax = px - a.position.x, raz = pz - a.position.z;
      const rbx = px - b.position.x, rbz = pz - b.position.z;
      const vax = a.velocity.x + wa * raz, vaz = a.velocity.z - wa * rax;
      const vbx = b.velocity.x + wb * rbz, vbz = b.velocity.z - wb * rbx;
      const rvx = vbx - vax, rvz = vbz - vaz;
      const vn = rvx * nx + rvz * nz;
      if (vn >= 0) continue; // separating
      const IyA = a.Iy || a.mass * 2, IyB = b.Iy || b.mass * 2;
      const cra = raz * nx - rax * nz, crb = rbz * nx - rbx * nz;
      const denom = ima + imb + (cra * cra) / IyA + (crb * crb) / IyB;
      const e = 0.3;
      const jn = (-(1 + e) * vn) / denom;
      const tx = -nz, tz = nx;
      const vt = rvx * tx + rvz * tz;
      let jt = -vt / (ima + imb) * 0.25;
      if (Math.abs(jt) > jn * 0.3) jt = Math.sign(jt) * jn * 0.3;
      const jx = jn * nx + jt * tx, jz = jn * nz + jt * tz;
      // scale impulse by "effective" inverse masses for kinematic bodies
      a._applyImpulse(-jx * (ima * a.mass), -jz * (ima * a.mass), px, pz);
      b._applyImpulse(jx * (imb * b.mass), jz * (imb * b.mass), px, pz);
      _pt.set(px, (pa.y + pb.y) * 0.5 + 0.6, pz);
      const sa = clamp((jn * ima) / 15, 0, 1), sb = clamp((jn * imb) / 15, 0, 1);
      report(a, sa, jn, _pt);
      report(b, sb, jn, _pt);
      if (b.kinematic && b.knock) b.knock(jn * imb);
      if (a.kinematic && a.knock) a.knock(jn * ima);
      a._lastCarHit = b; b._lastCarHit = a;
    }
  }
}
function report(v, strength, jn, pt) {
  if (v._reportImpact) {
    const fN = jn / Math.max(v._frameDt || 1 / 60, 1e-3);
    if (fN > v.lastImpact) v.lastImpact = fN;
    if (strength > v.lastImpactStrength) v.lastImpactStrength = strength;
    if (strength > 0.03 && (v._impactCooldown <= 0 || strength > 0.25)) {
      v._impactCooldown = 0.18;
      v._impactPoint.copy(pt);
      if (v.onCollision) v.onCollision(strength, v._impactPoint);
    }
  } else if (v.onCollision && strength > 0.03) v.onCollision(strength, pt);
}

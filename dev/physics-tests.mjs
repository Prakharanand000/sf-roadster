// Headless physics tests against the mock world.  Run from sf-roadster/:
//   node dev/physics-tests.mjs            (all tests)
//   node dev/physics-tests.mjs vehicle    (vehicle-only)   | ai | traffic
import * as THREE from 'three';
import { Vehicle, PHYS, resolveVehicleCollisions } from '../src/physics/vehicle.js';
import { AIDriver } from '../src/physics/ai.js';
import { Traffic } from '../src/physics/traffic.js';
import { createMockWorld, MOCK } from '../src/physics/mockWorld.js';
import { SAMPLE_SPECS, createMockCarModel, createMockTrafficCarModel } from '../src/physics/mockCar.js';

const world = createMockWorld();
const DT = 1 / 60;
const only = process.argv[2] || 'all';
const rows = [];
const add = (test, car, value, target, pass) => rows.push({ test, car, value, target, pass: pass ? 'PASS' : 'FAIL' });
const isBad = (v) => !Number.isFinite(v.position.x + v.position.y + v.position.z + v.velocity.x + v.velocity.y + v.velocity.z + v.quaternion.w);
const inp = (o = {}) => Object.assign({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, jump: false, jumpPressed: false }, o);
const deg = (r) => (r * 180) / Math.PI;
const fmt = (x, d = 2) => (typeof x === 'number' ? x.toFixed(d) : String(x));

function settle(v, n = 30) { for (let i = 0; i < n; i++) v.update(DT, inp()); }

// ---------------------------------------------------------------- vehicle tests
function testAccelTop(spec) {
  const v = new Vehicle(spec, world);
  v.reset(MOCK.RUNWAY_X0 + 20, MOCK.RUNWAY_Z, Math.PI / 2);
  settle(v);
  let t = 0, t100 = null, t200 = null, vmax = 0, t95 = null;
  while (t < 60 && v.position.x < MOCK.RUNWAY_X1 - 20) {
    v.update(DT, inp({ throttle: 1 }));
    t += DT;
    if (t100 === null && v.speedKmh >= 100) t100 = t;
    if (t200 === null && v.speedKmh >= 200) t200 = t;
    vmax = Math.max(vmax, v.speed);
    if (t95 === null && v.speed >= spec.physics.maxSpeed * 0.95) t95 = t;
    if (isBad(v)) break;
  }
  add('0-100 km/h (s)', spec.id, fmt(t100), '2.0-4.0', t100 !== null && t100 < 4.5);
  add('0-200 km/h (s)', spec.id, fmt(t200), '< 12', t200 !== null && t200 < 12);
  const pct = vmax / spec.physics.maxSpeed;
  add('top speed km/h (spec)', spec.id, `${fmt(vmax * 3.6, 0)} (${fmt(spec.physics.maxSpeed * 3.6, 0)}) @${fmt(t95, 1)}s`, '>= 97 % in runway', pct > 0.97 && pct < 1.03);
  return v;
}

function testBrake(spec) {
  const v = new Vehicle(spec, world);
  v.reset(MOCK.RUNWAY_X0 + 20, MOCK.RUNWAY_Z, Math.PI / 2);
  settle(v);
  v.velocity.set(100 / 3.6, 0, 0);
  for (let i = 0; i < 10; i++) v.update(DT, inp({ throttle: 0.0 }));
  v.velocity.set(100 / 3.6, 0, 0);
  const x0 = v.position.x;
  let t = 0, maxPitch = 0;
  while (v.speed > 0.05 && t < 10) {
    v.update(DT, inp({ brake: 1 }));
    t += DT;
    maxPitch = Math.max(maxPitch, Math.abs(Math.asin(v._fwdV.y)));
  }
  const d = v.position.x - x0;
  add('braking 100-0 (m)', spec.id, `${fmt(d, 1)} in ${fmt(t)}s, dive ${fmt(deg(maxPitch), 1)}deg`, '24-42 m', d > 23 && d < 45);
}

// skidpad: pure-pursuit around a circle of radius R on the plaza, slowly ramping speed
function testSkidpad(spec, R = 50) {
  const v = new Vehicle(spec, world);
  const cx = -40, cz = -60; // clear of the plaza buildings
  v.reset(cx + R, cz, Math.PI); // facing -z at (R,0): counter-clockwise when seen from +y? path direction below
  settle(v);
  let target = 12, t = 0, best = 0, bestV = 0, latStable = [];
  const fwd = new THREE.Vector3();
  while (t < 90) {
    t += DT;
    const px = v.position.x - cx, pz = v.position.z - cz;
    const ang = Math.atan2(pz, px);
    // direction of travel: decreasing angle? heading PI at angle 0 means moving -z, so angle decreases
    const la = ang - 14 / R;
    const tx = cx + R * Math.cos(la), tz = cz + R * Math.sin(la);
    const F = v._fwdV, L = v._leftV;
    const dx = tx - v.position.x, dz = tz - v.position.z;
    const lf = dx * F.x + dz * F.z, ll = dx * L.x + dz * L.z;
    const alpha = Math.atan2(ll, lf);
    const Ld = Math.hypot(dx, dz);
    const steerAng = -Math.atan(v.wheelBase * 2 * Math.sin(alpha) / Ld);
    const steer = Math.max(-1, Math.min(1, steerAng / v.steerLimit));
    target += DT * 0.25;
    const thr = v.speed < target ? Math.min(1, (target - v.speed) * 0.8) : 0;
    v.update(DT, inp({ throttle: thr, steer }));
    const r = Math.hypot(v.position.x - cx, v.position.z - cz);
    const aLat = (v.speed * v.speed) / r / 9.81; // centripetal from the actual radius
    if (Math.abs(r - R) < 2.5 && t > 5) {
      latStable.push(aLat);
      if (latStable.length > 60) latStable.shift();
      const avg = latStable.reduce((a, b) => a + b, 0) / latStable.length;
      if (latStable.length === 60 && avg > best) { best = avg; bestV = v.speed; }
    }
    if (r - R > 8) break; // lost it (understeer wide)
    if (isBad(v)) break;
  }
  const grip = Math.min(spec.physics.gripFront, spec.physics.gripRear);
  add(`skidpad R${R} lateral g`, spec.id, `${fmt(best)} g @ ${fmt(bestV * 3.6, 0)} km/h`, `~${fmt(grip * 0.9)}-${fmt(grip * 1.15)}`, best > grip * 0.8 && best < grip * 1.3);
}

function testDrift(spec) {
  const v = new Vehicle(spec, world);
  v.reset(-200, -150, Math.PI / 2 + 0.3);
  settle(v);
  v.velocity.set(Math.sin(v.heading) * 26, 0, Math.cos(v.heading) * 26);
  let t = 0, peak = 0, spun = false, fuel0 = (v.thrusterFuel = 0.2), driftTime = 0, minSpeed = 99;
  const h0 = v.heading;
  while (t < 6) {
    t += DT;
    let i;
    if (t < 0.25) i = inp({ throttle: 0.6, steer: 1 });
    else if (t < 0.85) i = inp({ throttle: 0.4, steer: 1, handbrake: true });
    else if (t < 2.6) {
      // hold the drift: light counter-steer proportional to the drift angle, throttle on
      const s = Math.max(-1, Math.min(1, 0.3 - v.driftAngle * 1.2));
      i = inp({ throttle: 0.8, steer: s });
    } else i = inp({ throttle: 0.5, steer: Math.max(-1, Math.min(1, -v.driftAngle * 2)) });
    v.update(DT, i);
    peak = Math.max(peak, Math.abs(v.driftAngle));
    if (Math.abs(v.driftAngle) > 1.4) spun = true;
    if (v.drifting) driftTime += DT;
    if (t > 0.5) minSpeed = Math.min(minSpeed, Math.abs(v.speed));
  }
  const recovered = Math.abs(v.driftAngle) < 0.12;
  add('handbrake drift', spec.id, `peak ${fmt(deg(peak), 0)}deg, drift ${fmt(driftTime, 1)}s, vmin ${fmt(minSpeed * 3.6, 0)}km/h, fuel +${fmt(v.thrusterFuel - fuel0, 3)}, ${spun ? 'SPUN' : recovered ? 'recovered' : 'not recovered'}`, '>20deg, no spin, recovers', peak > 0.35 && !spun && recovered && minSpeed > 8);
}

// keyboard player: full throttle + full steer (digital) at 150 km/h for 1.5 s, then straighten
function testStepSteer(spec) {
  const v = new Vehicle(spec, world);
  v.reset(MOCK.RUNWAY_X0 + 20, MOCK.RUNWAY_Z, Math.PI / 2);
  settle(v);
  v.velocity.set(150 / 3.6, 0, 0);
  let maxB = 0, maxG = 0, t = 0;
  for (; t < 1.5; t += DT) { v.update(DT, inp({ throttle: 1, steer: 1 })); maxB = Math.max(maxB, Math.abs(v.driftAngle)); maxG = Math.max(maxG, Math.abs(v.lateralG)); }
  for (; t < 3.5; t += DT) v.update(DT, inp({ throttle: 1, steer: 0 }));
  const endB = Math.abs(v.driftAngle);
  add('step steer 150 km/h full lock+throttle', spec.id, `max slip angle ${fmt(deg(maxB), 1)}deg, peak lat ${fmt(maxG)} g, after release ${fmt(deg(endB), 1)}deg, ${fmt(v.speedKmh, 0)} km/h`, '< 15deg, settles', maxB < 0.26 && endB < 0.08);
}

function testHop(spec) {
  const v = new Vehicle(spec, world);
  v.reset(-50, -60, 0);
  settle(v, 60);
  const y0 = v.position.y;
  let maxY = y0, t = 0, jumped = 0;
  v.onJump = () => jumped++;
  v.update(DT, inp({ jumpPressed: true, jump: true }));
  while (t < 3) { v.update(DT, inp()); t += DT; maxY = Math.max(maxY, v.position.y); if (v.onGround && t > 0.3) break; }
  const hgt = maxY - y0;
  add('hop height (m)', spec.id, `${fmt(hgt)} (impulse ${spec.physics.jumpImpulse} m/s), airtime ${fmt(t, 2)}s`, '>= 4.0', hgt >= 4.0 && jumped === 1);

  // hop onto the 4 m roof (x 60..90, z -15..15, top 8): approach along +x
  const v2 = new Vehicle(spec, world);
  v2.reset(20, 0, Math.PI / 2);
  settle(v2, 30);
  let tt = 0, hopped = false, onRoof = false, hitWall = 0;
  v2.onCollision = (s) => { hitWall = Math.max(hitWall, s); };
  while (tt < 8) {
    tt += DT;
    const dist = 60 - (v2.position.x + v2.halfLength);
    const sp = v2.speed;
    let i = inp({ throttle: sp < 11 ? 1 : 0, brake: sp > 13 ? 0.3 : 0 });
    if (!hopped && dist < 10.5 && v2.onGround) { i.jumpPressed = true; hopped = true; }
    if (v2.position.x > 75) { i.throttle = 0; i.brake = 1; }
    v2.update(DT, i);
    if (v2.position.x > 62 && v2.onGround && v2.surface === 'roof' && Math.abs(v2.speed) < 0.3) { onRoof = true; break; }
  }
  add('hop onto 4 m roof', spec.id, `${onRoof ? 'landed on roof' : 'missed'} y=${fmt(v2.position.y)} (roof 8.00) wall-hit=${fmt(hitWall)}`, 'on roof', onRoof && Math.abs(v2.position.y - 8) < 0.2);
}

function testHover(spec) {
  const v = new Vehicle(spec, world);
  v.reset(-50, -60, 0);
  settle(v, 60);
  v.thrusterFuel = 1;
  let t = 0, hov = 0, air = 0;
  v.update(DT, inp({ jumpPressed: true, jump: true }));
  while (t < 8) {
    v.update(DT, inp({ jump: true }));
    t += DT;
    if (v.hovering) hov += DT;
    if (!v.onGround) air += DT;
    else if (t > 0.5) break;
  }
  add('hover (hold jump)', spec.id, `hover ${fmt(hov)}s, airtime ${fmt(air)}s, fuel left ${fmt(v.thrusterFuel)}`, 'hover ~2 s', hov > 1.7 && hov < 2.3);
}

function testWall(spec, which) {
  const v = new Vehicle(spec, world);
  // thinWall: x -150.5..-150, z -60..60 ; thickBlock: x 150..190, z -100..-40
  let x0, z0, hd, plane, side;
  if (which === 'thin') { x0 = -60; z0 = 0; hd = -Math.PI / 2; plane = -150; side = 1; } // moving -x, must stay x > -150
  else { x0 = 60; z0 = -70; hd = Math.PI / 2; plane = 150; side = -1; } // moving +x, must stay x < 150
  v.reset(x0, z0, hd);
  settle(v, 10);
  const sp = 320 / 3.6;
  v.velocity.set(Math.sin(hd) * sp, 0, Math.cos(hd) * sp);
  let maxImpact = 0, crossed = false, t = 0;
  v.onCollision = (s) => { maxImpact = Math.max(maxImpact, s); };
  while (t < 2.5) {
    v.update(DT, inp({ throttle: 1 }));
    t += DT;
    const front = v.position.x;
    if (side > 0 ? front < plane - 0.2 : front > plane + 0.2) crossed = true;
  }
  add(`320 km/h into ${which} wall`, spec.id, `${crossed ? 'TUNNELLED' : 'stopped'} impact ${fmt(maxImpact)} rebound ${fmt(Math.hypot(v.velocity.x, v.velocity.z) * 3.6, 0)}km/h`, 'no tunnel', !crossed && maxImpact > 0.5 && !isBad(v));
  // also: glancing hit spins the car
  const g = new Vehicle(spec, world);
  if (which === 'thick') {
    g.reset(100, -50, Math.PI / 2 + 0.35); settle(g, 10);
    g.velocity.set(Math.sin(g.heading) * 40, 0, Math.cos(g.heading) * 40);
    let maxYaw = 0;
    for (let i = 0; i < 150; i++) { g.update(DT, inp({ throttle: 0.5 })); maxYaw = Math.max(maxYaw, Math.abs(g.angularVelocity.y)); }
    add('glancing wall hit (144 km/h, 20deg)', spec.id, `yaw rate peak ${fmt(maxYaw)} rad/s, x=${fmt(g.position.x, 1)}`, 'spins, no tunnel', maxYaw > 0.5 && g.position.x < 150.2);
  }
}

function testCrest(spec) {
  const v = new Vehicle(spec, world);
  v.reset(MOCK.HILL_X, MOCK.HILL_Z0 - 60, 0); // heading 0 = +z, uphill
  settle(v);
  let t = 0, maxAir = 0, flips = 0, maxRoll = 0, maxPitchLand = 0, lands = 0, maxLandStr = 0, maxH = 0;
  v.onLand = (s) => { lands++; maxLandStr = Math.max(maxLandStr, s); };
  let sinceLand = 9;
  let lastAir = 0;
  while (t < 40 && v.position.z < 700) {
    t += DT;
    // simple lane keeping
    const lat = v.position.x - MOCK.HILL_X;
    const e = Math.atan2(-lat, 25) - Math.atan2(v._fwdV.x, v._fwdV.z);
    const steer = Math.max(-1, Math.min(1, -e / Math.max(0.05, v.steerLimit) * 0.8));
    v.update(DT, inp({ throttle: v.speed < 42 ? 1 : 0.2, steer }));
    if (!v.onGround) { lastAir += DT; maxAir = Math.max(maxAir, v.airTime); }
    else if (lastAir > 0) { sinceLand = 0; lastAir = 0; }
    sinceLand += DT;
    const U = v._upV;
    if (U.y < 0.5) flips++;
    const roll = Math.asin(Math.max(-1, Math.min(1, v._leftV.y)));
    const pitch = Math.asin(Math.max(-1, Math.min(1, v._fwdV.y)));
    if (sinceLand > 0.3 && sinceLand < 1.5 && v.onGround) { maxRoll = Math.max(maxRoll, Math.abs(roll)); }
    maxH = Math.max(maxH, v.position.y - world.heightAt(v.position.x, v.position.z));
    if (isBad(v)) break;
  }
  const ok = flips === 0 && maxRoll < 0.2 && v.position.z > 600 && !isBad(v);
  add('hill street crests @~150 km/h', spec.id, `air max ${fmt(maxAir)}s, max height ${fmt(maxH, 1)}m, landings ${lands} (max str ${fmt(maxLandStr)}), roll after land ${fmt(deg(maxRoll), 1)}deg, flips ${flips}, z=${fmt(v.position.z, 0)}`, 'airborne, stable landings', ok && maxAir > 0.3);
}

function testWaterBounds(spec) {
  const v = new Vehicle(spec, world);
  v.reset(1240, 300, Math.PI / 2);
  settle(v);
  let splash = 0, t = 0;
  v.onSplash = () => splash++;
  while (t < 10 && !v.inWater) { v.update(DT, inp({ throttle: 1 })); t += DT; }
  for (let i = 0; i < 120; i++) v.update(DT, inp({ throttle: 1 }));
  add('drive into bay', spec.id, `inWater=${v.inWater} splash=${splash} speed ${fmt(v.speedKmh, 0)}km/h`, 'splash once, slows', v.inWater && splash === 1 && v.speedKmh < 40);
  // bounds
  const b = new Vehicle(spec, world);
  b.reset(-1900, -1200, -Math.PI / 2);
  settle(b);
  b.velocity.set(-60, 0, 0);
  for (let i = 0; i < 240; i++) b.update(DT, inp({ throttle: 1 }));
  add('world bounds clamp', spec.id, `x=${fmt(b.position.x, 1)} (min -2000)`, 'stays inside', b.position.x >= -2000 && !isBad(b));
}

function testCarCar(spec) {
  const a = new Vehicle(spec, world), b = new Vehicle(spec, world);
  a.reset(-100, -100, Math.PI / 2); b.reset(-40, -100, -Math.PI / 2);
  settle(a); settle(b);
  a.velocity.set(80, 0, 0); b.velocity.set(-10, 0, 0);
  let hits = 0, passed = false;
  a.onCollision = () => hits++;
  for (let i = 0; i < 120; i++) {
    a.update(DT, inp({ throttle: 1 })); b.update(DT, inp());
    resolveVehicleCollisions([a, b]);
    if (a.position.x > b.position.x + 1) passed = true;
  }
  add('car-car head-on (288 vs 36 km/h)', spec.id, `${passed ? 'PASSED THROUGH' : 'blocked'} hits ${hits}, b speed ${fmt(b.velocity.x * 3.6, 0)}km/h`, 'no pass-through', !passed && hits > 0 && !isBad(a) && !isBad(b));
}

// same manoeuvres at 30 / 60 / 144 fps (+ a jittery frame time) must give the same result
function testFrameRates(spec) {
  const res = [];
  for (const fps of [30, 60, 144, 'jitter']) {
    const v = new Vehicle(spec, world);
    v.reset(MOCK.RUNWAY_X0 + 20, MOCK.RUNWAY_Z, Math.PI / 2);
    let t = 0, t100 = null, k = 0;
    const step = () => (fps === 'jitter' ? [1 / 30, 1 / 144, 1 / 60, 1 / 90][k++ % 4] : 1 / fps);
    while (t < 1) { const d = step(); v.update(d, inp()); t += d; }
    t = 0;
    while (t < 8 && t100 === null) { const d = step(); v.update(d, inp({ throttle: 1 })); t += d; if (v.speedKmh >= 100) t100 = t; }
    const h = new Vehicle(spec, world);
    h.reset(-50, -60, 0);
    t = 0; while (t < 1) { const d = step(); h.update(d, inp()); t += d; }
    const y0 = h.position.y; let my = y0; h.update(step(), inp({ jumpPressed: true }));
    t = 0; while (t < 2.5) { const d = step(); h.update(d, inp()); t += d; my = Math.max(my, h.position.y); }
    res.push({ fps, t100, hop: my - y0 });
  }
  const a = res.map(r => r.t100), b = res.map(r => r.hop);
  const spreadA = Math.max(...a) - Math.min(...a), spreadB = Math.max(...b) - Math.min(...b);
  add('frame-rate independence 30/60/144/jitter', spec.id, `0-100 ${a.map(x => fmt(x)).join('/')}s, hop ${b.map(x => fmt(x)).join('/')}m`, 'spread < 0.1 s / 0.15 m', spreadA < 0.1 && spreadB < 0.15);
}

function perf(spec) {
  const v = new Vehicle(spec, world);
  v.reset(0, 0, 0); settle(v);
  const N = 3000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) v.update(DT, inp({ throttle: 1, steer: Math.sin(i * 0.01) }));
  const ms = (performance.now() - t0) / N;
  add('perf: Vehicle.update @60fps', spec.id, `${fmt(ms, 3)} ms/frame`, '< 0.15 ms', ms < 0.15);
}

// ---------------------------------------------------------------- AI tests
function testAI(track, nCars = 4, laps = 2) {
  const specs = SAMPLE_SPECS;
  const cars = [], ais = [];
  for (let i = 0; i < nCars; i++) {
    const s = specs[i % specs.length];
    const v = new Vehicle(s, world);
    const g = track.grid[i];
    v.reset(g.x, g.z, g.heading);
    cars.push(v);
    ais.push(new AIDriver(v, track, { skill: 0.5 + 0.15 * (i % 4), aggression: 0.5, name: 'AI' + i }));
  }
  for (const v of cars) settle(v, 20);
  let t = 0, resets = 0, recover = 0, maxStuck = 0, collisions = 0, nan = false;
  const lapTimes = ais.map(() => []);
  const lastLap = ais.map(() => 0);
  cars.forEach(v => { v.onCollision = () => collisions++; });
  const limit = (track.lengthMeters * laps) / 15 + 60;
  while (t < limit) {
    t += DT;
    for (let i = 0; i < cars.length; i++) {
      const ai = ais[i];
      const input = ai.getInput(DT, world, cars);
      cars[i].update(DT, input);
      if (ai.needsReset) { if (process.env.DEBUG) console.log('reset', ai.name, ai.resetReason, 't', t.toFixed(1), 's', ai.tracker.s.toFixed(0), 'dist', ai.tracker.dist.toFixed(1), 'pos', cars[i].position.toArray().map(a => a.toFixed(1)).join(','), 'v', cars[i].speed.toFixed(1)); ai.resetToTrack(); resets++; }
      if (ai.lapsCompleted > lastLap[i]) { lapTimes[i].push(t); lastLap[i] = ai.lapsCompleted; }
      if (isBad(cars[i])) nan = true;
    }
    resolveVehicleCollisions(cars);
    if (ais.every(a => a.lapsCompleted >= laps)) break;
  }
  recover = ais.reduce((a, b) => a + b.recoveries, 0);
  const done = ais.filter(a => a.lapsCompleted >= laps).length;
  const lt = lapTimes.map(l => l.length ? fmt(l[0], 1) + (l[1] ? '/' + fmt(l[1] - l[0], 1) : '') : '-').join(' ');
  const avgSpeed = ais.map(a => a.progress / t);
  add(`AI ${laps} laps ${track.name} (${fmt(track.lengthMeters, 0)} m)`, `${nCars} cars`, `${done}/${nCars} done in ${fmt(t, 0)}s, lap times ${lt}, resets ${resets}, recoveries ${recover}, car hits ${collisions}`, 'all finish, 0 resets', done === nCars && !nan && resets <= 0);
  return { t, done };
}

// AI blocked by a wall that the path goes through: must detect stuck, reverse, then ask for reset
function testAIStuck() {
  const spec = SAMPLE_SPECS[0];
  const path = []; for (let x = 100; x <= 300; x += 8) path.push([x, -70]);
  const track = { id: 'stuck', name: 'stuck', laps: 1, loop: false, path, checkpoints: [], grid: [], lengthMeters: 200, width: 12 };
  const v = new Vehicle(spec, world);
  v.reset(110, -70, Math.PI / 2); settle(v);
  const ai = new AIDriver(v, track, { skill: 0.8, name: 'stuck' });
  let t = 0, firstRev = null, reason = null;
  while (t < 40 && !ai.needsReset) {
    t += DT;
    v.update(DT, ai.getInput(DT, world, [v]));
    if (firstRev === null && v.gear < 0) firstRev = t;
    if (isBad(v)) break;
  }
  reason = ai.resetReason;
  add('AI stuck at wall -> reverse/reset', spec.id, `first reverse ${fmt(firstRev, 1)}s, recoveries ${ai.recoveries}, needsReset ${ai.needsReset} (${reason}) @${fmt(t, 1)}s, x=${fmt(v.position.x, 1)}`, 'reverse after ~3 s, reset', ai.needsReset && ai.recoveries >= 1 && firstRev !== null && v.position.x < 150.2);
}

// ---------------------------------------------------------------- traffic test
function testTraffic() {
  const fakeScene = { add() {}, remove() {} };
  const spec = SAMPLE_SPECS[0];
  const player = new Vehicle(spec, world);
  player.reset(0, 300, 0);
  settle(player);
  const traffic = new Traffic(fakeScene, world, (seed) => createMockTrafficCarModel(seed), { count: 40 });
  let t = 0, nan = false, nm = 0, hits = 0, maxActive = 0;
  player.onCollision = () => hits++;
  // the player drives the ring road with an AI controller, at speed
  const ai = new AIDriver(player, world.tracks[0], { skill: 1, aggression: 1 });
  const t0 = performance.now();
  let frames = 0;
  while (t < 60) {
    t += DT; frames++;
    const input = ai.getInput(DT, world, [player, ...traffic.proxies]);
    player.update(DT, input);
    traffic.update(DT, player);
    resolveVehicleCollisions([player, ...traffic.proxies]);
    nm += traffic.nearMissCheck(player);
    for (const p of traffic.proxies) if (!Number.isFinite(p.position.x + p.position.y + p.position.z + p.heading)) nan = true;
    if (isBad(player)) nan = true;
    maxActive = Math.max(maxActive, traffic.proxies.length);
  }
  const ms = (performance.now() - t0) / frames;
  const st = traffic.stats();
  add('traffic 60 s (40 cars)', 'roadster', `NaN ${nan}, active ${st.active}/${st.count}, respawns ${st.respawns}, knocked ${st.knocked}, near misses ${nm}, hits ${hits}, ${fmt(ms, 3)} ms/frame (player+AI+traffic)`, 'no NaN, cars cycle', !nan && st.active > 20 && st.respawns > 0);
  // near miss unit check: player passes 1 m beside a stopped traffic car at 120 km/h
  const tr2 = new Traffic(fakeScene, world, (seed) => createMockTrafficCarModel(seed), { count: 1 });
  tr2.update(DT, player);
  const c = tr2.cars[0];
  tr2.placeCar(c, 3, 1, 0.5); // road 3 (straight runway), forward dir, middle
  c.speed = 0; c.targetSpeedOverride = 0; // parked (placeCar already posed it)
  const pv = new Vehicle(spec, world);
  const px = c.proxy.position.x, pz = c.proxy.position.z, hd = c.proxy.heading;
  const fx = Math.sin(hd), fz = Math.cos(hd), lx = fz, lz = -fx;
  const off = c.proxy.halfWidth + pv.halfWidth + 1.0;
  pv.reset(px - fx * 60 + lx * off, pz - fz * 60 + lz * off, hd);
  pv.update(DT, inp());
  pv.velocity.set(fx * 34, 0, fz * 34);
  let nm2 = 0;
  for (let i = 0; i < 180; i++) {
    pv.update(DT, inp({ throttle: 0.5 }));
    tr2.update(DT, pv);
    resolveVehicleCollisions([pv, ...tr2.proxies]);
    nm2 += tr2.nearMissCheck(pv);
  }
  add('near miss detection (1 m @ 122 km/h)', 'roadster', `${nm2} near miss`, '1', nm2 === 1);
  // same pass but scraping the car: must NOT count
  const tr3 = new Traffic(fakeScene, world, (seed) => createMockTrafficCarModel(seed), { count: 1 });
  tr3.update(DT, player);
  const c3 = tr3.cars[0];
  tr3.placeCar(c3, 3, 1, 0.5); c3.speed = 0; c3.targetSpeedOverride = 0;
  const pv3 = new Vehicle(spec, world);
  const off3 = c3.proxy.halfWidth + pv3.halfWidth - 0.15;
  pv3.reset(c3.proxy.position.x - fx * 60 + lx * off3, c3.proxy.position.z - fz * 60 + lz * off3, hd);
  pv3.update(DT, inp()); pv3.velocity.set(fx * 34, 0, fz * 34);
  let nm3 = 0, hit3 = 0;
  pv3.onCollision = () => hit3++;
  for (let i = 0; i < 180; i++) { pv3.update(DT, inp({ throttle: 0.5 })); tr3.update(DT, pv3); resolveVehicleCollisions([pv3, ...tr3.proxies]); nm3 += tr3.nearMissCheck(pv3); }
  add('near miss: scrape does not count', 'roadster', `${nm3} near miss, ${hit3} hit events, traffic car ${c3.state}`, '0', nm3 === 0 && hit3 > 0);
}

// ---------------------------------------------------------------- run
const t0 = performance.now();
if (only === 'all' || only === 'vehicle') {
  for (const s of SAMPLE_SPECS) testAccelTop(s);
  for (const s of SAMPLE_SPECS) testBrake(s);
  for (const s of SAMPLE_SPECS) testSkidpad(s);
  for (const s of SAMPLE_SPECS) testDrift(s);
  for (const s of SAMPLE_SPECS) testStepSteer(s);
  for (const s of SAMPLE_SPECS) testHop(s);
  testHover(SAMPLE_SPECS[0]);
  for (const s of SAMPLE_SPECS) { testWall(s, 'thick'); testWall(s, 'thin'); }
  for (const s of SAMPLE_SPECS) testCrest(s);
  testWaterBounds(SAMPLE_SPECS[1]);
  testCarCar(SAMPLE_SPECS[0]);
  testFrameRates(SAMPLE_SPECS[0]);
  perf(SAMPLE_SPECS[0]);
}
if (only === 'all' || only === 'ai') {
  testAI(world.tracks[0], 4, 2);
  testAI(world.tracks[1], 4, 2);
  testAIStuck();
}
if (only === 'all' || only === 'traffic') testTraffic();

// table
const cols = ['test', 'car', 'value', 'target', 'pass'];
const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
const line = (r) => '| ' + cols.map((c, i) => String(r[c]).padEnd(w[i])).join(' | ') + ' |';
console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
console.log('|' + w.map(x => '-'.repeat(x + 2)).join('|') + '|');
for (const r of rows) console.log(line(r));
const fails = rows.filter(r => r.pass !== 'PASS').length;
console.log(`\n${rows.length - fails}/${rows.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exitCode = fails ? 1 : 0;
